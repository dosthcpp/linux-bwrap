import net from "node:net";
import { unlink } from "node:fs/promises";
import type { LinuxBwrapPolicy } from "./policy.js";

const MAX_HEADER = 32 * 1024;

function allowedEndpoint(policy: LinuxBwrapPolicy, authority: string) {
  let url: URL;
  try { url = new URL(`http://${authority}`); } catch { return undefined; }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  const hostname = url.hostname.toLowerCase();
  const port = Number(url.port || 80);
  return policy.allowed.find((entry) => entry.hostname === hostname && entry.port === port);
}

export async function startDefaultDenyProxy(socketPath: string, policy: LinuxBwrapPolicy) {
  await unlink(socketPath).catch(() => undefined);
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    const reject = () => { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    client.once("error", () => undefined);
    client.on("data", function inspect(chunk) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_HEADER) return reject();
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", inspect);
      const header = buffer.subarray(0, end + 4).toString("latin1");
      const lines = header.split("\r\n");
      const [method, target, version] = lines[0]?.split(" ") ?? [];
      if (!method || !target || !version) return reject();
      const hostHeaders = lines.slice(1).filter((line) => /^host:/i.test(line));
      let authority = "";
      let parsedTarget: URL | undefined;
      if (method === "CONNECT") authority = target ?? "";
      else {
        try {
          parsedTarget = new URL(target);
          if (parsedTarget.protocol !== "http:") return reject();
          authority = parsedTarget.host;
        } catch { return reject(); }
        if (hostHeaders.length !== 1 || hostHeaders[0]!.slice(5).trim().toLowerCase() !== authority.toLowerCase()) return reject();
      }
      const allowed = allowedEndpoint(policy, authority);
      if (!allowed) return reject();
      // Plain proxy requests may reach only configured HTTP origins. CONNECT is
      // reserved for configured HTTPS origins, so an HTTP allowlist entry cannot
      // be repurposed as an opaque TCP tunnel.
      if ((method === "CONNECT") !== (allowed.protocol === "https:")) return reject();
      const parsed = new URL(`http://${authority}`);
      const upstream = net.connect(Number(parsed.port || 80), parsed.hostname);
      upstream.once("error", reject);
      upstream.once("connect", () => {
        if (method === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else {
          // HTTP proxies receive an absolute-form request target, while the
          // upstream HTTP server expects origin-form (for example `/health`).
          // Forwarding the absolute URL makes llama.cpp return 404 even when
          // the authority is allowlisted.
          const requestLineEnd = header.indexOf("\r\n");
          const originTarget = `${parsedTarget!.pathname || "/"}${parsedTarget!.search}`;
          const originFormHeader = `${method} ${originTarget} ${version}\r\n${header.slice(requestLineEnd + 2)}`;
          upstream.write(Buffer.concat([Buffer.from(originFormHeader, "latin1"), buffer.subarray(end + 4)]));
        }
        client.pipe(upstream); upstream.pipe(client);
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await unlink(socketPath).catch(() => undefined); } };
}
