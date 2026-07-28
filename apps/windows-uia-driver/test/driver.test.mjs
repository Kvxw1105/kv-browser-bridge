import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

const driver = join(process.cwd(), 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.dll');

async function request(method, params = {}) {
  const child = spawn('dotnet', [driver], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ id: 'test-1', method, params })}\n`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  const line = stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, 'sidecar should emit one JSONL response');
  return JSON.parse(line);
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
