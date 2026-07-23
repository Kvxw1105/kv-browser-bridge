#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KV_NATIVE_HOST_NAME, createNativeHostManifest, parseInstallerArgs } from './install-helpers.js';

const HOST_NAME = KV_NATIVE_HOST_NAME;
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
  const bridge = bridgePath();
  if (!existsSync(bridge)) throw new Error(`Bridge build is missing: ${bridge}`);
  const wrapper = wrapperPath();
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${bridge}" %*\r\n`, { encoding: 'utf8' });
  const target = manifestPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(createNativeHostManifest(extensionId, wrapper), null, 2), { encoding: 'utf8' });
  execFileSync('reg.exe', ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', target, '/f'], { stdio: 'inherit' });
  process.stdout.write(`Kv Browser Bridge registered for ${extensionId}. Reload the extension or restart Chrome.\n`);
}

function uninstall(): void {
  const target = manifestPath();
  if (existsSync(target)) rmSync(target);
  const wrapper = wrapperPath();
  if (existsSync(wrapper)) rmSync(wrapper);
  try {
    execFileSync('reg.exe', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
  } catch { /* The registry entry may already be absent. */ }
  process.stdout.write('Kv Browser Bridge registration removed.\n');
}

const command = parseInstallerArgs(process.argv.slice(2));
if (command.command === 'install') install(command.extensionId);
else uninstall();
