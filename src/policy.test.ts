import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkspacePath, isAllowedAuthority, parsePolicy } from "./policy.js";

describe("linux bwrap typed policy", () => {
  it.runIf(process.platform === "linux")("allows only Gate A and the configured Paperclip origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-policy-"));
    const policy = await parsePolicy({ workspaceRoot: root, paperclipOrigin: "https://paperclip.internal:3100" });
    expect(isAllowedAuthority(policy, "192.168.1.6:8020")).toBe(true);
    expect(isAllowedAuthority(policy, "192.168.1.6:8021")).toBe(true);
    expect(isAllowedAuthority(policy, "paperclip.internal:3100")).toBe(true);
    expect(isAllowedAuthority(policy, "8.8.8.8:443")).toBe(false);
    expect(isAllowedAuthority(policy, "[::1]:8020")).toBe(false);
    expect(isAllowedAuthority(policy, "192.168.1.6:22")).toBe(false);
    expect(isAllowedAuthority(policy, "user@192.168.1.6:8020")).toBe(false);
  });

  it.runIf(process.platform === "linux")("keeps the strict profile as the default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-policy-strict-"));
    const policy = await parsePolicy({ workspaceRoot: root, paperclipOrigin: "https://paperclip.internal:3100" });
    expect((policy as { networkProfile?: string }).networkProfile).toBe("gate-a-strict");
    expect(isAllowedAuthority(policy, "chatgpt.com:443")).toBe(false);
  });

  it.runIf(process.platform === "linux")("allows ChatGPT only in codex-managed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-policy-codex-"));
    const policy = await parsePolicy({
      workspaceRoot: root,
      paperclipOrigin: "https://paperclip.internal:3100",
      networkProfile: "codex-managed",
    });
    expect((policy as { networkProfile?: string }).networkProfile).toBe("codex-managed");
    expect(isAllowedAuthority(policy, "chatgpt.com:443")).toBe(true);
    expect(isAllowedAuthority(policy, "api.openai.com:443")).toBe(false);
    expect(isAllowedAuthority(policy, "8.8.8.8:443")).toBe(false);
  });

  it.runIf(process.platform === "linux")("rejects an unknown network profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-policy-invalid-"));
    await expect(parsePolicy({
      workspaceRoot: root,
      paperclipOrigin: "https://paperclip.internal:3100",
      networkProfile: "public",
    })).rejects.toThrow(/networkProfile/i);
  });

  it("rejects workspace symlink and traversal escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "bwrap-outside-"));
    await mkdir(path.join(root, "ok")); await symlink(outside, path.join(root, "escape"));
    await expect(assertWorkspacePath(root, path.join(root, "ok"))).resolves.toBe(await realpath(path.join(root, "ok")));
    await expect(assertWorkspacePath(root, path.join(root, "escape"))).rejects.toThrow("escapes configured root");
    await expect(assertWorkspacePath(root, path.join(root, "..", path.basename(outside)))).rejects.toThrow("escapes configured root");
  });
});
