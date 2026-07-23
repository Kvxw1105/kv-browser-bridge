#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.claude_code_browser';
const STORE_EXTENSION_ID = 'mnibceaaapcppokpnnljohdlmojjgbkf';
const currentDir = dirname(fileURLToPath(import.meta.url));

function appData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

function manifestPath(): string {
  if (platform() !== 'win32') throw new Error('This installer currently supports Windows only.');
  return join(appData(), 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}

function bridgePath(): string {
  return resolve(currentDir, 'bridge.js');
}

function wrapperPath(): string {
  return join(currentDir, `${HOST_NAME}.cmd`);
}

function install(extensionId: string): void {
  if (!/^[a-z]{32}$/.test(extensionId)) throw new Error('Chrome extension ID must be 32 lowercase letters.');
  const bridge = bridgePath();
  if (!existsSync(bridge)) throw new Error(`Bridge build is missing: ${bridge}`);
  const wrapper = wrapperPath();
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${bridge}" %*\r\n`, { encoding: 'utf8' });
  const target = manifestPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({
    name: HOST_NAME,
    description: 'Local Chrome Bridge for Codex',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2), { encoding: 'utf8' });
  execFileSync('reg.exe', ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', target, '/f'], { stdio: 'inherit' });
  process.stdout.write(`Chrome Bridge registered for ${extensionId}. Reload the extension or restart Chrome.\n`);
}

function uninstall(): void {
  const target = manifestPath();
  if (existsSync(target)) rmSync(target);
  const wrapper = wrapperPath();
  if (existsSync(wrapper)) rmSync(wrapper);
  try {
    execFileSync('reg.exe', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
  } catch { /* The registry entry may already be absent. */ }
  process.stdout.write('Chrome Bridge registration removed.\n');
}

const [command = 'install', extensionId = STORE_EXTENSION_ID] = process.argv.slice(2);
if (command === 'install') install(extensionId);
else if (command === 'uninstall') uninstall();
else throw new Error('Usage: local-chrome-install [install [extension-id] | uninstall]');
