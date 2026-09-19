import assert from 'node:assert/strict';
import test from 'node:test';
import {
  disconnectOutcomeFor,
  effectClassForMethod,
  operationClassForMethod,
  timeoutOutcomeFor,
} from '../dist/reliability.js';
import { effectClassFor, operationClassFor } from '../../../packages/browser-protocol/dist/index.js';

test('protocol classifies every read action as passive_read', () => {
  for (const action of [
    'get_tabs', 'find', 'download_status', 'list_bookmarks', 'list_extensions',
    'snapshot', 'screenshot', 'wait_for', 'get_text', 'get_url',
    'console_logs', 'console_errors', 'network_requests', 'network_failures',
    'get_response_body', 'inspect_element', 'get_element_styles', 'page_metrics',
    'list_webmcp_tools',
  ]) {
    assert.equal(effectClassFor(action), 'passive_read', action);
    assert.equal(operationClassFor(action), 'read', action);
  }
});

test('protocol classifies page-effect writes conservatively', () => {
  for (const action of ['navigate', 'type', 'select', 'set_files', 'evaluate']) {
    assert.equal(effectClassFor(action), 'browser_mutation', action);
  }
  assert.equal(effectClassFor('execute_webmcp_tool'), 'external_commit');
  for (const action of ['scroll', 'click', 'press']) {
    assert.equal(effectClassFor(action), 'transient_input', action);
  }
  for (const action of ['new_tab', 'switch_tab', 'close_tab', 'open_bookmark']) {
    assert.equal(effectClassFor(action), 'control_plane', action);
  }
});

test('server mirrors the protocol classification for browser methods', () => {
  assert.equal(effectClassForMethod('browser_get_url'), 'passive_read');
  assert.equal(effectClassForMethod('browser_click'), 'transient_input');
  assert.equal(effectClassForMethod('browser_execute_webmcp_tool'), 'external_commit');
  assert.equal(effectClassForMethod('browser_switch_tab'), 'control_plane');
  assert.equal(effectClassForMethod('browser_set_files'), 'browser_mutation');
});

test('an unrecognized method is conservatively a browser mutation', () => {
  assert.equal(effectClassForMethod('browser_mystery_write'), 'browser_mutation');
});

test('read timeout is retryable with dispatch phase', () => {
  const outcome = timeoutOutcomeFor('browser_get_url');
  assert.deepEqual(outcome, { code: 'BRIDGE_TIMEOUT', retryable: true, effectClass: 'passive_read', phase: 'dispatch' });
});

test('every non-read effect class times out as UNKNOWN_OUTCOME and is never retried', () => {
  for (const method of ['browser_click', 'browser_type', 'browser_navigate', 'browser_execute_webmcp_tool', 'browser_set_files', 'browser_switch_tab']) {
    const outcome = timeoutOutcomeFor(method);
    assert.equal(outcome.code, 'UNKNOWN_OUTCOME', method);
    assert.equal(outcome.retryable, false, method);
    assert.equal(outcome.phase, 'dispatch', method);
    assert.ok(outcome.effectClass !== 'passive_read', method);
  }
});

test('control-plane and read disconnects may reconnect', () => {
  assert.deepEqual(disconnectOutcomeFor('control_plane'), { code: 'BRIDGE_UNAVAILABLE', retryable: true, effectClass: 'control_plane', phase: 'disconnect' });
  assert.deepEqual(disconnectOutcomeFor('passive_read'), { code: 'BRIDGE_UNAVAILABLE', retryable: true, effectClass: 'passive_read', phase: 'disconnect' });
});

test('page-effect disconnects are unknown outcomes, never retried', () => {
  for (const effectClass of ['transient_input', 'browser_mutation', 'external_commit']) {
    const outcome = disconnectOutcomeFor(effectClass);
    assert.equal(outcome.code, 'UNKNOWN_OUTCOME', effectClass);
    assert.equal(outcome.retryable, false, effectClass);
    assert.equal(outcome.phase, 'disconnect', effectClass);
  }
});

test('legacy operation class keeps reads apart from everything else', () => {
  assert.equal(operationClassForMethod('browser_get_tabs'), 'read');
  assert.equal(operationClassForMethod('browser_connection_status'), 'read');
  assert.equal(operationClassForMethod('browser_execute_webmcp_tool'), 'non_idempotent_write');
  assert.equal(operationClassForMethod('browser_click'), 'non_idempotent_write');
});
