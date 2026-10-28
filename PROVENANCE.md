# AI Cloud source provenance

On 2026-10-28 the owner designated the AI Cloud source as canonical. This replaces
the publication-specific provider changes in public commit
`08b0221553ac05c9416f5dafca6d73b9cd5bde46`. The public repository is an integration
artifact; its existence does not establish original authorship by its owner.
The original Paperclip MIT notices are preserved.

## Canonical snapshot

- Source working copy: `/Volumes/Data/tony_ai_lab/ton-4427/ton-4662-release-parity`.
- Package: `packages/plugins/sandbox-providers/linux-bwrap`.
- Latest core source edit: **2026-09-20 11:35:26 KST** (`src/sandbox-init.ts`).
- Parent branch: `codex/ton4662-release-parity`.
- Parent HEAD: `adc14eec2c9b09cc64db5311aa8f901a224564d8`.

The package is untracked in that parent working copy. The parent HEAD identifies
the checkout, not the imported source revision. All 14 files under this
repository's `src/` were copied byte-for-byte from that working copy, including
the five original test files. Key SHA-256 identities are:

| Source file | SHA-256 |
| --- | --- |
| `src/runner.ts` | `1ecb5475183f0e467ef6b4a56de21405e91816a1cf9ec8459a342b6499cc23d4` |
| `src/policy.ts` | `fa8ca029b5f563734807d77172fdb0310991d27e138dde18383842feb21d40df` |
| `src/sandbox-init.ts` | `27e9d21821585191993d54eb6b936f6cfd9674066aa231128afa93981f1174a8` |

The AI Cloud inventory and the working copy's
`HANDOFF-2026-09-19-linux-bwrap-network-profiles.md` tie this source to the Linux
AI Cloud deployment. The handoff's designated 2026-09-20 acceptance artifact has
a matching Paperclip workspace copy. That is historical evidence, separate from
the fresh package verification recorded in the 2026-10-28 task report.

## Replacement scope

Restored the fixed Gate A origins, the original manifest and plugin configuration
normalization, and original policy/proxy/environment fixtures. Removed
`public-policy.test.ts`, which asserted the superseded public-only
`gateAOrigins` contract. Its history remains in the original public commit.
The original parser also predates the publication-specific wildcard and
same-authority protocol-conflict rejection; those additions are not represented
as part of the AI Cloud source.

`runSandboxed()`, proxy, namespace init and environment implementation already
matched this source in the public baseline. Their contents are unchanged by
this restoration. No missing source was invented.

Retained the standalone package scripts, TypeScript configuration, lockfile,
compiled exports, and vendored SDK/shared sources so this extracted package can
build without its parent monorepo. These packaging files are intentionally not
byte-identical to the monorepo package. The vendored versions remain SDK 1.0.0
and shared 0.3.1 from the previously inspected installation.

The separate standalone CLI prototype and the independently developed remote
provider are outside this replacement. No service deployment, restart, or
managed acceptance rerun is implied.
