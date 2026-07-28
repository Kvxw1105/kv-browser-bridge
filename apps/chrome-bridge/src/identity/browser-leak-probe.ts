import { isIP } from 'node:net';
import type { DevToolsEndpoint } from './windows-doctor.js';

export interface BrowserLeakProbeOptions {
  timeoutMs?: number;
  ipv6ProbeUrl?: string;
  dnsProbeUrl?: string;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => Date;
}

export interface BrowserLeakProbeResult {
  ok: boolean;
  observedAt: string;
  webrtcCandidates?: string[];
  ipv6Addresses?: string[];
  dnsResolvers?: string[];
  findings: Array<{ code: string; message: string }>;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Waiter = { sessionId?: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Map<string, Waiter[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => void this.onMessage(event));
    socket.addEventListener('close', () => this.failAll(new Error('Chrome DevTools WebSocket closed.')));
    socket.addEventListener('error', () => this.failAll(new Error('Chrome DevTools WebSocket failed.')));
  }

  static connect(url: string, timeoutMs: number, factory: (url: string) => WebSocket): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = factory(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome DevTools WebSocket open timed out.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools WebSocket failed to open.')); }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  wait(method: string, sessionId: string | undefined, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { sessionId, resolve, reject, timer: setTimeout(() => {
        this.remove(method, waiter);
        reject(new Error(`CDP event ${method} timed out.`));
      }, timeoutMs) };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), waiter]);
    });
  }

  close(): void { this.socket.close(); }

  private async onMessage(event: MessageEvent): Promise<void> {
    const text = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : String(event.data);
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
      for (const waiter of [...(this.waiters.get(message.method) ?? [])]) {
        if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
        this.remove(message.method, waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private remove(method: string, waiter: Waiter): void {
    const remaining = (this.waiters.get(method) ?? []).filter((item) => item !== waiter);
    if (remaining.length) this.waiters.set(method, remaining); else this.waiters.delete(method);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
}

export async function probeBrowserLeakSignals(
  endpoint: DevToolsEndpoint,
  options: BrowserLeakProbeOptions = {},
): Promise<BrowserLeakProbeResult> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const findings: BrowserLeakProbeResult['findings'] = [];
  if (!endpoint.websocketUrl) return { ok: false, observedAt, findings: [{ code: 'DEVTOOLS_WEBSOCKET_MISSING', message: 'Browser DevTools WebSocket is unavailable.' }] };
  const timeoutMs = options.timeoutMs ?? 20_000;
  const factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  let client: CdpSession | undefined;
  try {
    client = await CdpSession.connect(endpoint.websocketUrl, timeoutMs, factory);
    const webrtcCandidates = await collectWebRtcCandidates(client, timeoutMs).catch((error) => {
      findings.push({ code: 'WEBRTC_PROBE_FAILED', message: message(error) });
      return undefined;
    });
    const ipv6Addresses = options.ipv6ProbeUrl
      ? await collectIpPage(client, options.ipv6ProbeUrl, timeoutMs).then((ip) => isIP(ip) === 6 ? [ip] : []).catch((error) => {
          findings.push({ code: 'IPV6_PROBE_FAILED', message: message(error) });
          return undefined;
        })
      : undefined;
    const dnsResolvers = options.dnsProbeUrl
      ? await collectTextPage(client, options.dnsProbeUrl, timeoutMs).then(parseDnsResolvers).catch((error) => {
          findings.push({ code: 'DNS_PROBE_FAILED', message: message(error) });
          return undefined;
        })
      : undefined;
    return { ok: findings.length === 0, observedAt, webrtcCandidates, ipv6Addresses, dnsResolvers, findings };
  } catch (error) {
    return { ok: false, observedAt, findings: [{ code: 'BROWSER_LEAK_PROBE_FAILED', message: message(error) }] };
  } finally {
    client?.close();
  }
}

async function collectWebRtcCandidates(client: CdpSession, timeoutMs: number): Promise<string[]> {
  return withTarget(client, 'about:blank', timeoutMs, async (sessionId) => {
    const result = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: `new Promise(async (resolve) => {
        const values = [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('probe');
        pc.onicecandidate = (event) => {
          if (event.candidate?.candidate) values.push(event.candidate.candidate);
          if (!event.candidate) { pc.close(); resolve(values); }
        };
        try { await pc.setLocalDescription(await pc.createOffer()); }
        catch { pc.close(); resolve(values); }
        setTimeout(() => { try { pc.close(); } catch {} resolve(values); }, 4000);
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId, timeoutMs);
    if (result.exceptionDetails) throw new Error('WebRTC candidate evaluation failed.');
    return Array.isArray(result.result?.value) ? result.result.value.filter((value): value is string => typeof value === 'string') : [];
  });
}

async function collectIpPage(client: CdpSession, url: string, timeoutMs: number): Promise<string> {
  return parseIp(await collectTextPage(client, url, timeoutMs));
}

async function collectTextPage(client: CdpSession, url: string, timeoutMs: number): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Leak probe URLs must use HTTPS.');
  return withTarget(client, 'about:blank', timeoutMs, async (sessionId) => {
    await client.send('Page.enable', {}, sessionId, timeoutMs);
    await client.send('Runtime.enable', {}, sessionId, timeoutMs);
    const loaded = client.wait('Page.loadEventFired', sessionId, timeoutMs);
    await client.send('Page.navigate', { url }, sessionId, timeoutMs);
    await loaded;
    const result = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: 'document.body?.innerText ?? ""', returnByValue: true, awaitPromise: true,
    }, sessionId, timeoutMs);
    if (result.exceptionDetails) throw new Error('Leak probe page evaluation failed.');
    return typeof result.result?.value === 'string' ? result.result.value.trim() : '';
  });
}

async function withTarget<T>(client: CdpSession, url: string, timeoutMs: number, work: (sessionId: string) => Promise<T>): Promise<T> {
  const created = await client.send<{ targetId: string }>('Target.createTarget', { url, background: true }, undefined, timeoutMs);
  try {
    const attached = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, timeoutMs);
    return await work(attached.sessionId);
  } finally {
    await client.send('Target.closeTarget', { targetId: created.targetId }, undefined, 5_000).catch(() => undefined);
  }
}

export function parseDnsResolvers(text: string): string[] {
  let value: unknown = text.trim();
  try { value = JSON.parse(String(value)); } catch { /* newline or comma-separated text */ }
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { dnsResolvers?: unknown }).dnsResolvers)
      ? (value as { dnsResolvers: unknown[] }).dnsResolvers
      : String(value).split(/[\s,]+/);
  return [...new Set(candidates.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => isIP(item) !== 0))].sort();
}

function parseIp(text: string): string {
  let value = text.trim();
  try {
    const parsed = JSON.parse(value) as { ip?: unknown };
    if (typeof parsed.ip === 'string') value = parsed.ip.trim();
  } catch { /* plain text */ }
  if (!isIP(value)) throw new Error('Probe response did not contain a valid IP address.');
  return value;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
