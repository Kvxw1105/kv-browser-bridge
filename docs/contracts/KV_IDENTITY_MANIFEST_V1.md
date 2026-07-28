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
9. A Bridge may claim an identity only when the browser process environment, Native Host expectation, and extension acknowledgement match exactly.
10. Public identity session records never contain Named Pipe endpoints or bearer tokens.

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
- Stable identity metadata injected into the dedicated browser process environment.
- Native extension identity handshake contracts and exact-match validation helpers.
- Per-identity private discovery paths and privacy-safe public session records.
- MCP-side registry helpers that list identities without exposing Bridge credentials.
- CLI commands for `check`, `plan`, `start`, `stop`, and `status`.
- Regression tests integrated into the existing local Chrome test suites.

## Commands

```powershell
npm run build -w apps/chrome-bridge
npm run build -w packages/browser-protocol
npm run build -w apps/codex-mcp-server
node --test apps/chrome-bridge/test/identity-runtime.test.mjs
node --test apps/chrome-bridge/test/identity-handshake.test.mjs
node --test apps/codex-mcp-server/test/identity-registry.test.mjs
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
%LOCALAPPDATA%/KvBrowserBridge/identities/<identityId>/bridge.json
%LOCALAPPDATA%/KvBrowserBridge/sessions/<identityId>.json
```

The lock is the concurrency authority. The receipt is the audit and recovery record. A live process is stopped only when both records identify the same PID and lock ID.

The private `bridge.json` contains the Named Pipe endpoint and bearer token. The public session file contains only identity metadata, PID, protocol version, and start time. Control-console and MCP list operations must read the public record and resolve the private discovery file only after an exact identity selection.

## Identity handshake

The dedicated browser process receives these environment variables:

```text
KV_BROWSER_IDENTITY_ID
KV_BROWSER_WORKSPACE_ID
KV_BROWSER_PLATFORM
KV_BROWSER_RUNTIME_SESSION_ID
```

The Native Host sends a `bridge:ready` message carrying its expected identity. The extension replies with `extension:hello`, including the extension ID, extension version, browser user agent, and the same identity fields. Any mismatch must leave the Bridge unavailable for browser requests.

The extension-side acknowledgement and protocol contracts are implemented. The remaining integration step is to make the active `ChromeBridge` process enforce this validation and publish the private/public discovery records.

## Verification completed in development sessions

- TypeScript compilation of the lifecycle identity module using the repository compiler mode.
- Ten focused lifecycle tests passed in an isolated local harness.
- Lifecycle tests cover valid and conflicting environments, credential non-disclosure, loopback DevTools arguments, concurrent-start blocking, stale-lock archival, failed-start cleanup, ownership-safe stop, and a real detached-process start/stop cycle on Linux.
- Identity handshake and registry regression tests have been added to repository test wildcards.
- Protocol guards reject malformed identities, path traversal, mismatched extension acknowledgements, corrupt public session files, missing private discovery, and stopped processes.

## External acceptance still required

- Repository-wide install, full build, and CI on the latest branch commit.
- Active `ChromeBridge` integration with identity-specific discovery and exact extension acknowledgement enforcement.
- Real Windows Chrome process launch and shutdown.
- Confirmation that Chrome writes and exposes the selected ephemeral DevTools endpoint.
- Multiple simultaneous identities using different `userDataDir` values.
- Real proxy egress, DNS, WebRTC, and IPv6 probes.
- Real account login retention and platform acceptance observation.

## Next slice

- Integrate `bridgeIdentityFromEnv`, identity-specific discovery paths, and `validateExtensionIdentityHello` into the active Bridge process.
- Add MCP tools for `browser_identity_sessions`, `browser_select_identity`, and selected-identity status.
- Maintain one `BridgeClient` per selected identity discovery file and close old clients safely on selection changes.
- Discover the ephemeral DevTools endpoint from the profile directory.
- Add the native proxy credential adapter.
- Add proxy egress, DNS, WebRTC, IPv6, browser-version, and locale preflight adapters.
- Build the control-console account and workspace mapping.
