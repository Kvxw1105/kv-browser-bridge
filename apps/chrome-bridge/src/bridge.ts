#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import {
  BRIDGE_PROTOCOL_VERSION,
  asBridgeError,
  browserActionFromTool,
  isBrowserResponse,
  isBrowserToolName,
  isExtensionHello,
  isPipeHello,
  isPipeRequest,
  isRecord,
  type BridgeConnectionStatus,
  type BridgeDiscovery,
  type BridgeError,
  type BrowserRequest,
  type ExtensionHandshakeStatus,
  type NativeMessage,
  operationClassFor,
  type PipeEvent,
  type PipeHelloAck,
  type PipeRequest,
  type PipeResponse,
} from '@kv-browser-bridge/browser-protocol';
import {
  bridgeIdentityFromEnv,
  discoveryPathForIdentity,
  publicSessionPathForIdentity,
  publicSessionRecord,
  validateExtensionIdentityHello,
} from './identity/bridge-context.js';
import { JsonlLogger } from './logger.js';
import { NativeMessagingChannel } from './native-channel.js';
import { nativeDisconnectErrorFor } from './native-disconnect.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: BridgeError) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
  operationClass: BrowserRequest['operationClass'];
}

class ChromeBridge {
  private readonly native = new NativeMessagingChannel();
  private readonly logger = new JsonlLogger();
  private readonly startedAt = new Date().toISOString();
  private readonly instanceId = randomUUID();
  private readonly token = randomBytes(32).toString('base64url');
  private readonly pipeName = makePipeName();
  private readonly identity = bridgeIdentityFromEnv();
  private readonly discoveryPath = discoveryPathForIdentity(this.identity);
  private readonly publicSessionPath = this.identity ? publicSessionPathForIdentity(this.identity) : undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly idempotencyInFlight = new Map<string, Promise<unknown>>();
  private readonly idempotencyCompleted = new Map<string, { expiresAt: number; result?: unknown; error?: BridgeError }>();
  private readonly clients = new Set<Socket>();
  private server: Server | undefined;
  private extensionConnected = false;
  private nativeReady = false;
  private generation = 0;
  private lastExtensionMessageAt: string | undefined;
  private lastError: BridgeError | undefined;
  private extensionHandshake: ExtensionHandshakeStatus | undefined;

  start(): void {
    this.native.onMessage((message) => this.handleNativeMessage(message));
    this.native.onError((error) => this.handleNativeError(error));
    this.native.start();

    this.server = createServer((socket) => this.acceptPipeClient(socket));
    this.server.on('error', (error) => {
      this.recordError(this.error('INTERNAL_ERROR', `Named Pipe server error: ${error.message}`, true));
    });
    this.server.listen(this.pipeName, () => {
      this.writeDiscovery();
      // A listening pipe is not evidence that the extension/native channel is ready.
      this.logger.write('info', 'bridge.started', {
        pipeName: this.pipeName,
        discoveryPath: this.discoveryPath,
        identityId: this.identity?.identityId,
        logPath: this.logger.filePath,
      });
      this.sendNative({ type: 'bridge:ready', protocolVersion: BRIDGE_PROTOCOL_VERSION, identity: this.identity });
    });

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', (error) => this.recordError(this.error('INTERNAL_ERROR', String(error), false)));
    process.on('unhandledRejection', (reason) => this.recordError(this.error('INTERNAL_ERROR', String(reason), false)));
  }

  private stop(reason: string): void {
    this.logger.write('info', 'bridge.stopping', { reason, identityId: this.identity?.identityId });
    this.extensionConnected = false;
    this.nativeReady = false;
    this.extensionHandshake = undefined;
    this.removePublicSession();
    this.removeDiscovery();
    const error = this.error('CONNECTION_CLOSED', 'Chrome Bridge stopped', true);
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(request.operationClass === 'non_idempotent_write'
        ? this.error('UNKNOWN_OUTCOME', 'Native connection closed after a write may have started', false, { action: request.method })
        : error);
      this.pending.delete(requestId);
    }
    for (const client of this.clients) client.destroy();
    this.server?.close();
    process.exit(0);
  }

  private handleNativeMessage(message: NativeMessage): void {
    this.extensionConnected = true;
    this.lastExtensionMessageAt = new Date().toISOString();

    if (isExtensionHello(message)) {
      try {
        if (message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error('Extension protocol version does not match the Bridge.');
        validateExtensionIdentityHello(this.identity, message);
        const wasReady = this.nativeReady;
        this.nativeReady = true;
        if (!wasReady) this.generation += 1;
        this.extensionHandshake = {
          acknowledgedAt: this.lastExtensionMessageAt,
          extensionId: message.extensionId,
          extensionVersion: message.extensionVersion,
          userAgent: message.userAgent,
        };
        this.lastError = undefined;
        this.writePublicSession();
        this.logger.write('info', 'extension.identity_acknowledged', {
          identityId: this.identity?.identityId,
          extensionId: message.extensionId,
          extensionVersion: message.extensionVersion,
        });
      } catch (error) {
        this.nativeReady = false;
        this.extensionHandshake = undefined;
        this.removePublicSession();
        this.recordError(this.error(
          'NATIVE_PROTOCOL_ERROR',
          error instanceof Error ? error.message : String(error),
          false,
          { identityId: this.identity?.identityId },
        ));
        return;
      }
      this.broadcastStatus();
      return;
    }

    if (!this.nativeReady) {
      if (this.identity) {
        this.logger.write('warn', 'native.message_before_identity_handshake', {
          identityId: this.identity.identityId,
          type: message.type,
        });
        return;
      }
      // Legacy installed extensions may not send extension:hello. Preserve the
      // original single-browser behavior only for an unbound legacy Bridge.
      this.generation += 1;
      this.nativeReady = true;
    }

    this.broadcastStatus();
    if (!isBrowserResponse(message)) {
      this.logger.write('debug', 'native.message', { type: message.type });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.logger.write('warn', 'native.orphan_response', { requestId: message.requestId });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    const durationMs = Date.now() - pending.startedAt;
    const error = asBridgeError(message.error);
    this.logger.write(error ? 'warn' : 'info', 'browser.response', {
      requestId: message.requestId,
      method: pending.method,
      durationMs,
      errorCode: error?.code,
      identityId: this.identity?.identityId,
    });
    if (error) pending.reject(error);
    else pending.resolve(message.result);
  }

  private handleNativeError(error: Error): void {
    this.extensionConnected = false;
    this.nativeReady = false;
    this.extensionHandshake = undefined;
    this.removePublicSession();
    const bridgeError = nativeDisconnectErrorFor('read', error.message);
    this.recordError(bridgeError);
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(nativeDisconnectErrorFor(request.operationClass, error.message));
      this.pending.delete(requestId);
    }
  }

  private acceptPipeClient(socket: Socket): void {
    let authenticated = false;
    const sessionId = randomUUID();
    let lineBuffer = '';
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      lineBuffer += data;
      if (Buffer.byteLength(lineBuffer, 'utf8') > 1024 * 1024) {
        this.writePipe(socket, this.pipeError('__protocol__', 'INVALID_REQUEST', 'Pipe input line exceeds 1 MiB', false));
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        this.handlePipeLine(socket, line, authenticated, sessionId, (isAuthenticated) => {
          authenticated = isAuthenticated;
          if (isAuthenticated && helloTimer) {
            clearTimeout(helloTimer);
            helloTimer = undefined;
            this.clients.add(socket);
          }
        });
      }
    });
    socket.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer);
      this.clients.delete(socket);
    });
    socket.on('error', (error) => this.logger.write('debug', 'pipe.client_error', { message: error.message }));
  }

  private handlePipeLine(socket: Socket, line: string, authenticated: boolean, sessionId: string, setAuthenticated: (value: boolean) => void): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.writePipe(socket, this.pipeError('__protocol__', 'INVALID_REQUEST', 'Pipe messages must be JSON objects', false));
      return;
    }

    if (!authenticated) {
      const rpcHello = asRpcHello(message);
      if (rpcHello) {
        const clientVersion = rpcHello.params.version;
        const clientName = rpcHello.params.client;
        if (!isSupportedVersion(clientVersion) || rpcHello.params.token !== this.token) {
          this.logger.write('warn', 'pipe.authentication_failed', { clientName, identityId: this.identity?.identityId });
          this.writePipe(socket, this.pipeError(rpcHello.id, 'AUTHENTICATION_FAILED', 'Invalid Bridge token or protocol version', false));
          socket.destroy();
          return;
        }
        setAuthenticated(true);
        (socket as Socket & { kvClientId?: string }).kvClientId = clientName ?? 'anonymous';
        this.writePipe(socket, {
          id: rpcHello.id,
          result: { accepted: true, protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId, bridge: this.status() },
        });
        this.logger.write('info', 'pipe.client_authenticated', { clientName, identityId: this.identity?.identityId });
        return;
      }
      if (!isPipeHello(message)) {
        this.writePipe(socket, this.pipeError('__hello__', 'AUTHENTICATION_FAILED', 'Send a valid hello message before requests', false));
        socket.destroy();
        return;
      }
      const clientVersion = message.version ?? message.protocolVersion;
      const clientName = message.client ?? message.clientName;
      if (!isSupportedVersion(clientVersion) || message.token !== this.token) {
        this.logger.write('warn', 'pipe.authentication_failed', { clientName, identityId: this.identity?.identityId });
        this.writePipe(socket, this.pipeError('__hello__', 'AUTHENTICATION_FAILED', 'Invalid Bridge token or protocol version', false));
        socket.destroy();
        return;
      }
      setAuthenticated(true);
      (socket as Socket & { kvClientId?: string }).kvClientId = clientName ?? 'anonymous';
      const ack: PipeHelloAck = {
        type: 'hello:ack',
        version: BRIDGE_PROTOCOL_VERSION,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        bridge: this.status(),
      };
      this.writePipe(socket, ack);
      this.logger.write('info', 'pipe.client_authenticated', { clientName, identityId: this.identity?.identityId });
      return;
    }

    if (!isPipeRequest(message)) {
      this.writePipe(socket, this.pipeError('__protocol__', 'INVALID_REQUEST', 'Unsupported Pipe message', false));
      return;
    }
    void this.handlePipeRequest(socket, message, sessionId);
  }

  private async handlePipeRequest(socket: Socket, request: PipeRequest, authenticatedSessionId: string): Promise<void> {
    if (request.method === 'browser_connection_status') {
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: this.status() } satisfies PipeResponse);
      return;
    }
    if (!isBrowserToolName(request.method)) {
      this.writePipe(socket, this.pipeError(request.id, 'INVALID_REQUEST', `Unsupported browser method: ${request.method}`, false));
      return;
    }
    const clientIdentity = (socket as Socket & { kvClientId?: string }).kvClientId ?? authenticatedSessionId;
    const cacheKey = `${clientIdentity}:${request.idempotencyKey ?? request.id}`;
    if (this.idempotencyCompleted.size > 1024) {
      const now = Date.now();
      for (const [key, value] of this.idempotencyCompleted) {
        if (value.expiresAt <= now || this.idempotencyCompleted.size > 1024) this.idempotencyCompleted.delete(key);
      }
    }
    const cached = this.idempotencyCompleted.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.writePipe(socket, cached.error
        ? { type: 'response', id: request.id, ok: false, error: cached.error }
        : { type: 'response', id: request.id, ok: true, result: cached.result });
      return;
    }
    try {
      let execution = this.idempotencyInFlight.get(cacheKey);
      if (!execution) {
        execution = this.forwardBrowserRequest(request.id, authenticatedSessionId, browserActionFromTool(request.method), request.params ?? {}, request.timeoutMs, request.deadlineAt);
        this.idempotencyInFlight.set(cacheKey, execution);
      }
      const result = await execution;
      this.idempotencyCompleted.set(cacheKey, { expiresAt: Date.now() + 30_000, result });
      if (request.method === 'browser_screenshot') this.persistScreenshotArtifact(result, request.params?.artifactPath, request.params?.artifactOnly === true);
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
    } catch (error) {
      const bridgeError = isBridgeError(error)
        ? error
        : this.error('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), false);
      this.idempotencyCompleted.set(cacheKey, { expiresAt: Date.now() + 30_000, error: bridgeError });
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: bridgeError } satisfies PipeResponse);
    } finally {
      this.idempotencyInFlight.delete(cacheKey);
    }
  }

  private forwardBrowserRequest(requestId: string, sessionId: string, action: BrowserRequest['action'], params: Record<string, unknown>, requestedTimeout?: number, requestedDeadline?: number): Promise<unknown> {
    if (!this.extensionConnected || !this.nativeReady) {
      return Promise.reject(this.error('BRIDGE_NOT_READY', this.identity
        ? `Chrome Extension has not completed the identity handshake for ${this.identity.identityId}.`
        : 'Chrome Extension is not connected to the Bridge', true));
    }
    const timeoutMs = clampTimeout(requestedTimeout);
    const deadlineAt = Math.min(typeof requestedDeadline === 'number' ? requestedDeadline : Infinity, Date.now() + timeoutMs);
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    // The authenticated bridge is the trust boundary for retry semantics.
    const operationClass = operationClassFor(action);
    const request: BrowserRequest = { type: 'browser:request', requestId, sessionId, action, params, timeoutMs, deadlineAt, operationClass };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        const timeout = this.error(operationClass === 'non_idempotent_write' ? 'UNKNOWN_OUTCOME' : 'REQUEST_TIMEOUT', `Browser action ${action} exceeded ${timeoutMs}ms`, operationClass === 'read', { action, timeoutMs, deadlineAt, operationClass });
        this.recordError(timeout);
        reject(timeout);
      }, remainingMs);
      this.pending.set(requestId, { resolve, reject, timer, method: `browser_${action}`, startedAt: Date.now(), operationClass });
      try {
        this.sendNative(request);
        this.logger.write('info', 'browser.request', { requestId, method: `browser_${action}`, timeoutMs, identityId: this.identity?.identityId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(this.error('CONNECTION_CLOSED', error instanceof Error ? error.message : String(error), true));
      }
    });
  }

  private sendNative(message: NativeMessage): void {
    try {
      this.native.send(message);
    } catch (error) {
      const bridgeError = this.error('NATIVE_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error), true);
      this.recordError(bridgeError);
      throw bridgeError;
    }
  }

  private persistScreenshotArtifact(result: unknown, artifactPath: unknown, artifactOnly = false): void {
    if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath)) return;
    if (!isRecord(result)) throw this.error('INVALID_REQUEST', 'Screenshot response is invalid', false);
    const dataUrl = result.dataUrl;
    if (typeof dataUrl !== 'string') throw this.error('EXTENSION_ERROR', 'Screenshot response did not include PNG data', false);
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw this.error('EXTENSION_ERROR', 'Screenshot response is not a PNG data URL', false);
    try {
      mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
      writeFileSync(artifactPath, Buffer.from(match[1], 'base64'), { mode: 0o600 });
      result.artifactPath = artifactPath;
      if (artifactOnly) delete result.dataUrl;
      this.logger.write('info', 'screenshot.saved', { artifactPath });
    } catch (error) {
      throw this.error('INTERNAL_ERROR', `Could not save screenshot artifact: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  private status(): BridgeConnectionStatus {
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      extensionConnected: this.extensionConnected,
      pipeName: this.pipeName,
      startedAt: this.startedAt,
      pendingRequests: this.pending.size,
      lastExtensionMessageAt: this.lastExtensionMessageAt,
      lastError: this.lastError,
      instanceId: this.instanceId,
      generation: this.generation,
      nativeReady: this.nativeReady,
      identity: this.identity,
      extensionHandshake: this.extensionHandshake,
    };
  }

  private discoveryRecord(): BridgeDiscovery {
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pipeName: this.pipeName,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      identity: this.identity,
    };
  }

  private writeDiscovery(): void {
    mkdirSync(dirname(this.discoveryPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.discoveryPath, JSON.stringify(this.discoveryRecord(), null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  private writePublicSession(): void {
    if (!this.publicSessionPath || !this.identity || !this.nativeReady) return;
    mkdirSync(dirname(this.publicSessionPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.publicSessionPath, `${JSON.stringify(publicSessionRecord(this.discoveryRecord()), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private removePublicSession(): void {
    if (this.publicSessionPath) rmSync(this.publicSessionPath, { force: true });
  }

  private removeDiscovery(): void {
    rmSync(this.discoveryPath, { force: true });
  }

  private broadcastStatus(): void {
    const event: PipeEvent = { type: 'event', event: 'connection:status', data: this.status() };
    for (const socket of this.clients) this.writePipe(socket, event);
  }

  private writePipe(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  private pipeError(id: string, code: BridgeError['code'], message: string, retryable: boolean): PipeResponse {
    return { type: 'response', id, ok: false, error: this.error(code, message, retryable) };
  }

  private error(code: BridgeError['code'], message: string, retryable: boolean, details?: Record<string, unknown>): BridgeError {
    return { code, message, retryable, details };
  }

  private recordError(error: BridgeError): void {
    this.lastError = error;
    this.logger.write('error', 'bridge.error', { code: error.code, message: error.message, retryable: error.retryable, identityId: this.identity?.identityId });
    this.broadcastStatus();
  }
}

function makePipeName(): string {
  const suffix = randomBytes(12).toString('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\kv-browser-bridge-${process.pid}-${suffix}`;
  return join(tmpdir(), `kv-browser-bridge-${process.pid}-${suffix}.sock`);
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1_000, Math.floor(value)));
}

function isBridgeError(value: unknown): value is BridgeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value && 'retryable' in value;
}

function isSupportedVersion(version: unknown): boolean {
  return version === BRIDGE_PROTOCOL_VERSION || version === '0.1.0';
}

function asRpcHello(value: unknown): { id: string; params: { token: string; client?: string; version?: unknown } } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.method !== 'hello' || !isRecord(value.params)) return undefined;
  if (typeof value.params.token !== 'string') return undefined;
  return {
    id: value.id,
    params: {
      token: value.params.token,
      client: typeof value.params.client === 'string' ? value.params.client : undefined,
      version: value.params.version,
    },
  };
}

/** Test seam: exercises the real private native-error handler with a pending request. */
export async function testActualNativeDisconnect(operationClass: BrowserRequest['operationClass']): Promise<BridgeError> {
  const bridge = Object.create(ChromeBridge.prototype) as ChromeBridge;
  const rejected = new Promise<BridgeError>((resolve) => {
    (bridge as any).pending = new Map([['test', {
      resolve: () => undefined,
      reject: resolve,
      timer: setTimeout(() => undefined, 60_000),
      method: 'browser_click',
      startedAt: Date.now(),
      operationClass,
    }]]);
  });
  (bridge as any).recordError = () => undefined;
  (bridge as any).broadcastStatus = () => undefined;
  (bridge as any).removePublicSession = () => undefined;
  (bridge as any).handleNativeError(new Error('fake native disconnect'));
  return rejected;
}

if (process.env.KV_BRIDGE_TEST !== '1') new ChromeBridge().start();
