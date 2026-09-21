import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const installer = join(root, 'scripts', 'install-agent-skill.mjs');

function runInstaller(args) {
  return spawnSync(process.execPath, [installer, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('installer copies the complete canonical Skill to an explicit destination', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kv-browser-bridge-skill-'));
  const destination = join(temp, 'kv-browser-bridge');
  try {
    const result = runInstaller(['--destination', destination]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8').includes('# Kv Browser Bridge'), true);
    assert.equal(JSON.parse(readFileSync(join(destination, 'capabilities.json'), 'utf8')).transport, 'stdio-mcp');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('installer refuses to replace a different existing Skill without --force', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kv-browser-bridge-skill-'));
  const destination = join(temp, 'kv-browser-bridge');
  try {
    const first = runInstaller(['--destination', destination]);
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(destination, 'SKILL.md'), 'user-owned instructions\n');

    const result = runInstaller(['--destination', destination]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different Skill/i);
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'user-owned instructions\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('installer replaces canonical files only after explicit --force', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kv-browser-bridge-skill-'));
  const destination = join(temp, 'kv-browser-bridge');
  try {
    const first = runInstaller(['--destination', destination]);
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(destination, 'SKILL.md'), 'user-owned instructions\n');

    const result = runInstaller(['--destination', destination, '--force']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(destination, 'SKILL.md'), 'utf8'), /# Kv Browser Bridge/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
