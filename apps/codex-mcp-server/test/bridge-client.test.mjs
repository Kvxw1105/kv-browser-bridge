import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUsableBridgeConfig } from '../dist/bridge-client.js';
import { operationClassForMethod, PerTabWriteQueue, timeoutErrorForMethod } from '../dist/reliability.js';

test('falls back from an incomplete Kv discovery candidate to a usable legacy candidate', () => {
  const legacy = { pipeName: '\\\\.\\pipe\\local-chrome-legacy', token: 'legacy-token' };

  assert.deepEqual(
    selectUsableBridgeConfig([
      { pipeName: '\\\\.\\pipe\\kv-browser-bridge-stale' },
      legacy,
    ]),
    legacy,
  );
});

test('timeouts conservatively classify writes as unknown outcomes', () => {
  assert.equal(operationClassForMethod('browser_get_url'), 'read');
  assert.deepEqual(timeoutErrorForMethod('browser_get_url'), { code: 'BRIDGE_TIMEOUT', retryable: true });
  assert.deepEqual(timeoutErrorForMethod('browser_click'), { code: 'UNKNOWN_OUTCOME', retryable: false });
});

test('per-tab write queue serializes one tab but permits another tab', async () => {
  const queue = new PerTabWriteQueue();
  const events = [];
  let release;
  const first = queue.run(1, 'non_idempotent_write', async () => { events.push('first'); await new Promise((resolve) => { release = resolve; }); events.push('first-end'); });
  const second = queue.run(1, 'non_idempotent_write', async () => { events.push('second'); });
  const other = queue.run(2, 'non_idempotent_write', async () => { events.push('other'); });
  await other;
  assert.deepEqual(events, ['first', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'first-end', 'second']);
});
