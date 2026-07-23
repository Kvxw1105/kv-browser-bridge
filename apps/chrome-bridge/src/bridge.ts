#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import {
  BRIDGE_PROTOCOL_VERSION,
  asBridgeError,
  browserActionFromTool,
  isBrowserResponse,
  isBrowserToolName,
  isPipeHello,
  isPipeRequest,
  isRecord,
  type BridgeConnectionStatus,
  type BridgeDiscovery,
  type BridgeError,
  type BrowserRequest,
  type NativeMessage,
  type PipeEvent,
  type PipeHelloAck,
  type PipeRequest,
  type PipeResponse,
} from '@kv-browser-bridge/browser-protocol';
import { JsonlLogger } from './logger.js';
import { NativeMessagingChannel } from './native-channel.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: BridgeError) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
}

class ChromeBridge {
  private readonly native = new NativeMessagingChannel();
  private readonly logger = new JsonlLogger();
  private readonly startedAt = new Date().toISOString();
  private readonly token = randomBytes(32).toString('base64url');
  private readonly pipeName = makePipeName();
  private readonly discoveryPath = makeDiscoveryPath();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly clients = new Set<Socket>();
  private server: Server | undefined;
  private extensionConnected = false;
  private lastExtensionMessageAt: string | undefined;
  private lastError: BridgeError | undefined;

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
      this.extensionConnected = true;
      this.broadcastStatus();
      this.logger.write('info', 'bridge.started', {
        pipeName: this.pipeName,
        discoveryPath: this.discoveryPath,
        logPath: this.logger.filePath,
      });
      this.sendNative({ type: 'bridge:ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    });

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', (error) => this.recordError(this.error('INTERNAL_ERROR', String(error), false)));
    process.on('unhandledRejection', (reason) => this.recordError(this.error('INTERNAL_ERROR', String(reason), false)));
  }

  private stop(reason: string): void {
    this.logger.write('info', 'bridge.stopping', { reason });
    this.extensionConnected = false;
    const error = this.error('CONNECTION_CLOSED', 'Chrome Bridge stopped', true);
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(requestId);
    }
    for (const client of this.clients) client.destroy();
    this.server?.close();
    process.exit(0);
  }

  private handleNativeMessage(message: NativeMessage): void {
    this.extensionConnected = true;
    this.lastExtensionMessageAt = new Date().toISOString();
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
    });
    if (error) pending.reject(error);
    else pending.resolve(message.result);
  }

  private handleNativeError(error: Error): void {
    this.extensionConnected = false;
    const bridgeError = this.error('CONNECTION_CLOSED', `Chrome Native Messaging disconnected: ${error.message}`, true);
    this.recordError(bridgeError);
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(bridgeError);
      this.pending.delete(requestId);
    }
    this.broadcastStatus();
  }

  private acceptPipeClient(socket: Socket): void {
    let authenticated = false;
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
        this.handlePipeLine(socket, line, authenticated, (isAuthenticated) => {
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

  private handlePipeLine(socket: Socket, line: string, authenticated: boolean, setAuthenticated: (value: boolean) => void): void {
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
          this.logger.write('warn', 'pipe.authentication_failed', { clientName });
          this.writePipe(socket, this.pipeError(rpcHello.id, 'AUTHENTICATION_FAILED', 'Invalid Bridge token or protocol version', false));
          socket.destroy();
          return;
        }
        setAuthenticated(true);
        this.writePipe(socket, {
          id: rpcHello.id,
          result: { accepted: true, protocolVersion: BRIDGE_PROTOCOL_VERSION, bridge: this.status() },
        });
        this.logger.write('info', 'pipe.client_authenticated', { clientName });
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
        this.logger.write('warn', 'pipe.authentication_failed', { clientName });
        this.writePipe(socket, this.pipeError('__hello__', 'AUTHENTICATION_FAILED', 'Invalid Bridge token or protocol version', false));
        socket.destroy();
        return;
      }
      setAuthenticated(true);
      const ack: PipeHelloAck = {
        type: 'hello:ack',
        version: BRIDGE_PROTOCOL_VERSION,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        bridge: this.status(),
      };
      this.writePipe(socket, ack);
      this.logger.write('info', 'pipe.client_authenticated', { clientName });
      return;
    }

    if (!isPipeRequest(message)) {
      this.writePipe(socket, this.pipeError('__protocol__', 'INVALID_REQUEST', 'Unsupported Pipe message', false));
      return;
    }
    void this.handlePipeRequest(socket, message);
  }

  private async handlePipeRequest(socket: Socket, request: PipeRequest): Promise<void> {
    if (request.method === 'browser_connection_status') {
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: this.status() } satisfies PipeResponse);
      return;
    }
    if (!isBrowserToolName(request.method)) {
      this.writePipe(socket, this.pipeError(request.id, 'INVALID_REQUEST', `Unsupported browser method: ${request.method}`, false));
      return;
    }
    try {
      const result = await this.forwardBrowserRequest(browserActionFromTool(request.method), request.params ?? {}, request.timeoutMs);
      if (request.method === 'browser_screenshot') this.persistScreenshotArtifact(result, request.params?.artifactPath);
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
    } catch (error) {
      const bridgeError = isBridgeError(error)
        ? error
        : this.error('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), false);
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: bridgeError } satisfies PipeResponse);
    }
  }

  private forwardBrowserRequest(action: BrowserRequest['action'], params: Record<string, unknown>, requestedTimeout?: number): Promise<unknown> {
    if (!this.extensionConnected) {
      return Promise.reject(this.error('BRIDGE_NOT_READY', 'Chrome Extension is not connected to the Bridge', true));
    }
    const requestId = randomUUID();
    const timeoutMs = clampTimeout(requestedTimeout);
    const request: BrowserRequest = { type: 'browser:request', requestId, action, params, timeoutMs };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        const timeout = this.error('REQUEST_TIMEOUT', `Browser action ${action} exceeded ${timeoutMs}ms`, true, { action, timeoutMs });
        this.recordError(timeout);
        reject(timeout);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method: `browser_${action}`, startedAt: Date.now() });
      try {
        this.sendNative(request);
        this.logger.write('info', 'browser.request', { requestId, method: `browser_${action}`, timeoutMs });
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

  private persistScreenshotArtifact(result: unknown, artifactPath: unknown): void {
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
    };
  }

  private writeDiscovery(): void {
    const configDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const discovery: BridgeDiscovery = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pipeName: this.pipeName,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
    };
    writeFileSync(this.discoveryPath, JSON.stringify(discovery, null, 2), { encoding: 'utf8', mode: 0o600 });
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
    this.logger.write('error', 'bridge.error', { code: error.code, message: error.message, retryable: error.retryable });
    this.broadcastStatus();
  }
}

function makePipeName(): string {
  const suffix = randomBytes(12).toString('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\kv-browser-bridge-${process.pid}-${suffix}`;
  return join(tmpdir(), `kv-browser-bridge-${process.pid}-${suffix}.sock`);
}

function makeDiscoveryPath(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'bridge.json');
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

new ChromeBridge().start();
