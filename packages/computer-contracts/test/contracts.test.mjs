import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionRequiresApproval,
  classifyActionRisk,
  validateActionEnvelope,
} from '../dist/index.js';

test('classifies browser reads without approval', () => {
  const action = { type: 'browser_command', command: 'browser_get_tabs' };
  assert.equal(classifyActionRisk(action), 'read');
});

test('requires approval before local file upload', () => {
  const envelope = {
    actionId: 'upload-1',
    action: {
      type: 'browser_command',
      command: 'browser_set_files',
      params: { files: ['C:\\temp\\draft.txt'] },
    },
    reason: 'Attach the user-selected draft.',
    expectedPostcondition: { kind: 'driver_result' },
    risk: 'external-write',
    timeoutMs: 30_000,
  };

  assert.equal(actionRequiresApproval(envelope), true);
  assert.deepEqual(validateActionEnvelope(envelope), [
    'explicit approval is required for this risk level',
  ]);
});

test('rejects a risk label that understates the action', () => {
  const envelope = {
    actionId: 'upload-2',
    action: {
      type: 'browser_command',
      command: 'browser_set_files',
      params: {},
    },
    reason: 'Attach a file.',
    expectedPostcondition: { kind: 'none' },
    risk: 'read',
    timeoutMs: 30_000,
    approved: true,
  };

  assert.match(validateActionEnvelope(envelope).join('\n'), /risk mismatch/);
});
