import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.KV_CODEX_INSTALL_TEST = '1';
const { codexConfigStatus, installCodexConfig, uninstallCodexConfig } = await import('../dist/codex-install.js');

test('installs, updates idempotently, and uninstalls with backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-codex-config-'));
  const configPath = join(dir, 'config.toml');
  try {
    await writeFile(configPath, 'model = "gpt-5"\n', 'utf8');

    const installed = await installCodexConfig(configPath);
    assert.equal(installed.installed, true);
    assert.equal(installed.changed, true);
    assert.ok(installed.backupPath);
    await access(installed.backupPath);
    const installedContent = await readFile(configPath, 'utf8');
    assert.match(installedContent, /^model = "gpt-5"/);
    assert.match(installedContent, /# BEGIN KV COMPUTER USE/);

    const second = await installCodexConfig(configPath);
    assert.equal(second.changed, false);
    assert.equal((await codexConfigStatus(configPath)).installed, true);

    const removed = await uninstallCodexConfig(configPath);
    assert.equal(removed.changed, true);
    assert.ok(removed.backupPath);
    assert.equal(await readFile(configPath, 'utf8'), 'model = "gpt-5"\n');
    assert.equal((await codexConfigStatus(configPath)).installed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installs into a new config without creating a fake backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-codex-new-'));
  const configPath = join(dir, '.codex', 'config.toml');
  try {
    const result = await installCodexConfig(configPath);
    assert.equal(result.changed, true);
    assert.equal(result.backupPath, undefined);
    assert.match(await readFile(configPath, 'utf8'), /\[mcp_servers\.kv-computer-use\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not overwrite an unmanaged same-name MCP entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-codex-conflict-'));
  const configPath = join(dir, 'config.toml');
  const original = '[mcp_servers.kv-computer-use]\ncommand = "custom"\n';
  try {
    await writeFile(configPath, original, 'utf8');
    await assert.rejects(installCodexConfig(configPath), /Refusing to replace unmanaged/);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
