import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  uploadInputProbe,
  uploadSummaryProbe,
  uploadThroughActivatedFileInput,
  validateUploadFiles,
} from '../src/background/upload-transaction.ts';

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileIo() {
  return {
    async stat(path) {
      try {
        const { statSync } = await import('node:fs');
        const info = statSync(path);
        return { size: info.size };
      } catch {
        return null;
      }
    },
    async sha256(path) {
      const { readFileSync } = await import('node:fs');
      return sha256Of(readFileSync(path));
    },
  };
}

function packageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kv-upload-'));
  const a = join(root, 'image-a.png');
  const b = join(root, 'sub', 'image-b.png');
  mkdirSync(join(root, 'sub'), { recursive: true });
  const bytesA = Buffer.from('fake-png-a');
  const bytesB = Buffer.from('fake-png-b');
  writeFileSync(a, bytesA);
  writeFileSync(b, bytesB);
  return {
    root,
    a,
    b,
    manifest: { files: [{ path: a, sha256: sha256Of(bytesA) }, { path: b, sha256: sha256Of(bytesB) }] },
  };
}

/** In-memory CDP runner with an event bus for Page.fileChooserOpened. */
function fakeUploadRunner({ replies = {}, throws = {}, chooserMode = 'selectSingle', fireChooserOnClick = true } = {}) {
  const calls = [];
  const handlers = [];
  const fireChooser = (event) => {
    for (const handler of [...handlers]) handler('Page.fileChooserOpened', event);
  };
  const runner = {
    calls,
    async ensureAttached() { calls.push(['ensureAttached']); },
    async send(method, params) {
      const index = calls.filter(([m]) => m === method).length;
      calls.push([method, params]);
      // Chrome opens the native chooser when the trusted click lands.
      if (fireChooserOnClick && method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        fireChooser({ backendNodeId: 500, mode: chooserMode });
      }
      if (throws[method]) {
        const trigger = throws[method];
        const thrown = typeof trigger === 'function' ? trigger(method, params, index) : trigger;
        if (thrown !== undefined) throw thrown;
      }
      const reply = replies[method];
      return typeof reply === 'function' ? reply(method, params, index) : (reply ?? {});
    },
    onEvent(handler) {
      handlers.push(handler);
      return { dispose: () => { handlers.splice(handlers.indexOf(handler), 1); } };
    },
    fireChooser,
  };
  return runner;
}

function runtimeCallReply(params, summaryCount = 1) {
  const decl = params.functionDeclaration ?? '';
  if (decl.includes(uploadInputProbe.toString())) return { result: { objectId: 'obj-upload-input' } };
  if (decl.includes(uploadSummaryProbe.toString())) return { result: { value: { count: summaryCount, multiple: false } } };
  if (decl.includes('publishBlocked')) return { result: { value: { x: 10, y: 20, tag: 'input', text: 'Choose File', publishBlocked: false } } };
  return { result: { value: true } };
}

function happyRunner(overrides = {}) {
  return fakeUploadRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-trigger' } },
      'Runtime.callFunctionOn': (method, params) => runtimeCallReply(params, overrides.summaryCount ?? 1),
      'DOM.getNodeForLocation': { backendNodeId: 42 },
      'DOM.describeNode': { node: { backendNodeId: 501 } },
    },
    ...overrides.runner,
  });
}

const baseOptions = (runner, files, overrides = {}) => ({
  runner,
  tabId: 7,
  backendNodeId: 42,
  files,
  timeoutMs: 500,
  activationGraceMs: 50,
  ...overrides,
});

test('validateUploadFiles accepts an in-root package with matching hashes', async () => {
  const fx = packageFixture();
  const result = await validateUploadFiles([fx.a, fx.b], { packageRoot: fx.root, manifest: fx.manifest }, fileIo());
  assert.deepEqual(result, { ok: true, verifiedHashes: true });
});

test('validateUploadFiles rejects a file outside the package root', async () => {
  const fx = packageFixture();
  const outside = join(tmpdir(), 'kv-upload-outside', 'x.png');
  const result = await validateUploadFiles([fx.a, outside], { packageRoot: fx.root, manifest: fx.manifest }, fileIo());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_VALIDATION_FAILED');
  assert.ok(result.details.outside.includes(outside));
});

test('validateUploadFiles rejects an untracked file and a hash mismatch', async () => {
  const fx = packageFixture();
  const untracked = await validateUploadFiles([join(fx.root, 'untracked.png')], { packageRoot: fx.root, manifest: fx.manifest }, fileIo());
  assert.equal(untracked.ok, false);
  assert.ok(untracked.details.untracked.length === 1);

  const tampered = await validateUploadFiles([fx.a], {
    packageRoot: fx.root,
    manifest: { files: [{ path: fx.a, sha256: 'a'.repeat(64) }] },
  }, fileIo());
  assert.equal(tampered.ok, false);
  assert.ok(tampered.details.hashMismatch.includes(fx.a));
});

test('validateUploadFiles rejects non-absolute paths, traversal, and the adapter limit', async () => {
  const fx = packageFixture();
  const relative = await validateUploadFiles(['relative\\x.png'], { packageRoot: fx.root, manifest: fx.manifest }, fileIo());
  assert.equal(relative.ok, false);
  const traversal = await validateUploadFiles([join(fx.root, '..', 'escape.png')], { packageRoot: fx.root, manifest: fx.manifest }, fileIo());
  assert.equal(traversal.ok, false);
  const tooMany = await validateUploadFiles(Array.from({ length: 17 }, (_, i) => join(fx.root, `f${i}.png`)), { packageRoot: fx.root, manifest: fx.manifest, maxFiles: 16 }, fileIo());
  assert.equal(tooMany.ok, false);
});

test('validateUploadFiles without file io enforces structure and reports hashes unverified', async () => {
  const fx = packageFixture();
  const result = await validateUploadFiles([fx.a], { packageRoot: fx.root, manifest: fx.manifest });
  assert.deepEqual(result, { ok: true, verifiedHashes: false });
});

test('upload transaction commits via chooser activation with full cleanup', async () => {
  const runner = happyRunner();
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['C:\\pkg\\a.png']));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.effectState, 'committed');
  assert.equal(outcome.phase, 'set_files');
  assert.deepEqual(outcome.fileNames, ['a.png']);
  assert.equal(outcome.tabId, 7);

  const setFilesCalls = runner.calls.filter(([method]) => method === 'DOM.setFileInputFiles');
  assert.equal(setFilesCalls.length, 1);
  assert.deepEqual(setFilesCalls[0][1], { backendNodeId: 500, files: ['C:\\pkg\\a.png'] });
  // Cleanup ran: probe removed, interception disabled, object group released.
  assert.ok(runner.calls.some(([method, params]) => method === 'Page.setInterceptFileChooserDialog' && params.enabled === false && params.cancel === true));
  assert.ok(runner.calls.some(([method]) => method === 'Runtime.releaseObjectGroup'));
  assert.ok(runner.calls.some(([method]) => method === 'Runtime.callFunctionOn'));
});

test('chooser activation timeout returns unknown, keeps cleanup, never auto-retries', async () => {
  const txRunner = fakeUploadRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-trigger' } },
      'Runtime.callFunctionOn': (method, params) => runtimeCallReply(params, 1),
      'DOM.getNodeForLocation': { backendNodeId: 42 },
    },
    throws: { 'DOM.setFileInputFiles': new Error('set files timed out') },
  });
  const outcome = await uploadThroughActivatedFileInput(baseOptions(txRunner, ['C:\\pkg\\a.png']));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.effectState, 'unknown');
  assert.equal(outcome.phase, 'set_files');
  assert.equal(outcome.code, 'SET_FILE_INPUT_FAILED');
  const setFilesCalls = txRunner.calls.filter(([method]) => method === 'DOM.setFileInputFiles');
  assert.equal(setFilesCalls.length, 1, 'never auto-retries an unknown outcome');
  assert.ok(txRunner.calls.some(([method, params]) => method === 'Page.setInterceptFileChooserDialog' && params.enabled === false && params.cancel === true));
  assert.ok(txRunner.calls.some(([method]) => method === 'Runtime.releaseObjectGroup'));
});

test('no chooser activation returns none with phase resolve_input', async () => {
  const runner = happyRunner({ summaryCount: 0, runner: { fireChooserOnClick: false } });
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['C:\\pkg\\a.png']));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.effectState, 'none');
  assert.equal(outcome.phase, 'resolve_input');
  assert.equal(outcome.code, 'UPLOAD_NOT_ACTIVATED');
  assert.equal(runner.calls.filter(([method]) => method === 'DOM.setFileInputFiles').length, 0);
});

test('probe fallback resolves the activated input without a chooser event', async () => {
  const runner = fakeUploadRunner({
    replies: {
      'DOM.resolveNode': { object: { objectId: 'obj-trigger' } },
      'Runtime.callFunctionOn': (method, params) => runtimeCallReply(params, 1),
      'DOM.getNodeForLocation': { backendNodeId: 42 },
      'DOM.describeNode': { node: { backendNodeId: 501 } },
    },
    fireChooserOnClick: false,
  });
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['C:\\pkg\\a.png']));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.effectState, 'committed');
  const setFilesCalls = runner.calls.filter(([method]) => method === 'DOM.setFileInputFiles');
  assert.deepEqual(setFilesCalls[0][1], { backendNodeId: 501, files: ['C:\\pkg\\a.png'] });
});

test('single-file input rejects multiple files before dispatch', async () => {
  const runner = happyRunner({ summaryCount: 1 });
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['C:\\pkg\\a.png', 'C:\\pkg\\b.png']));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.effectState, 'none');
  assert.equal(outcome.code, 'UPLOAD_COUNT_MISMATCH');
  assert.equal(runner.calls.filter(([method]) => method === 'DOM.setFileInputFiles').length, 0);
});

test('validation failure blocks the transaction before any CDP call', async () => {
  const runner = happyRunner();
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['relative\\x.png'], {
    validation: { packageRoot: 'C:\\pkg', manifest: { files: [] } },
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.effectState, 'none');
  assert.equal(outcome.phase, 'validate');
  assert.equal(outcome.code, 'FILE_VALIDATION_FAILED');
  assert.equal(runner.calls.length, 0, 'nothing touched the page');
});

test('cancellation before arming returns none without dispatching', async () => {
  const runner = happyRunner();
  const controller = new AbortController();
  controller.abort();
  const outcome = await uploadThroughActivatedFileInput(baseOptions(runner, ['C:\\pkg\\a.png'], { signal: controller.signal }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.effectState, 'none');
  assert.equal(outcome.phase, 'validate');
  assert.equal(outcome.code, 'UPLOAD_CANCELLED');
});
