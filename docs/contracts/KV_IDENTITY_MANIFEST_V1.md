# KV_IDENTITY_MANIFEST_V1

## Purpose

Bind one platform account to one durable browser storage directory, one network route, and one internally consistent regional environment. The contract reduces accidental account crossover and unstable device changes. It does not promise immunity from platform enforcement and must not be used to bypass access controls or platform rules.

## Invariants

1. `identityId` is immutable after the account begins use.
2. One identity owns one `userDataDir`; directories are never shared concurrently.
3. Proxy country, timezone, and locale must agree.
4. Concurrent sessions are blocked by default.
5. Proxy credentials are never placed in browser command-line arguments or stored in the manifest.
6. Authenticated proxies require a separately reviewed native credential adapter. The current launcher accepts unauthenticated or IP-allowlisted proxies only.
7. Existing identities evolve through recorded migrations; whole-device parameters are not randomly refreshed.
8. `native-stable` uses the actual browser and host environment. `managed-consistent` requires a separately reviewed browser adapter and is not implemented by the core runtime.

## Current vertical slice

The active implementation lives under `apps/chrome-bridge/src/identity` so it shares the existing Bridge build, TypeScript, installation, and test boundary. It provides:

- TypeScript manifest, proxy-binding, runtime-lock, receipt, and status contracts.
- Deterministic health checks for identity, region, DNS, WebRTC, IPv6, proxy authentication, and concurrency consistency.
- Atomic manifest and receipt persistence.
- A launch-plan generator for dedicated browser data directories and proxy routing.
- Loopback-only DevTools launch arguments with a random port request.
- Exclusive per-identity lock creation, live-process detection, stale-lock archival, and lock ownership checks.
- Detached browser process start, status, stop, crash detection, and startup-failure receipts.
- Refusal to terminate a live process when the receipt and identity lock do not match.
- CLI commands for `check`, `plan`, `start`, `stop`, and `status`.
- Regression tests integrated into the existing `test:local-chrome` suite.

## Commands

```powershell
npm run build -w apps/chrome-bridge
node --test apps/chrome-bridge/test/identity-runtime.test.mjs
node apps/chrome-bridge/dist/identity-cli.js check C:\path\identity-manifest.json
node apps/chrome-bridge/dist/identity-cli.js plan C:\path\identity-manifest.json
node apps/chrome-bridge/dist/identity-cli.js start C:\path\identity-manifest.json
node apps/chrome-bridge/dist/identity-cli.js status C:\path\identity-manifest.json
node apps/chrome-bridge/dist/identity-cli.js stop C:\path\identity-manifest.json
```

`start` creates the dedicated profile directory, acquires an exclusive lock, launches the configured browser, confirms that the process is alive, promotes the lock to that browser PID, and writes a receipt. `stop` verifies matching lock ownership before terminating a live process.

## Runtime state

By default, runtime state is stored under `%LOCALAPPDATA%\KvBrowserBridge\identities` on Windows. Set `KV_IDENTITY_RUNTIME_DIR` to use an explicit root during development or tests.

Each identity receives:

```text
<root>/<identityId>/runtime/session.lock.json
<root>/<identityId>/runtime/session-receipt.json
<root>/<identityId>/runtime/stale-locks/*.json
```

The lock is the concurrency authority. The receipt is the audit and recovery record. A live process is stopped only when both records identify the same PID and lock ID.

## Verification completed in the development session

- TypeScript compilation of the identity module using the repository compiler mode.
- Ten focused tests passed in an isolated local harness.
- Tests cover valid and conflicting environments, credential non-disclosure, loopback DevTools arguments, concurrent-start blocking, stale-lock archival, failed-start cleanup, ownership-safe stop, and a real detached-process start/stop cycle on Linux.

## External acceptance still required

- Real Windows Chrome process launch and shutdown.
- Confirmation that Chrome writes and exposes the selected ephemeral DevTools endpoint.
- Multiple simultaneous identities using different `userDataDir` values.
- Real proxy egress, DNS, WebRTC, and IPv6 probes.
- Chrome-extension and Native Messaging identity handshake.
- Real account login retention and platform acceptance observation.

## Next slice

- Windows Chrome discovery and DevTools endpoint discovery from the profile directory.
- Extension handshake carrying `identityId`, PID, and session token without exposing proxy secrets.
- Native proxy credential adapter.
- Runtime API and MCP tools for list, create, check, start, stop, and status.
- Proxy egress, DNS, WebRTC, IPv6, browser-version, and locale preflight adapters.
- Control-console account and workspace mapping.
