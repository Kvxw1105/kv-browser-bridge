export const COMPUTER_PROTOCOL_VERSION = 1;

export type DriverKind = 'browser' | 'windows-uia' | 'vision' | 'input' | 'native-app';
export type RiskLevel = 'read' | 'reversible-write' | 'external-write' | 'destructive';
export type VerificationStatus = 'passed' | 'failed' | 'unknown';

export interface BrowserTargetObservation { tabId: number; windowId?: number; title?: string; url?: string; active?: boolean; }
export interface WindowsObservation { protocolVersion: number; observationId: string; capturedAt: string; driver: 'windows-uia'; foregroundWindowHandle: number; windows: unknown[]; targetWindow?: unknown; elements: unknown[]; truncated: boolean; }
export interface DriverFailure { driver: DriverKind; code: string; message: string; retryable?: boolean; }
export interface ComputerObservation { protocolVersion: number; observationId: string; capturedAt: string; availableDrivers: DriverKind[]; activeDriver?: DriverKind; browserTargets?: BrowserTargetObservation[]; windows?: WindowsObservation; driverFailures?: DriverFailure[]; metadata?: Record<string, unknown>; }

export type ComputerAction =
  | { type: 'browser_command'; command: string; params?: Record<string, unknown> }
  | { type: 'focus_window'; windowHandle: number }
  | { type: 'invoke_ref'; targetRef: string; windowHandle?: number; maxSearchElements?: number; maxSearchDepth?: number }
  | { type: 'set_value_ref'; targetRef: string; value: string; windowHandle?: number; maxSearchElements?: number; maxSearchDepth?: number }
  | { type: 'launch_app' | 'click_ref' | 'click_point' | 'type_text' | 'hotkey' | 'wait'; [key: string]: unknown };

export interface Postcondition { kind: 'none' | 'url_contains' | 'text_present' | 'driver_result' | 'window_focused' | 'value_equals'; value?: string; windowHandle?: number; targetRef?: string; }
export interface ActionEnvelope { actionId: string; action: ComputerAction; reason: string; expectedPostcondition: Postcondition; risk: RiskLevel; timeoutMs: number; approved?: boolean; }
export interface ActionReceipt { protocolVersion: number; actionId: string; startedAt: string; finishedAt: string; driver: DriverKind; status: 'completed' | 'blocked' | 'failed'; result?: unknown; error?: { code: string; message: string; retryable?: boolean }; verification: { status: VerificationStatus; evidence?: Record<string, unknown> }; }

const readCommands = new Set(['browser_get_tabs','browser_find','browser_download_status','browser_list_bookmarks','browser_list_extensions','browser_snapshot','browser_screenshot','browser_wait_for','browser_get_text','browser_get_url','browser_console_logs','browser_console_errors','browser_network_requests','browser_network_failures','browser_get_response_body','browser_inspect_element','browser_get_element_styles','browser_page_metrics','browser_connection_status']);

export function classifyActionRisk(action: ComputerAction): RiskLevel {
  if (action.type === 'wait') return 'read';
  if (action.type === 'focus_window' || action.type === 'invoke_ref' || action.type === 'set_value_ref') return 'reversible-write';
  if (action.type !== 'browser_command') return 'reversible-write';
  if (readCommands.has(action.command)) return 'read';
  if (action.command === 'browser_set_files') return 'external-write';
  return 'reversible-write';
}

export function validateActionEnvelope(envelope: ActionEnvelope): string[] {
  const errors: string[] = [];
  if (!envelope.actionId.trim()) errors.push('actionId is required');
  if (!envelope.reason.trim()) errors.push('reason is required');
  if (!Number.isFinite(envelope.timeoutMs) || envelope.timeoutMs <= 0 || envelope.timeoutMs > 120_000) errors.push('timeoutMs must be between 1 and 120000');
  const expectedRisk = classifyActionRisk(envelope.action);
  if (envelope.risk !== expectedRisk && envelope.risk !== 'destructive') errors.push(`risk mismatch: expected ${expectedRisk}`);
  if ((envelope.risk === 'external-write' || envelope.risk === 'destructive') && envelope.approved !== true) errors.push('explicit approval is required for this risk level');
  if (envelope.action.type === 'focus_window' && (!Number.isInteger(envelope.action.windowHandle) || envelope.action.windowHandle <= 0)) errors.push('focus_window requires a positive windowHandle');
  if ((envelope.action.type === 'invoke_ref' || envelope.action.type === 'set_value_ref') && !envelope.action.targetRef.startsWith('uia:')) errors.push(`${envelope.action.type} requires a uia: targetRef`);
  if (envelope.action.type === 'set_value_ref' && typeof envelope.action.value !== 'string') errors.push('set_value_ref requires a string value');
  return errors;
}
