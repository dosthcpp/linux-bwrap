export const SANDBOX_HOME = "/tmp/paperclip-home";
export const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const PAPERCLIP_SANDBOX_BRIDGE_MODES = new Set(["queue_v1", "http2_v1"]);

function paperclipBridgeNoProxy(environment: Record<string, string>): string {
  const mode = environment.PAPERCLIP_API_BRIDGE_MODE?.trim() ?? "";
  if (!PAPERCLIP_SANDBOX_BRIDGE_MODES.has(mode)) return "";

  const rawUrl = environment.PAPERCLIP_API_URL?.trim() ?? "";
  if (!rawUrl) return "";

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "";
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
    return "";
  }

  const port = url.port;
  if (!port) return "";
  const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  return `${host}:${port}`;
}

export function sandboxEnvironment(environment: Record<string, string>): Record<string, string> {
  const bridgeNoProxy = paperclipBridgeNoProxy(environment);
  return {
    ...environment,
    HOME: SANDBOX_HOME,
    PATH: SANDBOX_PATH,
    NO_PROXY: bridgeNoProxy,
    no_proxy: bridgeNoProxy,
  };
}
