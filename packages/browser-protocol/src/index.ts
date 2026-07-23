/**
 * Transport-neutral contract shared by the Chrome Bridge and the Codex MCP
 * server. No process in this package owns stdin/stdout.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
export const NATIVE_CHUNK_MAX_BYTES = 384 * 1024;
export const PIPE_LINE_MAX_BYTES = 1024 * 1024;

export type BrowserAction =
  | 'get_tabs'
  | 'new_tab'
  | 'switch_tab'
  | 'navigate'
  | 'snapshot'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'press'
  | 'select'
  | 'evaluate'
  | 'set_files'
  | 'wait_for'
  | 'get_text'
  | 'get_url';

export type BrowserToolName = `browser_${BrowserAction}`;

export interface BrowserRequest {
  type: 'browser:request';
  requestId: string;
  action: BrowserAction;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface BrowserResponse {
  type: 'browser:response';
  requestId: string;
  result?: unknown;
  error?: string | BridgeError;
}

export type BridgeErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'BRIDGE_NOT_READY'
  | 'CONNECTION_CLOSED'
  | 'EXTENSION_ERROR'
  | 'INVALID_REQUEST'
  | 'NATIVE_MESSAGE_TOO_LARGE'
  | 'NATIVE_PROTOCOL_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'INTERNAL_ERROR';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface NativeChunk {
  type: 'bridge:chunk';
  transferId: string;
  index: number;
  total: number;
  encoding: 'base64-json';
  data: string;
}

export type NativeMessage = BrowserRequest | BrowserResponse | NativeChunk | {
  type: 'bridge:ready';
  protocolVersion: number;
} | {
  type: 'ping';
} | {
  type: 'pong';
};

export interface PipeHello {
  type: 'hello';
  token: string;
  /** Preferred field names used by the Codex MCP server. */
  version?: number | string;
  client?: string;
  /** Accepted during the migration from the original bridge draft. */
  protocolVersion?: number | string;
  clientName?: string;
}

export interface PipeHelloAck {
  type: 'hello:ack';
  version: number;
  protocolVersion: number;
  bridge: BridgeConnectionStatus;
}

export interface PipeRequest {
  type?: 'request';
  id: string;
  method: BrowserToolName | 'browser_connection_status';
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface PipeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}

export interface PipeEvent {
  type: 'event';
  event: 'connection:status';
  data: BridgeConnectionStatus;
}

export type PipeMessage = PipeHello | PipeHelloAck | PipeRequest | PipeResponse | PipeEvent;

export interface BridgeConnectionStatus {
  protocolVersion: number;
  extensionConnected: boolean;
  pipeName: string;
  startedAt: string;
  pendingRequests: number;
  lastExtensionMessageAt?: string;
  lastError?: BridgeError;
}

export interface BridgeDiscovery {
  protocolVersion: number;
  pipeName: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function browserActionFromTool(method: BrowserToolName): BrowserAction {
  return method.slice('browser_'.length) as BrowserAction;
}

export function isBrowserToolName(value: string): value is BrowserToolName {
  return /^browser_(get_tabs|new_tab|switch_tab|navigate|snapshot|screenshot|click|type|press|select|evaluate|set_files|wait_for|get_text|get_url)$/.test(value);
}

export function isNativeChunk(value: unknown): value is NativeChunk {
  if (!isRecord(value)) return false;
  return value.type === 'bridge:chunk'
    && typeof value.transferId === 'string'
    && Number.isInteger(value.index)
    && Number.isInteger(value.total)
    && value.encoding === 'base64-json'
    && typeof value.data === 'string';
}

export function isBrowserResponse(value: unknown): value is BrowserResponse {
  return isRecord(value)
    && value.type === 'browser:response'
    && typeof value.requestId === 'string';
}

export function isPipeHello(value: unknown): value is PipeHello {
  return isRecord(value)
    && value.type === 'hello'
    && typeof value.token === 'string'
    && (typeof value.version === 'number' || typeof value.version === 'string'
      || typeof value.protocolVersion === 'number' || typeof value.protocolVersion === 'string');
}

export function isPipeRequest(value: unknown): value is PipeRequest {
  return isRecord(value)
    && (value.type === undefined || value.type === 'request')
    && typeof value.id === 'string'
    && typeof value.method === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asBridgeError(error: string | BridgeError | undefined): BridgeError | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') {
    return { code: 'EXTENSION_ERROR', message: error, retryable: false };
  }
  return error;
}
