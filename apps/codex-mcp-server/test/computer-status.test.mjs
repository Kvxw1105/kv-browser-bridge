import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_COMPUTER_STATUS_TEST = '1';
process.env.KV_COMPUTER_DOCTOR_TEST = '1';
process.env.KV_CODEX_INSTALL_TEST = '1';
const { summarizeComputerStatus } = await import('../dist/computer-status.js');

const codex = (installed) => ({
  action: 'status',
  configPath: 'C:\\Users\\test\\.codex\\config.toml',
  installed,
  changed: false,
  serverPath: 'C:\\runtime\\computer-server.js',
  driverPath: 'C:\\runtime\\kv-windows-uia-driver.exe',
});

const report = (checks) => ({
  ok: checks.filter((check) => check.required).every((check) => check.ok),
  generatedAt: new Date(0).toISOString(),
  checks,
  mcpConfig: {},
  codexToml: '',
});

const requiredChecks = [
  { name: 'node-runtime', required: true, ok: true, message: 'ok' },
  { name: 'windows-uia-sidecar', required: true, ok: true, message: 'ok' },
];

test('reports ready only when required, optional, and Codex checks pass', () => {
  const snapshot = summarizeComputerStatus(report([
    ...requiredChecks,
    { name: 'chrome-bridge', required: false, ok: true, message: 'ok' },
  ]), codex(true));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.runtime.requiredPassed, 2);
  assert.equal(snapshot.runtime.optionalPassed, 1);
  assert.deepEqual(snapshot.nextActions, []);
});

test('reports degraded when optional Chrome integration is unavailable', () => {
  const snapshot = summarizeComputerStatus(report([
    ...requiredChecks,
    { name: 'chrome-bridge', required: false, ok: false, message: 'not connected' },
  ]), codex(true));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.state, 'degraded');
  assert.match(snapshot.nextActions[0], /Chrome extension/);
});

test('reports not-installed when runtime works but Codex is not registered', () => {
  const snapshot = summarizeComputerStatus(report(requiredChecks), codex(false));
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.state, 'not-installed');
  assert.match(snapshot.nextActions[0], /Codex MCP/);
});

test('reports unavailable and names failed required checks', () => {
  const snapshot = summarizeComputerStatus(report([
    { name: 'windows-uia-sidecar', required: true, ok: false, message: 'driver missing' },
  ]), codex(true));
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.state, 'unavailable');
  assert.match(snapshot.nextActions[0], /windows-uia-sidecar/);
  assert.match(snapshot.nextActions[0], /driver missing/);
});
