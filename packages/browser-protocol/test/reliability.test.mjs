import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineExpired, isBrowserToolName, operationClassFor } from '../dist/index.js';

test('classifies non-idempotent actions conservatively', () => {
  assert.equal(operationClassFor('get_tabs'), 'read');
  assert.equal(operationClassFor('click'), 'non_idempotent_write');
  assert.equal(operationClassFor('navigate'), 'non_idempotent_write');
});

test('recognizes DevTools diagnostics as read-only browser tools', () => {
  for (const name of [
    'browser_console_logs', 'browser_console_errors', 'browser_network_requests',
    'browser_network_failures', 'browser_get_response_body', 'browser_inspect_element',
    'browser_get_element_styles', 'browser_page_metrics',
  ]) {
    assert.equal(isBrowserToolName(name), true, name);
    assert.equal(operationClassFor(name.slice('browser_'.length)), 'read', name);
  }
});

test('deadline helper has deterministic boundary behavior', () => {
  assert.equal(deadlineExpired(100, 100), true);
  assert.equal(deadlineExpired(101, 100), false);
  assert.equal(deadlineExpired(undefined, 100), false);
});
