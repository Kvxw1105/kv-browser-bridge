/**
 * Session-scoped ref store for observed DOM identities.
 *
 * Adapted from Tencent/BrowserSkill (MIT, fixed commit fa953dc)
 * `apps/extension/src/session-manager/ref-store.ts`: the
 * replace/resolve/invalidate/clear generation state machine is reused, while
 * every entry is additionally owned by a local identity + runtime session so a
 * ref can never be resolved from a different identity, runtime session, tab,
 * or from a stale observation generation. Local identity/credential/Native
 * Messaging/Named Pipe/MCP boundaries keep the Kv Browser Bridge rules.
 */

export interface LocalRefEntry {
  readonly ref: string;
  readonly backendNodeId: number;
  readonly identityId: string;
  readonly runtimeSessionId: string;
  readonly tabId: number;
  readonly frameId?: string;
  readonly generation: number;
}

export interface LocalRefInput {
  backendNodeId: number;
  tabId: number;
  frameId?: string;
}

/** Ownership context of one observation; every stored ref inherits it. */
export interface RefOwnership {
  identityId: string;
  runtimeSessionId: string;
}

export interface RefResolveOptions extends RefOwnership {
  tabId: number;
  /** When provided, the ref must come from exactly this observation generation. */
  generation?: number;
}

export class RefStore {
  private map = new Map<string, LocalRefEntry>();
  private generation = 0;

  /** Current observation revision; bumped by every replace/clear. */
  get revision(): number {
    return this.generation;
  }

  size(): number {
    return this.map.size;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }

  /**
   * Raw lookup without any scope/generation checks. Used by ref gating to
   * distinguish a stale ref (not in the store) from a scope mismatch (in the
   * store but owned by another identity/session/tab).
   */
  peek(ref: string): LocalRefEntry | null {
    return this.map.get(normaliseRef(ref)) ?? null;
  }

  /**
   * Resolve a ref to its stored entry. Returns null unless the entry belongs
   * to the exact identity/runtime session/tab and (when pinned) generation.
   */
  resolve(ref: string, opts: RefResolveOptions): LocalRefEntry | null {
    const entry = this.map.get(normaliseRef(ref));
    if (!entry) return null;
    if (entry.identityId !== opts.identityId) return null;
    if (entry.runtimeSessionId !== opts.runtimeSessionId) return null;
    if (entry.tabId !== opts.tabId) return null;
    if (opts.generation !== undefined && entry.generation !== opts.generation) return null;
    return entry;
  }

  /**
   * Atomically replace the entire store with a fresh observation generation.
   * Used after every fresh observation; refs from previous generations are
   * dropped wholesale.
   */
  replace(entries: Iterable<readonly [string, LocalRefInput]>, ownership: RefOwnership): void {
    const generation = this.generation + 1;
    const next = new Map<string, LocalRefEntry>();
    for (const [ref, input] of entries) {
      const key = normaliseRef(ref);
      next.set(key, {
        ref: key,
        backendNodeId: input.backendNodeId,
        identityId: ownership.identityId,
        runtimeSessionId: ownership.runtimeSessionId,
        tabId: input.tabId,
        ...(input.frameId ? { frameId: input.frameId } : {}),
        generation,
      });
    }
    this.map = next;
    this.generation = generation;
  }

  /** A CDP node id may be reused by a new document in the same tab. */
  invalidateTab(tabId: number): void {
    let changed = false;
    for (const [ref, entry] of this.map) {
      if (entry.tabId === tabId) {
        this.map.delete(ref);
        changed = true;
      }
    }
    if (changed) this.generation += 1;
  }

  /** Drop every ref owned by a runtime session (session end / identity switch). */
  invalidateSession(ownership: RefOwnership): void {
    let changed = false;
    for (const [ref, entry] of this.map) {
      if (entry.identityId === ownership.identityId && entry.runtimeSessionId === ownership.runtimeSessionId) {
        this.map.delete(ref);
        changed = true;
      }
    }
    if (changed) this.generation += 1;
  }

  clear(): void {
    this.generation += 1;
    this.map.clear();
  }

  entries(): IterableIterator<[string, LocalRefEntry]> {
    return this.map.entries();
  }
}

/** Canonical ref key: `@e3` and `e3` both become `e3`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1) : ref;
}
