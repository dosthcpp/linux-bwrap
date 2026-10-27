import path from "node:path";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LinuxBwrapPolicy } from "./policy.js";
import { assertWorkspacePath } from "./policy.js";
import { startDefaultDenyProxy } from "./proxy.js";

export interface RunInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /**
   * Optional provider-owned Unix socket that must be reachable from the
   * namespace. The caller supplies this out-of-band so an untrusted command
   * cannot choose an arbitrary host path to bind into the sandbox.
   */
  bridgeSocketPath?: string;
}
const SYSTEM_BINDS = ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl", "/etc/hosts"];
const SPEC_FD = 3;
const RUN_DIR_PREFIX = "run-";
const MAX_RUN_DURATION_MS = 86_400_000;
const STALE_RUN_GRACE_MS = 300_000;
export const BWRAP_RUNTIME_DIR_ENV = "PAPERCLIP_BWRAP_RUNTIME_DIR";
export const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createBoundedOutputCapture(limit = MAX_CAPTURED_OUTPUT_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Output capture limit must be a positive safe integer.");
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let capturedBytes = 0;
  return {
    append(stream: "stdout" | "stderr", chunk: Buffer | string): boolean {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (capturedBytes + buffer.length > limit) return false;
      capturedBytes += buffer.length;
      chunks[stream].push(buffer);
      return true;
    },
    text(stream: "stdout" | "stderr"): string {
      return Buffer.concat(chunks[stream]).toString("utf8");
    },
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveBwrapRuntimeRoot(workspaceRoot: string): Promise<string> {
  const configured = process.env[BWRAP_RUNTIME_DIR_ENV]?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error(`${BWRAP_RUNTIME_DIR_ENV} must name an absolute service-owned runtime directory.`);
  }
  const [runtimeRoot, canonicalWorkspace] = await Promise.all([realpath(configured), realpath(workspaceRoot)]);
  const metadata = await stat(runtimeRoot);
  if (!metadata.isDirectory()) throw new Error(`${BWRAP_RUNTIME_DIR_ENV} must name a directory.`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${BWRAP_RUNTIME_DIR_ENV} must not grant group or other permissions.`);
  }
  const uid = process.getuid?.();
  if (uid != null && metadata.uid !== uid) {
    throw new Error(`${BWRAP_RUNTIME_DIR_ENV} must be owned by the plugin worker identity.`);
  }
  if (isInside(canonicalWorkspace, runtimeRoot)) {
    throw new Error(`${BWRAP_RUNTIME_DIR_ENV} must be outside workspaceRoot.`);
  }
  return runtimeRoot;
}

export async function cleanupStaleRunDirs(runtimeRoot: string, nowMs = Date.now()): Promise<void> {
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  const uid = process.getuid?.();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_DIR_PREFIX)) return;
    const candidate = path.join(runtimeRoot, entry.name);
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata?.isDirectory() || (uid != null && metadata.uid !== uid)) return;
    if (nowMs - metadata.mtimeMs <= MAX_RUN_DURATION_MS + STALE_RUN_GRACE_MS) return;
    await rm(candidate, { recursive: true, force: true });
  }));
}

export async function buildBwrapArgs(policy: LinuxBwrapPolicy, input: RunInput, runDir: string): Promise<string[]> {
  const cwd = await assertWorkspacePath(policy.workspaceRoot, input.cwd);
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run/paperclip"];
  for (const source of SYSTEM_BINDS) { try { await access(source, constants.R_OK); args.push("--ro-bind", source, source); } catch { /* absent */ } }
  args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
  args.push("--perms", "0600", "--file", String(SPEC_FD), "/run/paperclip/spec.json");
  args.push("--bind", path.join(runDir, "proxy.sock"), "/run/paperclip/proxy.sock");
  const bridgeSocketPath = input.bridgeSocketPath?.trim() ?? "";
  if (bridgeSocketPath) {
    const runtimeRoot = path.dirname(runDir);
    if (!path.isAbsolute(bridgeSocketPath) || !isInside(runtimeRoot, bridgeSocketPath)) {
      throw new Error("bridgeSocketPath must be an absolute path inside the worker runtime root.");
    }
    const metadata = await lstat(bridgeSocketPath).catch(() => null);
    if (!metadata?.isSocket()) {
      throw new Error("bridgeSocketPath must name a worker-owned Unix socket.");
    }
    args.push("--bind", bridgeSocketPath, "/run/paperclip/bridge.sock");
  }
  args.push("--ro-bind", fileURLToPath(new URL("./sandbox-init.js", import.meta.url)), "/run/paperclip/init.js");
  args.push("--ro-bind", fileURLToPath(new URL("./sandbox-environment.js", import.meta.url)), "/run/paperclip/sandbox-environment.js");
  args.push("--chdir", cwd, "/usr/bin/node", "/run/paperclip/init.js");
  return args;
}

export async function runSandboxed(policy: LinuxBwrapPolicy, input: RunInput) {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_RUN_DURATION_MS) {
    throw new Error("Sandbox timeout must be between 1ms and 24 hours.");
  }
  const runtimeRoot = await resolveBwrapRuntimeRoot(policy.workspaceRoot);
  await cleanupStaleRunDirs(runtimeRoot);
  const runDir = await mkdtemp(path.join(runtimeRoot, RUN_DIR_PREFIX));
  const socketPath = path.join(runDir, "proxy.sock");
  if (Buffer.byteLength(socketPath) > 100) {
    await rm(runDir, { recursive: true, force: true });
    throw new Error(`${BWRAP_RUNTIME_DIR_ENV} is too long for the Linux Unix-domain proxy socket path.`);
  }
  const serializedSpec = JSON.stringify({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    ...(input.bridgeSocketPath ? { bridgeSocketPath: "/run/paperclip/bridge.sock" } : {}),
  });
  let proxy: Awaited<ReturnType<typeof startDefaultDenyProxy>> | undefined;
  try {
    proxy = await startDefaultDenyProxy(socketPath, policy);
    const args = await buildBwrapArgs(policy, input, runDir);
    return await new Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", args, {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", TZ: "UTC" },
      });
      const output = createBoundedOutputCapture();
      let settled = false, timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      };
      const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        if (!output.append(stream, chunk)) {
          fail(new Error(`Sandbox output exceeded the ${MAX_CAPTURED_OUTPUT_BYTES}-byte aggregate capture limit.`));
        }
      };
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", fail);
      const specPipe = child.stdio[SPEC_FD] as NodeJS.WritableStream | null;
      if (!specPipe) return fail(new Error("Bubblewrap specification pipe was not created."));
      specPipe.once("error", fail);
      specPipe.end(serializedSpec);
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs);
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: timedOut ? null : code,
          timedOut,
          stdout: output.text("stdout"),
          stderr: output.text("stderr"),
        });
      });
      child.stdin.end(input.stdin ?? "");
    });
  } finally { await proxy?.close(); await rm(runDir, { recursive: true, force: true }); }
}
