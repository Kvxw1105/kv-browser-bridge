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
import { WindowsUiaError, type WindowsUiaActionResult, type WindowsUiaObservation, type WindowsUiaStatus } from './windows-uia-client.js';

export interface ComputerBridgePort {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getStatus(): unknown;
}

export interface WindowsUiaPort {
  status(): Promise<WindowsUiaStatus>;
  observe(params?: Record<string, unknown>): Promise<WindowsUiaObservation>;
  focusWindow(windowHandle: number): Promise<WindowsUiaActionResult>;
  invokeRef(params: { windowHandle?: number; targetRef: string; maxSearchElements?: number; maxSearchDepth?: number }): Promise<WindowsUiaActionResult>;
  setValueRef(params: { windowHandle?: number; targetRef: string; value: string; maxSearchElements?: number; maxSearchDepth?: number }): Promise<WindowsUiaActionResult>;
  close?(): Promise<void>;
}

export class BrowserComputerRuntime {
  constructor(private readonly bridge: ComputerBridgePort, private readonly windows?: WindowsUiaPort) {}

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
    const [browserResult, windowsResult] = await Promise.allSettled([
      observeBrowser ? this.bridge.request('browser_get_tabs') : Promise.resolve(undefined),
      observeWindows ? this.windows!.observe({ windowHandle: options.windowHandle, maxWindows: options.maxWindows, maxElements: options.maxElements, maxDepth: options.maxDepth }) : Promise.resolve(undefined),
    ]);
    const availableDrivers: DriverKind[] = [];
    const failures: DriverFailure[] = [];
    let browserTargets: ComputerObservation['browserTargets'];
    let windows: WindowsUiaObservation | undefined;
    if (observeBrowser) {
      if (browserResult.status === 'fulfilled') { browserTargets = normalizeTabs(browserResult.value); availableDrivers.push('browser'); }
      else failures.push(asDriverFailure('browser', browserResult.reason));
    }
    if (observeWindows) {
      if (windowsResult.status === 'fulfilled') { windows = windowsResult.value; availableDrivers.push('windows-uia'); }
      else failures.push(asDriverFailure('windows-uia', windowsResult.reason));
    }
    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      observationId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      availableDrivers,
      activeDriver: windows ? 'windows-uia' : availableDrivers[0],
      browserTargets,
      windows,
      driverFailures: failures.length ? failures : undefined,
      metadata: { bridge: this.bridge.getStatus() },
    };
  }

  async execute(envelope: ActionEnvelope): Promise<ActionReceipt> {
    const startedAt = new Date().toISOString();
    const blocked = validateActionEnvelope(envelope);
    if (blocked.length) return errorReceipt(envelope.actionId, startedAt, 'browser', 'blocked', 'POLICY_BLOCKED', blocked.join('; '), false);

    if (envelope.action.type === 'browser_command') return await this.executeBrowser(envelope, startedAt);
    if (!this.windows) return errorReceipt(envelope.actionId, startedAt, 'windows-uia', 'blocked', 'WINDOWS_UIA_NOT_CONFIGURED', 'Windows UIA driver is not configured.', false);

    try {
      let result: WindowsUiaActionResult;
      switch (envelope.action.type) {
        case 'focus_window': result = await this.windows.focusWindow(envelope.action.windowHandle); break;
        case 'invoke_ref': result = await this.windows.invokeRef(envelope.action); break;
        case 'set_value_ref': result = await this.windows.setValueRef(envelope.action); break;
        default: return errorReceipt(envelope.actionId, startedAt, 'windows-uia', 'blocked', 'ACTION_UNSUPPORTED', `Action ${envelope.action.type} is not available in the controlled UIA release.`, false);
      }
      const verification = await this.verifyWindows(envelope, result);
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'windows-uia',
        status: verification.status === 'failed' ? 'failed' : 'completed',
        result,
        verification,
      };
    } catch (error) {
      const typed = error instanceof WindowsUiaError ? error : new WindowsUiaError('WINDOWS_UIA_ACTION_FAILED', error instanceof Error ? error.message : String(error), true);
      return errorReceipt(envelope.actionId, startedAt, 'windows-uia', 'failed', typed.code, typed.message, typed.retryable, 'failed');
    }
  }

  async close(): Promise<void> { await this.windows?.close?.(); }

  private async executeBrowser(envelope: ActionEnvelope, startedAt: string): Promise<ActionReceipt> {
    if (envelope.action.type !== 'browser_command') throw new Error('Expected browser action.');
    try {
      const result = await this.bridge.request(envelope.action.command, envelope.action.params ?? {}, envelope.timeoutMs);
      const verification = verifyBrowserResult(envelope, result);
      return { protocolVersion: COMPUTER_PROTOCOL_VERSION, actionId: envelope.actionId, startedAt, finishedAt: new Date().toISOString(), driver: 'browser', status: verification.status === 'failed' ? 'failed' : 'completed', result, verification };
    } catch (error) {
      const typed = error instanceof BridgeError ? error : new BridgeError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      return errorReceipt(envelope.actionId, startedAt, 'browser', 'failed', typed.code, typed.message, typed.retryable, 'failed');
    }
  }

  private async verifyWindows(envelope: ActionEnvelope, result: WindowsUiaActionResult): Promise<ActionReceipt['verification']> {
    const postcondition = envelope.expectedPostcondition;
    if (postcondition.kind === 'none') return { status: 'unknown' };
    if (postcondition.kind === 'driver_result') return { status: 'passed', evidence: { result } };
    const windowHandle = postcondition.windowHandle ?? result.windowHandle;
    const observation = await this.windows!.observe({ browser: false, windowHandle, maxWindows: 50, maxElements: 2_000, maxDepth: 20 });
    if (postcondition.kind === 'window_focused') {
      const expected = postcondition.windowHandle ?? windowHandle;
      const passed = observation.foregroundWindowHandle === expected;
      return { status: passed ? 'passed' : 'failed', evidence: { expected, actual: observation.foregroundWindowHandle, observationId: observation.observationId } };
    }
    if (postcondition.kind === 'value_equals') {
      const targetRef = postcondition.targetRef ?? ('targetRef' in envelope.action ? envelope.action.targetRef : undefined);
      const expected = postcondition.value ?? ('value' in envelope.action && typeof envelope.action.value === 'string' ? envelope.action.value : undefined);
      const element = findElement(observation.elements, targetRef);
      const actual = element?.value;
      const passed = Boolean(targetRef) && actual === expected;
      return { status: passed ? 'passed' : 'failed', evidence: { targetRef, expected, actual, observationId: observation.observationId } };
    }
    return { status: 'passed', evidence: { result, observationId: observation.observationId } };
  }
}

function errorReceipt(actionId: string, startedAt: string, driver: DriverKind, status: ActionReceipt['status'], code: string, message: string, retryable: boolean, verification: ActionReceipt['verification']['status'] = 'unknown'): ActionReceipt {
  return { protocolVersion: COMPUTER_PROTOCOL_VERSION, actionId, startedAt, finishedAt: new Date().toISOString(), driver, status, error: { code, message, retryable }, verification: { status: verification } };
}

function normalizeTabs(value: unknown): ComputerObservation['browserTargets'] {
  const candidates = Array.isArray(value) ? value : typeof value === 'object' && value !== null && Array.isArray((value as { tabs?: unknown }).tabs) ? (value as { tabs: unknown[] }).tabs : [];
  return candidates.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const tab = candidate as Record<string, unknown>;
    if (typeof tab.id !== 'number') return [];
    return [{ tabId: tab.id, windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined, title: typeof tab.title === 'string' ? tab.title : undefined, url: typeof tab.url === 'string' ? tab.url : undefined, active: typeof tab.active === 'boolean' ? tab.active : undefined }];
  });
}

function verifyBrowserResult(envelope: ActionEnvelope, result: unknown): ActionReceipt['verification'] {
  const postcondition = envelope.expectedPostcondition;
  if (postcondition.kind === 'none') return { status: 'unknown' };
  if (postcondition.kind === 'driver_result') return { status: result === undefined ? 'failed' : 'passed', evidence: { resultPresent: result !== undefined } };
  const expected = postcondition.value ?? '';
  const passed = expected.length > 0 && JSON.stringify(result).includes(expected);
  return { status: passed ? 'passed' : 'failed', evidence: { expected } };
}

function findElement(elements: unknown[], targetRef?: string): Record<string, unknown> | undefined {
  if (!targetRef) return undefined;
  return elements.find((item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).ref === targetRef) as Record<string, unknown> | undefined;
}

function asDriverFailure(driver: DriverKind, error: unknown): DriverFailure {
  if (error instanceof BridgeError) return { driver, code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof WindowsUiaError) return { driver, code: error.code, message: error.message, retryable: error.retryable };
  return { driver, code: driver === 'windows-uia' ? 'WINDOWS_UIA_OBSERVE_FAILED' : 'DRIVER_OBSERVE_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true };
}
