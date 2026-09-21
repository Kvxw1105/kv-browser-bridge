export type OperationClass = 'read' | 'non_idempotent_write';

export type EffectClass = 'passive_read' | 'transient_input' | 'browser_mutation' | 'external_commit' | 'control_plane';
export type FailurePhase = 'dispatch' | 'disconnect' | 'deadline';

const reads = new Set(['browser_capabilities', 'browser_get_tabs', 'browser_find', 'browser_download_status', 'browser_list_bookmarks', 'browser_list_extensions', 'browser_snapshot', 'browser_screenshot', 'browser_wait_for', 'browser_get_text', 'browser_get_url', 'browser_connection_status', 'browser_get_clients', 'browser_lease_status']);

const effectByMethod: Record<string, EffectClass> = {
  browser_capabilities: 'passive_read',
  browser_get_tabs: 'passive_read',
  browser_new_tab: 'control_plane',
  browser_switch_tab: 'control_plane',
  browser_scroll: 'transient_input',
  browser_find: 'passive_read',
  browser_close_tab: 'control_plane',
  browser_download_status: 'passive_read',
  browser_list_bookmarks: 'passive_read',
  browser_open_bookmark: 'control_plane',
  browser_list_extensions: 'passive_read',
  browser_navigate: 'browser_mutation',
  browser_snapshot: 'passive_read',
  browser_screenshot: 'passive_read',
  browser_click: 'transient_input',
  browser_type: 'browser_mutation',
  browser_press: 'transient_input',
  browser_select: 'browser_mutation',
  browser_evaluate: 'browser_mutation',
  browser_set_files: 'browser_mutation',
  browser_wait_for: 'passive_read',
  browser_get_text: 'passive_read',
  browser_get_url: 'passive_read',
  browser_console_logs: 'passive_read',
  browser_console_errors: 'passive_read',
  browser_network_requests: 'passive_read',
  browser_network_failures: 'passive_read',
  browser_get_response_body: 'passive_read',
  browser_inspect_element: 'passive_read',
  browser_get_element_styles: 'passive_read',
  browser_page_metrics: 'passive_read',
  browser_list_webmcp_tools: 'passive_read',
  browser_execute_webmcp_tool: 'external_commit',
  browser_connection_status: 'passive_read',
};

/** Conservative default: an unrecognized method may have mutated the page. */
export function effectClassForMethod(method: string): EffectClass {
  return effectByMethod[method] ?? 'browser_mutation';
}

export function operationClassForMethod(method: string): OperationClass {
  return reads.has(method) ? 'read' : 'non_idempotent_write';
}

export interface OutcomeFailure {
  code: 'BRIDGE_TIMEOUT' | 'UNKNOWN_OUTCOME' | 'BRIDGE_UNAVAILABLE';
  retryable: boolean;
  effectClass: EffectClass;
  phase: FailurePhase;
}

/**
 * What an ambiguous dispatch timeout means for a method. Reads may be retried;
 * every non-read effect class returns UNKNOWN_OUTCOME (never retried) with the
 * effect class and phase attached.
 */
export function timeoutOutcomeFor(method: string): OutcomeFailure {
  const effectClass = effectClassForMethod(method);
  if (effectClass === 'passive_read') {
    return { code: 'BRIDGE_TIMEOUT', retryable: true, effectClass, phase: 'dispatch' };
  }
  return { code: 'UNKNOWN_OUTCOME', retryable: false, effectClass, phase: 'dispatch' };
}

/**
 * What a mid-flight disconnect means for an effect class. Reads and
 * control-plane operations have no page side effects, so the connection may be
 * re-established; page-effect classes may have committed and are unknown.
 */
export function disconnectOutcomeFor(effectClass: EffectClass): OutcomeFailure {
  if (effectClass === 'passive_read' || effectClass === 'control_plane') {
    return { code: 'BRIDGE_UNAVAILABLE', retryable: true, effectClass, phase: 'disconnect' };
  }
  return { code: 'UNKNOWN_OUTCOME', retryable: false, effectClass, phase: 'disconnect' };
}

/** Legacy helpers kept for compatibility with earlier callers/tests. */
export function timeoutErrorForMethod(method: string): { code: 'BRIDGE_TIMEOUT' | 'UNKNOWN_OUTCOME'; retryable: boolean } {
  return operationClassForMethod(method) === 'read'
    ? { code: 'BRIDGE_TIMEOUT', retryable: true }
    : { code: 'UNKNOWN_OUTCOME', retryable: false };
}

export function disconnectErrorFor(operationClass: OperationClass): { code: 'BRIDGE_UNAVAILABLE' | 'UNKNOWN_OUTCOME'; retryable: boolean } {
  return operationClass === 'non_idempotent_write'
    ? { code: 'UNKNOWN_OUTCOME', retryable: false }
    : { code: 'BRIDGE_UNAVAILABLE', retryable: true };
}

export function healthState(socketReady: boolean, bridge?: { extensionConnected?: boolean; nativeReady?: boolean }): { ready: boolean; degraded: boolean } {
  const extensionReady = bridge?.extensionConnected === true && bridge?.nativeReady === true;
  return { ready: socketReady && extensionReady, degraded: socketReady && !extensionReady };
}

/** Minimal fake-transport-friendly cache: a reconnect with the same stable identity/key never reruns work. */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  constructor(private readonly maxEntries = 1024, private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}
  run(identity: string, key: string, execute: () => Promise<T>): Promise<T> {
    const cacheKey = `${identity}:${key}`;
    this.cleanup();
    const existing = this.entries.get(cacheKey);
    if (existing) return existing.value;
    const value = execute();
    this.entries.set(cacheKey, { expiresAt: this.now() + this.ttlMs, value });
    this.cleanup();
    return value;
  }
  size(): number { return this.entries.size; }
  private cleanup(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now || this.entries.size > this.maxEntries) this.entries.delete(key);
  }
}

/** Serializes page writes without blocking unrelated tabs or read operations. */
export class PerTabWriteQueue {
  private tails = new Map<number, Promise<void>>();
  async run<T>(tabId: number | undefined, operationClass: OperationClass, work: () => Promise<T>): Promise<T> {
    if (operationClass === 'read' || tabId == null) return work();
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.tails.set(tabId, tail);
    await previous;
    try { return await work(); } finally {
      release();
      if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
    }
  }
}
