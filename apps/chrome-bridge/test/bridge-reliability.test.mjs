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
