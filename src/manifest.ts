import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.linux-bwrap-sandbox-provider",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linux Bubblewrap Sandbox Provider",
  description: "Local Linux Bubblewrap runner with a server-owned default-deny egress policy.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "linux-bwrap",
    kind: "sandbox_provider",
    displayName: "Linux Bubblewrap",
    description: "Runs commands in a bwrap mount/network namespace. Egress policy is fixed by the server.",
    configSchema: {
      type: "object",
      properties: {
        paperclipOrigin: { type: "string", description: "Paperclip server origin permitted in addition to the fixed Gate A endpoints." },
        workspaceRoot: { type: "string", description: "Canonical host workspace root exposed read-write to the sandbox." },
        timeoutMs: { type: "number", default: 300000 },
        networkProfile: {
          type: "string",
          enum: ["gate-a-strict", "codex-managed"],
          default: "gate-a-strict",
          description: "Closed server-owned egress profile; codex-managed additionally permits chatgpt.com:443.",
        },
      },
      required: ["paperclipOrigin", "workspaceRoot"],
      additionalProperties: false
    }
  }]
};
export default manifest;
