# Identity Stack Readiness

Audit date: 2026-07-31 (updated 2026-08-03)
Repository: `Kvxw1105/kv-browser-bridge`
Scope: Git and architecture integration state. The four-layer stack has now
been merged into `main` in order; this document records the final state.

## Merge record (2026-08-03)

- PR #2 `feature/identity-runtime-v01` -> `main`, merged with rebase.
- PR #4 `feature/network-isolation-v01` -> `main`, retargeted, rebased onto new
  `main`, CI re-run, merged with rebase.
- PR #5 `codex/windows-identity-console-mvp` -> `main`, retargeted, rebased,
  CI re-run (release-check x2 + desktop-console), merged with rebase.
- PR #10 `feature/managed-multi-identity-session-alpha-v02` -> `main`,
  retargeted, rebased, CI re-run, final Windows revalidation at
  `f2ae343` passed, merged with rebase.
- Final `main` tip after the sequence: `be4c3ca`.
- PR #11 `codex/product-packaging-v01` retargeted to `main` and rebased;
  remains Draft and unmerged.

## Stack order

```text
PR #2  feature/identity-runtime-v01
  -> PR #4  feature/network-isolation-v01
    -> PR #5  codex/windows-identity-console-mvp
      -> PR #10 feature/managed-multi-identity-session-alpha-v02
```

## PR #2: Identity Runtime

- URL: https://github.com/Kvxw1105/kv-browser-bridge/pull/2
- State: `OPEN`, ready for review (`isDraft=false`)
- Base: `main`
- Base SHA: `fb857d094bdb5101ac8d1e1e8e8c17b96aea8a12`
- Head: `feature/identity-runtime-v01`
- Head SHA: `1fde95c80abc63d450010c944cd3ee917cb93da1`
- Mergeability: `MERGEABLE`, `CLEAN`
- Commits: 63
- Changed files: 29
- CI: three `release-check` runs succeeded on the head SHA
- Reviews: one automated `COMMENTED` review; no approval or requested-changes decision
- Layer contract: Identity lifecycle, locks, receipts, private discovery, public
  session registry, MCP identity selection, and Windows identity tests.
- Boundary: does not own network policy, Desktop Console, or managed multi-
  identity Supervisor behavior.
- Readiness: **READY**, subject to normal human review and merge of this base layer.

## PR #4: Network Isolation

- URL: https://github.com/Kvxw1105/kv-browser-bridge/pull/4
- State: `OPEN`, Draft
- Base: `feature/identity-runtime-v01`
- Base SHA: `1fde95c80abc63d450010c944cd3ee917cb93da1`
- Head: `feature/network-isolation-v01`
- Head SHA: `c8e0f17d8cc401f83994cda517f5c00d07c0ce9c`
- Mergeability: `MERGEABLE`, `CLEAN`
- Commits: 63
- Changed files: 45
- CI: the two initial runs (`30401316920`, `30401320125`) failed before
  exposing steps. After the one-line package-validator fix, both new runs
  passed on `c8e0f17`: push run `30648882999` and pull-request run
  `30648883599`. The successful steps covered `npm ci`, `npm run test`,
  `npm run check`, `npm run package`, and `validate-npm-pack`.
- Reviews: none recorded
- Layer contract: network observation, runtime-session binding, leak probes,
  baseline/drift/collision records, and network guard primitives.
- Boundary: does not own Desktop UI or Managed Multi-Identity Alpha.
- Review item: its legacy `identity-cli network-leak-check` path remains
  fail-closed on missing/failed mandatory evidence. Keep that path explicitly
  Strict/legacy when PR #10 is retargeted; it is not the default Observe
  lifecycle. This is a contract note, not a merge blocker for PR #4.
- Readiness: **READY**, subject to normal review and the ordered merge/retarget
  operation after PR #2.

## PR #5: Desktop Console

- URL: https://github.com/Kvxw1105/kv-browser-bridge/pull/5
- State: `OPEN`, Draft
- Base: `feature/network-isolation-v01`
- Base SHA: `d79e76484f56ba6e5797c6f8b3958443f49910ec`
- Head: `codex/windows-identity-console-mvp`
- Head SHA: `17c5a17ae5ee5e5f4895f42d98039df28a40ee31`
- Mergeability: `MERGEABLE`, `CLEAN`
- Commits: 36
- Changed files: 23
- CI: two `release-check` runs and one `desktop-console` run succeeded
- Reviews: none recorded
- Layer contract: Desktop Identity Console, Dashboard, Create/Edit/Delete,
  GUI lifecycle controls, and Desktop IPC/preload/renderer wiring.
- Boundary: does not own the PR #10 Supervisor, CDP pipe, dynamic managed
  Extension provisioning, or dual-Identity orchestration.
- Overlap: PR #10 makes narrow changes to `console-service.ts`,
  `IdentityConsoleView.tsx`, and shared console types to surface managed
  session state. This is an intentional upper-layer extension, not a second
  Desktop Console implementation.
- Readiness: **CONDITIONALLY READY** after PR #4 is merged and retargeted to
  `main`; re-run Desktop build and CI on the new merge base.

## PR #10: Managed Multi-Identity Alpha

- URL: https://github.com/Kvxw1105/kv-browser-bridge/pull/10
- State: `OPEN`, Draft
- Base: `codex/windows-identity-console-mvp`
- Base SHA: `17c5a17ae5ee5e5f4895f42d98039df28a40ee31`
- Head: `feature/managed-multi-identity-session-alpha-v02`
- Head SHA: `edc5aaf31293caa55f9c2fedac62c060cbf259b4`
- Mergeability: `MERGEABLE`, `CLEAN`
- Commits: 3
- Changed files: 33
- CI: two `release-check` runs and one `desktop-console` run succeeded
- Reviews: none recorded
- Layer contract: `SessionSupervisor`, CDP pipe, managed Extension
  provisioning, simultaneous dual Identity runtime, MCP A/B routing,
  Observe/Strict policy documents, and the Real Network Qualification contract.
- Boundary: does not add new Desktop features, account automation, or proxy
  product behavior.
- Evidence boundary: Managed Multi-Identity and single-inbound Observe reports
  remain under ignored `local/` paths; external second-inbound and authenticated
  proxy states are explicitly `PENDING_EXTERNAL`.
- Local managed-identity report is `ok: true`: both sessions were ready with
  distinct runtime IDs, Bridge discovery, Extension handshakes, MCP routing,
  Stop-A isolation, restart persistence, and clean final stop.
- Readiness: **READY AS TOP LAYER ON CURRENT STACK**, but final merge readiness
  is conditional on the lower-layer retarget sequence and final SHA-bound
  revalidation.

## Cross-layer file overlap

The overlaps below are expected because each branch is stacked, not parallel:

| Pair | Shared paths | Interpretation |
| --- | ---: | --- |
| PR #2 / PR #4 | 6 | Network layer extends runtime model, health, launch, and CLI contracts |
| PR #2 / PR #5 | 1 | Desktop layer consumes the shared identity export |
| PR #2 / PR #10 | 9 | Supervisor hardens the existing runtime/process/session contracts |
| PR #4 / PR #5 | 2 | Desktop layer consumes the network/runtime package contract |
| PR #4 / PR #10 | 6 | Managed policy and supervisor extend the network/session contracts |
| PR #5 / PR #10 | 5 | Managed session state is surfaced through the existing Console types/view |

No independent duplicate implementation was found. The main contract risk is
the legacy PR #4 CLI fail-closed path versus the PR #10 default Observe policy;
review must keep those paths explicitly separated.

## Merge order

1. PR #2: Identity Runtime into `main`.
2. PR #4: Network Isolation after retargeting to `main` and successful CI.
3. PR #5: Desktop Console after retargeting to `main` and successful Desktop CI.
4. PR #10: Managed Multi-Identity Alpha after retargeting to `main` and final
   evidence revalidation.

All four layers were merged into `main` on 2026-08-03 in the recorded order.

## Retarget plan

### After PR #2 merges

1. Record the new `main` merge SHA.
2. Retarget PR #4 base to `main`.
3. Rebase/update `feature/network-isolation-v01` onto the new `main` while
   preserving only the PR #4 delta; use `push --force-with-lease` only if a
   rebase changes the branch SHA.
4. Verify `git merge-base --is-ancestor origin/main origin/feature/network-isolation-v01`.
5. Re-run `npm run test`, `npm run check`, `npm run release-check`, and PR #4 CI.
6. Resolve the Observe/Strict boundary review item before marking PR #4 ready.

### After PR #4 merges

1. Record the new `main` merge SHA.
2. Retarget PR #5 base to `main`.
3. Rebase/update `codex/windows-identity-console-mvp` onto the new `main`,
   preserving only the Desktop Console delta.
4. Inspect the diff for accidental network-runtime duplication.
5. Run `npm run typecheck -w apps/desktop`, `npm run build -w apps/desktop`,
   and the Desktop Console CI.

### After PR #5 merges

1. Record the new `main` merge SHA.
2. Retarget PR #10 base to `main`.
3. Rebase/update `feature/managed-multi-identity-session-alpha-v02` onto the
   new `main`, preserving only the Managed Alpha delta.
4. Inspect the final diff and verify no Desktop Console implementation was
   duplicated.
5. Run `npm run release-check`.
6. Run `scripts/accept-managed-multi-identity.ps1` and record a fresh ignored
   Windows evidence report.
7. Run the single-inbound Observe qualification and the Strict policy focused
   tests; bind all evidence to the final candidate SHA.

During the execution, each upper PR was retargeted to `main` only after its
lower PR had merged, then rebased and re-validated before its own merge.

## Final revalidation matrix

The final PR #10 candidate must have fresh evidence at its post-retarget SHA:

- `npm run release-check`
- GitHub `release-check` and `desktop-console` checks
- `scripts/accept-managed-multi-identity.ps1`
- single-inbound Observe qualification with
  `local/e2e-real-network-qualification/report.json`
- `node --test apps/chrome-bridge/test/network-enforcement.test.mjs`
- `git check-ignore -v local/e2e-managed-multi-identity local/e2e-real-network-qualification`
- `git diff --check` and `git status --short`

Evidence from `edc5aaf` remains valid historical evidence, but it must be
re-run after PR #10 is retargeted to the post-PR #5 `main` SHA.
