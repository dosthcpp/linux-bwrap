import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedAuthority, parsePolicy } from "./policy.js";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn().mockResolvedValue(undefined),
}));

const roots: string[] = [];
async function config() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-public-policy-"));
  roots.push(workspaceRoot);
  return { workspaceRoot, paperclipOrigin: "https://paperclip.example.test" };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "linux")("public configurable egress policy", () => {
  it("has no implicit Gate A destination when the setting is absent", async () => {
    const policy = await parsePolicy(await config());
    expect(policy.allowed).toEqual([{ protocol: "https:", hostname: "paperclip.example.test", port: 443 }]);
    expect(isAllowedAuthority(policy, "gate-a.example.test:8020")).toBe(false);
    expect(isAllowedAuthority(policy, "chatgpt.com:443")).toBe(false);
  });

  it("uses only exact configured Gate A origins in both profiles", async () => {
    const raw = await config();
    for (const networkProfile of ["gate-a-strict", "codex-managed"]) {
      const policy = await parsePolicy({ ...raw, networkProfile, gateAOrigins: ["http://gate-a.example.test:8020", "https://second.example.test"] });
      expect(isAllowedAuthority(policy, "gate-a.example.test:8020")).toBe(true);
      expect(isAllowedAuthority(policy, "second.example.test:443")).toBe(true);
      expect(isAllowedAuthority(policy, "gate-a.example.test:8021")).toBe(false);
      expect(isAllowedAuthority(policy, "sub.gate-a.example.test:8020")).toBe(false);
      expect(isAllowedAuthority(policy, "chatgpt.com:443")).toBe(networkProfile === "codex-managed");
    }
  });

  it.each([null, "http://gate-a.example.test", [42], [""], ["ftp://gate-a.example.test"], ["https://*.example.test"], ["https://user:example@example.test"], ["https://example.test/path"], ["https://example.test?query=1"], ["https://example.test#fragment"]].map((gateAOrigins) => ({ gateAOrigins })))("rejects malformed or broad Gate A settings: $gateAOrigins", async ({ gateAOrigins }) => {
    await expect(parsePolicy({ ...await config(), gateAOrigins })).rejects.toThrow();
  });

  it("preserves configured origins through plugin config normalization", async () => {
    const raw = { ...await config(), gateAOrigins: ["https://gate-a.example.test:8443"] };
    const result = await plugin.definition.onEnvironmentValidateConfig!({ config: raw } as never);
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ gateAOrigins: raw.gateAOrigins });
    const normalized = await parsePolicy(result.normalizedConfig!);
    expect(isAllowedAuthority(normalized, "gate-a.example.test:8443")).toBe(true);
    const schema = manifest.environmentDrivers![0]!.configSchema as { properties: Record<string, unknown> };
    expect(schema.properties.gateAOrigins).toMatchObject({ type: "array" });
  });

  it.each([
    { gateAOrigins: ["http://same.example.test:443", "https://same.example.test"], networkProfile: "gate-a-strict" },
    { gateAOrigins: ["http://paperclip.example.test:443"], networkProfile: "gate-a-strict" },
    { gateAOrigins: ["http://chatgpt.com:443"], networkProfile: "codex-managed" },
  ])("rejects conflicting protocols for one authority: $gateAOrigins", async (extra) => {
    await expect(parsePolicy({ ...await config(), ...extra })).rejects.toThrow(/conflicting protocols/i);
  });
});
