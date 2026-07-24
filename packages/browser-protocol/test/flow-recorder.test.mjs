import assert from 'node:assert/strict';
import test from 'node:test';
import { compileWorkflow, redactRecordedInput } from '../dist/flow-recorder.js';

test('compiles a manual click with semantic and normalized coordinate targets', () => {
  const workflow = compileWorkflow({
    id: 'run-1',
    intent: 'open comments',
    startedAt: '2026-07-25T00:00:00.000Z',
    tabId: 42,
    events: [{
      kind: 'human_click',
      at: '2026-07-25T00:00:01.000Z',
      page: { url: 'https://example.test/studio', viewport: { width: 1200, height: 800, devicePixelRatio: 1 } },
      target: { selector: '[data-testid="comments"]', xpath: '//button[1]', role: 'button', name: 'Comments', x: 900, y: 200, xRatio: 0.75, yRatio: 0.25 },
    }],
  });
  assert.equal(workflow.steps[0].strategy, 'hybrid');
  assert.equal(workflow.steps[0].target.geometry.xRatio, 0.75);
  assert.equal(workflow.steps[0].target.semantic.name, 'Comments');
});

test('redacts sensitive manual input while retaining useful shape metadata', () => {
  assert.deepEqual(redactRecordedInput('123456', 'otp'), { redacted: true, length: 6, kind: 'otp' });
  assert.deepEqual(redactRecordedInput('regular title', 'text'), { redacted: false, value: 'regular title', length: 13, kind: 'text' });
});

test('marks unresolved errors as human guidance checkpoints', () => {
  const workflow = compileWorkflow({
    id: 'run-2', intent: 'publish draft', startedAt: '2026-07-25T00:00:00.000Z', tabId: 42,
    events: [{ kind: 'blocker', at: '2026-07-25T00:00:02.000Z', code: 'CAPTCHA_DETECTED', message: 'Complete verification' }],
  });
  assert.equal(workflow.checkpoints[0].kind, 'human_guidance');
  assert.equal(workflow.checkpoints[0].reason, 'CAPTCHA_DETECTED');
});
