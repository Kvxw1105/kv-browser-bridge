import { isIP } from 'node:net';
import { readDevToolsActivePort, type DevToolsEndpoint } from './windows-doctor.js';

export interface BrowserNetworkProbeResult {
  ok: boolean;
  publicIp?: string;
  probeUrl: string;
  observedAt: string;
  error?: { code: string; message: string };
}

export interface BrowserNetworkProbeOptions {
  probeUrl?: string;
  timeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => Date;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type EventWaiter = { sessionId?: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventWaiters = new Map<string, EventWaiter[]>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(event));
    socket.addEventListener('close', () => this.failAll(new Error('Chrome DevTools WebSocket closed.')));
    socket.addEventListener('error', () => this.failAll(new Error('Chrome DevTools WebSocket failed.')));
  }

  static connect(url: string, timeoutMs: number, factory: (url: string) => WebSocket): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = factory(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Chrome DevTools WebSocket did not open within ${timeoutMs}ms.`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Chrome DevTools WebSocket failed to open.'));
      }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(method, waiter);
        reject(new Error(`CDP event ${method} timed out.`));
      }, timeoutMs);
      const waiter: EventWaiter = { sessionId, resolve, reject, timer };
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(waiter);
      this.eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.socket.close();
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const text = typeof event.data === 'string'
      ? event.data
      : event.data instanceof ArrayBuffer
        ? Buffer.from(event.data).toString('utf8')
        : event.data instanceof Blob
          ? await event.data.text()
          : String(event.data);
    let message: any;
    try { message = JSON.parse(text); } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Chrome DevTools command failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      const waiters = this.eventWaiters.get(message.method) ?? [];
      for (const waiter of [...waiters]) {
        if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
        this.removeWaiter(message.method, waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private removeWaiter(method: string, waiter: EventWaiter): void {
    const remaining = (this.eventWaiters.get(method) ?? []).filter((candidate) => candidate !== waiter);
    if (remaining.length > 0) this.eventWaiters.set(method, remaining);
    else this.eventWaiters.delete(method);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.eventWaiters.clear();
  }
}

export async function probeBrowserPublicIp(
  endpoint: DevToolsEndpoint,
  options: BrowserNetworkProbeOptions = {},
): Promise<BrowserNetworkProbeResult> {
  const probeUrl = options.probeUrl ?? 'https://api.ipify.org?format=json';
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  if (!endpoint.websocketUrl) return failure('DEVTOOLS_WEBSOCKET_MISSING', 'DevToolsActivePort did not include a browser WebSocket path.');
  let parsed: URL;
  try { parsed = new URL(probeUrl); } catch { return failure('PROBE_URL_INVALID', 'probeUrl must be a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:') return failure('PROBE_URL_INSECURE', 'Only HTTPS network probe URLs are allowed.');

  const factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  let client: CdpClient | undefined;
  let targetId: string | undefined;
  try {
    client = await CdpClient.connect(endpoint.websocketUrl, timeoutMs, factory);
    const created = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true }, undefined, timeoutMs);
    targetId = created.targetId;
    const attached = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, undefined, timeoutMs);
    const sessionId = attached.sessionId;
    await client.send('Page.enable', {}, sessionId, timeoutMs);
    await client.send('Runtime.enable', {}, sessionId, timeoutMs);
    const loaded = client.waitForEvent('Page.loadEventFired', sessionId, timeoutMs);
    await client.send('Page.navigate', { url: probeUrl }, sessionId, timeoutMs);
    await loaded;
    const evaluation = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: 'document.body?.innerText ?? ""', returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    if (evaluation.exceptionDetails) throw new Error('Probe page evaluation failed.');
    const text = typeof evaluation.result?.value === 'string' ? evaluation.result.value.trim() : '';
    const publicIp = parsePublicIp(text);
    return { ok: true, publicIp, probeUrl, observedAt };
  } catch (error) {
    return failure('BROWSER_NETWORK_PROBE_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    if (client && targetId) await client.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => undefined);
    client?.close();
  }

  function failure(code: string, message: string): BrowserNetworkProbeResult {
    return { ok: false, probeUrl, observedAt, error: { code, message } };
  }
}

export async function waitForDevToolsEndpoint(
  userDataDir: string,
  timeoutMs = 15_000,
  pollIntervalMs = 200,
  reader: (userDataDir: string) => DevToolsEndpoint | undefined = readDevToolsActivePort,
): Promise<DevToolsEndpoint | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = reader(userDataDir);
    if (endpoint?.websocketUrl) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return reader(userDataDir);
}

export function parsePublicIp(text: string): string {
  let candidate = text.trim();
  try {
    const parsed = JSON.parse(candidate) as { ip?: unknown };
    if (typeof parsed.ip === 'string') candidate = parsed.ip.trim();
  } catch { /* plain-text IP responses are supported */ }
  if (!isIP(candidate)) throw new Error('Network probe response did not contain a valid IPv4 or IPv6 address.');
  return candidate;
}
