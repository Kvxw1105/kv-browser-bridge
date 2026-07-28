# Network Isolation Acceptance V1

This acceptance plan verifies that one browser identity is bound to one observed network egress and fails closed when the binding becomes unsafe.

## Security objective

For every configured identity:

1. its Chrome profile and runtime session are unique;
2. its assigned proxy endpoint is reachable before Chrome starts;
3. the public IP is observed from inside that exact Chrome runtime;
4. the observation belongs to the current `runtimeSessionId`;
5. the public IP does not drift from the identity baseline;
6. no other recent identity uses the same public IP;
7. unsafe identities are stopped and frozen;
8. baseline reset is explicit, offline, and archived.

This reduces accidental shared-network exposure and account crossover. It does not guarantee acceptance by any platform and does not spoof device fingerprints or bypass platform rules.

## Automated acceptance

Run from repository root on Windows PowerShell:

```powershell
npm ci
npm run test:local-chrome
npm run check:local-chrome
npm run package
```

Expected result: every command exits with code 0.

## Identity-level acceptance

For each manifest:

```powershell
node apps/chrome-bridge/dist/identity-cli.js check .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js proxy-check .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js start .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js network-status .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js doctor .\identities\account-a.json
```

Pass conditions:

- `check.healthy` is true;
- proxy preflight reports `ok: true`;
- start reports `ok: true` and a non-empty `runtimeSessionId`;
- network status is `verified`;
- network record `runtimeSessionId` equals the running Bridge identity session;
- doctor reports the browser runtime ready.

## Collision test

Configure identity A and identity B to resolve through the same actual public IP, even if their local Clash ports are different.

Start A, then start B.

Expected result:

- B start fails closed;
- B browser is stopped;
- A and B network records are both `frozen`;
- both records include `NETWORK_IDENTITY_COLLISION`;
- each record names the other identity in `collisionWith`.

## Drift test

1. Start identity A and establish its baseline.
2. Stop A.
3. Change the Clash route behind A to a different public IP.
4. Start A again.

Expected result:

- start fails closed;
- browser is stopped;
- network record is `frozen`;
- reasons include `NETWORK_EGRESS_DRIFT`.

## Stale-session test

1. Start A and verify its network.
2. Stop A.
3. Start A again with a new runtime session.
4. Before the new observation is written, attempt an Agent browser operation.

Expected result: the MCP operational guard rejects the operation with `NETWORK_IDENTITY_STALE` or `NETWORK_IDENTITY_UNVERIFIED`.

## Reset test

While A is running:

```powershell
node apps/chrome-bridge/dist/identity-cli.js network-reset .\identities\account-a.json --confirm
```

Expected result: reset is refused.

After A is stopped, run the command again.

Expected result:

- the current baseline is moved into `network/history`;
- no history file is overwritten;
- the next start establishes a new baseline.

## Manual network-leak acceptance

The following remain mandatory before production use but are not yet automatic release gates:

- DNS resolver observation through the assigned route;
- WebRTC host/server-reflexive candidate inspection;
- IPv6 egress observation and fail-closed handling;
- authenticated proxy support where credentials must not appear in Chrome arguments;
- real Clash/Mihomo multi-inbound mapping;
- real Windows Chrome extension and Native Host handshake;
- real platform login and normal-use acceptance.

Record each manual result with identity ID, runtime session ID, timestamp, public IP, DNS resolver result, WebRTC result, IPv6 result, and the exact Clash route used.
