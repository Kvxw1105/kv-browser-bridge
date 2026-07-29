import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { IdentityConsoleService } from '../../../chrome-bridge/src/identity/console-service.js';
import type { IdentityConsoleApiResult, IdentityConsoleItem, IdentityConsoleOperationResult } from '../shared/identity-console.js';

let service: IdentityConsoleService | undefined;

function getService(): IdentityConsoleService {
  if (!service) service = new IdentityConsoleService(join(app.getPath('userData'), 'identity-console'));
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
}
