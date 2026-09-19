import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchClick, isClickFailure, resolveInputTarget } from '../src/background/cdp-input.ts';

/** In-memory CDP runner: per-method canned replies, call log, throw-on-demand.
 * A reply/throw value may be a function `(method, params, callIndex)`. */
function fakeRunner({ replies = {}, throws = {} } = {}) {
  const calls = [];
  let callIndex = 0;
  async function send(method, params) {
    const index = callIndex++;
    calls.push([method, params]);
    if (throws[method]) {
      const trigger = throws[method];
      const thrown = typeof trigger === 'function' ? trigger(method, params, index) : trigger;
      if (thrown !== undefined) throw thrown;
    }
    const reply = replies[method];
    if (typeof reply === 'function') return reply(method, params, index);
    return reply ?? {};
  }
  return {
    calls,
    async ensureAttached() { calls.push(['ensureAttached']); },
    send,
  };
}

function probeReply(overrides = {}) {
  return { result: { value: { x: 100, y: 200, tag: 'button', text: 'Save', publishBlocked: false, ...overrides } } };
}

function mouseEvents(calls) {
  return calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params.type);
}

function happyRunner() {
  return fakeRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-1' } },
      'Runtime.callFunctionOn': probeReply(),
      'DOM.getNodeForLocation': { backendNodeId: 7 },
    },
  });
}

test('clicks a visible uncovered target with a full trusted mouse sequence', async () => {
  const runner = happyRunner();
  const outcome = await dispatchClick(runner, 7, {});
  assert.equal(outcome.ok, true);
  assert.equal(outcome.effectState, 'committed');
  assert.equal(outcome.x, 100);
  assert.equal(outcome.y, 200);
  assert.deepEqual(mouseEvents(runner.calls), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('hidden element fails with effectState none before any input', async () => {
  const runner = fakeRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-1' } },
      'Runtime.callFunctionOn': { result: { value: { error: 'hidden' } } },
    },
  });
  const outcome = await dispatchClick(runner, 7, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'ELEMENT_HIDDEN');
  assert.equal(outcome.error.effectState, 'none');
  assert.deepEqual(mouseEvents(runner.calls), []);
});

test('covered action point fails with effectState none before any input', async () => {
  const containmentRunner = fakeRunner({
    replies: {
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': (method, params) => {
        const arg = params?.arguments?.[0];
        // Input probe passes a plain value; containment probe passes an objectId.
        return arg && typeof arg.objectId === 'string' ? { result: { value: false } } : probeReply();
      },
      'DOM.getNodeForLocation': { backendNodeId: 99 },
    },
  });
  const outcome = await dispatchClick(containmentRunner, 7, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'ELEMENT_COVERED');
  assert.equal(outcome.error.effectState, 'none');
  assert.deepEqual(mouseEvents(containmentRunner.calls), []);
});

test('cancel between mouseMoved and mousePressed fails with effectState none', async () => {
  const controller = new AbortController();
  const runner = fakeRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-1' } },
      'Runtime.callFunctionOn': probeReply(),
      'DOM.getNodeForLocation': { backendNodeId: 7 },
      // mouseMoved succeeds and cancels before mousePressed is dispatched.
      'Input.dispatchMouseEvent': () => { controller.abort(); return {}; },
    },
  });
  const outcome = await dispatchClick(runner, 7, { signal: controller.signal });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'INPUT_CANCELLED');
  assert.equal(outcome.error.effectState, 'none');
  assert.deepEqual(mouseEvents(runner.calls), ['mouseMoved']);
});

test('disconnect after mousePressed fails with effectState unknown', async () => {
  const runner = fakeRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-1' } },
      'Runtime.callFunctionOn': probeReply(),
      'DOM.getNodeForLocation': { backendNodeId: 7 },
    },
    throws: {
      // The first two mouse events succeed; the third (mouseReleased) disconnects.
      'Input.dispatchMouseEvent': (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 3) throw new Error('chrome.debugger: Target closed');
        };
      })(),
    },
  });
  const outcome = await dispatchClick(runner, 7, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'INPUT_DISCONNECTED');
  assert.equal(outcome.error.effectState, 'unknown');
  // mouseMoved + mousePressed were dispatched (and mouseReleased attempted)
  // before the failure — the page may already have reacted.
  assert.deepEqual(mouseEvents(runner.calls), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('publish button without confirmation is blocked before any input', async () => {
  const runner = fakeRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-1' } },
      'Runtime.callFunctionOn': probeReply({ text: '发布作品', publishBlocked: true }),
      'DOM.getNodeForLocation': { backendNodeId: 7 },
    },
  });
  const outcome = await dispatchClick(runner, 7, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'PREPUBLISH_BLOCKED');
  assert.equal(outcome.error.effectState, 'none');
  assert.deepEqual(mouseEvents(runner.calls), []);
});

test('resolveInputTarget surfaces a stale backend node without dispatching input', async () => {
  const runner = fakeRunner({
    replies: { 'DOM.resolveNode': { object: undefined } },
  });
  const result = await resolveInputTarget(runner, 404, {});
  assert.ok(isClickFailure(result));
  assert.equal(result.code, 'ELEMENT_NOT_FOUND');
  assert.equal(result.effectState, 'none');
});
