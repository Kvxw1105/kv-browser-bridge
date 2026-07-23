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

/** Serializes page writes without blocking unrelated tabs or read operations. */
export class PerTabWriteQueue {
  private tails = new Map<number, Promise<void>>();
  async run<T>(tabId: number | undefined, operationClass: OperationClass, work: () => Promise<T>): Promise<T> {
    if (operationClass === 'read' || tabId == null) return work();
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(tabId, previous.then(() => next));
    await previous;
    try { return await work(); } finally {
      release();
      if (this.tails.get(tabId) === next) this.tails.delete(tabId);
    }
  }
}
