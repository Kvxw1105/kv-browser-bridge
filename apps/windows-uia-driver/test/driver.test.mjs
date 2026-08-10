import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const driver = join(process.cwd(), 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.dll');
const harness = join(process.cwd(), 'apps', 'windows-uia-driver', 'test', 'fixtures', 'uia-harness.ps1');
const runInteractiveE2e = process.env.KV_RUN_UIA_E2E === '1';

async function request(method, params = {}) {
  const session = startDriver();
  try { return await session.request(method, params); }
  finally { await session.close(); }
}

function startDriver() {
  const child = spawn('dotnet', [driver], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  let stderr = '';
  let sequence = 0;
  const pending = new Map();

  function rejectPending(error) {
    for (const [id, resolver] of pending) {
      pending.delete(id);
      resolver.reject(error);
    }
  }

  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      rejectPending(new Error(`Windows UIA driver failed to start: ${error.message}`));
      resolve({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => {
      if (pending.size > 0) {
        rejectPending(new Error(`Windows UIA driver exited before responding. code=${code} signal=${signal} stderr=${stderr}`));
      }
      resolve({ code, signal, error: null });
    });
  });

  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const resolver = pending.get(response.id);
      if (!resolver) continue;
      pending.delete(response.id);
      resolver.resolve(response);
    }
  });

  return {
    request(method, params = {}) {
      const id = `test-${++sequence}`;
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new Error(`Windows UIA driver is not running. code=${child.exitCode} signal=${child.signalCode} stderr=${stderr}`));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
        }, 15_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          const resolver = pending.get(id);
          if (!resolver) return;
          pending.delete(id);
          resolver.reject(new Error(`Failed to write ${method} request to Windows UIA driver: ${error.message}`));
        });
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const result = await exitPromise;
      if (result.error) throw result.error;
      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 0, stderr);
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${message}. Last value: ${JSON.stringify(last)}`);
}

test('reports controlled Windows UIA capabilities', async () => {
  const response = await request('status');
  assert.equal(response.ok, true);
  assert.equal(response.result.driver, 'windows-uia');
  assert.equal(response.result.mode, 'controlled-write');
  assert.ok(response.result.capabilities.includes('observe_foreground'));
  assert.ok(response.result.capabilities.includes('focus_window'));
  assert.ok(response.result.capabilities.includes('invoke_ref'));
  assert.ok(response.result.capabilities.includes('set_value_ref'));
});

test('returns a bounded Windows observation envelope', async () => {
  const response = await request('observe', { maxWindows: 5, maxElements: 10, maxDepth: 2 });
  assert.equal(response.ok, true);
  assert.equal(response.result.driver, 'windows-uia');
  assert.ok(Array.isArray(response.result.windows));
  assert.ok(Array.isArray(response.result.elements));
  assert.ok(response.result.windows.length <= 5);
  assert.ok(response.result.elements.length <= 10);
});

test('controls a real Windows form through UI Automation', { timeout: 45_000, skip: !runInteractiveE2e }, async () => {
  const resultPath = join(tmpdir(), `kv-uia-result-${process.pid}-${Date.now()}.txt`);
  const diagnosticPath = join(tmpdir(), `kv-uia-diagnostic-${process.pid}-${Date.now()}.json`);
  const eventPath = join(tmpdir(), `kv-uia-event-${process.pid}-${Date.now()}.txt`);
  const form = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    env: {
      ...process.env,
      KV_UIA_HARNESS_RESULT_PATH: resultPath,
      KV_UIA_HARNESS_DIAGNOSTIC_PATH: diagnosticPath,
      KV_UIA_HARNESS_EVENT_PATH: eventPath,
    },
  });
  let formStderr = '';
  form.stderr.setEncoding('utf8');
  form.stderr.on('data', (chunk) => { formStderr += chunk; });
  const session = startDriver();

  try {
    const harnessDiagnostic = await waitFor(async () => {
      try { return JSON.parse((await readFile(diagnosticPath, 'utf8')).replace(/^\uFEFF/, '')); }
      catch { return undefined; }
    }, 'UIA harness diagnostics were not written');
    const driverStatus = await session.request('status');
    assert.equal(driverStatus.ok, true);
    assert.equal(driverStatus.result.sessionId, harnessDiagnostic.sessionId);
    assert.equal(driverStatus.result.isElevated, harnessDiagnostic.isElevated);

    const window = await waitFor(async () => {
      const observed = await session.request('observe', { maxWindows: 100, maxElements: 5, maxDepth: 1 });
      assert.equal(observed.ok, true);
      return observed.result.windows.find((candidate) => candidate.name === 'KV UIA Integration Harness');
    }, 'UIA harness window did not appear');

    const observed = await session.request('observe', {
      windowHandle: window.handle,
      maxWindows: 100,
      maxElements: 50,
      maxDepth: 6,
    });
    assert.equal(observed.ok, true);
    const input = observed.result.elements.find((element) => element.automationId === 'InputField');
    const apply = observed.result.elements.find((element) => element.automationId === 'ApplyButton');
    const resultLabel = observed.result.elements.find((element) => element.automationId === 'ResultLabel');
    assert.ok(input?.ref, 'input should expose a stable UIA reference');
    assert.equal(input.canSetValue, true);
    assert.ok(apply?.ref, 'button should expose a stable UIA reference');
    assert.equal(apply.canInvoke, true);
    assert.ok(resultLabel?.ref, 'result label should expose a stable UIA reference');
    assert.equal(resultLabel.name, 'Integration Result');

    const value = 'runtime-e2e-value';
    const setResult = await session.request('set_value_ref', {
      windowHandle: window.handle,
      targetRef: input.ref,
      value,
    });
    assert.equal(setResult.ok, true);
    assert.equal(setResult.result.valueSet, true);
    assert.equal(setResult.result.currentValue, value);

    await waitFor(async () => {
      const result = await session.request('observe', {
        windowHandle: window.handle,
        maxWindows: 100,
        maxElements: 50,
        maxDepth: 6,
      });
      assert.equal(result.ok, true);
      const current = result.result.elements.find((element) => element.automationId === 'InputField');
      return current?.value === value ? current : undefined;
    }, 'input value did not stabilize before button invocation');

    const invokeResult = await session.request('invoke_ref', {
      windowHandle: window.handle,
      targetRef: apply.ref,
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result.dispatchMethod, 'win32-bm-click');
    assert.ok(Number.isInteger(invokeResult.result.nativeWindowHandle));
    assert.notEqual(invokeResult.result.nativeWindowHandle, 0);
    assert.equal(invokeResult.result.nativeProcessId, form.pid);
    assert.match(invokeResult.result.nativeWindowClassName, /^WindowsForms10\.BUTTON/);

    const expected = `Applied:${value}`;
    const eventState = await waitFor(async () => {
      try {
        const content = (await readFile(eventPath, 'utf8')).replace(/^\uFEFF/, '');
        return content.startsWith('entered') || content.startsWith('error:') ? content : undefined;
      } catch { return undefined; }
    }, 'button invocation did not enter the harness Click handler');
    assert.ok(!eventState.startsWith('error:'), eventState);

    await waitFor(async () => {
      const result = await session.request('observe', {
        windowHandle: window.handle,
        maxWindows: 100,
        maxElements: 50,
        maxDepth: 6,
      });
      assert.equal(result.ok, true);
      const current = result.result.elements.find((element) => element.automationId === 'ResultLabel');
      return current?.name === expected && result.result.targetWindow?.name === `KV UIA Integration Harness - ${expected}`
        ? current
        : undefined;
    }, 'button invocation did not update the result label and harness title');

    const applied = await waitFor(async () => {
      try {
        const content = (await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, '');
        return content === expected ? content : undefined;
      } catch {
        return undefined;
      }
    }, 'button invocation did not execute the real form click handler');
    assert.equal(applied, expected);
  } finally {
    form.kill();
    await once(form, 'exit').catch(() => undefined);
    await session.close();
    await rm(resultPath, { force: true });
    await rm(diagnosticPath, { force: true });
    await rm(eventPath, { force: true });
    assert.equal(formStderr, '');
  }
});

test('rejects unknown UIA methods', async () => {
  const response = await request('click_point', { x: 10, y: 10 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'METHOD_NOT_FOUND');
});

test('rejects malformed UIA references before execution', async () => {
  const response = await request('invoke_ref', { windowHandle: 1, targetRef: 'coordinate:10,10' });
  assert.equal(response.ok, false);
  assert.ok(['WINDOW_NOT_FOUND', 'INVALID_ELEMENT_REF'].includes(response.error.code));
});
