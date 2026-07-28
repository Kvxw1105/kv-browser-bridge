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
7. WebRTC is restricted to `disable_non_proxied_udp` by the extension bootstrap;
8. browser-side DNS, WebRTC, and IPv6 evidence is collected and evaluated;
9. unsafe or unverified identities are stopped and frozen;
10. baseline reset is explicit, offline, and archived.

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

For two or more real identities, run the full acceptance script:

```powershell
.\scripts\accept-network-isolation.ps1 `
  -Manifest .\identities\account-a.json, .\identities\account-b.json `
  -StopAfter
```

The script builds and tests the runtime, validates each manifest, checks each proxy, launches each identity, verifies public egress, runs DNS/WebRTC/IPv6 acceptance, checks cross-identity public-IP uniqueness, writes `network-isolation-acceptance.json`, and stops identities on failure.

## Required manifest verification settings

A strict identity should include:

```json
{
  "policies": {
    "webrtc": "proxy-only",
    "dns": "proxy",
    "ipv6": "disabled",
    "allowConcurrentSessions": false
  },
  "networkVerification": {
    "publicIpProbeUrl": "https://api.ipify.org?format=json",
    "ipv6ProbeUrl": "https://api6.ipify.org?format=json",
    "dnsProbeUrl": "https://YOUR-DNS-PROBE.example/result",
    "expectedDnsResolvers": ["YOUR_EXPECTED_DNS_RESOLVER_IP"],
    "allowedWebrtcCandidates": [],
    "timeoutMs": 20000
  }
}
```

Probe URLs must use HTTPS. A DNS probe service must return either an array of resolver IPs, an object shaped as `{ "dnsResolvers": [...] }`, or comma/newline-separated resolver IPs. Missing evidence remains `unverified` and fails closed.

## Identity-level acceptance

For each manifest:

```powershell
node apps/chrome-bridge/dist/identity-cli.js check .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js proxy-check .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js start .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js network-leak-check .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js network-status .\identities\account-a.json
node apps/chrome-bridge/dist/identity-cli.js doctor .\identities\account-a.json
```

Pass conditions:

- `check.healthy` is true;
- proxy preflight reports `ok: true`;
- start reports `ok: true` and a non-empty `runtimeSessionId`;
- network status is `verified`;
- network record `runtimeSessionId` equals the running Bridge identity session;
- `network-leak-acceptance.json` has `ready: true`;
- DNS, WebRTC, and IPv6 checks satisfy the manifest contract;
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

## Stale-session and MCP gate test

1. Start A and verify its network.
2. Stop A.
3. Start A again with a new runtime session.
4. Before the new observation is written, attempt an Agent browser operation.

Expected result: the guarded MCP entrypoint rejects the operation with a network guard error. The connection-status diagnostic remains available so the operator can inspect the reason.

## WebRTC protection test

Build and install the extension, then inspect the extension service worker log. It must report the requested policy as `disable_non_proxied_udp`. Run `network-leak-check`; any ICE candidate outside the configured allow-list causes `WEBRTC_LEAK_DETECTED` and stops the identity.

## DNS and IPv6 test

Run `network-leak-check` with configured HTTPS probe URLs.

Expected result:

- resolver IPs outside `expectedDnsResolvers` cause `DNS_ROUTE_MISMATCH`;
- missing DNS evidence causes `DNS_UNVERIFIED`;
- an observed IPv6 address while policy is `disabled` causes `IPV6_LEAK_DETECTED`;
- missing IPv6 evidence while policy is `disabled` causes `IPV6_UNVERIFIED`;
- any failed or unverified mandatory check stops the identity browser.

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

## Remaining real-environment acceptance

The following cannot be proven by repository CI and must be run on the target Windows machine:

- real Clash/Mihomo multi-inbound mapping, with one inbound mapped to one stable outbound;
- verification that every configured inbound produces a distinct public IP;
- extension and Native Host installation in the actual Chrome profiles;
- authenticated proxy support, if the selected provider requires credentials;
- normal platform login and ordinary human use without cross-account session contamination.

Record identity ID, runtime session ID, timestamp, public IP, DNS result, WebRTC result, IPv6 result, Clash inbound, Clash outbound, and test operator for every production acceptance run.
