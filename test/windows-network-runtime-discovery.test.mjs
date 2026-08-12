import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const windowsOnly = process.platform === 'win32' ? test : test.skip;

windowsOnly('Windows runtime discovery emits stable machine-readable JSON without mutating the system', () => {
  const script = resolve('scripts/discover-network-runtime.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Compact',
  ], { encoding: 'utf8', timeout: 30_000 });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.platform, 'windows');
  assert.equal(typeof report.observedAt, 'string');
  assert.ok(Array.isArray(report.chromeCandidates));
  assert.ok(Array.isArray(report.proxyCandidates));
  assert.ok(Array.isArray(report.warnings));
  for (const candidate of report.proxyCandidates) {
    assert.ok(candidate.port >= 1 && candidate.port <= 65535);
    assert.ok(candidate.host === '127.0.0.1' || candidate.host === '::1');
  }
});
