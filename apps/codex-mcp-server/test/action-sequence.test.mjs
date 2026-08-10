import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionSequenceExecutor,
  sequenceActionId,
  validateActionSequence,
} from '../dist/action-sequence.js';

const browserStep = (stepId, overrides = {}) => ({
  stepId,
  action: { type: 'browser_command', command: 'browser_get_tabs' },
  reason: 'Read the current browser tabs.',
  expectedPostcondition: { kind: 'driver_result' },
  risk: 'read',
  ...overrides,
});

const launchStep = (stepId, overrides = {}) => ({
  stepId,
  action: { type: 'launch_app', appId: 'notepad' },
  reason: 'Launch the allowlisted application.',
  expectedPostcondition: { kind: 'process_started', appId: 'notepad' },
  risk: 'reversible-write',
  ...overrides,
});

const sequence = (steps, overrides = {}) => ({
  sequenceId: 'sequence-1',
  steps,
  stopOnFailure: true,
  ...overrides,
});

const actionReceipt = (envelope, status = 'completed', verification = status === 'completed' ? 'passed' : 'failed') => ({
  protocolVersion: 1,
  actionId: envelope.actionId,
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(1).toISOString(),
  driver: envelope.action.type === 'launch_app'
    ? 'native-app'
    : envelope.action.type === 'browser_command'
      ? 'browser'
      : 'windows-uia',
  status,
  result: envelope.action.type === 'launch_app'
    ? { action: 'launch_app', appId: envelope.action.appId, pid: 1234, startedAt: new Date(0).toISOString() }
    : { action: envelope.action.type },
  verification: { status: verification },
});

const recordingExecutor = (handler = async (envelope) => actionReceipt(envelope), options = {}) => {
  const calls = [];
  const executor = new ActionSequenceExecutor(async (envelope) => {
    calls.push(envelope);
    return await handler(envelope, calls.length - 1);
  }, options);
  return { executor, calls };
};

test('executes a one-step sequence successfully', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([browserStep('read')]));
  assert.equal(result.status, 'completed');
  assert.equal(result.totalSteps, 1);
  assert.equal(result.completedSteps, 1);
  assert.equal(result.stepReceipts.length, 1);
  assert.equal(calls.length, 1);
});

test('executes multiple steps strictly in order without parallel overlap', async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const { executor, calls } = recordingExecutor(async (envelope) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${envelope.actionId}`);
    await Promise.resolve();
    events.push(`finish:${envelope.actionId}`);
    active -= 1;
    return actionReceipt(envelope);
  });
  const result = await executor.execute(sequence([
    browserStep('one'),
    browserStep('two'),
    browserStep('three'),
  ]));
  assert.equal(result.status, 'completed');
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map((call) => call.actionId), [
    'sequence-1:one',
    'sequence-1:two',
    'sequence-1:three',
  ]);
  assert.deepEqual(events, [
    'start:sequence-1:one',
    'finish:sequence-1:one',
    'start:sequence-1:two',
    'finish:sequence-1:two',
    'start:sequence-1:three',
    'finish:sequence-1:three',
  ]);
});

test('allows exactly ten steps', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence(
    Array.from({ length: 10 }, (_, index) => browserStep(`step-${index + 1}`)),
  ));
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 10);
  assert.equal(calls.length, 10);
});

test('rejects eleven steps before execution', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence(
    Array.from({ length: 11 }, (_, index) => browserStep(`step-${index + 1}`)),
  ));
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'SEQUENCE_TOO_LARGE');
  assert.equal(calls.length, 0);
  assert.equal(result.stepReceipts.length, 0);
});

test('rejects an empty sequence before execution', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([]));
  assert.equal(result.error.code, 'SEQUENCE_INVALID');
  assert.equal(calls.length, 0);
});

test('rejects duplicate step IDs before execution', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([browserStep('same'), browserStep('same')]));
  assert.equal(result.error.code, 'DUPLICATE_STEP_ID');
  assert.equal(result.stoppedAtStep, 'same');
  assert.equal(calls.length, 0);
});

test('rejects unsafe sequence IDs', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([browserStep('one')], { sequenceId: 'bad:sequence id' }));
  assert.equal(result.error.code, 'SEQUENCE_INVALID');
  assert.equal(calls.length, 0);
});

test('requires stopOnFailure when the field is supplied', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([browserStep('one')], { stopOnFailure: false }));
  assert.equal(result.error.code, 'STOP_ON_FAILURE_REQUIRED');
  assert.equal(calls.length, 0);
});

test('forbids nested sequences before any action runs', async () => {
  const { executor, calls } = recordingExecutor();
  const nested = browserStep('nested', {
    action: { type: 'computer_execute_sequence', steps: [] },
    risk: 'reversible-write',
  });
  const result = await executor.execute(sequence([nested]));
  assert.equal(result.error.code, 'NESTED_SEQUENCE_FORBIDDEN');
  assert.equal(calls.length, 0);
});

test('stops after the first blocked receipt and does not execute later steps', async () => {
  const { executor, calls } = recordingExecutor(async (envelope) => actionReceipt(envelope, 'blocked', 'unknown'));
  const result = await executor.execute(sequence([browserStep('blocked'), browserStep('later')]));
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'STEP_BLOCKED');
  assert.equal(result.stoppedAtStep, 'blocked');
  assert.deepEqual(result.skippedSteps, ['later']);
  assert.equal(result.stepReceipts.length, 1);
  assert.equal(calls.length, 1);
});

test('stops after a failed middle step and retains completed receipts', async () => {
  const { executor, calls } = recordingExecutor(async (envelope, index) => (
    index === 1 ? actionReceipt(envelope, 'failed') : actionReceipt(envelope)
  ));
  const result = await executor.execute(sequence([
    browserStep('first'),
    browserStep('failed'),
    browserStep('never'),
  ]));
  assert.equal(result.status, 'partially-completed');
  assert.equal(result.error.code, 'STEP_FAILED');
  assert.equal(result.completedSteps, 1);
  assert.deepEqual(result.stepReceipts.map((receipt) => receipt.actionId), [
    'sequence-1:first',
    'sequence-1:failed',
  ]);
  assert.deepEqual(result.skippedSteps, ['never']);
  assert.equal(calls.length, 2);
});

test('treats failed verification as a failed step even if receipt status says completed', async () => {
  const { executor, calls } = recordingExecutor(async (envelope) => actionReceipt(envelope, 'completed', 'failed'));
  const result = await executor.execute(sequence([browserStep('unverified'), browserStep('never')]));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'STEP_FAILED');
  assert.equal(result.completedSteps, 0);
  assert.equal(calls.length, 1);
});

test('stops at the total deadline and preserves work already completed', async () => {
  let now = 0;
  const { executor, calls } = recordingExecutor(async (envelope) => {
    now = 101;
    return actionReceipt(envelope);
  }, { now: () => now });
  const result = await executor.execute(sequence([
    browserStep('first'),
    browserStep('timed-out'),
  ], { timeoutMs: 100 }));
  assert.equal(result.status, 'partially-completed');
  assert.equal(result.error.code, 'SEQUENCE_TIMEOUT');
  assert.equal(result.stoppedAtStep, 'timed-out');
  assert.equal(result.completedSteps, 1);
  assert.deepEqual(result.skippedSteps, ['timed-out']);
  assert.equal(calls.length, 1);
});

test('does not retry a step that throws', async () => {
  const { executor, calls } = recordingExecutor(async () => {
    throw new Error('side effect outcome is unknown');
  });
  const result = await executor.execute(sequence([browserStep('once'), browserStep('never')]));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'STEP_FAILED');
  assert.equal(result.error.retryable, false);
  assert.equal(calls.length, 1);
});

test('blocks an unapproved external-write step during sequence validation', async () => {
  const { executor, calls } = recordingExecutor();
  const upload = browserStep('upload', {
    action: { type: 'browser_command', command: 'browser_set_files', params: { files: ['C:\\draft.txt'] } },
    reason: 'Upload a selected file.',
    risk: 'external-write',
  });
  const result = await executor.execute(sequence([upload]));
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'STEP_BLOCKED');
  assert.match(result.error.message, /explicit approval/);
  assert.equal(calls.length, 0);
});

test('preserves explicit per-step approval without adding it automatically', async () => {
  const { executor, calls } = recordingExecutor();
  const upload = browserStep('upload', {
    action: { type: 'browser_command', command: 'browser_set_files', params: { files: ['C:\\draft.txt'] } },
    reason: 'Upload a selected file.',
    risk: 'external-write',
    approved: true,
  });
  const result = await executor.execute(sequence([upload]));
  assert.equal(result.status, 'completed');
  assert.equal(result.risk, 'external-write');
  assert.equal(calls[0].approved, true);
});

test('keeps launch_app appId-only enforcement inside sequences', async () => {
  for (const [field, value] of Object.entries({
    path: 'C:\\Windows\\notepad.exe',
    command: 'notepad.exe',
    args: ['/unsafe'],
    shell: true,
  })) {
    const { executor, calls } = recordingExecutor();
    const result = await executor.execute(sequence([
      launchStep('launch', { action: { type: 'launch_app', appId: 'notepad', [field]: value } }),
    ]));
    assert.equal(result.error.code, 'STEP_BLOCKED');
    assert.match(result.error.message, new RegExp(`does not allow field ${field}`));
    assert.equal(calls.length, 0);
  }
});

test('supports a bounded browser, UIA, and native-app sequence', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([
    browserStep('browser'),
    {
      stepId: 'focus',
      action: { type: 'focus_window', windowHandle: 42 },
      reason: 'Focus the selected window.',
      expectedPostcondition: { kind: 'window_focused', windowHandle: 42 },
      risk: 'reversible-write',
    },
    launchStep('launch'),
  ]));
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map((call) => call.action.type), ['browser_command', 'focus_window', 'launch_app']);
  assert.equal(result.risk, 'reversible-write');
});

test('generates deterministic action IDs and rejects client-supplied step actionId', async () => {
  assert.equal(sequenceActionId('seq', 'step'), 'seq:step');
  const { executor, calls } = recordingExecutor();
  const result = await executor.execute(sequence([
    { ...browserStep('one'), actionId: 'client-controlled' },
  ]));
  assert.equal(result.error.code, 'SEQUENCE_INVALID');
  assert.equal(calls.length, 0);
});

test('validates step and total timeout bounds before execution', () => {
  assert.equal(validateActionSequence(sequence([
    browserStep('step', { timeoutMs: 120_001 }),
  ]))[0].code, 'SEQUENCE_INVALID');
  assert.equal(validateActionSequence(sequence([
    browserStep('step'),
  ], { timeoutMs: 300_001 }))[0].code, 'SEQUENCE_INVALID');
});
