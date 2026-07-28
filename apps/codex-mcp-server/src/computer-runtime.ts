import {
  COMPUTER_PROTOCOL_VERSION,
  type ActionEnvelope,
  type ActionReceipt,
  type ComputerObservation,
  validateActionEnvelope,
} from './computer-contracts.js';
import { BridgeError } from './bridge-client.js';

export interface ComputerBridgePort {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getStatus(): unknown;
}

export class BrowserComputerRuntime {
  constructor(private readonly bridge: ComputerBridgePort) {}

  status() {
    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      availableDrivers: ['browser'],
      plannedDrivers: ['windows-uia', 'vision', 'input', 'native-app'],
      bridge: this.bridge.getStatus(),
    };
  }

  async observe(): Promise<ComputerObservation> {
    const tabs = await this.bridge.request('browser_get_tabs');
    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      observationId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      availableDrivers: ['browser'],
      activeDriver: 'browser',
      browserTargets: normalizeTabs(tabs),
      metadata: { bridge: this.bridge.getStatus() },
    };
  }

  async execute(envelope: ActionEnvelope): Promise<ActionReceipt> {
    const startedAt = new Date().toISOString();
    const blocked = validateActionEnvelope(envelope);
    if (blocked.length > 0) return receipt(envelope.actionId, startedAt, 'blocked', {
      code: 'POLICY_BLOCKED', message: blocked.join('; '), retryable: false,
    });

    if (envelope.action.type !== 'browser_command') return receipt(envelope.actionId, startedAt, 'blocked', {
      code: 'DRIVER_UNAVAILABLE',
      message: `Action ${envelope.action.type} requires a driver that is not installed yet.`,
      retryable: false,
    });

    try {
      const result = await this.bridge.request(envelope.action.command, envelope.action.params ?? {}, envelope.timeoutMs);
      const verification = verifyDriverResult(envelope, result);
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'browser',
        status: verification.status === 'failed' ? 'failed' : 'completed',
        result,
        verification,
      };
    } catch (error) {
      const bridgeError = error instanceof BridgeError
        ? error
        : new BridgeError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      return receipt(envelope.actionId, startedAt, 'failed', {
        code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable,
      }, 'failed');
    }
  }
}

function receipt(
  actionId: string,
  startedAt: string,
  status: ActionReceipt['status'],
  error: NonNullable<ActionReceipt['error']>,
  verification: ActionReceipt['verification']['status'] = 'unknown',
): ActionReceipt {
  return {
    protocolVersion: COMPUTER_PROTOCOL_VERSION,
    actionId,
    startedAt,
    finishedAt: new Date().toISOString(),
    driver: 'browser',
    status,
    error,
    verification: { status: verification },
  };
}

function normalizeTabs(value: unknown): ComputerObservation['browserTargets'] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { tabs?: unknown }).tabs)
      ? (value as { tabs: unknown[] }).tabs
      : [];
  return candidates.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const tab = candidate as Record<string, unknown>;
    if (typeof tab.id !== 'number') return [];
    return [{
      tabId: tab.id,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
      title: typeof tab.title === 'string' ? tab.title : undefined,
      url: typeof tab.url === 'string' ? tab.url : undefined,
      active: typeof tab.active === 'boolean' ? tab.active : undefined,
    }];
  });
}

function verifyDriverResult(envelope: ActionEnvelope, result: unknown): ActionReceipt['verification'] {
  const postcondition = envelope.expectedPostcondition;
  if (postcondition.kind === 'none') return { status: 'unknown' };
  if (postcondition.kind === 'driver_result') {
    return { status: result === undefined ? 'failed' : 'passed', evidence: { resultPresent: result !== undefined } };
  }
  const serialized = JSON.stringify(result);
  const expected = postcondition.value ?? '';
  const passed = expected.length > 0 && serialized.includes(expected);
  return { status: passed ? 'passed' : 'failed', evidence: { expected } };
}
