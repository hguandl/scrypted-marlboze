# Marlboze for Scrypted

Native Marlboze LAN camera input based on the official Scrypted TypeScript
template. It discovers and wakes cameras, decrypts HEVC video, and delivers
HEVC/PCMA over local RFC4571 to Rebroadcast without transcoding. Local channel 4
alarms update MotionSensor; downstream plugins may convert codecs as needed.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

The official SDK's Rollup configuration produces `out/plugin.zip`. No custom
loader, CLI wrapper or SDK source changes are required. Tests use Node's
built-in runner with TypeScript stripping; no test framework or direct
TypeScript dependency is added.

Run one regression with:

```sh
node --experimental-strip-types --test test/r1-receive-gap.test.ts
```

pnpm 12.14.0 was verified. `pnpm-workspace.yaml` enables executable symlinks to
preserve SDK command aliases, and skips the optional `bufferutil` native build
in favor of its JavaScript fallback. Both npm and pnpm lockfiles are retained;
keep them synchronized when changing dependencies.

## Deploy and debug

```sh
pnpm dlx scrypted login NAS_IP:10443
pnpm run scrypted-deploy NAS_IP:10443
```

Use the Scrypted management account. Deployment uses HTTPS on port 10443.
Keep the package name `scrypted-marlboze` and the server's data volume to retain
existing devices. For VS Code debugging, set `scrypted.debugHost` in
`.vscode/settings.json` and launch **Scrypted Debugger**. The original debug
task builds and deploys through the SDK; no container rebuild is needed.

## Camera setup

Add a camera through Marlboze and supply its UID, MAC, decrypted device password,
IPv4 address and stream selector. Stream defaults to `0`; `1` was verified as
the high-resolution stream. Other selectors are passed through to the device.

Enable Rebroadcast and Snapshot, then HomeKit if needed. LAN broadcast wake
in Docker requires a suitable LAN path, typically host networking. Motion
Reset Time defaults to 30 seconds after the last alarm. The independent alarm
connection may keep the camera awake even without a video viewer.

## Layout

- `src/main.ts`: device provider and plugin entry.
- `src/device/`: camera interfaces, settings and motion monitoring.
- `src/protocol/`: device communication, ordering and encryption.
- `src/media/`: media sessions, HEVC parsing and RTP packetization.
- `test/`: one synthetic regression per R1–R7 and a shared source loader.
- `.vscode/`: official template deployment and debugger configuration.

`AGENTS.md` describes contribution rules; `REVIEW.md` tracks review status.
`out/`, `dist/` and `node_modules/` are generated and ignored by Git.
Tests do not connect to cameras and do not replace real-device verification.
Never commit credentials, private responses or captured media.
