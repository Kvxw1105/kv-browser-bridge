import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineExpired, operationClassFor } from '../dist/index.js';

test('classifies non-idempotent actions conservatively', () => {
  assert.equal(operationClassFor('get_tabs'), 'read');
  assert.equal(operationClassFor('click'), 'non_idempotent_write');
  assert.equal(operationClassFor('navigate'), 'non_idempotent_write');
});

test('deadline helper has deterministic boundary behavior', () => {
  assert.equal(deadlineExpired(100, 100), true);
  assert.equal(deadlineExpired(101, 100), false);
  assert.equal(deadlineExpired(undefined, 100), false);
});
