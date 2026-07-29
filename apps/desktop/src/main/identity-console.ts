import { app, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IdentityConsoleService } from '../../../chrome-bridge/src/identity/console-service.js';
import type { IdentityConsoleApiResult, IdentityConsoleItem, IdentityConsoleOperationResult, IdentityConsoleLog } from '../shared/identity-console.js';
import type { IdentityManifest } from '../../../chrome-bridge/src/identity/model.js';

let service: IdentityConsoleService | undefined;

export function resolveIdentityConsoleDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  appDataDir = join(app.getPath('userData'), 'identity-console'),
): string {
  const configured = env['KV_BROWSER_IDENTITY_HOME']?.trim();
  if (configured) return resolve(configured);
  const repositoryLocal = resolve(cwd, 'local');
  if (existsSync(repositoryLocal)) return repositoryLocal;
  return appDataDir;
}

function getService(): IdentityConsoleService {
  if (!service) service = new IdentityConsoleService(resolveIdentityConsoleDir());
  return service;
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
}
