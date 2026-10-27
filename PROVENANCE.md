# Source provenance and publication changes

The baseline is a preserved Paperclip release-parity source snapshot, cross-checked against a separately inspected Linux installation. The source checkout reported commit `adc14eec2c9b09cc64db5311aa8f901a224564d8`; this identifies the checkout, not a claim that its working tree was pristine or that this commit alone contains every deployed change.

Rebuilding the baseline provider with TypeScript 5.9.3 produced byte-identical installed JavaScript for all nine modules: `index`, `manifest`, `plugin`, `policy`, `proxy`, `runner`, `sandbox-environment`, `sandbox-init`, and `worker`. The installed source maps did not contain embedded source. The preserved TypeScript, rather than decompiled or invented code, supplies the source baseline.

This confirms correspondence to the inspected files. It does not identify the historic build command, deploy commit, original author of each local change, or which runner a live service selects. No live-service routing or deployment state was changed or verified.

Publication changes:

- Replace two private Gate A default origins with `gateAOrigins`, an optional operator-owned array, defaulting to no extra destinations. Retain both named network profiles and the existing managed-profile ChatGPT destination.
- Validate configured origin entries, reject conflicting protocols for one authority, and preserve configuration through plugin normalization. Keep manifest, tests, and example configuration aligned.
- Replace repeated internal destinations and internal-looking test hostnames with reserved `.example.test` fixtures; replace a personal home-path fixture with a generic path. The original numeric destinations and personal path are not included.
- Replace parent-monorepo build scripts and relative TypeScript inheritance with a standalone pnpm workspace, pinned build dependencies, and compiled package exports.
- Include the inspected installation's SDK and shared source dependencies, excluding their tests. Adjust only their package/build configuration to use this workspace. Preserve their source and MIT notices.

No remote helper or production deployment configuration is part of this repository. Source correspondence and successful tests do not imply a complete Paperclip deployment or a security audit.
