#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCodexBlock, removeCodexBlock, upsertCodexBlock } from './codex-config.js';

export type CodexInstallResult = {
  action: 'install' | 'uninstall' | 'status';
  configPath: string;
  installed: boolean;
  changed: boolean;
  backupPath?: string;
  serverPath: string;
  driverPath?: string;
};

export function defaultCodexConfigPath(): string {
  const explicit = process.env.CODEX_HOME;
  const home = explicit ? resolve(explicit) : join(homedir(), '.codex');
  return join(home, 'config.toml');
}

export async function installCodexConfig(configPath = defaultCodexConfigPath()): Promise<CodexInstallResult> {
  const serverPath = computerServerPath();
  const driverPath = await windowsDriverPath();
  await access(serverPath, constants.R_OK);
  const source = await readOptional(configPath);
  const edit = upsertCodexBlock(source, serverPath, process.execPath, { driverPath });
  if (!edit.changed) return { action: 'install', configPath, installed: true, changed: false, serverPath, driverPath };

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = source.length > 0 ? await backup(configPath) : undefined;
  await atomicWrite(configPath, edit.content);
  return { action: 'install', configPath, installed: true, changed: true, backupPath, serverPath, driverPath };
}

export async function uninstallCodexConfig(configPath = defaultCodexConfigPath()): Promise<CodexInstallResult> {
  const serverPath = computerServerPath();
  const source = await readOptional(configPath);
  const edit = removeCodexBlock(source);
  if (!edit.changed) return { action: 'uninstall', configPath, installed: false, changed: false, serverPath };

  const backupPath = await backup(configPath);
  await atomicWrite(configPath, edit.content);
  return { action: 'uninstall', configPath, installed: false, changed: true, backupPath, serverPath };
}

export async function codexConfigStatus(configPath = defaultCodexConfigPath()): Promise<CodexInstallResult> {
  const serverPath = computerServerPath();
  const source = await readOptional(configPath);
  return { action: 'status', configPath, installed: hasCodexBlock(source), changed: false, serverPath };
}

function computerServerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'computer-server.js');
}

async function windowsDriverPath(): Promise<string> {
  const explicit = process.env.KV_WINDOWS_UIA_DRIVER;
  if (explicit) {
    const candidate = resolve(explicit);
    await access(candidate, constants.R_OK);
    return candidate;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(moduleDir, '..', '..', '..');
  const candidates = [
    resolve(moduleDir, '..', 'windows-uia', 'kv-windows-uia-driver.exe'),
    resolve(moduleDir, '..', 'windows-uia', 'kv-windows-uia-driver.dll'),
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.exe'),
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.dll'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next deterministic location.
    }
  }
  throw new Error('Windows UIA driver is missing. Build the release driver before installing the Codex MCP configuration.');
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function backup(path: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.kv-backup-${timestamp}`;
  await copyFile(path, backupPath);
  return backupPath;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.kv-tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status';
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex >= 0 && process.argv[configIndex + 1]
    ? resolve(process.argv[configIndex + 1])
    : defaultCodexConfigPath();

  const result = action === 'install'
    ? await installCodexConfig(configPath)
    : action === 'uninstall'
      ? await uninstallCodexConfig(configPath)
      : action === 'status'
        ? await codexConfigStatus(configPath)
        : (() => { throw new Error('Usage: kv-computer-use-codex <install|uninstall|status> [--config path]'); })();

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.env.KV_CODEX_INSTALL_TEST !== '1') {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
