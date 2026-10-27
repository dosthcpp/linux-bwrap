# Linux Bubblewrap provider for Paperclip

An MIT-licensed source snapshot of `@paperclipai/plugin-linux-bwrap` for Linux Paperclip agent workers. It combines a Bubblewrap mount/network namespace with an exact HTTP(S) egress proxy, a workspace boundary, private runtime sockets, timeouts, and bounded output capture.

The publication baseline was rebuilt from a preserved source snapshot with TypeScript 5.9.3. All nine generated JavaScript modules matched the inspected server installation byte for byte before the publication changes. This repository then replaces deployment-specific Gate A defaults with operator configuration. See [PROVENANCE.md](PROVENANCE.md).

## Build and test

Use Node.js 22.12.0 or later and pnpm 9.15.9. The matching Paperclip SDK and shared sources are included under `vendor/`; no parent monorepo, private registry, or monorepo install scripts are required.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm typecheck
pnpm test
```

`pnpm build` builds the vendored shared package, SDK, and provider. The provider's manifest and worker entrypoints are `dist/manifest.js` and `dist/worker.js`. Package exports also use `dist`. This is a source repository; it does not publish an npm package or install a Paperclip service.

On a non-root Linux account, install the distribution packages providing `/usr/bin/bwrap`, `/usr/bin/socat`, `/usr/bin/setpriv`, `/usr/bin/node`, and `/usr/bin/curl`. User namespaces and the relevant kernel sandbox facilities must be available. Then run the real confinement tests:

```sh
pnpm test:integration
```

These tests check egress denial, an allowed loopback upstream, namespace capability state, secret/environment isolation, removal of the transient execution specification, and output limits. Linux-only tests skip on macOS. Passing these tests is evidence about the tested environment, not a general sandbox security certification.

## Operator configuration

The Paperclip host owns this configuration. Do not derive it from an untrusted command or task payload. The [example](examples/provider-config.json) uses reserved test domains and paths; replace them with your own approved destinations and an existing absolute workspace directory.

```json
{
  "paperclipOrigin": "https://paperclip.example.test",
  "workspaceRoot": "/srv/paperclip-workspace",
  "gateAOrigins": [
    "http://gate-a.example.test:8020",
    "http://gate-a.example.test:8021"
  ],
  "networkProfile": "gate-a-strict",
  "timeoutMs": 300000
}
```

| Setting | Behavior |
| --- | --- |
| `paperclipOrigin` | Required exact HTTP(S) origin for the Paperclip server. |
| `workspaceRoot` | Required existing absolute directory, resolved through `realpath`. Requested working directories must remain inside it. |
| `gateAOrigins` | Optional array of exact HTTP(S) origins. Defaults to `[]`; no original private destination is built in. Credentials, wildcard hosts, non-root paths, queries, fragments, and non-string entries are rejected. |
| `networkProfile` | Defaults to `gate-a-strict`: permits only the configured Gate A origins and Paperclip origin. `codex-managed` additionally permits `https://chatgpt.com:443`, preserving the inspected installation's profile behavior. It does not add `api.openai.com` or arbitrary internet access. |
| `timeoutMs` | Integer from 1 through 86400000; defaults to 300000. |

The proxy requires exact host and port matches. Plain HTTP requests can use only HTTP entries; HTTPS CONNECT can use only HTTPS entries. It performs upstream DNS resolution on the host. Operators remain responsible for the configured destinations and their DNS. There is no wildcard, CIDR, or generic TCP allowlist.

Configuration rejects HTTP and HTTPS entries sharing the same host and port, including conflicts with the Paperclip origin or the managed profile destination. This avoids ambiguous proxy routing.

Set `PAPERCLIP_BWRAP_RUNTIME_DIR` in the **worker service environment** to an existing absolute directory outside `workspaceRoot`, owned by that worker account with mode `0700`. Keep the path short enough for Unix sockets. The runner creates and removes private per-run directories there. It does not use a fixed deployment path or inherit ambient worker environment values into child commands.

The preserved runner also supports an explicit provider-owned callback bridge socket. This repository includes the local runner side only; configuring a remote helper, SSH transport, or Paperclip callback bridge host is outside this source snapshot.

## Scope and license

Included: local provider TypeScript, tests, manifest, configuration example, standalone build files, lockfile, matching SDK/shared sources, and the parent project's unmodified MIT notice. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Excluded: live worker configuration, remote runtime helpers, deployment/service/SSH/nginx configuration, credentials, environment files, logs, evidence, backups, databases, sockets, original Git history, installed dependencies, and generated build output. No operational migration or service restart is performed by these sources. Review and integrate the built plugin with a compatible Paperclip host; this repository does not include that host.
