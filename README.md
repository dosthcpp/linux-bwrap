# AI Cloud Linux Bubblewrap provider for Paperclip

This repository uses the preserved AI Cloud Linux provider source as its canonical
baseline, restored on 2026-10-28 at the owner's direction. Its 14 source and test
files come from the release-parity working copy last edited on 2026-09-20.
See [PROVENANCE.md](PROVENANCE.md) for source identity and replacement scope.
The Paperclip MIT notices remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The provider runs Linux commands inside Bubblewrap mount, PID, user, and network
namespaces. A host-side proxy controls HTTP(S) egress. The child receives a
loopback proxy and cannot route direct sockets out of its network namespace.

## Build and test

Use Node.js 22.12.0 or later and pnpm 9.15.9. The matching Paperclip SDK and shared
sources are included under `vendor/`; the standalone build does not require the
original parent monorepo.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm typecheck
pnpm test
```

The plugin entrypoints are `dist/manifest.js` and `dist/worker.js`. Package exports
use `dist`. On a non-root Linux account, install the packages providing
`/usr/bin/bwrap`, `/usr/bin/node`, `/usr/bin/socat`, `/usr/bin/setpriv`, and
`/usr/bin/curl`, with user namespaces available, then run:

```sh
pnpm test:integration
```

The integration tests exercise `runSandboxed()` with an allowed loopback
upstream, blocked egress, capability and NoNewPrivs checks, child environment and
worker-secret isolation, transient specification removal, and output limits.
Linux-only tests skip on macOS.

## AI Cloud configuration

The provider preserves the AI Cloud source's fixed network profiles:

| Profile | Permitted destinations |
| --- | --- |
| `gate-a-strict` (default) | `http://192.168.1.6:8020`, `http://192.168.1.6:8021`, and the configured `paperclipOrigin` |
| `codex-managed` | The strict profile plus `https://chatgpt.com:443` |

The former public snapshot's configurable `gateAOrigins` field is no longer part
of the manifest or policy. The restored parser ignores that field; it does not
override or remove the two fixed AI Cloud destinations. Existing configurations
must account for this behavior change.

Set `workspaceRoot` to an existing absolute directory and `paperclipOrigin` to an
HTTP(S) origin without credentials, a path, query, or fragment. `timeoutMs`
defaults to 300000 and must be between 1 and 86400000. The
[example](examples/provider-config.json) shows these fields; its Paperclip origin
and workspace path are placeholders.

Set `PAPERCLIP_BWRAP_RUNTIME_DIR` in the worker service environment to an existing
worker-owned, mode-0700 directory outside `workspaceRoot`. Keep its path short
enough for Unix sockets. Per-run command/environment data is delivered through
an anonymous pipe and removed before the child starts. The Bubblewrap process
receives a fixed minimal environment. The runner also supports an explicit
provider-owned callback bridge socket.

This is the local provider package with independent build support. Remote
providers, service configuration, live credentials, and operational deployment
are separate. Successful package tests do not establish live Paperclip managed
acceptance or constitute a security audit.
