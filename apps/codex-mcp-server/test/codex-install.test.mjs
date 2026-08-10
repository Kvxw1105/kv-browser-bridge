import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.KV_CODEX_INSTALL_TEST = '1';
const { codexConfigStatus, installCodexConfig, uninstallCodexConfig } = await import('../dist/codex-install.js');

async function withDriver(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const driverPath = join(dir, 'kv-windows-uia-driver.exe');
  await writeFile(driverPath, 'test-driver', 'utf8');
  const previous = process.env.KV_WINDOWS_UIA_DRIVER;
  process.env.KV_WINDOWS_UIA_DRIVER = driverPath;
  try { await run(dir, driverPath); }
  finally {
    if (previous === undefined) delete process.env.KV_WINDOWS_UIA_DRIVER;
    else process.env.KV_WINDOWS_UIA_DRIVER = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('installs, updates idempotently, and uninstalls with backups', async () => {
  await withDriver('kv-codex-config-', async (dir, driverPath) => {
    const configPath = join(dir, 'config.toml');
    await writeFile(configPath, 'model = "gpt-5"\n', 'utf8');

    const installed = await installCodexConfig(configPath);
    assert.equal(installed.installed, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.driverPath, driverPath);
    assert.ok(installed.backupPath);
    await access(installed.backupPath);
    const installedContent = await readFile(configPath, 'utf8');
    assert.match(installedContent, /^model = "gpt-5"/);
    assert.match(installedContent, /# BEGIN KV COMPUTER USE/);
    assert.match(installedContent, /KV_WINDOWS_UIA_DRIVER/);

    const second = await installCodexConfig(configPath);
    assert.equal(second.changed, false);
    assert.equal((await codexConfigStatus(configPath)).installed, true);

    const removed = await uninstallCodexConfig(configPath);
    assert.equal(removed.changed, true);
    assert.ok(removed.backupPath);
    assert.equal(await readFile(configPath, 'utf8'), 'model = "gpt-5"\n');
    assert.equal((await codexConfigStatus(configPath)).installed, false);
  });
});

test('installs into a new config without creating a fake backup', async () => {
  await withDriver('kv-codex-new-', async (dir) => {
    const configPath = join(dir, '.codex', 'config.toml');
    const result = await installCodexConfig(configPath);
    assert.equal(result.changed, true);
    assert.equal(result.backupPath, undefined);
    assert.match(await readFile(configPath, 'utf8'), /\[mcp_servers\.kv-computer-use\]/);
  });
});

test('does not overwrite an unmanaged same-name MCP entry', async () => {
  await withDriver('kv-codex-conflict-', async (dir) => {
    const configPath = join(dir, 'config.toml');
    const original = '[mcp_servers.kv-computer-use]\ncommand = "custom"\n';
    await writeFile(configPath, original, 'utf8');
    await assert.rejects(installCodexConfig(configPath), /Refusing to replace unmanaged/);
    assert.equal(await readFile(configPath, 'utf8'), original);
  });
});

test('refuses installation when the explicit UIA driver is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-codex-missing-driver-'));
  const previous = process.env.KV_WINDOWS_UIA_DRIVER;
  process.env.KV_WINDOWS_UIA_DRIVER = join(dir, 'missing.exe');
  try {
    await assert.rejects(installCodexConfig(join(dir, 'config.toml')));
  } finally {
    if (previous === undefined) delete process.env.KV_WINDOWS_UIA_DRIVER;
    else process.env.KV_WINDOWS_UIA_DRIVER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
