import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LinuxBwrapPolicy } from "./policy.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_BWRAP_INTEGRATION === "1";
const suite = describe.runIf(enabled);

suite("real Linux Bubblewrap confinement", () => {
  let workspace = "";
  let runtimeRoot = "";
  let port = 0;
  let previousRuntimeRoot: string | undefined;
  const server = createServer((_request, response) => response.end("allowed\n"));

  beforeAll(async () => {
    for (const binary of ["/usr/bin/bwrap", "/usr/bin/node", "/usr/bin/socat", "/usr/bin/setpriv"]) {
      await access(binary, constants.X_OK);
    }
    workspace = await mkdtemp(path.join(os.tmpdir(), "paperclip-bwrap-integration-"));
    runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-bwrap-runtime-"));
    previousRuntimeRoot = process.env.PAPERCLIP_BWRAP_RUNTIME_DIR;
    process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = runtimeRoot;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing test server address"));
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRuntimeRoot == null) delete process.env.PAPERCLIP_BWRAP_RUNTIME_DIR;
    else process.env.PAPERCLIP_BWRAP_RUNTIME_DIR = previousRuntimeRoot;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  });

  it("confines egress and prevents ambient worker secrets or the transient spec from crossing the boundary", async () => {
    const { runSandboxed } = await import("../dist/runner.js");
    const policy: LinuxBwrapPolicy = {
      networkProfile: "gate-a-strict",
      workspaceRoot: workspace,
      timeoutMs: 15_000,
      allowed: [{ protocol: "http:", hostname: "127.0.0.1", port }],
    };
    const script = String.raw`
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const net = require('node:net');
function curl(url) { return new Promise((resolve) => { const child = spawn('/usr/bin/curl', ['--silent', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '2', url]); let out = ''; child.stdout.on('data', (chunk) => out += chunk); child.on('exit', (code) => resolve(code === 0 ? Number(out) : 'ERROR')); child.on('error', () => resolve('ERROR')); }); }
function socket(host, port) { return new Promise((resolve) => { const s = net.connect({host, port, timeout: 1000}); s.on('connect', () => { s.destroy(); resolve('OPEN'); }); s.on('error', () => resolve('DENIED')); s.on('timeout', () => { s.destroy(); resolve('DENIED'); }); }); }
(async () => {
  const status = readFileSync('/proc/self/status', 'utf8');
  const capInh = status.match(/^CapInh:\s*(\S+)$/m)?.[1] ?? null;
  const capPrm = status.match(/^CapPrm:\s*(\S+)$/m)?.[1] ?? null;
  const capEff = status.match(/^CapEff:\s*(\S+)$/m)?.[1] ?? null;
  const capBnd = status.match(/^CapBnd:\s*(\S+)$/m)?.[1] ?? null;
  const capAmb = status.match(/^CapAmb:\s*(\S+)$/m)?.[1] ?? null;
  const noNewPrivs = status.match(/^NoNewPrivs:\s*(\S+)$/m)?.[1] ?? null;
  const allowed = await curl('http://127.0.0.1:${port}/');
  const publicIp = await curl('http://1.1.1.1/');
  const publicDns = await curl('http://example.com/');
  const direct = await socket('1.1.1.1', 80);
  const ipv6 = await socket('::1', 80);
  const connect = await new Promise((resolve) => { const s = net.connect(18080, '127.0.0.1', () => s.write('CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n')); let out=''; let settled=false; const done = (value) => { if (settled) return; settled=true; s.destroy(); resolve(value); }; s.on('data', c => { out += c; if (out.includes('403 Forbidden')) done('DENIED'); }); s.on('end', () => done(out.includes('403 Forbidden') ? 'DENIED' : 'ERROR')); s.on('error', () => done('ERROR')); s.setTimeout(1000, () => done('TIMEOUT')); });
  const proxyEnv = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'all_proxy', 'no_proxy'].map((key) => [key, process.env[key] ?? null]));
  console.log(JSON.stringify({uid: process.getuid(), capInh, capPrm, capEff, capBnd, capAmb, noNewPrivs, allowed, publicIp, publicDns, direct, ipv6, connect, proxyEnv, specPresent: existsSync('/run/paperclip/spec.json'), inheritedWorkerSecret: process.env.INHERITED_WORKER_SECRET ?? null, explicitChildValue: process.env.EXPLICIT_CHILD_VALUE ?? null}));
})();`;
    const previousWorkerSecret = process.env.INHERITED_WORKER_SECRET;
    process.env.INHERITED_WORKER_SECRET = "must-not-cross-bwrap-boundary";
    const result = await (async () => {
      try {
        return await runSandboxed(policy, {
          command: "/usr/bin/node", args: ["-e", script], cwd: workspace,
          env: {
            PATH: "/usr/bin:/bin",
            EXPLICIT_CHILD_VALUE: "delivered",
            HTTP_PROXY: "http://attacker.invalid:9", HTTPS_PROXY: "http://attacker.invalid:9",
            http_proxy: "http://attacker.invalid:9", https_proxy: "http://attacker.invalid:9",
            ALL_PROXY: "http://attacker.invalid:9", all_proxy: "http://attacker.invalid:9",
            NO_PROXY: "*", no_proxy: "*",
          },
          timeoutMs: 15_000,
        });
      } finally {
        if (previousWorkerSecret == null) delete process.env.INHERITED_WORKER_SECRET;
        else process.env.INHERITED_WORKER_SECRET = previousWorkerSecret;
      }
    })();
    expect(result, result.stderr).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(result.stdout.trim())).toEqual({
      uid: process.getuid?.(),
      capInh: "0000000000000000", capPrm: "0000000000000000",
      capEff: "0000000000000000", capBnd: "0000000000000000",
      capAmb: "0000000000000000", noNewPrivs: "1",
      allowed: 200, publicIp: 403, publicDns: 403,
      direct: "DENIED", ipv6: "DENIED", connect: "DENIED",
      proxyEnv: {
        HTTP_PROXY: "http://127.0.0.1:18080", HTTPS_PROXY: "http://127.0.0.1:18080",
        http_proxy: "http://127.0.0.1:18080", https_proxy: "http://127.0.0.1:18080",
        ALL_PROXY: "", NO_PROXY: "", all_proxy: "", no_proxy: "",
      },
      specPresent: false, inheritedWorkerSecret: null, explicitChildValue: "delivered",
    });
  }, 20_000);

  it("kills a sandbox that exceeds the aggregate output capture limit", async () => {
    const { MAX_CAPTURED_OUTPUT_BYTES, runSandboxed } = await import("../dist/runner.js");
    const policy: LinuxBwrapPolicy = {
      networkProfile: "gate-a-strict",
      workspaceRoot: workspace,
      timeoutMs: 15_000,
      allowed: [{ protocol: "http:", hostname: "127.0.0.1", port }],
    };
    await expect(runSandboxed(policy, {
      command: "/usr/bin/node",
      args: ["-e", `process.stdout.write(Buffer.alloc(${MAX_CAPTURED_OUTPUT_BYTES + 1}, "x"))`],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 15_000,
    })).rejects.toThrow(`Sandbox output exceeded the ${MAX_CAPTURED_OUTPUT_BYTES}-byte aggregate capture limit.`);
  }, 20_000);
});
