# KV_IDENTITY_MANIFEST_V1

## Purpose

Bind one platform account to one durable browser storage directory, one network route, and one internally consistent regional environment. The contract is designed to reduce accidental account crossover and unstable device changes. It does not promise immunity from platform enforcement and must not be used to bypass access controls or platform rules.

## Invariants

1. `identityId` is immutable after the account begins use.
2. One identity owns one `userDataDir`; directories are never shared concurrently.
3. Proxy country, timezone, and locale must agree.
4. Concurrent sessions are blocked by default.
5. Proxy credentials are referenced through environment variables and are never stored in the manifest.
6. Existing identities evolve through recorded migrations; whole-device parameters are not randomly refreshed.
7. `native-stable` uses the actual browser and host environment. `managed-consistent` requires a separately reviewed browser adapter and is not implemented by the core runtime.

## Current vertical slice

The `apps/identity-runtime` package provides:

- TypeScript manifest and proxy-binding contracts.
- Deterministic health checks for identity, region, DNS, WebRTC, and concurrency policy consistency.
- Atomic manifest persistence.
- A launch-plan generator for dedicated browser data directories and proxy routing.
- A CLI with `check` and `plan` commands.
- Unit tests for accepted and blocked configurations.

## Commands

```powershell
npm run test:identity
npm run check:identity
node apps/identity-runtime/dist/cli.js check C:\path\identity-manifest.json
node apps/identity-runtime/dist/cli.js plan C:\path\identity-manifest.json
```

`plan` does not start a browser. It returns a reviewable launch plan and exits nonzero when required secrets, browser paths, or identity invariants are missing.

## Planned next slice

- Exclusive identity lock and stale-lock recovery.
- Windows Chrome launcher with process receipt and clean shutdown tracking.
- Extension handshake carrying `identityId` without exposing proxy secrets.
- Runtime API for list, create, check, start, stop, and status.
- Proxy egress, DNS, WebRTC, and browser-version preflight adapters.
- Control-console account and workspace mapping.
- Real Windows, Chrome, and proxy acceptance tests.
