import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyActionRisk, validateActionEnvelope } from '../dist/computer-contracts.js';
import { BrowserComputerRuntime } from '../dist/computer-runtime.js';

class FakeBridge {
  calls = [];
  getStatus() { return { ready: true }; }
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'browser_get_tabs') return { tabs: [{ id: 7, title: 'Example', url: 'https://example.com', active: true }] };
    return { ok: true, url: 'https://example.com/done' };
  }
}

class FakeWindows {
  value = 'before';
  foreground = 42;
  calls = [];
  async status() { return { available: true, executable: 'fake.exe', mode: 'controlled-write', capabilities: ['focus_window', 'invoke_ref', 'set_value_ref'] }; }
  async observe(params = {}) {
    this.calls.push({ method: 'observe', params });
    return {
      protocolVersion: 1,
      observationId: `windows-${this.calls.length}`,
      capturedAt: new Date().toISOString(),
      driver: 'windows-uia',
      foregroundWindowHandle: this.foreground,
      windows: [{ handle: 42, name: 'Editor' }],
      targetWindow: { handle: 42, name: 'Editor' },
      elements: [{ ref: 'uia:1.2', name: 'Document', value: this.value, canInvoke: true, canSetValue: true }],
      truncated: false,
    };
  }
  async focusWindow(windowHandle) { this.calls.push({ method: 'focus_window', windowHandle }); this.foreground = windowHandle; return { action: 'focus_window', windowHandle, foregroundWindowHandle: windowHandle }; }
  async invokeRef(params) { this.calls.push({ method: 'invoke_ref', params }); return { action: 'invoke_ref', windowHandle: params.windowHandle ?? 42, targetRef: params.targetRef }; }
  async setValueRef(params) { this.calls.push({ method: 'set_value_ref', params }); this.value = params.value; return { action: 'set_value_ref', windowHandle: params.windowHandle ?? 42, targetRef: params.targetRef, valueSet: true, currentValue: params.value }; }
}

test('classifies browser and controlled Windows actions', () => {
  assert.equal(classifyActionRisk({ type: 'browser_command', command: 'browser_get_tabs' }), 'read');
  assert.equal(classifyActionRisk({ type: 'browser_command', command: 'browser_set_files' }), 'external-write');
  assert.equal(classifyActionRisk({ type: 'focus_window', windowHandle: 42 }), 'reversible-write');
  assert.equal(classifyActionRisk({ type: 'set_value_ref', targetRef: 'uia:1.2', value: 'x' }), 'reversible-write');
});

test('blocks external writes without explicit approval', () => {
  const errors = validateActionEnvelope({ actionId: 'upload-1', action: { type: 'browser_command', command: 'browser_set_files', params: { files: ['C:\\draft.txt'] } }, reason: 'Attach the selected draft.', expectedPostcondition: { kind: 'driver_result' }, risk: 'external-write', timeoutMs: 30_000 });
  assert.deepEqual(errors, ['explicit approval is required for this risk level']);
});

test('rejects malformed UIA references before execution', () => {
  const errors = validateActionEnvelope({ actionId: 'invoke-1', action: { type: 'invoke_ref', targetRef: 'bad-ref' }, reason: 'Activate target.', expectedPostcondition: { kind: 'driver_result' }, risk: 'reversible-write', timeoutMs: 30_000 });
  assert.match(errors.join('\n'), /uia: targetRef/);
});

test('merges browser and Windows UIA observations', async () => {
  const runtime = new BrowserComputerRuntime(new FakeBridge(), new FakeWindows());
  const status = await runtime.status();
  const observation = await runtime.observe();
  assert.deepEqual(status.availableDrivers, ['browser', 'windows-uia']);
  assert.equal(status.windowsUia.mode, 'controlled-write');
  assert.deepEqual(observation.availableDrivers, ['browser', 'windows-uia']);
  assert.equal(observation.windows.elements[0].ref, 'uia:1.2');
});

test('keeps browser observation when Windows UIA fails', async () => {
  const windows = { async status() { return { available: false, error: { code: 'TEST', message: 'offline' } }; }, async observe() { throw new Error('offline'); } };
  const runtime = new BrowserComputerRuntime(new FakeBridge(), windows);
  const observation = await runtime.observe();
  assert.deepEqual(observation.availableDrivers, ['browser']);
  assert.equal(observation.browserTargets[0].tabId, 7);
  assert.equal(observation.driverFailures[0].driver, 'windows-uia');
});

test('executes a browser action and verifies its result', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserComputerRuntime(bridge);
  const receipt = await runtime.execute({ actionId: 'navigate-1', action: { type: 'browser_command', command: 'browser_navigate', params: { url: 'https://example.com/done' } }, reason: 'Open the requested page.', expectedPostcondition: { kind: 'url_contains', value: '/done' }, risk: 'reversible-write', timeoutMs: 30_000 });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.verification.status, 'passed');
});

test('focuses a window then verifies foreground identity', async () => {
  const windows = new FakeWindows();
  const runtime = new BrowserComputerRuntime(new FakeBridge(), windows);
  const receipt = await runtime.execute({ actionId: 'focus-1', action: { type: 'focus_window', windowHandle: 77 }, reason: 'Bring the requested application forward.', expectedPostcondition: { kind: 'window_focused', windowHandle: 77 }, risk: 'reversible-write', timeoutMs: 30_000 });
  assert.equal(receipt.driver, 'windows-uia');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.verification.status, 'passed');
});

test('sets a UIA value then re-observes and verifies it', async () => {
  const windows = new FakeWindows();
  const runtime = new BrowserComputerRuntime(new FakeBridge(), windows);
  const receipt = await runtime.execute({ actionId: 'value-1', action: { type: 'set_value_ref', targetRef: 'uia:1.2', windowHandle: 42, value: 'after' }, reason: 'Fill the requested field.', expectedPostcondition: { kind: 'value_equals', targetRef: 'uia:1.2', value: 'after', windowHandle: 42 }, risk: 'reversible-write', timeoutMs: 30_000 });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.verification.status, 'passed');
  assert.equal(receipt.verification.evidence.actual, 'after');
  assert.equal(windows.calls.some((call) => call.method === 'observe'), true);
});

test('keeps unsupported raw desktop actions blocked', async () => {
  const runtime = new BrowserComputerRuntime(new FakeBridge(), new FakeWindows());
  const receipt = await runtime.execute({ actionId: 'click-1', action: { type: 'click_point', x: 1, y: 1 }, reason: 'Click a coordinate.', expectedPostcondition: { kind: 'none' }, risk: 'reversible-write', timeoutMs: 30_000 });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.error.code, 'ACTION_UNSUPPORTED');
});
