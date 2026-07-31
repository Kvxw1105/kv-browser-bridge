# Network Isolation Acceptance V1

This document defines real-network qualification for managed identities. It
does not redefine the already-accepted managed session lifecycle in PR #10.

## Accepted baseline

The following are implemented and covered by the Managed Multi-Identity Alpha
acceptance:

- two independent managed Chrome profiles can run concurrently;
- each runtime has its own lock, receipt, `runtimeSessionId`, Bridge discovery,
  and Extension identity handshake;
- MCP identity selection routes browser actions to the selected session;
- stopping A preserves B, and restarting A preserves its Profile while issuing
  a new runtime session;
- managed Profile Extension provisioning, Native Host installation, and the
  identity-bound handshake are complete.

Real-network qualification starts after those lifecycle checks pass.

## Policy contract

Network probes observe and compare evidence. `network-enforcement.ts` is the
policy decision point for managed-session actions. Probe failure must not stop
an Attached Mode browser, and probe modules must not apply lifecycle actions
directly.

### Observe Mode

Observe is the default managed-session policy:

- duplicate proxy endpoints are allowed;
- duplicate public egress is allowed and may produce `WARNING`;
- missing DNS evidence is `UNVERIFIED` and does not stop a session;
- `host:mdns` and `mdns` are not real WebRTC IP leaks;
- public-egress drift is a warning;
- observed IPv6 is a warning unless Strict policy is enabled;
- Process State, Bridge Readiness, Network Assessment, and Effective Session
  State remain separate in output;
- the browser and Bridge remain running after an observation warning.

Observe output for each identity must include proxy preflight, observed public
IP, baseline comparison, DNS status/resolvers, normalized WebRTC observations,
IPv6 status, warnings, process state, and Bridge readiness.

### Strict Mode

Strict must be explicitly enabled by the caller. It may apply a hard action only
for configured failures:

- an explicit expected public-egress mismatch may stop or freeze the session;
- a real IPv6 observation while IPv6 is disabled may stop or freeze the session;
- a real WebRTC IP outside the configured allow-list is a hard failure;
- DNS absence remains `UNVERIFIED` and is never a hard failure by itself;
- an unexpected DNS resolver is recorded as `DNS_ROUTE_MISMATCH`; stopping is
  decided by the explicit Strict policy, not by the probe module;
- public-egress uniqueness is a hard requirement only when explicitly enabled.

The hard action must clean the matching lock, receipt, public registry record,
and private Bridge discovery without changing another identity.

## Real environment preparation

Use the ignored directory `local/e2e-real-network-qualification` for all
qualification artifacts. Record only redacted metadata:

- Clash/Mihomo implementation and version;
- a redacted local configuration identifier, not the file contents;
- each real listening inbound's protocol, host, and port;
- the expected outbound label for each inbound;
- whether authentication is configured;
- Chrome and KV Extension versions.

Never record proxy usernames/passwords, subscription URLs, bearer tokens,
cookies, account data, complete Clash configuration, or complete Profile
contents/paths.

If only one real inbound exists, run the single-inbound Observe matrix and set
the distinct-outbound result to `EXTERNAL_ENVIRONMENT_PENDING`. Do not invent a
second inbound, outbound, public IP, DNS result, or account.

## Single-inbound Observe acceptance

For each real identity:

1. run proxy preflight;
2. start the managed session and wait for Bridge readiness;
3. record browser-observed public IP against the current `runtimeSessionId`;
4. run the configured HTTPS DNS, IPv6, and WebRTC probes;
5. record the composite Process/Bridge/Network snapshot;
6. keep the session running for warnings and `UNVERIFIED` observations;
7. stop it and verify only its own runtime artifacts are removed.

Pass conditions:

- the public-IP observation belongs to the current runtime session;
- DNS absence is `UNVERIFIED`, not a stop;
- mDNS-only WebRTC is `PASS` or `INFO`;
- duplicate proxy endpoint or public IP is a warning only;
- no other managed identity is stopped or modified.

## Dual-inbound qualification

When two real stable outbounds are available, configure A and B with their
respective inbounds and run at least three complete rounds:

`Start A -> Bridge ready -> public IP -> DNS/IPv6/WebRTC -> Start B -> Bridge ready -> public IP -> DNS/IPv6/WebRTC`

Verify in every round:

- A and B have distinct `runtimeSessionId` values;
- Browser and Bridge sessions never cross-route;
- each observation is tied to its own current runtime session;
- Stop A leaves B usable;
- Restart A issues a new session ID and retains A's Profile;
- changing A's route does not change B;
- restarting Clash/Mihomo and repeating the matrix does not reuse stale
  `verified` state for a new runtime session;
- KV starts and operates without depending on a Clash/Mihomo private API.

If product policy requires distinct public egress, explicitly enable
`uniquePublicEgress=true`; otherwise record equal egress as a warning.

## Strict acceptance matrix

Run these cases only with an explicit Strict policy:

| Case | Expected result |
| --- | --- |
| expected public IP matches | `PASS`; session remains running |
| expected public IP mismatches | `PUBLIC_EGRESS_MISMATCH`; configured hard action; own artifacts cleaned |
| IPv6 disabled, no IPv6 observed | `PASS` |
| IPv6 disabled, real IPv6 observed | `IPV6_LEAK_DETECTED`; configured hard action |
| WebRTC has only `host:mdns`/`mdns` | no leak failure |
| WebRTC has real unallowed IP | `WEBRTC_LEAK_DETECTED`; configured hard action |
| DNS probe has no resolver evidence | `DNS_UNVERIFIED`; session is not stopped for that reason |
| DNS probe returns unexpected resolver | `DNS_ROUTE_MISMATCH`; action comes from Strict policy |

## Authenticated proxy boundary

If a real authenticated proxy is available, verify that credentials never enter
Chrome arguments, logs, receipts, or reports, and that invalid credentials
produce a structured failure through the Native Credential Adapter.

Without real credentials, record:

`AUTHENTICATED_PROXY_ACCEPTANCE=PENDING_EXTERNAL_CREDENTIAL`

This does not block qualification of an unauthenticated Clash/Mihomo inbound.

## Evidence report

Write only to the ignored directory:

- `local/e2e-real-network-qualification/report.json`
- `local/e2e-real-network-qualification/report.md`

The report must include `schemaVersion`, mode, Chrome/Clash versions, run
count, round timestamps, redacted identity/inbound/outbound identifiers,
runtime session IDs, observed public IPs, DNS/WebRTC/IPv6 statuses and
normalized observations, network assessment, enforcement action, process
continue/stop result, result status (`PASS`, `FAIL`, `UNVERIFIED`, or
`PENDING_EXTERNAL`), and failure reason codes.

It must not contain credentials or page-sensitive data, and all real evidence
must remain Git ignored.

## Code-change boundary

If the qualification passes, produce local evidence only and do not change
runtime code. Do not weaken probes or fill missing evidence with fabricated
values.

If a reproducible runtime defect is found, record the minimal reproduction,
create `fix/real-network-qualification-v01` from the PR #10 HEAD, and use a
new Draft stacked PR. Do not expand PR #10 after the acceptance-contract
documentation commit.

## Completion states

`ACHIEVED` requires the Observe/Strict contract, at least one real-inbound
Observe run, correct session binding, separate DNS/WebRTC/IPv6 results,
mDNS-only acceptance, DNS-unverified non-stopping behavior, Strict hard-action
behavior, isolated Stop/Restart behavior, a redacted ignored report, and no
fabricated network results.

The following may remain `PENDING_EXTERNAL` without being a code blocker:

- no second real proxy inbound or no two distinct stable outbounds;
- no authenticated proxy credentials;
- DNS service cannot provide resolver evidence;
- real platform account acceptance has not been manually performed.
