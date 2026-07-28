export const COMPUTER_PROTOCOL_VERSION = 1;

export type DriverKind = 'browser' | 'windows-uia' | 'vision' | 'input' | 'native-app';
export type ElementSource = 'dom' | 'accessibility' | 'uia' | 'vision';
export type RiskLevel = 'read' | 'reversible-write' | 'external-write' | 'destructive';
export type VerificationStatus = 'passed' | 'failed' | 'unknown';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerElement {
  ref: string;
  source: ElementSource;
  role?: string;
  name?: string;
  value?: string;
  bounds?: Rect;
  enabled?: boolean;
  visible?: boolean;
  confidence?: number;
  nativeId?: string;
}

export interface BrowserTargetObservation {
  tabId: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
}

export interface ComputerObservation {
  protocolVersion: number;
  observationId: string;
  capturedAt: string;
  availableDrivers: DriverKind[];
  activeDriver?: DriverKind;
  browserTargets?: BrowserTargetObservation[];
  elements?: ComputerElement[];
  metadata?: Record<string, unknown>;
}

export type ComputerAction =
  | {
      type: 'browser_command';
      command: string;
      params?: Record<string, unknown>;
    }
  | {
      type: 'launch_app';
      app: string;
    }
  | {
      type: 'focus_window';
      windowRef: string;
    }
  | {
      type: 'click_ref';
      targetRef: string;
    }
  | {
      type: 'click_point';
      x: number;
      y: number;
    }
  | {
      type: 'type_text';
      targetRef?: string;
      text: string;
      clear?: boolean;
    }
  | {
      type: 'hotkey';
      keys: string[];
    }
  | {
      type: 'wait';
      milliseconds: number;
    };

export interface Postcondition {
  kind: 'none' | 'url_contains' | 'text_present' | 'driver_result';
  value?: string;
}

export interface ActionEnvelope {
  actionId: string;
  action: ComputerAction;
  reason: string;
  expectedPostcondition: Postcondition;
  risk: RiskLevel;
  timeoutMs: number;
  approved?: boolean;
}

export interface ActionReceipt {
  protocolVersion: number;
  actionId: string;
  startedAt: string;
  finishedAt: string;
  driver: DriverKind;
  status: 'completed' | 'blocked' | 'failed';
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  verification: {
    status: VerificationStatus;
    evidence?: Record<string, unknown>;
  };
}

const browserReadCommands = new Set([
  'browser_get_tabs',
  'browser_find',
  'browser_download_status',
  'browser_list_bookmarks',
  'browser_list_extensions',
  'browser_snapshot',
  'browser_screenshot',
  'browser_wait_for',
  'browser_get_text',
  'browser_get_url',
  'browser_console_logs',
  'browser_console_errors',
  'browser_network_requests',
  'browser_network_failures',
  'browser_get_response_body',
  'browser_inspect_element',
  'browser_get_element_styles',
  'browser_page_metrics',
  'browser_connection_status',
]);

const browserExternalWriteCommands = new Set([
  'browser_set_files',
]);

export function classifyActionRisk(action: ComputerAction): RiskLevel {
  if (action.type === 'wait') return 'read';
  if (action.type !== 'browser_command') return 'reversible-write';
  if (browserReadCommands.has(action.command)) return 'read';
  if (browserExternalWriteCommands.has(action.command)) return 'external-write';
  return 'reversible-write';
}

export function actionRequiresApproval(action: ActionEnvelope): boolean {
  return action.risk === 'external-write' || action.risk === 'destructive';
}

export function validateActionEnvelope(envelope: ActionEnvelope): string[] {
  const errors: string[] = [];
  if (!envelope.actionId.trim()) errors.push('actionId is required');
  if (!envelope.reason.trim()) errors.push('reason is required');
  if (!Number.isFinite(envelope.timeoutMs) || envelope.timeoutMs <= 0 || envelope.timeoutMs > 120_000) {
    errors.push('timeoutMs must be between 1 and 120000');
  }
  const classifiedRisk = classifyActionRisk(envelope.action);
  if (envelope.risk !== classifiedRisk && envelope.risk !== 'destructive') {
    errors.push(`risk mismatch: expected ${classifiedRisk}`);
  }
  if (actionRequiresApproval(envelope) && envelope.approved !== true) {
    errors.push('explicit approval is required for this risk level');
  }
  return errors;
}
