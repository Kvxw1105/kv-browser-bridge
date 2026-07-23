import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeDisconnectErrorFor } from '../dist/native-disconnect.js';

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
