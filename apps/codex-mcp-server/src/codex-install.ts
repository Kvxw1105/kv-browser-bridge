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
};

export function defaultCodexConfigPath(): string {
  const explicit = process.env.CODEX_HOME;
  const home = explicit ? resolve(explicit) : join(homedir(), '.codex');
  return join(home, 'config.toml');
}

export async function installCodexConfig(configPath = defaultCodexConfigPath()): Promise<CodexInstallResult> {
  const serverPath = computerServerPath();
  await access(serverPath, constants.R_OK);
  const source = await readOptional(configPath);
  const edit = upsertCodexBlock(source, serverPath, process.execPath);
  if (!edit.changed) return { action: 'install', configPath, installed: true, changed: false, serverPath };

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = source.length > 0 ? await backup(configPath) : undefined;
  await atomicWrite(configPath, edit.content);
  return { action: 'install', configPath, installed: true, changed: true, backupPath, serverPath };
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
