import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import { SANDBOX_HOME, sandboxEnvironment } from "./sandbox-environment.js";

interface Spec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  bridgeSocketPath?: string;
}
const specPath = "/run/paperclip/spec.json";
let serializedSpec: string;
try {
  serializedSpec = readFileSync(specPath, "utf8");
} finally {
  unlinkSync(specPath);
}
const spec = JSON.parse(serializedSpec) as Spec;
const status = readFileSync("/proc/self/status", "utf8");
for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
  const value = status.match(new RegExp(`^${field}:\\s*(\\S+)$`, "m"))?.[1];
  if (!value || !/^0+$/.test(value)) throw new Error(`Sandbox init requires an empty ${field} capability set.`);
}
if (!/^NoNewPrivs:\s*1$/m.test(status)) throw new Error("Sandbox init requires NoNewPrivs=1.");
if (process.getuid?.() === 0) throw new Error("Sandbox init refuses namespace UID 0.");
const drop = ["--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"];
const BRIDGE_ROLE_AGENT = "PAPERCLIP_BRIDGE_ROLE:agent\n";
mkdirSync(SANDBOX_HOME, { recursive: true, mode: 0o700 });
const relays = [
  spawn("/usr/bin/setpriv", [...drop, "/usr/bin/socat", "TCP-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork", "UNIX-CONNECT:/run/paperclip/proxy.sock"], { stdio: "inherit" }),
];

function bridgeLoopbackPort(): number | null {
  if (!spec.bridgeSocketPath || !spec.env.PAPERCLIP_API_BRIDGE_MODE) return null;
  let url: URL;
  try {
    url = new URL(spec.env.PAPERCLIP_API_URL ?? "");
  } catch {
    throw new Error("Sandbox callback bridge requires a valid loopback PAPERCLIP_API_URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    throw new Error("Sandbox callback bridge requires a loopback PAPERCLIP_API_URL.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 18080) {
    throw new Error("Sandbox callback bridge requires a non-proxy loopback port.");
  }
  return port;
}

function startBridgeRelay(port: number): net.Server {
  const server = net.createServer((client) => {
    const bridge = net.createConnection({ path: "/run/paperclip/bridge.sock" });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      bridge.destroy();
    };
    client.setNoDelay(true);
    bridge.setNoDelay(true);
    client.once("error", close);
    bridge.once("error", close);
    client.once("close", close);
    bridge.once("close", close);
    bridge.once("connect", () => {
      bridge.write(BRIDGE_ROLE_AGENT);
      client.pipe(bridge);
      bridge.pipe(client);
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const bridgePort = bridgeLoopbackPort();
let bridgeRelay: net.Server | null = null;
if (bridgePort !== null) {
  bridgeRelay = startBridgeRelay(bridgePort);
}

function stopRelays(): void {
  for (const relay of relays) relay.kill();
  if (bridgeRelay?.listening) bridgeRelay.close();
}

for (const relay of relays) {
  relay.once("error", (error) => {
    console.error(error);
    stopRelays();
    process.exit(125);
  });
}
bridgeRelay?.once("error", (error) => {
  console.error(error);
  stopRelays();
  process.exit(125);
});

async function waitForRelay(relay: ReturnType<typeof spawn>, port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (relay.exitCode !== null) throw new Error(`Proxy relay exited with code ${relay.exitCode}.`);
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Proxy relay did not become ready.");
}

async function waitForServer(server: net.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

void Promise.all([
  waitForRelay(relays[0]!, 18080),
  ...(bridgeRelay === null ? [] : [waitForServer(bridgeRelay)]),
]).then(() => {
  const child = spawn("/usr/bin/setpriv", [...drop, spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: sandboxEnvironment({
      ...spec.env,
      HTTP_PROXY: "http://127.0.0.1:18080",
      HTTPS_PROXY: "http://127.0.0.1:18080",
      http_proxy: "http://127.0.0.1:18080",
      https_proxy: "http://127.0.0.1:18080",
      ALL_PROXY: "",
      NO_PROXY: "",
      all_proxy: "",
      no_proxy: "",
    }),
    stdio: ["inherit", "inherit", "inherit"]
  });
  child.once("error", (error) => { console.error(error); stopRelays(); process.exit(127); });
  child.once("exit", (code, signal) => { stopRelays(); if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
}).catch((error) => {
  console.error(error);
  stopRelays();
  process.exit(125);
});
