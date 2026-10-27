import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LinuxBwrapPolicy } from "./policy.js";
import {
  BWRAP_RUNTIME_DIR_ENV,
  buildBwrapArgs,
  cleanupStaleRunDirs,
  createBoundedOutputCapture,
  resolveBwrapRuntimeRoot,
} from "./runner.js";

const roots: string[] = [];
const originalRuntimeRoot = process.env.PAPERCLIP_BWRAP_RUNTIME_DIR;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (originalRuntimeRoot == null) delete process.env.PAPERCLIP_BWRAP_RUNTIME_DIR;
  else process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = originalRuntimeRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("linux-bwrap runtime boundary", () => {
  it("caps aggregate stdout and stderr capture without retaining the overflowing chunk", () => {
    const output = createBoundedOutputCapture(5);
    expect(output.append("stdout", "abc")).toBe(true);
    expect(output.append("stderr", Buffer.from("de"))).toBe(true);
    expect(output.append("stdout", "f")).toBe(false);
    expect(output.text("stdout")).toBe("abc");
    expect(output.text("stderr")).toBe("de");
  });

  it("requires a private worker-owned runtime root outside the workspace", async () => {
    const workspace = await tempRoot("paperclip-bwrap-workspace-");
    delete process.env.PAPERCLIP_BWRAP_RUNTIME_DIR;
    await expect(resolveBwrapRuntimeRoot(workspace)).rejects.toThrow(BWRAP_RUNTIME_DIR_ENV);

    const inside = path.join(workspace, "runtime");
    await mkdir(inside, { mode: 0o700 });
    process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = inside;
    await expect(resolveBwrapRuntimeRoot(workspace)).rejects.toThrow("outside workspaceRoot");

    const exposed = await tempRoot("paperclip-bwrap-exposed-");
    await chmod(exposed, 0o750);
    process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = exposed;
    await expect(resolveBwrapRuntimeRoot(workspace)).rejects.toThrow("group or other permissions");

    const runtimeRoot = await tempRoot("paperclip-bwrap-runtime-");
    process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = runtimeRoot;
    await expect(resolveBwrapRuntimeRoot(workspace)).resolves.toBe(await realpath(runtimeRoot));
  });

  it("removes only stale owned run directories", async () => {
    const runtimeRoot = await tempRoot("paperclip-bwrap-cleanup-");
    const stale = path.join(runtimeRoot, "run-stale");
    const fresh = path.join(runtimeRoot, "run-fresh");
    const unrelated = path.join(runtimeRoot, "keep-me");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
    await writeFile(path.join(stale, "marker"), "stale");
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 86_400_000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);

    await cleanupStaleRunDirs(runtimeRoot, now);

    await expect(mkdir(stale)).resolves.toBeUndefined();
    await expect(mkdir(fresh)).rejects.toThrow();
    await expect(mkdir(unrelated)).rejects.toThrow();
  });

  it("feeds the run specification through an anonymous pipe into namespace-local tmpfs", async () => {
    const workspace = await tempRoot("paperclip-bwrap-args-");
    const runtimeRoot = await tempRoot("paperclip-bwrap-args-runtime-");
    const socketPath = path.join(runtimeRoot, "proxy.sock");
    await writeFile(socketPath, "");
    const policy: LinuxBwrapPolicy = { networkProfile: "gate-a-strict", allowed: [], workspaceRoot: workspace, timeoutMs: 1_000 };

    const args = await buildBwrapArgs(policy, {
      command: "/usr/bin/node",
      args: ["--version"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
    }, runtimeRoot);

    expect(args).toContain("--file");
    expect(args).not.toContain("--ro-bind-data");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("CAP_NET_ADMIN");
    expect(args).not.toContain("--uid");
    expect(args).not.toContain("--gid");
    expect(args).toContain("3");
    expect(args).not.toContain(path.join(runtimeRoot, "spec.json"));
  });

  it("binds the sandbox environment helper beside the namespace init module", async () => {
    const workspace = await tempRoot("paperclip-bwrap-helper-");
    const runtimeRoot = await tempRoot("paperclip-bwrap-helper-runtime-");
    const policy: LinuxBwrapPolicy = { networkProfile: "gate-a-strict", allowed: [], workspaceRoot: workspace, timeoutMs: 1_000 };

    const args = await buildBwrapArgs(policy, {
      command: "/usr/bin/node",
      args: ["--version"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
    }, runtimeRoot);

    const destinationIndex = args.indexOf("/run/paperclip/sandbox-environment.js");
    expect(destinationIndex).toBeGreaterThan(1);
    expect(args[destinationIndex - 2]).toBe("--ro-bind");
    expect(path.basename(args[destinationIndex - 1]!)).toBe("sandbox-environment.js");
  });

  it("keeps the host loopback name resolvable inside the network namespace", async () => {
    const workspace = await tempRoot("paperclip-bwrap-hosts-");
    const runtimeRoot = await tempRoot("paperclip-bwrap-hosts-runtime-");
    const policy: LinuxBwrapPolicy = {
      networkProfile: "gate-a-strict",
      allowed: [],
      workspaceRoot: workspace,
      timeoutMs: 1_000,
    };

    const args = await buildBwrapArgs(policy, {
      command: "/usr/bin/node",
      args: ["--version"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
    }, runtimeRoot);

    expect(args).toEqual(expect.arrayContaining(["--ro-bind", "/etc/hosts", "/etc/hosts"]));
  });

  it("binds an explicit run-owned callback bridge socket into the namespace", async () => {
    const workspace = await tempRoot("paperclip-bwrap-bridge-workspace-");
    const runtimeRoot = await tempRoot("paperclip-bwrap-bridge-runtime-");
    const bridgeSocket = path.join(runtimeRoot, "bridge.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bridgeSocket, resolve);
    });
    const policy: LinuxBwrapPolicy = {
      networkProfile: "gate-a-strict",
      allowed: [],
      workspaceRoot: workspace,
      timeoutMs: 1_000,
    };

    const args = await buildBwrapArgs(policy, {
      command: "/usr/bin/node",
      args: ["--version"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
      bridgeSocketPath: bridgeSocket,
    }, runtimeRoot);

    expect(args).toEqual(expect.arrayContaining([
      "--bind",
      bridgeSocket,
      "/run/paperclip/bridge.sock",
    ]));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
