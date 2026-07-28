import {
  COMPUTER_PROTOCOL_VERSION,
  type ActionEnvelope,
  type ActionReceipt,
  type ComputerObservation,
  type DriverFailure,
  type DriverKind,
  validateActionEnvelope,
} from './computer-contracts.js';
import { BridgeError } from './bridge-client.js';
import type { WindowsUiaObservation, WindowsUiaStatus } from './windows-uia-client.js';

export interface ComputerBridgePort {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getStatus(): unknown;
}

export interface WindowsUiaPort {
  status(): Promise<WindowsUiaStatus>;
  observe(params?: Record<string, unknown>): Promise<WindowsUiaObservation>;
  close?(): Promise<void>;
}

export class BrowserComputerRuntime {
  constructor(
    private readonly bridge: ComputerBridgePort,
    private readonly windows?: WindowsUiaPort,
  ) {}

  async status() {
    const windowsStatus = this.windows
      ? await this.windows.status()
      : { available: false, error: { code: 'WINDOWS_UIA_NOT_CONFIGURED', message: 'Windows UIA client is not configured.' } };
    const availableDrivers: DriverKind[] = ['browser'];
    if (windowsStatus.available) availableDrivers.push('windows-uia');
    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      availableDrivers,
      plannedDrivers: ['vision', 'input', 'native-app'],
      bridge: this.bridge.getStatus(),
      windowsUia: windowsStatus,
    };
  }

  async observe(options: { browser?: boolean; windows?: boolean; windowHandle?: number; maxWindows?: number; maxElements?: number; maxDepth?: number } = {}): Promise<ComputerObservation> {
    const observeBrowser = options.browser !== false;
    const observeWindows = options.windows !== false && Boolean(this.windows);
    const browserPromise = observeBrowser
      ? this.bridge.request('browser_get_tabs')
      : Promise.resolve(undefined);
    const windowsPromise = observeWindows
      ? this.windows!.observe({
          windowHandle: options.windowHandle,
          maxWindows: options.maxWindows,
          maxElements: options.maxElements,
          maxDepth: options.maxDepth,
        })
      : Promise.resolve(undefined);
    const [browserResult, windowsResult] = await Promise.allSettled([browserPromise, windowsPromise]);

    const availableDrivers: DriverKind[] = [];
    const failures: DriverFailure[] = [];
    let browserTargets: ComputerObservation['browserTargets'];
    let windows: WindowsUiaObservation | undefined;

    if (observeBrowser) {
      if (browserResult.status === 'fulfilled') {
        browserTargets = normalizeTabs(browserResult.value);
        availableDrivers.push('browser');
      } else {
        failures.push(asDriverFailure('browser', browserResult.reason));
      }
    }

    if (observeWindows) {
      if (windowsResult.status === 'fulfilled') {
        windows = windowsResult.value;
        availableDrivers.push('windows-uia');
      } else {
        failures.push(asDriverFailure('windows-uia', windowsResult.reason));
      }
    }

    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      observationId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      availableDrivers,
      activeDriver: windows ? 'windows-uia' : availableDrivers[0],
      browserTargets,
      windows,
      driverFailures: failures.length > 0 ? failures : undefined,
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
      code: 'DRIVER_READ_ONLY',
      message: `Action ${envelope.action.type} is unavailable because the Windows UIA driver is read-only in this release.`,
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

  async close(): Promise<void> {
    await this.windows?.close?.();
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

function asDriverFailure(driver: DriverKind, error: unknown): DriverFailure {
  if (error instanceof BridgeError) {
    return { driver, code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    driver,
    code: driver === 'windows-uia' ? 'WINDOWS_UIA_OBSERVE_FAILED' : 'DRIVER_OBSERVE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
