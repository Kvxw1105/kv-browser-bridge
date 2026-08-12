import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeDisconnectErrorFor } from '../dist/native-disconnect.js';
import { MultiAgentCoordinator } from '../dist/coordinator.js';
import { serializeCoordinationStatus } from '@kv-browser-bridge/browser-protocol';

const identity = (id) => ({ clientId: id, clientName: id, instanceId: `${id}-instance`, capabilities: ['read', 'write', 'record'] });
const coordinator = () => {
  const value = new MultiAgentCoordinator({ mode: 'enforce' });
  value.connect(identity('agent-a'), 'session-a');
  value.connect(identity('agent-b'), 'session-b');
  return value;
};

test('native disconnect uses the ChromeBridge pending-request policy for writes', () => {
  const write = nativeDisconnectErrorFor('non_idempotent_write', 'native host exited');
  assert.equal(write.code, 'UNKNOWN_OUTCOME');
  assert.equal(write.retryable, false);
  const read = nativeDisconnectErrorFor('read', 'native host exited');
  assert.equal(read.code, 'CONNECTION_CLOSED');
  assert.equal(read.retryable, true);
});

test('actual ChromeBridge native-error handler rejects a seeded write as unknown outcome', async () => {
  process.env.KV_BRIDGE_TEST = '1';
  const { testActualNativeDisconnect } = await import('../dist/bridge.js');
  const error = await testActualNativeDisconnect('non_idempotent_write');
  assert.equal(error.code, 'UNKNOWN_OUTCOME');
  assert.equal(error.retryable, false);
});

test('native request routing keeps same external IDs isolated across sessions', async () => {
  process.env.KV_BRIDGE_TEST = '1';
  const { testNativeRequestRouting } = await import('../dist/bridge.js');
  const routed = await testNativeRequestRouting();
  assert.equal(new Set(routed.requestIds).size, 2);
  assert.deepEqual(routed.results, ['first', 'second']);
});

test('idempotency cache hit skips record-start lease acquisition', async () => {
  process.env.KV_BRIDGE_TEST = '1';
  const { testIdempotencyCacheSkipsRecordingLease } = await import('../dist/bridge.js');
  const result = await testIdempotencyCacheSkipsRecordingLease();
  assert.equal(result.acquireCount, 0);
  assert.deepEqual(result.response, { type: 'response', id: 'request-1', ok: true, result: 'cached' });
});

test('record-start unknown outcome quarantines its tab once', async () => {
  process.env.KV_BRIDGE_TEST = '1';
  const { testUnknownOutcomeQuarantineCount } = await import('../dist/bridge.js');
  assert.equal(await testUnknownOutcomeQuarantineCount(), 1);
});

test('Bridge coordination serializes same-tab writes across sessions', async () => {
  const value = coordinator();
  const order = [];
  let release;
  const first = value.runTabWrite(7, async () => {
    order.push('first-start');
    await new Promise((resolve) => { release = resolve; });
    order.push('first-end');
  });
  const second = value.runTabWrite(7, async () => { order.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('Bridge coordination permits different-tab writes to overlap', async () => {
  const value = coordinator();
  let release;
  const first = value.runTabWrite(7, async () => new Promise((resolve) => { release = resolve; }));
  let secondStarted = false;
  const second = value.runTabWrite(8, async () => { secondStarted = true; });
  await second;
  assert.equal(secondStarted, true);
  release();
  await first;
});

test('Bridge coordination keeps each session target isolated', () => {
  const value = coordinator();
  value.setDefaultTab('session-a', 7);
  value.setDefaultTab('session-b', 8);
  assert.equal(value.resolveTab('session-a'), 7);
  assert.equal(value.resolveTab('session-b'), 8);
});

test('Bridge coordination makes recorder ownership exclusive and cleans up on disconnect', () => {
  const value = coordinator();
  const lease = value.acquire('session-a', 'global:recorder', 'recording', 5_000);
  assert.throws(() => value.acquire('session-b', 'global:recorder', 'recording', 5_000), (error) => error.code === 'RESOURCE_BUSY');
  value.disconnect('session-a');
  assert.doesNotThrow(() => value.acquire('session-b', 'global:recorder', 'recording', 5_000));
  assert.equal(value.status().leases.some((entry) => entry.id === lease.id), false);
});

test('Bridge coordination status is redacted before transport broadcast', () => {
  const value = coordinator();
  value.setDefaultTab('session-a', 7);
  const status = serializeCoordinationStatus(value.status());
  const text = JSON.stringify(status);
  assert.equal(text.includes('session-a'), false);
  assert.equal(text.includes('agent-a-instance'), false);
  assert.equal(text.includes('token'), false);
  assert.equal(text.includes('pipe'), false);
  assert.equal(status.clients[0].defaultTabId, 7);
});
