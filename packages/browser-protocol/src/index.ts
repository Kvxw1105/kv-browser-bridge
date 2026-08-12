/**
 * Transport-neutral contract shared by the Chrome Bridge and the Codex MCP
 * server. No process in this package owns stdin/stdout.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
export const NATIVE_CHUNK_MAX_BYTES = 384 * 1024;
export const PIPE_LINE_MAX_BYTES = 1024 * 1024;

export * from './flow-recorder.js';
export * from './coordinator.js';

import type { CoordinationPipeMethod, CoordinationStatusView } from './coordinator.js';
import { isAgentIdentity } from './coordinator.js';

export interface BridgeIdentity {
  identityId: string;
  workspaceId?: string;
  platform?: string;
  runtimeSessionId?: string;
}

export interface BridgeReadyMessage {
  type: 'bridge:ready';
  protocolVersion: number;
  identity?: BridgeIdentity;
}

export interface ExtensionHelloMessage {
  type: 'extension:hello';
  protocolVersion: number;
  extensionId: string;
  extensionVersion: string;
  identity?: BridgeIdentity;
  userAgent?: string;
}

export interface ExtensionHandshakeStatus {
  acknowledgedAt: string;
  extensionId: string;
  extensionVersion: string;
  userAgent?: string;
}

export type BrowserAction =
  | 'get_tabs'
  | 'new_tab'
  | 'switch_tab'
  | 'scroll'
  | 'find'
  | 'close_tab'
  | 'download_status'
  | 'list_bookmarks'
  | 'open_bookmark'
  | 'list_extensions'
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
  | 'get_url'
  | 'console_logs'
  | 'console_errors'
  | 'network_requests'
  | 'network_failures'
  | 'get_response_body'
  | 'inspect_element'
  | 'get_element_styles'
  | 'page_metrics'
  | 'record_start'
  | 'record_stop'
  | 'record_status'
  | 'record_note'
  | 'list_webmcp_tools'
  | 'execute_webmcp_tool';

export type BrowserToolName = `browser_${BrowserAction}`;
export type RuntimeToolName = 'browser_recipe_review' | 'browser_replay_start' | 'browser_replay_step' | 'browser_run_export' | 'browser_run_generate_guide';
export type OperationClass = 'read' | 'non_idempotent_write';

export interface BrowserRequest {
  type: 'browser:request';
  requestId: string;
  action: BrowserAction;
  params: Record<string, unknown>;
  timeoutMs?: number;
  /** Stable ID supplied by the pipe caller; never regenerated downstream. */
  sessionId?: string;
  deadlineAt?: number;
  operationClass?: OperationClass;
  idempotencyKey?: string;
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
  | 'UNKNOWN_OUTCOME'
  | 'DEBUGGER_DETACHED'
  | 'DEBUGGER_IN_USE'
  | 'RESOURCE_BUSY'
  | 'RESOURCE_QUARANTINED'
  | 'TAB_ID_REQUIRED'
  | 'LEASE_NOT_OWNED'
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

export type NativeMessage = BrowserRequest | BrowserResponse | NativeChunk | BridgeReadyMessage | ExtensionHelloMessage | {
  type: 'ping';
} | {
  type: 'pong';
} | {
  type: 'bridge:coordination_status';
  status: CoordinationStatusView;
} | {
  type: 'go_event';
  data: unknown;
} | {
  type: 'go_ledger_append';
  data: { key: string; event: Record<string, unknown> };
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
  clientId?: string;
  instanceId?: string;
  capabilities?: import('./coordinator.js').AgentCapability[];
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
  method: BrowserToolName | RuntimeToolName | 'browser_connection_status' | CoordinationPipeMethod;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  sessionId?: string;
  deadlineAt?: number;
  operationClass?: OperationClass;
  idempotencyKey?: string;
}

export interface PipeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}

export interface ConnectionStatusPipeEvent {
  type: 'event';
  event: 'connection:status';
  data: BridgeConnectionStatus;
}

export interface CoordinationStatusPipeEvent {
  type: 'event';
  event: 'coordination:status';
  data: CoordinationStatusView;
}

export type PipeEvent = ConnectionStatusPipeEvent | CoordinationStatusPipeEvent;

export type PipeMessage = PipeHello | PipeHelloAck | PipeRequest | PipeResponse | PipeEvent;

export interface BridgeConnectionStatus {
  protocolVersion: number;
  extensionConnected: boolean;
  pipeName: string;
  startedAt: string;
  pendingRequests: number;
  lastExtensionMessageAt?: string;
  lastError?: BridgeError;
  instanceId?: string;
  generation?: number;
  nativeReady?: boolean;
  identity?: BridgeIdentity;
  extensionHandshake?: ExtensionHandshakeStatus;
}

export function operationClassFor(action: BrowserAction): OperationClass {
  // `execute_webmcp_tool` is a page-side write: an ambiguous timeout or
  // disconnect must surface as UNKNOWN_OUTCOME so the caller never retries
  // the tool call (WebMCP execution can have side effects on the page).
  return new Set<BrowserAction>(['get_tabs', 'find', 'download_status', 'list_bookmarks', 'list_extensions', 'snapshot', 'screenshot', 'wait_for', 'get_text', 'get_url', 'console_logs', 'console_errors', 'network_requests', 'network_failures', 'get_response_body', 'inspect_element', 'get_element_styles', 'page_metrics', 'record_status', 'list_webmcp_tools']).has(action)
    ? 'read' : 'non_idempotent_write';
}

export function deadlineExpired(deadlineAt: unknown, now = Date.now()): boolean {
  return typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) && deadlineAt <= now;
}

export interface BridgeDiscovery {
  protocolVersion: number;
  pipeName: string;
  token: string;
  pid: number;
  startedAt: string;
  identity?: BridgeIdentity;
}

export function browserActionFromTool(method: BrowserToolName): BrowserAction {
  return method.slice('browser_'.length) as BrowserAction;
}

export function isBrowserToolName(value: string): value is BrowserToolName {
  return /^browser_(get_tabs|new_tab|switch_tab|scroll|find|close_tab|download_status|list_bookmarks|open_bookmark|list_extensions|navigate|snapshot|screenshot|click|type|press|select|evaluate|set_files|wait_for|get_text|get_url|console_logs|console_errors|network_requests|network_failures|get_response_body|inspect_element|get_element_styles|page_metrics|record_start|record_stop|record_status|record_note|list_webmcp_tools|execute_webmcp_tool)$/.test(value);
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

export function isBridgeIdentity(value: unknown): value is BridgeIdentity {
  if (!isRecord(value) || typeof value.identityId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.identityId)) return false;
  return ['workspaceId', 'platform', 'runtimeSessionId'].every((field) => value[field] === undefined || typeof value[field] === 'string');
}

export function isExtensionHello(value: unknown): value is ExtensionHelloMessage {
  return isRecord(value)
    && value.type === 'extension:hello'
    && typeof value.protocolVersion === 'number'
    && typeof value.extensionId === 'string'
    && typeof value.extensionVersion === 'string'
    && (value.identity === undefined || isBridgeIdentity(value.identity))
    && (value.userAgent === undefined || typeof value.userAgent === 'string');
}

export function isPipeHello(value: unknown): value is PipeHello {
  return isRecord(value)
    && value.type === 'hello'
    && typeof value.token === 'string'
    && (!('clientName' in value) || typeof value.clientName === 'string')
    && (typeof value.version === 'number' || typeof value.version === 'string'
      || typeof value.protocolVersion === 'number' || typeof value.protocolVersion === 'string')
    && (!('clientId' in value || 'instanceId' in value || 'capabilities' in value)
      || isAgentIdentity(value));
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

export * from './webmcp.js';
