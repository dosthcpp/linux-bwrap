import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startDefaultDenyProxy } from "./proxy.js";
import type { LinuxBwrapPolicy } from "./policy.js";

const policy: LinuxBwrapPolicy = { networkProfile: "gate-a-strict", workspaceRoot: "/workspace", timeoutMs: 1000, allowed: [{ protocol: "http:", hostname: "gate-a.example.test", port: 8020 }] };
async function request(socket: string, payload: string) { return await new Promise<string>((resolve, reject) => { const client = net.connect(socket); let data = ""; client.on("data", (v) => { data += v; }); client.on("end", () => resolve(data)); client.on("error", reject); client.write(payload); }); }

describe.runIf(process.platform === "linux")("default-deny proxy", () => {
  it("rewrites allowlisted absolute-form requests to origin-form upstream", async () => {
    const upstream = createServer((request, response) => {
      if (request.url !== "/health?probe=1") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.end("ok\n");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const root = await mkdtemp(path.join(os.tmpdir(), ".bwrap-proxy-"));
    const socket = path.join(root, "proxy.sock");
    const localPolicy: LinuxBwrapPolicy = {
      networkProfile: "gate-a-strict",
      workspaceRoot: "/workspace",
      timeoutMs: 1000,
      allowed: [{ protocol: "http:", hostname: "127.0.0.1", port: address.port }],
    };
    const proxy = await startDefaultDenyProxy(socket, localPolicy);
    try {
      const response = await request(socket, `GET http://127.0.0.1:${address.port}/health?probe=1 HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`);
      expect(response).toContain("200 OK");
      expect(response).toContain("ok");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("allows HTTPS CONNECT only for an HTTPS profile entry", async () => {
    const upstream = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const root = await mkdtemp(path.join(os.tmpdir(), ".bwrap-proxy-connect-"));
    const socket = path.join(root, "proxy.sock");
    const codexPolicy: LinuxBwrapPolicy = {
      networkProfile: "codex-managed",
      workspaceRoot: "/workspace",
      timeoutMs: 1000,
      allowed: [
        { protocol: "https:", hostname: "chatgpt.com", port: 443 },
        { protocol: "https:", hostname: "127.0.0.1", port: address.port },
      ],
    };
    const proxy = await startDefaultDenyProxy(socket, codexPolicy);
    try {
      await expect(request(socket, `CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)).resolves.toContain("200 Connection Established");
      await expect(request(socket, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).resolves.toContain("403 Forbidden");
      await expect(request(socket, "CONNECT gate-a.example.test:8020 HTTP/1.1\r\nHost: gate-a.example.test:8020\r\n\r\n")).resolves.toContain("403 Forbidden");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("denies public IP, IPv6, DNS and CONNECT authority bypasses", async () => {
    const shortWritableRoot = process.platform === "darwin" ? (process.env.PAPERCLIP_WORKSPACE_CWD ?? process.cwd()) : os.tmpdir();
    const root = await mkdtemp(path.join(shortWritableRoot, ".bwrap-proxy-")); const socket = path.join(root, "proxy.sock"); const proxy = await startDefaultDenyProxy(socket, policy);
    try {
      for (const target of ["8.8.8.8:443", "example.com:443", "[::1]:443", "user@gate-a.example.test:8020", "gate-a.example.test:8021"]) {
        await expect(request(socket, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)).resolves.toContain("403 Forbidden");
      }
      await expect(request(socket, "GET http://gate-a.example.test:8020/ HTTP/1.1\r\nHost: 8.8.8.8\r\n\r\n")).resolves.toContain("403 Forbidden");
      await expect(request(socket, "CONNECT gate-a.example.test:8020 HTTP/1.1\r\nHost: gate-a.example.test:8020\r\n\r\n")).resolves.toContain("403 Forbidden");
    } finally { await proxy.close(); }
  });
});
