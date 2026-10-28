import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export interface LinuxBwrapPolicy {
  readonly networkProfile: NetworkProfile;
  readonly allowed: readonly { protocol: "http:" | "https:"; hostname: string; port: number }[];
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
}

export type NetworkProfile = "gate-a-strict" | "codex-managed";

const GATE_A = ["http://192.168.1.6:8020", "http://192.168.1.6:8021"] as const;
const CODEX_MANAGED = [...GATE_A, "https://chatgpt.com"] as const;

function readNetworkProfile(value: unknown): NetworkProfile {
  if (value === undefined || value === "gate-a-strict") return "gate-a-strict";
  if (value === "codex-managed") return "codex-managed";
  throw new Error("networkProfile must be gate-a-strict or codex-managed.");
}

function endpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) origins are supported.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("paperclipOrigin must be an origin without credentials, path, query, or fragment.");
  }
  return { protocol: url.protocol, hostname: url.hostname.toLowerCase(), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) } as const;
}

export async function parsePolicy(raw: Record<string, unknown>): Promise<LinuxBwrapPolicy> {
  if (process.platform !== "linux") throw new Error("linux-bwrap is supported only on Linux.");
  const configuredOrigin = typeof raw.paperclipOrigin === "string" ? raw.paperclipOrigin.trim() : "";
  const configuredRoot = typeof raw.workspaceRoot === "string" ? raw.workspaceRoot.trim() : "";
  if (!configuredOrigin || !configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error("paperclipOrigin and an absolute workspaceRoot are required.");
  }
  const root = await realpath(configuredRoot);
  if (!(await stat(root)).isDirectory()) throw new Error("workspaceRoot must be a directory.");
  const timeout = Number(raw.timeoutMs ?? 300_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400_000) throw new Error("timeoutMs is invalid.");
  const networkProfile = readNetworkProfile(raw.networkProfile);
  const profileOrigins = networkProfile === "codex-managed" ? CODEX_MANAGED : GATE_A;
  return {
    networkProfile,
    allowed: [...profileOrigins.map(endpoint), endpoint(configuredOrigin)],
    workspaceRoot: root,
    timeoutMs: timeout,
  };
}

export async function assertWorkspacePath(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(candidate);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workspace path escapes configured root: ${candidate}`);
  }
  return resolved;
}

export function isAllowedAuthority(policy: LinuxBwrapPolicy, authority: string): boolean {
  let url: URL;
  try { url = new URL(`http://${authority}`); } catch { return false; }
  if (url.username || url.password || url.pathname !== "/") return false;
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 80);
  return policy.allowed.some((entry) => entry.hostname === host && entry.port === port);
}
