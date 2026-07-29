# Kv Browser Bridge Multi-Agent Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Codex, New Max, Claude Code, and other local stdio MCP clients to share one Kv Browser Bridge safely: concurrent reads, globally serialized tab writes, visible client identity, session-scoped target tabs, exclusive task/recorder leases, disconnect recovery, and actionable conflict errors.

**Architecture:** Keep the current Extension -> Native Messaging -> Chrome Bridge -> Named Pipe -> stdio MCP chain. Put the coordinator in `apps/chrome-bridge`, because it is the only process shared by every MCP client. MCP servers identify themselves during Pipe hello; the Bridge owns client sessions, global per-tab command queues, explicit leases, and session target resolution. The Extension remains the only CDP owner and receives a redacted coordination status for its control panel.

**Tech Stack:** TypeScript, Node.js `net`, existing line-delimited Pipe RPC, Chrome MV3 Extension, Node test runner, current npm workspaces. No new production dependency and no database requirement for v1 coordination.

---

## 0. Reality, Base, and Protected State

Observed on 2026-07-30:

- Remote stable: `origin/main@fb857d0`.
- Recorder branch: `origin/codex/recorder-release-gate@93c9e0a`.
- Runtime branch: `origin/feature/runtime-shadow-v04@5669a3f`.
- Runtime worktree: `D:\Projects\kv-browser-bridge-runtime-shadow-v04`.
- Runtime worktree currently has user/parallel changes in:
  - `apps/extension/src/background/browser-executor.ts`
  - `test/release-engineering.test.mjs`
  - `test/fixtures/`
  - `artifacts/`
- Do not stage, restore, delete, move, or overwrite those paths.
- `feature/runtime-shadow-v04` already contains Shadow Runtime, Run/Recipe/Replay, Run Package, Guide output, recorder, and real-browser evidence. Do not create a second Runtime.
- Existing MCP-level `PerTabWriteQueue` is process-local. It does not coordinate different Agent MCP processes.
- Existing Bridge accepts multiple authenticated Pipe sockets but identifies all current MCP processes as `codex-mcp-server`.

### Execution branch

Before implementation, the controller must verify whether the dirty Runtime worktree has been committed by its owner. Then create a new worktree from the latest clean remote Runtime commit:

```powershell
git -C D:\Projects\codex-local-chrome fetch origin
git -C D:\Projects\codex-local-chrome worktree add `
  D:\Projects\kv-browser-bridge-multi-agent-v05 `
  -b feature/multi-agent-coordinator-v05 `
  origin/feature/runtime-shadow-v04
```

Expected: new worktree is clean. If remote Runtime moved beyond `5669a3f`, record the new SHA in `docs/status/CURRENT_STATE.md`; do not reset it back.

### Rollout switch

Use:

```text
KBB_COORDINATOR_MODE=off      # exact legacy behavior
KBB_COORDINATOR_MODE=observe  # identity/status/queues logged; lease conflicts reported but not blocked
KBB_COORDINATOR_MODE=enforce  # task leases and explicit conflict rejection enabled
```

Default remains `off` until real dual-client acceptance passes. Test installation uses `observe` first.

---

## 1. Concurrency Policy

| Operation | Same tab | Different tabs | Explicit task lease |
|---|---|---|---|
| `get_tabs`, `get_url`, `get_text`, `find` | concurrent | concurrent | not required |
| `snapshot`, `screenshot`, DevTools reads | concurrent but bounded | concurrent | not required |
| `navigate`, `click`, `type`, `press`, `select`, `set_files`, `scroll` | Bridge-global serial queue | concurrent | honored when present |
| `switch_tab` | session target update; optional Chrome activation | independent session targets | not required |
| `record_start` -> `record_stop` | one global recorder owner | still globally exclusive | automatic recorder + tab lease |
| final publish/comment/reply/delete/payment | not added in this milestone | not added | future policy layer |

Rules:

1. Reads never wait behind a write lease.
2. A short command queue prevents two writes from executing simultaneously on one tab, even without an explicit lease.
3. An explicit tab lease prevents another client from starting writes on that tab across a multi-step task.
4. Missing `tabId` remains compatible in `off`; in `observe` it emits a warning; in `enforce`, multi-client writes resolve the session target or return `TAB_ID_REQUIRED`.
5. On `UNKNOWN_OUTCOME`, keep the tab in `quarantined` state for 30 seconds. Another client receives `RESOURCE_QUARANTINED` until the owner verifies/releases it or the TTL expires.
6. Socket close releases ordinary leases immediately. Quarantined leases retain their remaining TTL.

---

## 2. Subagent Topology

The controller owns branch creation, task ordering, integration, final tests, commits, push, and real Chrome acceptance. Implementation agents never share a worktree.

### Agent A - Protocol Contract (standard model)

Owns only:

- `packages/browser-protocol/src/coordinator.ts`
- `packages/browser-protocol/src/index.ts`
- `packages/browser-protocol/test/coordinator.test.mjs`

Starts first. No other implementer starts until Agent A's contract passes spec and quality review.

### Agent B - Coordinator Core (standard model)

Owns only:

- `apps/chrome-bridge/src/coordinator.ts`
- `apps/chrome-bridge/test/coordinator.test.mjs`

May start after Agent A contract is frozen. Does not edit `bridge.ts`.

### Agent C - MCP Identity and Session Client (cheap/standard model)

Owns only:

- `apps/codex-mcp-server/src/client-identity.ts`
- `apps/codex-mcp-server/src/bridge-client.ts`
- `apps/codex-mcp-server/test/client-identity.test.mjs`
- `apps/codex-mcp-server/test/bridge-client.test.mjs`

May run in parallel with Agent B after Agent A. Does not register new tools in `server.ts`.

### Agent D - Bridge Integration (strong model)

Owns:

- `apps/chrome-bridge/src/bridge.ts`
- `apps/chrome-bridge/test/bridge-reliability.test.mjs`

Runs after B and C are merged. Integrates the frozen contract and coordinator core.

### Agent E - MCP Tools (cheap/standard model)

Owns:

- `apps/codex-mcp-server/src/server.ts`
- a new `apps/codex-mcp-server/test/coordinator-tools.test.mjs`

Runs after D. Adds tools only; does not modify Bridge internals.

### Agent F - Extension Status UI (frontend-capable standard model)

Owns:

- `apps/extension/src/background/service-worker.ts`
- `apps/extension/src/sidepanel/components/LocalBridgePanel.tsx`
- `apps/extension/src/sidepanel/styles.css`

Starts after D defines the final redacted status message. Does not change browser execution or recorder internals.

### Agent G - Install/Compatibility/Docs (cheap model)

Owns:

- `apps/chrome-bridge/src/install-helpers.ts`
- `apps/chrome-bridge/test/install-helpers.test.mjs`
- `docs/compatibility.md`
- `docs/status/CURRENT_STATE.md`
- `docs/status/DECISIONS.md`
- `docs/status/HANDOFF.md`
- `skills/kv-browser-bridge/SKILL.md`

Starts after tool names and environment keys are frozen.

### Review agents

For every implementation task:

1. Fresh spec reviewer checks only requested behavior and compatibility.
2. After spec approval, fresh quality reviewer checks race conditions, cleanup, types, tests, and accidental scope.
3. Implementer fixes findings; the same reviewer rechecks.
4. Final strong reviewer reviews the complete diff and multi-client state machine.

Do not dispatch multiple implementers against the same worktree. Parallelism is B + C, then E + F + G after their dependencies are merged.

---

## Task 1: Freeze the Transport-Neutral Contract

**Files:**

- Create: `packages/browser-protocol/src/coordinator.ts`
- Modify: `packages/browser-protocol/src/index.ts`
- Test: `packages/browser-protocol/test/coordinator.test.mjs`

- [ ] Add these exact contract types:

```ts
export type CoordinatorMode = 'off' | 'observe' | 'enforce';
export type AgentCapability = 'read' | 'write' | 'record';
export type LeaseResource = `tab:${number}` | 'global:recorder';
export type LeaseState = 'active' | 'quarantined';

export interface AgentIdentity {
  clientId: string;
  clientName: string;
  instanceId: string;
  capabilities: AgentCapability[];
}

export interface AgentSession extends AgentIdentity {
  sessionId: string;
  connectedAt: string;
  lastSeenAt: string;
  defaultTabId?: number;
}

export interface ResourceLease {
  id: string;
  resource: LeaseResource;
  ownerSessionId: string;
  purpose: string;
  state: LeaseState;
  acquiredAt: string;
  expiresAt: string;
}

export interface CoordinationStatus {
  mode: CoordinatorMode;
  clients: AgentSession[];
  leases: ResourceLease[];
}
```

- [ ] Extend `PipeHello` with optional `clientId`, `clientName`, `instanceId`, and `capabilities`. Preserve `client` and legacy `clientName` parsing.
- [ ] Extend `BridgeErrorCode` with `RESOURCE_BUSY`, `RESOURCE_QUARANTINED`, `TAB_ID_REQUIRED`, and `LEASE_NOT_OWNED`.
- [ ] Extend Pipe methods with:

```text
browser_get_clients
browser_lease_acquire
browser_lease_renew
browser_lease_release
browser_lease_status
```

- [ ] Add `coordination:status` as a Pipe event and `bridge:coordination_status` as a Native message carrying only client names/IDs, tab IDs, lease purpose/state/expiry; never include bearer token or Pipe path.
- [ ] Test old hello messages still validate, new identity fields validate, invalid IDs are rejected, and status objects round-trip.
- [ ] Run:

```powershell
npm run build -w packages/browser-protocol
node --test packages/browser-protocol/test/*.test.mjs
```

Expected: all existing and new protocol tests pass.

- [ ] Commit: `feat: define multi-agent coordination protocol`

---

## Task 2: Implement the Pure Coordinator State Machine

**Files:**

- Create: `apps/chrome-bridge/src/coordinator.ts`
- Test: `apps/chrome-bridge/test/coordinator.test.mjs`

Implement `MultiAgentCoordinator` without sockets, Native Messaging, filesystem, or timers hidden inside the class. Inject `now: () => number` for deterministic tests.

Required API:

```ts
export class MultiAgentCoordinator {
  constructor(options: { mode: CoordinatorMode; now?: () => number });
  connect(identity: AgentIdentity, sessionId: string): AgentSession;
  touch(sessionId: string): void;
  disconnect(sessionId: string): void;
  setDefaultTab(sessionId: string, tabId: number): void;
  resolveTab(sessionId: string, suppliedTabId?: number): number | undefined;
  status(): CoordinationStatus;
  acquire(sessionId: string, resource: LeaseResource, purpose: string, ttlMs: number): ResourceLease;
  renew(sessionId: string, leaseId: string, ttlMs: number): ResourceLease;
  release(sessionId: string, leaseId: string): void;
  assertWriteAllowed(sessionId: string, tabId: number): void;
  quarantineTab(sessionId: string, tabId: number, ttlMs?: number): ResourceLease;
  runTabWrite<T>(tabId: number, work: () => Promise<T>): Promise<T>;
}
```

Validation:

- `clientId`, `clientName`, `instanceId`, `purpose`: trim, 1-100 chars.
- Lease TTL: 5,000-300,000 ms.
- Same owner acquiring same resource renews the existing lease.
- Another owner in `observe` records a conflict callback/result but proceeds.
- Another owner in `enforce` gets `RESOURCE_BUSY` with redacted owner name, resource, purpose, and `retryAfterMs`.
- Quarantine returns `RESOURCE_QUARANTINED` to every non-owner.
- Disconnect removes active leases; quarantined leases stay until expiry.

Tests must prove:

1. Two reads are unaffected by a lease.
2. Two same-tab writes execute in order.
3. Different-tab writes overlap.
4. Lease acquisition/renew/release ownership.
5. TTL expiry using injected clock.
6. Disconnect cleanup.
7. Quarantine behavior.
8. Global recorder exclusivity.
9. `off`, `observe`, and `enforce` differences.

Run:

```powershell
npm run build -w apps/chrome-bridge
node --test apps/chrome-bridge/test/coordinator.test.mjs
```

Commit: `feat: add bridge multi-agent coordinator core`

---

## Task 3: Give Every MCP Process a Real Identity

**Files:**

- Create: `apps/codex-mcp-server/src/client-identity.ts`
- Modify: `apps/codex-mcp-server/src/bridge-client.ts`
- Test: `apps/codex-mcp-server/test/client-identity.test.mjs`
- Test: `apps/codex-mcp-server/test/bridge-client.test.mjs`

Environment contract:

```text
KBB_CLIENT_ID       default: codex
KBB_CLIENT_NAME     default: Codex
KBB_CLIENT_INSTANCE optional; default random UUID per MCP process
```

Implement:

```ts
export function clientIdentity(env: NodeJS.ProcessEnv = process.env): AgentIdentity
```

Normalize IDs to `[a-zA-Z0-9._-]`, reject empty/over-100 values, and never derive identity from a secret or username. Send all identity fields in `BridgeClient.hello()`.

Tests:

- Defaults produce `codex`, `Codex`, and a UUID.
- New Max env produces `newmax`, `New Max`.
- Two default invocations get different instance IDs.
- Hello payload includes capabilities `read`, `write`, `record`.
- Existing authentication and reconnect tests still pass.

Run:

```powershell
npm run build -w apps/codex-mcp-server
node --test apps/codex-mcp-server/test/*.test.mjs
```

Commit: `feat: identify MCP clients to the bridge`

---

## Task 4: Integrate Coordination in Chrome Bridge

**Files:**

- Modify: `apps/chrome-bridge/src/bridge.ts`
- Test: `apps/chrome-bridge/test/bridge-reliability.test.mjs`

Integration rules:

1. Create one `MultiAgentCoordinator` per Bridge process.
2. On authenticated Pipe hello, register identity against the generated session ID.
3. Store the session ID on the socket; on close, call `disconnect(sessionId)`.
4. For `browser_switch_tab`, store the session target before forwarding optional activation to Extension.
5. For browser calls with no `tabId`, resolve the calling session target. In `off`, keep legacy Extension fallback. In `observe`, log `coordination.missing_tab`. In `enforce`, return `TAB_ID_REQUIRED` when no session target exists.
6. Wrap all resolved tab writes in the Bridge-global `runTabWrite`.
7. Before write execution, call `assertWriteAllowed`.
8. On a write `UNKNOWN_OUTCOME`, quarantine `tab:<id>` for 30 seconds before responding.
9. `record_start` atomically acquires `global:recorder` and its tab. `record_stop` releases both after response or retains quarantine on ambiguous outcome.
10. Broadcast redacted coordination status to Pipe clients and Extension whenever client/lease/target state changes.

Add integration tests using two fake sessions:

- same-tab write order is global across sessions;
- different-tab writes overlap;
- session A target never replaces session B target;
- recorder session B gets `RESOURCE_BUSY` while A records;
- socket close releases A lease;
- old Pipe hello still works in `off` mode;
- no bearer token appears in status events.

Run:

```powershell
npm run test:local-chrome
```

Expected: all existing tests plus coordinator integration tests pass.

Commit: `feat: coordinate browser work across MCP clients`

---

## Task 5: Expose Coordination MCP Tools

**Files:**

- Modify: `apps/codex-mcp-server/src/server.ts`
- Create: `apps/codex-mcp-server/test/coordinator-tools.test.mjs`

Register:

```text
browser_get_clients       read-only
browser_lease_status      read-only
browser_lease_acquire     write to local coordinator only
browser_lease_renew       write to local coordinator only
browser_lease_release     write to local coordinator only
```

Schemas:

```ts
const leaseResource = z.union([
  z.string().regex(/^tab:[1-9]\d*$/),
  z.literal('global:recorder'),
]);
```

- Acquire: `resource`, `purpose` 3-200 chars, `ttlMs` 5,000-300,000.
- Renew: `leaseId`, `ttlMs`.
- Release: `leaseId`.
- Client/status output stays bounded and excludes token, Pipe name, command lines, local paths, and browsing content.
- Classify coordination status tools as reads so timeout never becomes `UNKNOWN_OUTCOME`.

Test tool discovery, Zod rejection, exact Bridge method forwarding, bounded status, and error propagation.

Commit: `feat: expose multi-agent lease tools`

---

## Task 6: Show Agent Ownership in the Extension

**Files:**

- Modify: `apps/extension/src/background/service-worker.ts`
- Modify: `apps/extension/src/sidepanel/components/LocalBridgePanel.tsx`
- Modify: `apps/extension/src/sidepanel/styles.css`

The Service Worker already broadcasts unknown Native messages to panel ports. Add typed handling for `bridge:coordination_status`; persist no Agent history in Chrome storage.

Add an unframed `Agent 与任务` section below connection status:

- Agent name and client ID.
- Connection indicator.
- Session target tab ID.
- Active lease purpose, state, and remaining time.
- Recorder owner.
- Empty state: `当前没有 Agent 占用浏览器任务`.

Do not expose instance UUID in normal UI; place it in an optional title attribute for diagnostics. Do not add release/takeover buttons in this milestone. The UI is observation-only.

Responsive acceptance:

- 360x720 and 1280x900: no text overflow or overlap.
- Panel remains vertically scrollable.
- One, two, and five-client fixtures render without layout shift.
- Light/dark and zh/en remain functional.

Run:

```powershell
npm run build -w apps/extension
npx tsc -p apps/extension/tsconfig.json --noEmit
```

Commit: `feat: show connected agents and leases`

---

## Task 7: Installation, Skill, and Compatibility

**Files:**

- Modify: `apps/chrome-bridge/src/install-helpers.ts`
- Modify: `apps/chrome-bridge/test/install-helpers.test.mjs`
- Modify: `docs/compatibility.md`
- Modify: `skills/kv-browser-bridge/SKILL.md`
- Modify: `docs/status/CURRENT_STATE.md`
- Modify: `docs/status/DECISIONS.md`
- Modify: `docs/status/HANDOFF.md`

Document generic MCP configuration:

```json
{
  "mcpServers": {
    "kv-browser-bridge": {
      "command": "node",
      "args": ["C:\\path\\to\\apps\\codex-mcp-server\\dist\\server.js"],
      "env": {
        "KBB_CLIENT_ID": "agent-id",
        "KBB_CLIENT_NAME": "Agent Name"
      }
    }
  }
}
```

Update Skill instructions:

- always supply `tabId` for writes;
- acquire an explicit lease for multi-step writes;
- concurrent reads are allowed;
- treat `RESOURCE_BUSY` as wait/choose-another-tab, never retry in a tight loop;
- treat `RESOURCE_QUARANTINED` as requiring state verification;
- only one recorder owner;
- do not auto-release another Agent's lease.

Installer tests must verify coordinator mode is omitted by default and only emitted when explicitly requested. Do not change the user's installed stable registration during unit tests.

Commit: `docs: document multi-agent bridge operation`

---

## Task 8: Dual-Client Integration Harness

**Files:**

- Create: `test/multi-agent-coordinator.test.mjs`
- Create: `test/fixtures/multi-agent-page.html`
- Modify: `package.json`

The fixture contains two buttons and counters only; it performs no network call, publish, comment, storage, or account action.

The Node integration test starts one fake Bridge coordinator and two stdio MCP processes with:

```text
KBB_CLIENT_ID=codex-test
KBB_CLIENT_NAME=Codex Test

KBB_CLIENT_ID=newmax-test
KBB_CLIENT_NAME=New Max Test
```

Prove:

1. Both appear in `browser_get_clients`.
2. Concurrent reads both complete.
3. Agent A lease blocks Agent B same-tab write with `RESOURCE_BUSY`.
4. Agent B can write another tab/resource.
5. Release lets Agent B proceed.
6. Disconnect releases ordinary leases.
7. Recorder is globally exclusive.
8. No secret fields appear in status JSON.

Add root script:

```json
"test:multi-agent": "node --test test/multi-agent-coordinator.test.mjs"
```

Run:

```powershell
npm run test:multi-agent
npm run test:local-chrome
npm run check:local-chrome
```

Commit: `test: cover two-agent browser coordination`

---

## Task 9: Real Chrome Acceptance

Do not replace the stable installation. Use the existing test-install/restore mechanism from Runtime Shadow.

1. Build from the multi-agent worktree.
2. Register test host with `KBB_COORDINATOR_MODE=observe`.
3. Reload only the test unpacked extension.
4. Start two MCP stdio processes named `Codex Acceptance` and `New Max Acceptance`.
5. Use a local fixture tab or a user-approved non-consequential page.
6. Verify concurrent `browser_get_text` and bounded `browser_snapshot`.
7. Acquire a tab lease from Agent A.
8. In `observe`, confirm Agent B conflict is logged without corrupting state.
9. Restart test host in `enforce`.
10. Confirm Agent B receives `RESOURCE_BUSY` and no click reaches Extension.
11. Release; confirm Agent B can perform one fixture click.
12. Start recorder with A; confirm B recorder start is blocked.
13. Stop recorder; confirm lease release.
14. Terminate A MCP process; confirm session and lease disappear.
15. Capture screenshot and structured logs.
16. Run `test-restore` and reload stable extension.
17. Re-verify stable `browser_get_tabs`.

Evidence directory:

```text
artifacts/multi-agent-acceptance/DATE/
  connection-status.json
  clients-before.json
  lease-conflict.json
  clients-after-disconnect.json
  fixture-screenshot.png
  bridge-log.jsonl
  verification.md
```

Do not commit this evidence directory unless manually reviewed for browser/private data.

Acceptance status must distinguish:

```text
CODED
LOCALLY_TESTED
REAL_BROWSER_VERIFIED
COMMITTED
PUSHED
PR_OPENED
CI_PASSED
RELEASED
```

---

## Task 10: Final Review, Push, and PR

Run from the clean coordinator worktree:

```powershell
npm ci
npm run release-check
npm run test:multi-agent
git diff origin/feature/runtime-shadow-v04...HEAD --check
git status --short
```

Final reviewer must challenge:

- two Agent instances with the same `clientId` but different instance IDs;
- client disconnect during a pending write;
- `UNKNOWN_OUTCOME` quarantine;
- expired lease cleanup;
- explicit lease plus same-tab command queue ordering;
- old MCP client hello compatibility;
- missing `tabId` behavior in all three modes;
- status event contains no token, Pipe path, local path, URL, title, or page content;
- stable Runtime/Recorder/Run Package tests remain passing;
- stable install was restored after browser acceptance.

Push only the coordinator branch. Open a PR into `feature/runtime-shadow-v04` first, not directly into `main`. Merge Runtime + Recorder + Coordinator to `main` only after the Runtime branch owner resolves its current uncommitted changes and the combined release gate passes.

---

## Controller Dispatch Runbook

The low-intelligence controller should follow this exact order:

```text
1. Verify/create coordinator worktree.
2. Agent A implements contract.
3. Spec review A -> fixes -> quality review A -> fixes -> merge A.
4. Dispatch Agent B and Agent C in parallel, each in a separate worktree.
5. Review B and C independently; merge both.
6. Agent D integrates Bridge.
7. Review D; merge.
8. Dispatch Agent E, F, and G in parallel, separate worktrees.
9. Review and merge E/F/G one at a time.
10. Agent H implements dual-client harness.
11. Full local gate.
12. Strong final reviewer.
13. Controller performs real Chrome acceptance.
14. Fix only evidence-backed failures, maximum three repair rounds.
15. Update status/handoff, push branch, open PR.
```

Every implementer prompt must include:

- exact task text copied from this plan;
- assigned worktree and allowed files;
- protected paths;
- base commit SHA;
- required tests;
- required commit message;
- output status: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`;
- instruction to inspect its diff and avoid staging unrelated files.

No implementer may claim real Chrome verification. Only the controller performing Task 9 may set `REAL_BROWSER_VERIFIED`.

---

## Completion Definition

The milestone is complete only when:

- two named Agent MCP processes are visible simultaneously;
- concurrent reads succeed;
- same-tab writes are globally serialized;
- an explicit lease blocks another Agent with structured `RESOURCE_BUSY`;
- different-tab work remains concurrent;
- targets are session-scoped;
- one global recorder owner is enforced;
- disconnect and TTL release work;
- `UNKNOWN_OUTCOME` creates quarantine;
- panel shows redacted Agent/lease state;
- old clients work in `off` mode;
- Runtime Shadow, Recorder, Replay, Run Package, and Guide tests still pass;
- real Chrome test installation is restored to stable;
- branch is pushed and PR evidence is accurate.
