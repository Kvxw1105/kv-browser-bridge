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
10. Public identity and MCP status outputs never contain bearer tokens, Named Pipe endpoints, or private discovery paths.
11. A failed identity selection never falls back silently to the default Chrome Bridge or another identity.

## Implemented milestone

The active implementation lives under `apps/chrome-bridge/src/identity` and shares the existing Bridge build, installation, and test boundary. It provides:

- Versioned identity manifests, health checks, proxy-binding policy, locks, receipts, and runtime status.
- Dedicated profile launch, exclusive identity locks, stale-lock recovery, ownership-safe stop, and crash/startup-failure records.
- Loopback-only ephemeral DevTools launch arguments and `DevToolsActivePort` discovery.
- Stable identity metadata injected through the browser process environment rather than command-line arguments.
- Active Native Host and extension identity handshake enforcement.
- Private per-identity Bridge discovery and a separate token-free public session registry.
- MCP tools to list, select, inspect, and clear identities.
- Fail-closed selected-route guards on every later browser operation.
- Route reset logic that prevents an old Bridge socket from reconnecting during identity switches.
- A Windows-oriented doctor and acceptance report command.
- Cross-platform lifecycle, handshake, registry, routing, privacy-redaction, and diagnostics regression tests.

## Installed commands

After building or installing the local Chrome Bridge package:

```powershell
kv-browser-identity check C:\path\identity-manifest.json
kv-browser-identity plan C:\path\identity-manifest.json
kv-browser-identity start C:\path\identity-manifest.json
kv-browser-identity status C:\path\identity-manifest.json
kv-browser-identity doctor C:\path\identity-manifest.json
kv-browser-identity acceptance C:\path\identity-manifest.json
kv-browser-identity stop C:\path\identity-manifest.json
```

Repository development equivalents:

```powershell
npm ci
npm run test
npm run check
npm run package
node apps/chrome-bridge/dist/identity-cli.js doctor C:\path\identity-manifest.json
```

A Windows template is available at `docs/examples/identity-manifest.windows.example.json`.

## Runtime and discovery state

By default, runtime state is stored under `%LOCALAPPDATA%\KvBrowserBridge\identities`. Set `KV_IDENTITY_RUNTIME_DIR` to use an explicit root during development or tests.

```text
<runtime-root>/<identityId>/runtime/session.lock.json
<runtime-root>/<identityId>/runtime/session-receipt.json
<runtime-root>/<identityId>/runtime/stale-locks/*.json
%LOCALAPPDATA%/KvBrowserBridge/identities/<identityId>/bridge.json
%LOCALAPPDATA%/KvBrowserBridge/sessions/<identityId>.json
<userDataDir>/DevToolsActivePort
```

The lock is the concurrency authority. The receipt is the audit and recovery record. The private `bridge.json` contains the Named Pipe endpoint and bearer token. The public session file contains identity metadata, PID, protocol version, and start time only. `DevToolsActivePort` is read locally to report the selected ephemeral loopback debugging endpoint.

## Identity handshake and routing

The dedicated browser process receives:

```text
KV_BROWSER_IDENTITY_ID
KV_BROWSER_WORKSPACE_ID
KV_BROWSER_PLATFORM
KV_BROWSER_RUNTIME_SESSION_ID
```

The Native Host sends `bridge:ready` with its expected identity. The extension replies with `extension:hello`, including the extension ID, version, user agent, and matching identity fields. Until this acknowledgement succeeds, an identity Bridge does not publish a public session and rejects browser requests.

MCP exposes:

```text
browser_identity_sessions
browser_select_identity
browser_selected_identity
browser_clear_identity
```

Selecting an identity resolves its private discovery file, resets the old route without reconnecting it, authenticates to the new Bridge, and verifies the Bridge identity plus extension handshake. All later browser tools recheck the selected identity and fail closed on mismatch or disconnect.

## Windows acceptance procedure

1. Copy `docs/examples/identity-manifest.windows.example.json` and replace the account, profile, Chrome, and proxy fields.
2. Run `kv-browser-identity check` and `plan`; resolve every error before launch.
3. Run `start`, then complete the initial Chrome extension installation/login when required.
4. Run `doctor`. It checks the configured Chrome path, standard Chrome locations, profile writability, runtime ownership state, private Bridge discovery, public handshake registry, and `DevToolsActivePort`.
5. Run `acceptance`. It writes `identity-acceptance-report.json` beside the manifest and exits nonzero until the runtime, handshake registry, and diagnostics are ready.
6. From MCP, call `browser_identity_sessions`, select the exact identity, then verify `browser_selected_identity` before any write action.
7. Run `stop` and confirm the lock, public session record, and Bridge process are cleared.

## Verification evidence

- Ten lifecycle tests previously passed in an isolated local harness.
- Repository tests cover identity environment validation, private/public discovery separation, exact extension acknowledgement, malformed identities, path traversal, stale sessions, route mismatch, incomplete handshake, and output redaction.
- Diagnostics tests cover standard Chrome candidate discovery, valid `DevToolsActivePort` parsing, stopped-state reporting, and the complete ready-state evidence set.
- GitHub Actions runs the repository release-check on Windows: `npm ci`, tests, type/build checks, extension packaging, and npm package validation.

## External acceptance still required

The repository can produce a deterministic Windows acceptance report, but the following cannot be truthfully certified without running on the user's actual Windows account and network:

- Real Chrome extension and Native Messaging handshake for each installed profile.
- Multiple simultaneous logged-in identities and long-term login retention.
- Real proxy egress, DNS, WebRTC, IPv6, browser-version, and locale consistency probes.
- Platform-specific account acceptance and operational limits.
- Authenticated proxy support, pending the native credential adapter.

## Next major product layer

- Add active egress, DNS, WebRTC, IPv6, locale, and browser-version preflight adapters to the doctor report.
- Add the native proxy credential adapter.
- Build the browser management console for workspace/account mapping, launch, selection, diagnostics, and task routing.
