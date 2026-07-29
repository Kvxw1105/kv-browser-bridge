#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  operationClassFor,
  type PipeEvent,
  type PipeHelloAck,
  type PipeRequest,
  type PipeResponse,
  type BrowserAction,
  type AgentCapability,
  type AgentIdentity,
  type CoordinationStatusView,
  type CoordinationPipeMethod,
  isAgentIdentity,
  serializeCoordinationStatus,
} from '@kv-browser-bridge/browser-protocol';
import { JsonlLogger } from './logger.js';
import { NativeMessagingChannel } from './native-channel.js';
import { nativeDisconnectErrorFor } from './native-disconnect.js';
import { KvRuntime, runtimeMode } from './runtime.js';
import { CoordinatorError, MultiAgentCoordinator } from './coordinator.js';

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

type BridgeSocket = Socket & {
  kvSessionId?: string;
  kvIdentity?: AgentIdentity;
};

interface RecordingLeases {
  tabId: number;
  recorderLeaseId: string;
  tabLeaseId: string;
}

class ChromeBridge {
  private readonly native = new NativeMessagingChannel();
  private readonly logger = new JsonlLogger();
  private readonly runtime = runtimeMode() === 'legacy' ? undefined : new KvRuntime();
  private readonly startedAt = new Date().toISOString();
  private readonly instanceId = randomUUID();
  private readonly token = randomBytes(32).toString('base64url');
  private readonly pipeName = makePipeName();
  private readonly discoveryPath = makeDiscoveryPath();
  private readonly pending = new Map<string, PendingRequest>();
  private nativeRequestSequence = 0;
  private readonly idempotencyInFlight = new Map<string, Promise<unknown>>();
  private readonly idempotencyCompleted = new Map<string, { expiresAt: number; result?: unknown; error?: BridgeError }>();
  private readonly clients = new Set<Socket>();
  private readonly coordinator = new MultiAgentCoordinator({
    mode: coordinationMode(),
    onConflict: (conflict) => this.logger.write('warn', 'coordination.conflict', { ...conflict }),
  });
  private readonly coordinationMode = coordinationMode();
  private readonly recordingLeases = new Map<string, RecordingLeases>();
  private replay: { runId: string; recipe: Record<string, unknown>; nextStep: number } | undefined;
  private server: Server | undefined;
  private extensionConnected = false;
  private nativeReady = false;
  private generation = 0;
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
      // A listening pipe is not evidence that the extension/native channel is ready.
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
      request.reject(request.operationClass === 'non_idempotent_write'
        ? this.error('UNKNOWN_OUTCOME', 'Native connection closed after a write may have started', false, { action: request.method })
        : error);
      this.pending.delete(requestId);
    }
    for (const client of this.clients) client.destroy();
    this.runtimeSafe(() => this.runtime?.close());
    this.server?.close();
    process.exit(0);
  }

  private handleNativeMessage(message: NativeMessage): void {
    this.extensionConnected = true;
    if (!this.nativeReady) this.generation += 1;
    this.nativeReady = true;
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
    this.nativeReady = false;
    const bridgeError = nativeDisconnectErrorFor('read', error.message);
    this.recordError(bridgeError);
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(nativeDisconnectErrorFor(request.operationClass, error.message));
      this.pending.delete(requestId);
    }
    this.broadcastStatus();
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
        this.handlePipeLine(socket as BridgeSocket, line, authenticated, sessionId, (isAuthenticated) => {
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
      const bridgeSocket = socket as BridgeSocket;
      if (bridgeSocket.kvSessionId) {
        this.coordinator.disconnect(bridgeSocket.kvSessionId);
        this.recordingLeases.delete(bridgeSocket.kvSessionId);
        this.broadcastCoordinationStatus();
      }
    });
    socket.on('error', (error) => this.logger.write('debug', 'pipe.client_error', { message: error.message }));
  }

  private handlePipeLine(socket: BridgeSocket, line: string, authenticated: boolean, sessionId: string, setAuthenticated: (value: boolean) => void): void {
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
        const identity = identityFromHello(rpcHello.params, sessionId);
        if (!identity) {
          this.writePipe(socket, this.pipeError(rpcHello.id, 'INVALID_REQUEST', 'Invalid Agent identity', false));
          socket.destroy();
          return;
        }
        try {
          this.coordinator.connect(identity, sessionId);
        } catch (error) {
          this.writePipe(socket, this.pipeError(rpcHello.id, 'INVALID_REQUEST', error instanceof Error ? error.message : String(error), false));
          socket.destroy();
          return;
        }
        setAuthenticated(true);
        socket.kvSessionId = sessionId;
        socket.kvIdentity = identity;
        (socket as Socket & { kvClientId?: string }).kvClientId = identity.clientId;
        this.writePipe(socket, {
          id: rpcHello.id,
          result: { accepted: true, protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId, bridge: this.status() },
        });
        this.logger.write('info', 'pipe.client_authenticated', { clientName });
        this.broadcastCoordinationStatus();
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
      const identity = identityFromHello(message, sessionId);
      if (!identity) {
        this.writePipe(socket, this.pipeError('__hello__', 'INVALID_REQUEST', 'Invalid Agent identity', false));
        socket.destroy();
        return;
      }
      try {
        this.coordinator.connect(identity, sessionId);
      } catch (error) {
        this.writePipe(socket, this.pipeError('__hello__', 'INVALID_REQUEST', error instanceof Error ? error.message : String(error), false));
        socket.destroy();
        return;
      }
      setAuthenticated(true);
      socket.kvSessionId = sessionId;
      socket.kvIdentity = identity;
      (socket as Socket & { kvClientId?: string }).kvClientId = identity.clientId;
      const ack: PipeHelloAck = {
        type: 'hello:ack',
        version: BRIDGE_PROTOCOL_VERSION,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        bridge: this.status(),
      };
      this.writePipe(socket, ack);
      this.logger.write('info', 'pipe.client_authenticated', { clientName });
      this.broadcastCoordinationStatus();
      return;
    }

    if (!isPipeRequest(message)) {
      this.writePipe(socket, this.pipeError('__protocol__', 'INVALID_REQUEST', 'Unsupported Pipe message', false));
      return;
    }
    void this.handlePipeRequest(socket, message, socket.kvSessionId ?? sessionId);
  }

  private async handlePipeRequest(socket: BridgeSocket, request: PipeRequest, authenticatedSessionId: string): Promise<void> {
    if (request.method === 'browser_connection_status') {
      this.coordinator.touch(authenticatedSessionId);
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: this.status() } satisfies PipeResponse);
      return;
    }
    if (isRuntimeMethod(request.method)) {
      this.coordinator.touch(authenticatedSessionId);
      await this.handleRuntimeRequest(socket, request, authenticatedSessionId);
      return;
    }
    if (isCoordinationMethod(request.method)) {
      this.coordinator.touch(authenticatedSessionId);
      await this.handleCoordinationRequest(socket, request, authenticatedSessionId);
      return;
    }
    if (!isBrowserToolName(request.method)) {
      this.writePipe(socket, this.pipeError(request.id, 'INVALID_REQUEST', `Unsupported browser method: ${request.method}`, false));
      return;
    }
    const clientIdentity = socket.kvIdentity?.clientId ?? authenticatedSessionId;
    const action = browserActionFromTool(request.method);
    const sessionId = socket.kvSessionId ?? authenticatedSessionId;
    const cacheKey = `${clientIdentity}:${request.method}:${action}:${request.idempotencyKey ?? request.id}`;
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
    const existingExecution = this.idempotencyInFlight.get(cacheKey);
    if (existingExecution) {
      try {
        const result = await existingExecution;
        this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
      } catch (error) {
        this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: this.coordinatorError(error) } satisfies PipeResponse);
      }
      return;
    }
    let settleExecution!: (value: unknown) => void;
    let rejectExecution!: (reason?: unknown) => void;
    const reservedExecution = new Promise<unknown>((resolve, reject) => {
      settleExecution = resolve;
      rejectExecution = reject;
    });
    reservedExecution.catch(() => undefined);
    this.idempotencyInFlight.set(cacheKey, reservedExecution);
    this.coordinator.touch(authenticatedSessionId);
    const originalParams = { ...(request.params ?? {}) };
    let params: Record<string, unknown>;
    try {
      params = this.resolveCoordinationParams(sessionId, action, originalParams);
      if (action === 'switch_tab' && typeof params.tabId === 'number') {
        this.coordinator.setDefaultTab(sessionId, params.tabId);
        this.broadcastCoordinationStatus();
      }
      if (action === 'record_start' && typeof params.tabId === 'number') {
        this.acquireRecordingLeases(sessionId, params.tabId, params.intent);
      }
    } catch (error) {
      const bridgeError = this.coordinatorError(error);
      rejectExecution(error);
      this.idempotencyCompleted.set(cacheKey, { expiresAt: Date.now() + 30_000, error: bridgeError });
      this.idempotencyInFlight.delete(cacheKey);
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: bridgeError } satisfies PipeResponse);
      return;
    }
    const eventId = this.runtimeSafe(() => this.runtime?.recordRequest(
      request.method,
      params,
      operationClassFor(action),
      typeof params.tabId === 'number' ? params.tabId : undefined,
    ));
    try {
      const execution = this.coordinateBrowserRequest(request.id, sessionId, action, params, request.timeoutMs, request.deadlineAt);
      execution.then(settleExecution, rejectExecution);
      const result = await execution;
      this.idempotencyCompleted.set(cacheKey, { expiresAt: Date.now() + 30_000, result });
      if (request.method === 'browser_screenshot') this.persistScreenshotArtifact(result, params.artifactPath, params.artifactOnly === true);
      if (action === 'record_stop') this.releaseRecordingLeases(sessionId, params.tabId, false);
      this.runtimeSafe(() => {
        this.runtime?.recordResult(eventId, result);
        if (request.method === 'browser_screenshot' && isRecord(result)) this.runtime?.addArtifact(eventId, 'screenshot', result.artifactPath);
        if (request.method === 'browser_record_stop') this.runtime?.saveRecipeDraft(result);
      });
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
    } catch (error) {
      const bridgeError = this.coordinatorError(error);
      rejectExecution(error);
      this.idempotencyCompleted.set(cacheKey, { expiresAt: Date.now() + 30_000, error: bridgeError });
      this.runtimeSafe(() => this.runtime?.recordResult(eventId, undefined, bridgeError));
      if (action === 'record_start') this.releaseRecordingLeases(sessionId, params.tabId, bridgeError.code === 'UNKNOWN_OUTCOME');
      if (bridgeError.code === 'UNKNOWN_OUTCOME' && action !== 'record_start' && action !== 'record_stop' && typeof params.tabId === 'number') this.quarantineTab(sessionId, params.tabId);
      if (action === 'record_stop') this.releaseRecordingLeases(sessionId, params.tabId, bridgeError.code === 'UNKNOWN_OUTCOME');
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: bridgeError } satisfies PipeResponse);
    } finally {
      this.idempotencyInFlight.delete(cacheKey);
    }
  }

  private resolveCoordinationParams(sessionId: string, action: BrowserAction, params: Record<string, unknown>): Record<string, unknown> {
    const resolved = { ...params };
    const suppliedTabId = typeof resolved.tabId === 'number' ? resolved.tabId : undefined;
    if (!actionRequiresTab(action)) return resolved;
    const tabId = this.coordinator.resolveTab(sessionId, suppliedTabId);
    if (tabId !== undefined) {
      resolved.tabId = tabId;
      return resolved;
    }
    if (this.coordinationMode === 'observe') {
      this.logger.write('warn', 'coordination.missing_tab', { action, sessionId });
      return resolved;
    }
    if (this.coordinationMode === 'enforce') {
      throw this.error('TAB_ID_REQUIRED', `browser_${action} requires a session target tab`, false, { action });
    }
    return resolved;
  }

  private coordinateBrowserRequest(
    requestId: string,
    sessionId: string,
    action: BrowserAction,
    params: Record<string, unknown>,
    requestedTimeout?: number,
    requestedDeadline?: number,
  ): Promise<unknown> {
    const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
    const execute = () => this.forwardBrowserRequest(requestId, sessionId, action, params, requestedTimeout, requestedDeadline);
    if (tabId === undefined || operationClassFor(action) === 'read') return execute();
    this.coordinator.assertWriteAllowed(sessionId, tabId);
    return this.coordinator.runTabWrite(tabId, execute);
  }

  private acquireRecordingLeases(sessionId: string, tabId: number, purpose: unknown): void {
    const existing = this.recordingLeases.get(sessionId);
    if (existing) {
      if (existing.tabId !== tabId) {
        throw this.error('INVALID_REQUEST', 'Recording lease already targets a different tab', false, {
          activeTabId: existing.tabId,
          requestedTabId: tabId,
        });
      }
      return;
    }
    const label = typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'recording';
    const recorderLease = this.coordinator.acquire(sessionId, 'global:recorder', label, 300_000);
    try {
      const tabLease = this.coordinator.acquire(sessionId, `tab:${tabId}`, label, 300_000);
      this.recordingLeases.set(sessionId, { tabId, recorderLeaseId: recorderLease.id, tabLeaseId: tabLease.id });
      this.broadcastCoordinationStatus();
    } catch (error) {
      try { this.coordinator.release(sessionId, recorderLease.id); } catch { /* best effort rollback */ }
      throw error;
    }
  }

  private releaseRecordingLeases(sessionId: string, tabId: unknown, ambiguous: boolean): void {
    const leases = this.recordingLeases.get(sessionId);
    const targetTabId = typeof tabId === 'number' ? tabId : leases?.tabId;
    if (leases) {
      try { this.coordinator.release(sessionId, leases.tabLeaseId); } catch { /* expired/disconnected */ }
      try { this.coordinator.release(sessionId, leases.recorderLeaseId); } catch { /* expired/disconnected */ }
      this.recordingLeases.delete(sessionId);
    }
    if (ambiguous && targetTabId !== undefined) this.quarantineTab(sessionId, targetTabId);
    this.broadcastCoordinationStatus();
  }

  private quarantineTab(sessionId: string, tabId: number): void {
    try {
      this.coordinator.quarantineTab(sessionId, tabId);
      this.broadcastCoordinationStatus();
    } catch (error) {
      this.logger.write('warn', 'coordination.quarantine_failed', { sessionId, tabId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private coordinatorError(error: unknown): BridgeError {
    if (error instanceof CoordinatorError) return this.error(error.code, error.message, error.retryable, error.details);
    if (isBridgeError(error)) return error;
    return this.error('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), false);
  }

  private forwardBrowserRequest(requestId: string, sessionId: string, action: BrowserRequest['action'], params: Record<string, unknown>, requestedTimeout?: number, requestedDeadline?: number): Promise<unknown> {
    if (!this.extensionConnected) {
      return Promise.reject(this.error('BRIDGE_NOT_READY', 'Chrome Extension is not connected to the Bridge', true));
    }
    const timeoutMs = clampTimeout(requestedTimeout);
    const deadlineAt = Math.min(typeof requestedDeadline === 'number' ? requestedDeadline : Infinity, Date.now() + timeoutMs);
    if (typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline) && requestedDeadline <= Date.now()) {
      return Promise.reject(this.error('REQUEST_TIMEOUT', `Browser action ${action} deadline has expired`, operationClassFor(action) === 'read', { action, deadlineAt: requestedDeadline }));
    }
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    // The authenticated bridge is the trust boundary for retry semantics.
    const operationClass = operationClassFor(action);
    const nativeRequestId = `${this.instanceId}:${++this.nativeRequestSequence}`;
    const request: BrowserRequest = { type: 'browser:request', requestId: nativeRequestId, sessionId, action, params, timeoutMs, deadlineAt, operationClass };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(nativeRequestId)) return;
        const timeout = this.error(operationClass === 'non_idempotent_write' ? 'UNKNOWN_OUTCOME' : 'REQUEST_TIMEOUT', `Browser action ${action} exceeded ${timeoutMs}ms`, operationClass === 'read', { action, timeoutMs, deadlineAt, operationClass });
        this.recordError(timeout);
        reject(timeout);
      }, remainingMs);
      this.pending.set(nativeRequestId, { resolve, reject, timer, method: `browser_${action}`, startedAt: Date.now(), operationClass });
      try {
        this.sendNative(request);
        this.logger.write('info', 'browser.request', { requestId: nativeRequestId, method: `browser_${action}`, timeoutMs });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(nativeRequestId);
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

  private async handleCoordinationRequest(socket: Socket, request: PipeRequest, sessionId: string): Promise<void> {
    try {
      const method = request.method as CoordinationPipeMethod;
      const status = () => serializeCoordinationStatus(this.coordinator.status());
      let result: unknown;
      if (method === 'browser_get_clients') {
        result = { clients: status().clients };
      } else if (method === 'browser_lease_status') {
        result = status();
      } else if (method === 'browser_lease_acquire') {
        const resource = parseLeaseResource(request.params?.resource);
        const purpose = typeof request.params?.purpose === 'string' && request.params.purpose.trim()
          ? request.params.purpose.trim()
          : 'coordination';
        const ttlMs = typeof request.params?.ttlMs === 'number' ? request.params.ttlMs : 30_000;
        result = boundedLease(this.coordinator.acquire(sessionId, resource, purpose, ttlMs));
        this.broadcastCoordinationStatus();
      } else if (method === 'browser_lease_renew') {
        const leaseId = request.params?.leaseId;
        if (typeof leaseId !== 'string' || !leaseId.trim()) throw this.error('INVALID_REQUEST', 'leaseId is required', false);
        const ttlMs = typeof request.params?.ttlMs === 'number' ? request.params.ttlMs : 30_000;
        result = boundedLease(this.coordinator.renew(sessionId, leaseId, ttlMs));
        this.broadcastCoordinationStatus();
      } else {
        const leaseId = request.params?.leaseId;
        if (typeof leaseId !== 'string' || !leaseId.trim()) throw this.error('INVALID_REQUEST', 'leaseId is required', false);
        this.coordinator.release(sessionId, leaseId);
        result = { released: true, leaseId };
        this.broadcastCoordinationStatus();
      }
      this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
    } catch (error) {
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: this.coordinatorError(error) } satisfies PipeResponse);
    }
  }

  private async handleRuntimeRequest(socket: Socket, request: PipeRequest, sessionId: string): Promise<void> {
    if (!this.runtime) {
      this.writePipe(socket, this.pipeError(request.id, 'INVALID_REQUEST', 'Set KBB_RUNTIME_MODE=shadow to use runtime tools', false));
      return;
    }
    let replayEventId: string | undefined;
    try {
      if (request.method === 'browser_recipe_review') {
        const change = request.params ?? {};
        const draftId = typeof change.draftId === 'string' ? change.draftId : this.runtime.latestRecipeDraft()?.id;
        if (typeof draftId !== 'string' || !Array.isArray(change.stepIds) || change.stepIds.some((id) => typeof id !== 'string')) throw this.error('INVALID_REQUEST', 'draftId and stepIds are required', false);
        const result = this.runtime.reviewRecipeDraft(draftId, { type: String(change.type) as 'delete' | 'merge' | 'describe' | 'variable' | 'manual_confirm', stepIds: change.stepIds, text: typeof change.text === 'string' ? change.text : undefined, name: typeof change.name === 'string' ? change.name : undefined });
        this.writePipe(socket, { type: 'response', id: request.id, ok: true, result } satisfies PipeResponse);
        return;
      }
      if (request.method === 'browser_replay_start') {
        const draftId = typeof request.params?.draftId === 'string' ? request.params.draftId : this.runtime.latestRecipeDraft()?.id;
        if (typeof draftId !== 'string') throw this.error('INVALID_REQUEST', 'draftId is required', false);
        const started = this.runtime.startReplay(draftId);
        this.replay = { ...started, nextStep: 0 };
        this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: { runId: started.runId, steps: Array.isArray(started.recipe.steps) ? started.recipe.steps.length : 0 } } satisfies PipeResponse);
        return;
      }
      if (request.method === 'browser_run_export') {
        const runId = typeof request.params?.runId === 'string' ? request.params.runId : this.runtime.latestRunId();
        const directory = typeof request.params?.directory === 'string' ? request.params.directory : '';
        if (!runId || !directory || !isAbsolute(directory)) throw this.error('INVALID_REQUEST', 'runId and an absolute directory are required', false);
        this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: this.runtime.exportRunPackage(runId, directory) } satisfies PipeResponse);
        return;
      }
      if (request.method === 'browser_run_generate_guide') {
        const runId = typeof request.params?.runId === 'string' ? request.params.runId : this.runtime.latestRunId();
        const directory = typeof request.params?.directory === 'string' ? request.params.directory : '';
        if (!runId || !directory || !isAbsolute(directory)) throw this.error('INVALID_REQUEST', 'runId and an absolute directory are required', false);
        const packageInfo = this.runtime.exportRunPackage(runId, join(resolve(directory), runId));
        const script = resolve(import.meta.dirname, '../../../scripts/import-kv-run-package.mjs');
        const guide = spawnSync(process.execPath, [script, packageInfo.directory], { encoding: 'utf8' });
        if (guide.status !== 0) throw this.error('INTERNAL_ERROR', `Guide generation failed: ${guide.stderr || guide.stdout}`, false);
        this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: { package: packageInfo, guide: JSON.parse(guide.stdout) } } satisfies PipeResponse);
        return;
      }
      const replay = this.replay;
      if (!replay) throw this.error('INVALID_REQUEST', 'Start a replay before executing a step', false);
      const index = typeof request.params?.index === 'number' ? request.params.index : replay.nextStep;
      const steps = Array.isArray(replay.recipe.steps) ? replay.recipe.steps.filter(isRecord) : [];
      const step = steps[index];
      const action = typeof step?.action === 'string' ? step.action : '';
      if (!step || !action || action.startsWith('record_') || !isBrowserToolName(`browser_${action}`)) throw this.error('INVALID_REQUEST', `Replay step ${index + 1} is not executable`, false);
      const browserAction = action as BrowserAction;
      const operationClass = operationClassFor(browserAction);
      if (operationClass === 'non_idempotent_write' && request.params?.confirmWrite !== true) throw this.error('INVALID_REQUEST', 'Replay write steps require confirmWrite=true', false);
      const params = isRecord(step.params) ? { ...step.params } : {};
      if (typeof params.tabId !== 'number' && typeof replay.recipe.tabId === 'number') params.tabId = replay.recipe.tabId;
      replayEventId = this.runtime.recordRequest(`browser_${action}`, params, operationClass, typeof params.tabId === 'number' ? params.tabId : undefined);
       const result = await this.forwardBrowserRequest(request.id, sessionId, browserAction, params, request.timeoutMs, request.deadlineAt);
       this.runtime.recordResult(replayEventId, result);
       replay.nextStep = index + 1;
       const done = replay.nextStep >= steps.length;
       if (done) {
         this.runtime.finishRun('completed');
         this.runtime.resumeShadowRun();
         this.replay = undefined;
       }
       this.writePipe(socket, { type: 'response', id: request.id, ok: true, result: { runId: replay.runId, index, done, result } } satisfies PipeResponse);
    } catch (error) {
      const bridgeError = isBridgeError(error) ? error : this.error('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), false);
      this.runtimeSafe(() => this.runtime?.recordResult(replayEventId, undefined, bridgeError));
      this.writePipe(socket, { type: 'response', id: request.id, ok: false, error: bridgeError } satisfies PipeResponse);
    }
  }

  private runtimeSafe<T>(write: () => T): T | undefined {
    try { return write(); }
    catch (error) {
      this.logger.write('warn', 'runtime.shadow_failed', { message: error instanceof Error ? error.message : String(error) });
      return undefined;
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

  private broadcastCoordinationStatus(): void {
    const status: CoordinationStatusView = serializeCoordinationStatus(this.coordinator.status());
    const event: PipeEvent = { type: 'event', event: 'coordination:status', data: status };
    for (const socket of this.clients) this.writePipe(socket, event);
    try {
      this.sendNative({ type: 'bridge:coordination_status', status });
    } catch (error) {
      this.logger.write('debug', 'coordination.native_status_unavailable', { message: error instanceof Error ? error.message : String(error) });
    }
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

function isRuntimeMethod(value: string): value is 'browser_recipe_review' | 'browser_replay_start' | 'browser_replay_step' | 'browser_run_export' | 'browser_run_generate_guide' {
  return value === 'browser_recipe_review' || value === 'browser_replay_start' || value === 'browser_replay_step' || value === 'browser_run_export' || value === 'browser_run_generate_guide';
}

function isCoordinationMethod(value: string): value is CoordinationPipeMethod {
  return value === 'browser_get_clients'
    || value === 'browser_lease_acquire'
    || value === 'browser_lease_renew'
    || value === 'browser_lease_release'
    || value === 'browser_lease_status';
}

function parseLeaseResource(value: unknown): `tab:${number}` | 'global:recorder' {
  if (value === 'global:recorder') return value;
  if (typeof value === 'string' && /^tab:\d+$/.test(value)) return value as `tab:${number}`;
  throw { code: 'INVALID_REQUEST', message: 'resource must be global:recorder or tab:<id>', retryable: false } satisfies BridgeError;
}

function boundedLease(lease: { id: string; resource: string; purpose: string; state: string; expiresAt: string }): Record<string, string> {
  return {
    id: lease.id,
    resource: lease.resource,
    purpose: lease.purpose,
    state: lease.state,
    expiresAt: lease.expiresAt,
  };
}

function isSupportedVersion(version: unknown): boolean {
  return version === BRIDGE_PROTOCOL_VERSION || version === '0.1.0';
}

function coordinationMode(): 'off' | 'observe' | 'enforce' {
  const value = process.env.KBB_COORDINATION_MODE;
  return value === 'observe' || value === 'enforce' ? value : 'off';
}

function actionRequiresTab(action: BrowserAction): boolean {
  return !new Set<BrowserAction>([
    'get_tabs', 'new_tab', 'download_status', 'list_bookmarks', 'open_bookmark', 'list_extensions',
  ]).has(action);
}

function identityFromHello(value: unknown, sessionId: string): AgentIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const hasIdentityFields = 'clientId' in value || 'instanceId' in value || 'capabilities' in value;
  if (hasIdentityFields) {
    const candidate = {
      clientId: value.clientId,
      clientName: value.clientName ?? value.client,
      instanceId: value.instanceId,
      capabilities: value.capabilities,
    };
    return isAgentIdentity(candidate) ? candidate : undefined;
  }
  const clientName = typeof value.clientName === 'string' ? value.clientName : typeof value.client === 'string' ? value.client : 'legacy-client';
  return isAgentIdentity({ clientId: clientName, clientName, instanceId: sessionId, capabilities: ['read', 'write', 'record'] })
    ? { clientId: clientName, clientName, instanceId: sessionId, capabilities: ['read', 'write', 'record'] }
    : undefined;
}

function asRpcHello(value: unknown): { id: string; params: Record<string, unknown> & { token: string; client?: string; version?: unknown } } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.method !== 'hello' || !isRecord(value.params)) return undefined;
  if (typeof value.params.token !== 'string') return undefined;
  return {
    id: value.id,
    params: value.params as Record<string, unknown> & { token: string; client?: string; version?: unknown },
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
  (bridge as any).handleNativeError(new Error('fake native disconnect'));
  return rejected;
}

/** Test seam: verifies that native request IDs are unique across pipe sessions. */
export async function testNativeRequestRouting(): Promise<{ requestIds: string[]; results: unknown[] }> {
  const bridge = Object.create(ChromeBridge.prototype) as ChromeBridge;
  const messages: BrowserRequest[] = [];
  (bridge as any).instanceId = 'test-bridge';
  (bridge as any).nativeRequestSequence = 0;
  (bridge as any).pending = new Map();
  (bridge as any).extensionConnected = true;
  (bridge as any).logger = { write: () => undefined };
  (bridge as any).broadcastStatus = () => undefined;
  (bridge as any).sendNative = (message: BrowserRequest) => messages.push(message);
  const first = (bridge as any).forwardBrowserRequest('same-id', 'session-a', 'click', {}, 1_000);
  const second = (bridge as any).forwardBrowserRequest('same-id', 'session-b', 'click', {}, 1_000);
  (bridge as any).handleNativeMessage({ type: 'browser:response', requestId: messages[0].requestId, result: 'first' });
  (bridge as any).handleNativeMessage({ type: 'browser:response', requestId: messages[1].requestId, result: 'second' });
  return { requestIds: messages.map((message) => message.requestId), results: await Promise.all([first, second]) };
}

/** Test seam: confirms a completed idempotency hit does not acquire recording leases. */
export async function testIdempotencyCacheSkipsRecordingLease(): Promise<{ acquireCount: number; response: unknown }> {
  const bridge = Object.create(ChromeBridge.prototype) as ChromeBridge;
  let acquireCount = 0;
  let response: unknown;
  (bridge as any).coordinator = {
    touch: () => undefined,
    resolveTab: () => 7,
    acquire: () => { acquireCount += 1; throw new Error('lease acquisition should be skipped'); },
  };
  (bridge as any).coordinationMode = 'enforce';
  (bridge as any).idempotencyCompleted = new Map([['client-a:browser_record_start:record_start:request-1', { expiresAt: Date.now() + 30_000, result: 'cached' }]]);
  (bridge as any).idempotencyInFlight = new Map();
  (bridge as any).recordingLeases = new Map();
  (bridge as any).runtime = undefined;
  (bridge as any).writePipe = (_socket: unknown, value: unknown) => { response = value; };
  await (bridge as any).handlePipeRequest(
    { kvIdentity: { clientId: 'client-a' }, kvSessionId: 'session-a' },
    { id: 'request-1', method: 'browser_record_start', params: { tabId: 7 } },
    'session-a',
  );
  return { acquireCount, response };
}

/** Test seam: confirms UNKNOWN_OUTCOME quarantines a recording tab only once. */
export async function testUnknownOutcomeQuarantineCount(): Promise<number> {
  const bridge = Object.create(ChromeBridge.prototype) as ChromeBridge;
  let quarantineCount = 0;
  (bridge as any).coordinator = {
    touch: () => undefined,
    resolveTab: (_sessionId: string, tabId?: number) => tabId,
    acquire: (_sessionId: string, resource: string) => ({ id: resource === 'global:recorder' ? 'recorder' : 'tab' }),
    release: () => undefined,
    quarantineTab: () => { quarantineCount += 1; },
  };
  (bridge as any).coordinationMode = 'enforce';
  (bridge as any).broadcastCoordinationStatus = () => undefined;
  (bridge as any).idempotencyCompleted = new Map();
  (bridge as any).idempotencyInFlight = new Map();
  (bridge as any).recordingLeases = new Map();
  (bridge as any).runtime = undefined;
  (bridge as any).coordinateBrowserRequest = () => Promise.reject({ code: 'UNKNOWN_OUTCOME', message: 'ambiguous', retryable: false });
  (bridge as any).writePipe = () => undefined;
  await (bridge as any).handlePipeRequest(
    { kvIdentity: { clientId: 'client-a' }, kvSessionId: 'session-a' },
    { id: 'request-1', method: 'browser_record_start', params: { tabId: 7 } },
    'session-a',
  );
  return quarantineCount;
}

if (process.env.KV_BRIDGE_TEST !== '1') new ChromeBridge().start();
