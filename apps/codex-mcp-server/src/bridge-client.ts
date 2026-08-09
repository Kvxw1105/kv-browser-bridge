import { createConnection, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { healthState, operationClassForMethod, PerTabWriteQueue, timeoutErrorForMethod } from './reliability.js';
import { createClientIdentity, type ClientIdentity } from './client-identity.js';

export type BridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_AUTH_FAILED'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_PROTOCOL_ERROR'
  | 'UNKNOWN_OUTCOME'
  | 'DEBUGGER_DETACHED'
  | 'DEBUGGER_IN_USE'
  | 'BROWSER_NOT_CONNECTED'
  | 'TAB_NOT_FOUND'
  | 'SELECTOR_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export type BridgeConfig = { pipeName?: string; endpoint?: string; token?: string };
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
  operationClass: 'read' | 'non_idempotent_write';
  method: string;
};
type BridgeResponse = { id?: string; result?: unknown; error?: unknown };
type BridgeEvent = { type?: string; event?: string; data?: unknown };
const PIPE_LINE_MAX_BYTES = 1024 * 1024;

export type BridgeStatus = {
  connected: boolean;
  authenticated: boolean;
  endpoint?: string;
  reconnectAttempts: number;
  lastConnectedAt?: string;
  lastError?: { code: BridgeErrorCode; message: string; at: string };
  bridge?: unknown;
  ready: boolean;
  degraded: boolean;
};

export type BridgeClientOptions = {
  requestTimeoutMs: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  identity?: ClientIdentity;
  onEvent?: (event: { type?: string; event?: string; data?: unknown }) => void;
};

function configPaths(): string[] {
  const appData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const explicit = process.env.KV_BROWSER_BRIDGE_CONFIG ?? process.env.LOCAL_CHROME_BRIDGE_CONFIG;
  if (explicit) return [explicit];
  return [
    join(appData, 'KvBrowserBridge', 'bridge.json'),
    // Read the previous location as a compatibility fallback for active clients.
    join(appData, 'CodexLocalChrome', 'bridge.json'),
  ];
}

export function selectUsableBridgeConfig(candidates: BridgeConfig[], overrides: BridgeConfig = {}): BridgeConfig | undefined {
  return candidates.find((candidate) => {
    const endpoint = overrides.endpoint ?? candidate.pipeName ?? candidate.endpoint;
    const token = overrides.token ?? candidate.token;
    return typeof endpoint === 'string' && endpoint.length > 0 && typeof token === 'string' && token.length > 0;
  });
}

async function loadConfig(): Promise<{ endpoint: string; token: string }> {
  const fromEnvironment = {
    endpoint: process.env.KV_BROWSER_BRIDGE_PIPE ?? process.env.LOCAL_CHROME_PIPE,
    token: process.env.KV_BROWSER_BRIDGE_TOKEN ?? process.env.LOCAL_CHROME_TOKEN,
  };

  let fromFile: BridgeConfig = {};
  if (!fromEnvironment.endpoint || !fromEnvironment.token) {
    const candidates: BridgeConfig[] = [];
    let lastError: unknown;
    for (const path of configPaths()) {
      try {
        candidates.push(JSON.parse(await readFile(path, 'utf8')) as BridgeConfig);
      } catch (error) {
        lastError = error;
      }
    }
    fromFile = selectUsableBridgeConfig(candidates, fromEnvironment) ?? {};
    if (!fromFile.pipeName && !fromFile.endpoint && !fromFile.token) {
      throw new BridgeError(
        'BRIDGE_UNAVAILABLE',
        `Could not read Chrome Bridge configuration at ${configPaths().join(' or ')}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        true,
      );
    }
  }

  const endpoint = fromEnvironment.endpoint ?? fromFile.pipeName ?? fromFile.endpoint;
  const token = fromEnvironment.token ?? fromFile.token;
  if (!endpoint || !token) {
    throw new BridgeError('BRIDGE_UNAVAILABLE', 'Chrome Bridge configuration is missing pipeName or token.', true);
  }
  return { endpoint, token };
}

function asBridgeError(error: unknown, fallback = 'INTERNAL_ERROR'): BridgeError {
  if (error instanceof BridgeError) return error;
  if (typeof error === 'object' && error !== null) {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    const code = typeof value.code === 'string' ? value.code as BridgeErrorCode : fallback as BridgeErrorCode;
    const message = typeof value.message === 'string' ? value.message : 'Chrome Bridge request failed.';
    return new BridgeError(code, message, value.retryable === true, value.details);
  }
  return new BridgeError(fallback as BridgeErrorCode, String(error));
}

/** A reconnecting, line-delimited JSON-RPC client. No data is ever written to MCP stdout. */
export class BridgeClient {
  private socket: Socket | null = null;
  private connection: Promise<void> | null = null;
  private endpoint: string | undefined;
  private token: string | undefined;
  private buffer = '';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private authenticated = false;
  private lastConnectedAt: string | undefined;
  private lastError: BridgeStatus['lastError'];
  private bridgeStatus: unknown;
  private sessionId: string | undefined;
  private readonly writeQueue = new PerTabWriteQueue();

  private readonly identity: ClientIdentity;

  constructor(private readonly options: BridgeClientOptions) {
    this.identity = options.identity ?? createClientIdentity();
  }

  getStatus(): BridgeStatus {
    const bridge = this.bridgeStatus as { extensionConnected?: unknown; nativeReady?: unknown; lastExtensionMessageAt?: unknown } | undefined;
    const socketReady = this.socket !== null && !this.socket.destroyed && this.authenticated;
    const health = healthState(socketReady, bridge as { extensionConnected?: boolean; nativeReady?: boolean } | undefined);
    return {
      connected: this.socket !== null && !this.socket.destroyed,
      authenticated: this.authenticated,
      endpoint: this.endpoint,
      reconnectAttempts: this.reconnectAttempts,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      bridge: this.bridgeStatus,
      ready: health.ready,
      degraded: health.degraded,
    };
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    await this.ensureConnected();
    if (!this.socket || !this.authenticated) {
      throw new BridgeError('BRIDGE_UNAVAILABLE', 'Chrome Bridge is not connected.', true);
    }

    const operationClass = operationClassForMethod(method);
    const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
    const idempotencyKey = typeof params.idempotencyKey === 'string' ? params.idempotencyKey : crypto.randomUUID();
    return this.writeQueue.run(tabId, operationClass, () => this.requestOnce(method, params, timeoutMs, operationClass, idempotencyKey));
  }

  private requestOnce(method: string, params: Record<string, unknown>, timeoutMs: number, operationClass: 'read' | 'non_idempotent_write', idempotencyKey: string): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeout = timeoutErrorForMethod(method);
        reject(new BridgeError(timeout.code, `${method} exceeded ${timeoutMs}ms.`, timeout.retryable, { operationClass }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, operationClass });
      this.write({ id, method, params, timeoutMs, deadlineAt: Date.now() + timeoutMs, sessionId: this.sessionId, operationClass, idempotencyKey });
    });
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.authenticated) return;
    if (!this.connection) this.connection = this.connect();
    try {
      await this.connection;
    } catch (error) {
      // A missing Bridge during MCP startup is normal. Keep retrying in the
      // background while returning the classified error to the current tool.
      this.scheduleReconnect();
      throw error;
    } finally {
      this.connection = null;
    }
  }

  private async connect(): Promise<void> {
    const config = await loadConfig();
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.options.log('bridge_connecting', { endpoint: this.endpoint });

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: this.endpoint! });
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new BridgeError('BRIDGE_UNAVAILABLE', `Could not connect to Chrome Bridge: ${error instanceof Error ? error.message : String(error)}`, true));
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        socket.removeListener('error', fail);
        this.installSocket(socket);
        resolve();
      });
    });

    try {
      await this.hello();
      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = undefined;
      this.options.log('bridge_connected', { endpoint: this.endpoint });
    } catch (error) {
      this.socket?.destroy();
      this.socket = null;
      this.authenticated = false;
      const bridgeError = asBridgeError(error, 'BRIDGE_AUTH_FAILED');
      this.recordError(bridgeError);
      throw bridgeError;
    }
  }

  private installSocket(socket: Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => this.readLines(data));
    socket.on('error', (error) => this.options.log('bridge_socket_error', { message: error.message }));
    socket.on('close', () => this.handleDisconnect());
  }

  private async hello(): Promise<void> {
    const result = await this.requestRaw('hello', buildHelloParams(this.identity, this.token),
      Math.min(this.options.requestTimeoutMs, 10_000));
    if (typeof result === 'object' && result !== null && (result as { accepted?: boolean }).accepted === false) {
      throw new BridgeError('BRIDGE_AUTH_FAILED', 'Chrome Bridge rejected the MCP server token.');
    }
    if (typeof result === 'object' && result !== null) {
      const value = result as { sessionId?: unknown; bridge?: unknown };
      this.sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
      this.bridgeStatus = value.bridge;
    }
  }

  private requestRaw(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new BridgeError('BRIDGE_UNAVAILABLE', 'Chrome Bridge socket is unavailable.', true));
    }
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT', `${method} exceeded ${timeoutMs}ms.`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, operationClass: 'read' });
      this.write({ id, method, params, timeoutMs, deadlineAt: Date.now() + timeoutMs });
    });
  }

  private write(message: { id: string; method: string; params: Record<string, unknown>; timeoutMs?: number; deadlineAt?: number; sessionId?: string; operationClass?: 'read' | 'non_idempotent_write'; idempotencyKey?: string }): void {
    if (!this.socket || this.socket.destroyed) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.reject(new BridgeError('BRIDGE_UNAVAILABLE', 'Chrome Bridge disconnected before request could be sent.', true));
      }
      return;
    }
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private readLines(data: string): void {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer, 'utf8') > PIPE_LINE_MAX_BYTES) {
      this.protocolDisconnect('Pipe response line exceeds 1 MiB');
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as BridgeResponse & BridgeEvent;
        if (parsed.type === 'event' && parsed.event === 'connection:status') {
          this.bridgeStatus = parsed.data;
          this.options.log('bridge_connection_status', { bridge: parsed.data as Record<string, unknown> });
        } else if (parsed.type === 'event') {
          this.options.onEvent?.(parsed);
        } else this.handleResponse(parsed);
      } catch (error) {
        this.protocolDisconnect(`Invalid JSON from Chrome Bridge: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  private handleResponse(response: BridgeResponse): void {
    if (!response.id) {
      this.options.log('bridge_notification', { hasError: Boolean(response.error) });
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error !== undefined) {
      const error = asBridgeError(response.error);
      this.recordError(error);
      pending.reject(error);
      return;
    }
    pending.resolve(response.result);
  }

  private protocolDisconnect(message: string): void {
    const error = new BridgeError('BRIDGE_PROTOCOL_ERROR', message, true);
    this.recordError(error);
    this.socket?.destroy();
    this.handleDisconnect();
  }

  private handleDisconnect(): void {
    const wasConnected = this.socket !== null;
    this.socket = null;
    this.authenticated = false;
    const error = new BridgeError('BRIDGE_UNAVAILABLE', 'Chrome Bridge connection closed.', true);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.operationClass === 'non_idempotent_write'
        ? new BridgeError('UNKNOWN_OUTCOME', `${pending.method} may have completed before the Chrome Bridge disconnected.`, false)
        : error);
    }
    this.pending.clear();
    if (wasConnected) this.recordError(error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectAttempts += 1;
    this.options.log('bridge_reconnect_scheduled', { delayMs, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error) => {
        this.recordError(asBridgeError(error, 'BRIDGE_UNAVAILABLE'));
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private recordError(error: BridgeError): void {
    this.lastError = { code: error.code, message: error.message, at: new Date().toISOString() };
    this.options.log('bridge_error', { code: error.code, message: error.message, retryable: error.retryable });
  }
}

export function buildHelloParams(identity: ClientIdentity, token?: string): Record<string, unknown> {
  return {
    ...(token === undefined ? {} : { token }),
    // Keep legacy fields so older Bridge hosts can authenticate and identify us.
    client: 'codex-mcp-server',
    version: '0.1.0',
    clientId: identity.clientId,
    clientName: identity.clientName,
    instanceId: identity.instanceId,
    capabilities: [...identity.capabilities],
  };
}
