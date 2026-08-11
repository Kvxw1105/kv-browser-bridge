import { app, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IdentityConsoleService } from '../../../chrome-bridge/src/identity/console-service.js';
import { defaultRuntimeRoot } from '../../../chrome-bridge/src/identity/paths.js';
import { migrateLegacyConsoleDir, resolveIdentityConsoleDir } from '../../../../scripts/identity-console-dir.mjs';
import type { IdentityConsoleApiResult, IdentityConsoleItem, IdentityConsoleOperationResult, IdentityConsoleLog } from '../shared/identity-console.js';
import type { IdentityManifest } from '../../../chrome-bridge/src/identity/model.js';

let service: IdentityConsoleService | undefined;

/**
 * The desktop console shares one identity world with the CLI/runtime:
 * manifests live under %LOCALAPPDATA%\KvBrowserBridge\identity-console and the
 * runtime root is the CLI default (%LOCALAPPDATA%\KvBrowserBridge\identities),
 * so identities created by the CLI (or real-network qualification) show up in
 * the desktop console and vice versa. KV_BROWSER_IDENTITY_HOME overrides the
 * manifest location for development.
 */

function resolveExtensionDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['KV_BROWSER_EXTENSION_PATH']?.trim();
  if (configured) return resolve(configured);
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'extension') : '';
  if (packaged && existsSync(join(packaged, 'manifest.json'))) return packaged;
  const repository = resolve(process.cwd(), 'apps', 'extension', 'dist');
  if (existsSync(join(repository, 'manifest.json'))) return repository;
  return undefined;
}

function discoverScriptPath(): string {
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'scripts', 'discover-network-runtime.ps1') : '';
  if (packaged && existsSync(packaged)) return packaged;
  return resolve(process.cwd(), 'scripts', 'discover-network-runtime.ps1');
}

function unpackedExtensionId(extensionPath: string): string {
  const hash = createHash('sha256').update(extensionPath, 'utf16le').digest();
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}

function getService(): IdentityConsoleService {
  if (!service) {
    const localDir = resolveIdentityConsoleDir(process.env, process.cwd());
    migrateLegacyConsoleDir(localDir, app.getPath('userData'));
    service = new IdentityConsoleService(localDir, defaultRuntimeRoot(), undefined, { extensionPath: resolveExtensionDir() });
  }
  return service;
}
function discover(): unknown {
  const raw = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', discoverScriptPath(), '-Compact'], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(raw);
}
function installBridge(): unknown {
  const extensionDir = resolveExtensionDir();
  if (!extensionDir) throw new Error('Bundled or repository extension not found.');
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'bridge') : '';
  const installJs = packaged && existsSync(join(packaged, 'install.js'))
    ? join(packaged, 'install.js')
    : resolve(process.cwd(), 'apps', 'chrome-bridge', 'dist', 'install.js');
  if (!existsSync(installJs)) throw new Error(`Native host installer not found: ${installJs}`);
  const output = execFileSync(process.execPath, [installJs, 'install', unpackedExtensionId(extensionDir)], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return { extensionId: unpackedExtensionId(extensionDir), installer: installJs, output: output.slice(0, 500) };
}

function errorFrom(value: unknown): { code: string; message: string } {
  const message = value instanceof Error ? value.message : String(value);
  const separator = message.indexOf(':');
  if (separator > 0) return { code: message.slice(0, separator).trim(), message: message.slice(separator + 1).trim() };
  return { code: 'IDENTITY_CONSOLE_ERROR', message };
}

async function safe<T>(operation: () => T | Promise<T>): Promise<IdentityConsoleApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: errorFrom(error) };
  }
}

export function registerIdentityConsoleHandlers(): void {
  ipcMain.handle('identity:list', () => safe<IdentityConsoleItem[]>(() => getService().listIdentities() as IdentityConsoleItem[]));
  ipcMain.handle('identity:status', (_event, identityId: string) => safe<IdentityConsoleItem>(() => getService().getIdentityStatus(identityId) as IdentityConsoleItem));
  ipcMain.handle('identity:start', (_event, identityId: string) => safe<IdentityConsoleOperationResult>(() => getService().startIdentity(identityId) as Promise<IdentityConsoleOperationResult>));
  ipcMain.handle('identity:stop', (_event, identityId: string) => safe<IdentityConsoleOperationResult>(() => getService().stopIdentity(identityId) as IdentityConsoleOperationResult));
  ipcMain.handle('identity:create', (_event, manifest: IdentityManifest) => safe<IdentityConsoleItem>(() => getService().createIdentity(manifest) as IdentityConsoleItem));
  ipcMain.handle('identity:update', (_event, manifest: IdentityManifest) => safe<IdentityConsoleItem>(() => getService().updateIdentity(manifest) as IdentityConsoleItem));
  ipcMain.handle('identity:delete', (_event, identityId: string) => safe<void>(() => getService().deleteIdentity(identityId)));
  ipcMain.handle('identity:refreshAll', () => safe<IdentityConsoleItem[]>(() => getService().listIdentities() as IdentityConsoleItem[]));
  ipcMain.handle('identity:validateAll', () => safe(() => getService().validateAllIdentities()));
  ipcMain.handle('identity:stopAll', () => safe<IdentityConsoleOperationResult[]>(() => getService().stopAll() as IdentityConsoleOperationResult[]));
  ipcMain.handle('identity:logs', () => safe<IdentityConsoleLog[]>(() => getService().listLogs() as IdentityConsoleLog[]));
  ipcMain.handle('identity:discover', () => safe(discover));
  ipcMain.handle('identity:installBridge', () => safe(installBridge));
}
