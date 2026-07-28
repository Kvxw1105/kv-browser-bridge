import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_COMPUTER_DOCTOR_TEST = '1';
const { buildMcpConfig, buildCodexToml, finalizeReport } = await import('../dist/computer-doctor.js');

test('builds a deterministic MCP launch configuration', () => {
  const config = buildMcpConfig('C:\\kv\\computer-server.js', 'C:\\node\\node.exe');
  assert.deepEqual(config, {
    command: 'C:\\node\\node.exe',
    args: ['C:\\kv\\computer-server.js'],
    env: { LOCAL_CHROME_REQUEST_TIMEOUT_MS: '30000' },
  });
});

test('builds a copy-safe Codex TOML snippet', () => {
  const toml = buildCodexToml('C:\\kv\\computer-server.js', 'C:\\node\\node.exe');
  assert.match(toml, /^\[mcp_servers\.kv-computer-use\]/);
  assert.match(toml, /command = "C:\\\\node\\\\node\.exe"/);
  assert.match(toml, /args = \["C:\\\\kv\\\\computer-server\.js"\]/);
  assert.match(toml, /startup_timeout_ms = 20000/);
});

test('doctor fails only when a required check fails', () => {
  const passing = finalizeReport([
    { name: 'required', required: true, ok: true, message: 'ok' },
    { name: 'optional', required: false, ok: false, message: 'offline' },
  ], 'server.js', 'node.exe');
  const failing = finalizeReport([
    { name: 'required', required: true, ok: false, message: 'missing' },
  ], 'server.js', 'node.exe');
  assert.equal(passing.ok, true);
  assert.equal(failing.ok, false);
  assert.match(passing.codexToml, /mcp_servers\.kv-computer-use/);
});
