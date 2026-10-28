import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginEnvironmentExecuteParams } from "@paperclipai/plugin-sdk";
import { assertWorkspacePath, parsePolicy } from "./policy.js";
import { runSandboxed } from "./runner.js";

async function requireTools() {
  for (const binary of ["/usr/bin/bwrap", "/usr/bin/socat", "/usr/bin/setpriv", "/usr/bin/node"]) await access(binary, constants.X_OK);
}

const plugin = definePlugin({
  async setup(ctx) { ctx.logger.info("Linux Bubblewrap sandbox provider ready"); },
  async onHealth() { return { status: "ok", message: "Linux Bubblewrap provider healthy" }; },
  async onEnvironmentValidateConfig(params) {
    try {
      const policy = await parsePolicy(params.config);
      await requireTools();
      return {
        ok: true,
        normalizedConfig: {
          paperclipOrigin: params.config.paperclipOrigin,
          workspaceRoot: policy.workspaceRoot,
          timeoutMs: policy.timeoutMs,
          networkProfile: policy.networkProfile,
        },
      };
    }
    catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
  },
  async onEnvironmentProbe(params) {
    try {
      const policy = await parsePolicy(params.config);
      await requireTools();
      return {
        ok: true,
        summary: "Bubblewrap and default-deny proxy prerequisites are available.",
        metadata: {
          provider: "linux-bwrap",
          networkProfile: policy.networkProfile,
          workspaceRoot: policy.workspaceRoot,
          allowed: policy.allowed,
        },
      };
    }
    catch (error) { return { ok: false, summary: "Linux Bubblewrap probe failed.", diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : String(error) }] }; }
  },
  async onEnvironmentAcquireLease(params) {
    const policy = await parsePolicy(params.config); await requireTools();
    return {
      providerLeaseId: `linux-bwrap:${params.runId}:${randomUUID()}`,
      metadata: {
        provider: "linux-bwrap",
        networkProfile: policy.networkProfile,
        remoteCwd: policy.workspaceRoot,
        reuseLease: false,
        allowed: policy.allowed,
      },
    };
  },
  async onEnvironmentResumeLease() { return { providerLeaseId: null, metadata: { expired: true } }; },
  async onEnvironmentReleaseLease() { return; },
  async onEnvironmentDestroyLease() { return; },
  async onEnvironmentRealizeWorkspace(params) {
    const policy = await parsePolicy(params.config);
    const requested = params.workspace.localPath ?? params.workspace.remotePath ?? policy.workspaceRoot;
    const cwd = await assertWorkspacePath(policy.workspaceRoot, requested);
    return { cwd, metadata: { provider: "linux-bwrap", remoteCwd: cwd } };
  },
  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
    const policy = await parsePolicy(params.config);
    const cwd = params.cwd ?? (typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : policy.workspaceRoot);
    return await runSandboxed(policy, { command: params.command, args: params.args ?? [], cwd, env: params.env ?? {}, stdin: params.stdin, timeoutMs: params.timeoutMs ?? policy.timeoutMs });
  }
});
export default plugin;
