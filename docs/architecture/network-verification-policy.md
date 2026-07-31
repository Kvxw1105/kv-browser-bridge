# Network Verification Policy

## Separation

`browser-leak-probe.ts` and `network-leak-report.ts` observe and compare data.
They do not stop, freeze, or restart a browser. `network-enforcement.ts` is the
only policy decision point for managed-session lifecycle actions.

## Default policy

Managed sessions default to `mode=observe`:

- duplicate proxy endpoints are allowed;
- duplicate public egress is allowed and may produce a warning;
- missing DNS evidence is `unverified` and does not stop a session;
- mDNS-only WebRTC candidates are not a real IP leak;
- strict automatic stopping is disabled.

## Strict policy

`mode=strict` is opt-in per supervisor configuration. It may stop a managed
session only for an explicit public-egress mismatch or an observed IPv6 address
when IPv6 is disabled. DNS absence remains `unverified`; it is not a hard stop.
WebRTC is hard only when a real IP candidate is observed outside the configured
allowlist. `host:mdns` and `mdns` are privacy-preserving host labels and pass.

## Session effects

The policy returns an action (`allow`, `warn`, `freeze`, or `stop`) plus stable
reason codes. The caller applies the action to a managed session. Attached
sessions never receive lifecycle actions from this policy.
