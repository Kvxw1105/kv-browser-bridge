import type { Readable, Writable } from 'node:stream';

export interface ChromeCdpTransportLike {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** Chromium remote-debugging-pipe uses null-delimited JSON messages. */
export class ChromeCdpTransport implements ChromeCdpTransportLike {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private nextId = 1;
  private closed = false;

  constructor(private readonly writePipe: Writable, private readonly readPipe: Readable) {
    readPipe.on('data', (chunk: Buffer | string) => this.consume(String(chunk)));
    const close = () => this.rejectAll(new Error('Chrome CDP pipe closed.'));
    readPipe.on('close', close);
    readPipe.on('error', close);
    writePipe.on('error', close);
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Chrome CDP pipe is closed.'));
    const id = this.nextId++;
    const message = `${JSON.stringify({ id, method, params })}\0`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.writePipe.write(message, 'utf8');
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('Chrome CDP pipe closed.'));
    this.readPipe.destroy();
    this.writePipe.end();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let delimiter = this.buffer.indexOf('\0');
    while (delimiter >= 0) {
      const payload = this.buffer.slice(0, delimiter);
      this.buffer = this.buffer.slice(delimiter + 1);
      delimiter = this.buffer.indexOf('\0');
      let message: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      try { message = JSON.parse(payload); } catch { continue; }
      if (typeof message.id !== 'number') continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'CDP request failed.'), { code: message.error.code }));
      else waiter.resolve(message.result ?? {});
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
}
