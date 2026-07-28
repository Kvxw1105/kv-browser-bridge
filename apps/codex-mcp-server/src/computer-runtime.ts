import {
  COMPUTER_PROTOCOL_VERSION,
  type ActionEnvelope,
  type ActionReceipt,
  type ComputerObservation,
  validateActionEnvelope,
} from '@kv-browser-bridge/computer-contracts';
import { BridgeClient, BridgeError } from './bridge-client.js';

export class BrowserComputerRuntime {
  constructor(private readonly bridge: BridgeClient) {}

  async observe(): Promise<ComputerObservation> {
    const tabs = await this.bridge.request('browser_get_tabs') as unknown;
    const browserTargets = normalizeTabs(tabs);
    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      observationId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      availableDrivers: ['browser'],
      activeDriver: 'browser',
      browserTargets,
      metadata: {
        bridge: this.bridge.getStatus(),
      },
    };
  }

  async execute(envelope: ActionEnvelope): Promise<ActionReceipt> {
    const startedAt = new Date().toISOString();
    const errors = validateActionEnvelope(envelope);
    if (errors.length > 0) {
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'browser',
        status: 'blocked',
        error: {
          code: 'POLICY_BLOCKED',
          message: errors.join('; '),
          retryable: false,
        },
        verification: { status: 'unknown' },
      };
    }

    if (envelope.action.type !== 'browser_command') {
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'browser',
        status: 'blocked',
        error: {
          code: 'DRIVER_UNAVAILABLE',
          message: `Action ${envelope.action.type} requires a driver that is not installed yet.`,
          retryable: false,
        },
        verification: { status: 'unknown' },
      };
    }

    try {
      const result = await this.bridge.request(
        envelope.action.command,
        envelope.action.params ?? {},
        envelope.timeoutMs,
      );
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
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'browser',
        status: 'failed',
        error: {
          code: bridgeError.code,
          message: bridgeError.message,
          retryable: bridgeError.retryable,
        },
        verification: { status: 'failed' },
      };
    }
  }
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
  if (postcondition.kind === 'url_contains' || postcondition.kind === 'text_present') {
    const value = postcondition.value ?? '';
    const passed = value.length > 0 && serialized.includes(value);
    return { status: passed ? 'passed' : 'failed', evidence: { expected: value } };
  }
  return { status: 'unknown' };
}
