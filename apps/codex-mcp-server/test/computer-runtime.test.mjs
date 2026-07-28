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

test('classifies reads and external writes', () => {
  assert.equal(classifyActionRisk({ type: 'browser_command', command: 'browser_get_tabs' }), 'read');
  assert.equal(classifyActionRisk({ type: 'browser_command', command: 'browser_set_files' }), 'external-write');
});

test('blocks external writes without explicit approval', () => {
  const errors = validateActionEnvelope({
    actionId: 'upload-1',
    action: { type: 'browser_command', command: 'browser_set_files', params: { files: ['C:\\draft.txt'] } },
    reason: 'Attach the selected draft.',
    expectedPostcondition: { kind: 'driver_result' },
    risk: 'external-write',
    timeoutMs: 30_000,
  });
  assert.deepEqual(errors, ['explicit approval is required for this risk level']);
});

test('observes Chrome tabs through the unified contract', async () => {
  const runtime = new BrowserComputerRuntime(new FakeBridge());
  const observation = await runtime.observe();
  assert.equal(observation.availableDrivers[0], 'browser');
  assert.equal(observation.browserTargets[0].tabId, 7);
  assert.equal(observation.browserTargets[0].url, 'https://example.com');
});

test('executes an approved browser action and verifies its result', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserComputerRuntime(bridge);
  const receipt = await runtime.execute({
    actionId: 'navigate-1',
    action: { type: 'browser_command', command: 'browser_navigate', params: { url: 'https://example.com/done' } },
    reason: 'Open the requested page.',
    expectedPostcondition: { kind: 'url_contains', value: '/done' },
    risk: 'reversible-write',
    timeoutMs: 30_000,
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.verification.status, 'passed');
  assert.equal(bridge.calls.at(-1).method, 'browser_navigate');
});
