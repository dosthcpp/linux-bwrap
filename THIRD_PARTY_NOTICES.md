# Third-party notices

The provider and vendored `@paperclipai/plugin-sdk` / `@paperclipai/shared` sources derive from the parent Paperclip project. The original notice is preserved verbatim in [LICENSE](LICENSE), [vendor/plugin-sdk/LICENSE](vendor/plugin-sdk/LICENSE), and [vendor/shared/LICENSE](vendor/shared/LICENSE): Copyright (c) 2025 Paperclip AI, MIT License.

The vendored package versions are SDK 1.0.0 and shared 0.3.1 from the inspected installation. They contain the host environment-driver interfaces used by this snapshot. They are not replacements for a complete Paperclip host. Upstream project reference: https://github.com/paperclipai/paperclip.

Registry dependencies, including Zod, TypeScript, Vitest, Node.js type declarations, and React type declarations, are resolved by the committed pnpm lockfile and retain their own licenses. Their installed code is not committed here. Bubblewrap, Node.js, socat, util-linux/setpriv, and curl are separate host prerequisites and are not vendored.
