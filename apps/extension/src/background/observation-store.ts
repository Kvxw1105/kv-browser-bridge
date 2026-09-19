/**
 * Minimal import boundary for VOM-style observations and ref gating.
 *
 * The browser_snapshot path (see vom-adapter.ts) renders observations and
 * writes them through this boundary. Observations are stored with an atomic
 * `replace` on the RefStore, and tools that accept a `ref` parameter resolve it
 * through the store with the current identity/runtime session/tab context — a
 * failed resolution is a structured error, never a silent fallback to a
 * selector.
 */

import type { LocalRefEntry, RefOwnership } from './ref-store';

export type RefGuardCode = 'STALE_REF' | 'REF_SCOPE_MISMATCH';

export class RefGuardError extends Error {
  readonly retryable = false;
  readonly code: RefGuardCode;
  readonly details: Record<string, unknown>;
  constructor(code: RefGuardCode, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'RefGuardError';
    this.code = code;
    this.details = details;
  }
}

export interface RefObservation {
  ownership: RefOwnership;
  entries: Iterable<readonly [string, { backendNodeId: number; tabId: number; frameId?: string }]>;
}

/** Minimal ref shape carried by a rendered VOM snapshot's `refs` list. */
export interface SnapshotRefInput {
  ref: string;
  backendNodeId: number;
  frameId?: string;
}

/**
 * Build a fresh RefObservation from one rendered snapshot's refs. Ownership and
 * tab come from the caller; each entry keeps its own frameId. Pass the result
 * to `storeObservation` to atomically replace the previous observation
 * generation — refs from an older snapshot are dropped wholesale.
 */
export function refObservationFromSnapshot(
  refs: Iterable<SnapshotRefInput>,
  tabId: number,
  ownership: RefOwnership,
): RefObservation {
  const entries: Array<readonly [string, { backendNodeId: number; tabId: number; frameId?: string }]> = [];
  for (const ref of refs) {
    const key = typeof ref.ref === 'string' ? ref.ref.trim() : '';
    if (!key || !Number.isInteger(ref.backendNodeId) || ref.backendNodeId <= 0) continue;
    entries.push([key, { backendNodeId: ref.backendNodeId, tabId, ...(ref.frameId ? { frameId: ref.frameId } : {}) }]);
  }
  return { ownership, entries };
}

export interface ResolvedRefTarget {
  entry: LocalRefEntry;
}

export interface RefGuardOptions {
  /** Pin the exact observation generation the caller read. */
  generation?: number;
}

/**
 * Atomic replace of the ref store with one fresh observation. The
 * browser_snapshot path stores every rendered observation through this
 * boundary; old generations are dropped wholesale by RefStore.replace.
 */
export function storeObservation(store: {
  replace(entries: Iterable<readonly [string, { backendNodeId: number; tabId: number; frameId?: string }]>, ownership: RefOwnership): void;
}, observation: RefObservation): void {
  store.replace(observation.entries, observation.ownership);
}

/**
 * Gate a `ref` parameter through the store. Returns null when no `ref`
 * parameter is present (the caller keeps its selector path). Throws
 * STALE_REF when the ref is unknown or from a pinned, outdated generation,
 * and REF_SCOPE_MISMATCH when the ref belongs to another identity/runtime
 * session/tab. Never falls back to a selector.
 */
export function requireRefTarget(
  store: {
    peek(ref: string): LocalRefEntry | null;
    resolve(ref: string, opts: RefOwnership & { tabId: number; generation?: number }): LocalRefEntry | null;
  },
  params: Record<string, unknown>,
  ownership: RefOwnership,
  tabId: number,
  options: RefGuardOptions = {},
): ResolvedRefTarget | null {
  const ref = typeof params.ref === 'string' && params.ref.trim() ? params.ref.trim() : '';
  if (!ref) return null;
  const pinned = typeof params.generation === 'number' ? params.generation : options.generation;

  const entry = store.peek(ref);
  if (!entry) {
    throw new RefGuardError('STALE_REF', `Ref ${ref} is not from any current observation`, { ref, tabId });
  }
  const resolved = store.resolve(ref, { identityId: ownership.identityId, runtimeSessionId: ownership.runtimeSessionId, tabId, ...(pinned === undefined ? {} : { generation: pinned }) });
  if (!resolved) {
    if (pinned !== undefined && entry.generation !== pinned) {
      throw new RefGuardError('STALE_REF', `Ref ${ref} is from observation generation ${entry.generation}, not ${pinned}`, { ref, tabId, generation: pinned, observedGeneration: entry.generation });
    }
    throw new RefGuardError(
      'REF_SCOPE_MISMATCH',
      `Ref ${ref} belongs to a different identity, runtime session, or tab`,
      { ref, tabId, entryIdentityId: entry.identityId, entryRuntimeSessionId: entry.runtimeSessionId, entryTabId: entry.tabId },
    );
  }
  return { entry: resolved };
}
