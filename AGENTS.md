# Repository Guidelines

## Project Structure

This is a native Marlboze LAN camera plugin built on the official Scrypted TypeScript template.

- `src/main.ts`: device provider, creation and restoration.
- `src/device/`: camera interfaces, settings and motion monitoring.
- `src/protocol/`: UDP client, channel ordering, configuration and encryption.
- `src/media/`: media sessions, HEVC parsing and RTP packetization.
- `test/`: synthetic regression tests and the shared source loader.
- `.vscode/`: official deployment tasks and debugger configuration.

Keep responsibilities within these modules. Do not edit generated `out/`, `dist/` or `node_modules/` files.

## Build & Validation

Run from this directory:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

The official SDK uses Rollup to generate `out/plugin.zip`; the `prepublishOnly` script generates the production package under `dist/`. Preserve the template scripts and TypeScript configuration. Keep npm and pnpm lockfiles consistent when changing dependencies.

Retain the executable-symlink setting in `pnpm-workspace.yaml`; do not replace SDK commands with custom wrappers or rewrite SDK sources. Do not add a direct TypeScript dependency solely for testing: the shared loader uses the SDK's compiler dependency.

## Coding Conventions

Use strict TypeScript, four-space indentation, semicolons, single quotes and descriptive camelCase names. Prefer Node.js standard libraries and existing SDK APIs. Keep byte order, packet framing and protocol assumptions explicit. Avoid unrelated refactoring or unnecessary abstractions.

## Testing

Use Node's built-in `node:test` and `node:assert/strict` in descriptive `*.test.ts` files. Run an individual test with:

```sh
node --experimental-strip-types --test test/r1-receive-gap.test.ts
```

Preserve existing behavior assertions when changing test access points. Use synthetic credentials, payloads and network substitutes. Tests must not require a camera. Run tests and build after code changes; distinguish synthetic validation from real-device verification.

## Lifecycle & Security

Local channel 4 command `0xf004` triggers motion. Each alarm extends the configurable reset deadline, defaulting to 30 seconds. Keep alarm monitoring independent of video viewers. Cancel connections and timers on release, and prevent stale callbacks from restarting stopped sessions.

Never commit or log credentials, tokens, private responses or captured media. Preserve user-maintained ignore rules; keep tests and internal guidance excluded from npm packages. Deploy, publish or connect to devices only when explicitly requested.

## Change Review

Use concise imperative commit subjects. Describe behavior changes, validation and remaining protocol assumptions. Keep README commands and configuration examples consistent with the implementation.
