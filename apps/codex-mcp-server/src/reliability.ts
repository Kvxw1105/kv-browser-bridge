export type OperationClass = 'read' | 'non_idempotent_write';

const reads = new Set(['browser_get_tabs', 'browser_find', 'browser_download_status', 'browser_list_bookmarks', 'browser_list_extensions', 'browser_snapshot', 'browser_screenshot', 'browser_wait_for', 'browser_get_text', 'browser_get_url', 'browser_connection_status']);

export function operationClassForMethod(method: string): OperationClass {
  return reads.has(method) ? 'read' : 'non_idempotent_write';
}

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
