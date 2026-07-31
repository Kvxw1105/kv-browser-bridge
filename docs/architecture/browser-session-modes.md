# Browser Session Modes

## Scope

The browser bridge supports two session modes. Existing attached-browser users
continue to use the legacy mode; the Desktop Identity Console only creates and
supervises managed-identity sessions.

## Attached session

An attached session connects to an already running, user-owned Chrome instance.
The bridge has no ownership of its process, profile, lock, or restart lifecycle.
The bridge may report connection and extension readiness, but it must not stop
the attached browser as a consequence of an identity network assessment.

## Managed-identity session

A managed session owns one Chrome process and one dedicated `user-data-dir` for
one stable `identityId`. The process receives one `runtimeSessionId` at launch.
The managed lifecycle is:

`proxy preflight -> process start -> DevTools -> private Bridge discovery -> extension handshake -> ready`

Stopping or restarting one managed identity must not mutate another identity's
process, lock, receipt, profile, discovery record, or selected MCP route.

## State model

### Process State

The process state is owned by `IdentityRuntime` and is derived from its lock and
receipt: `not-started`, `starting`, `running`, `stopped`, `failed`, or
`crashed`. A PID is public only while `alive=true`.

### Bridge Readiness

Bridge readiness requires the private identity discovery record, a live bridge
process, native channel readiness, and an extension hello whose identity fields
match `identityId`, workspace/platform, and `runtimeSessionId`.

### Network Assessment

Network assessment is an observation result, not a lifecycle state. It reports
public egress, DNS, WebRTC, and IPv6 observations with `pass`, `fail`, or
`unverified` statuses. The enforcement policy decides what those observations
mean for a managed session.

### Effective Session State

The Supervisor composes Process State, Bridge Readiness, and Network Assessment
into one snapshot. A session is `ready` only when process and bridge readiness
pass and enforcement has not returned a hard action. `warning`, `unverified`,
`frozen`, and `stopped` remain distinct states; they must not be collapsed into
one renderer boolean.
