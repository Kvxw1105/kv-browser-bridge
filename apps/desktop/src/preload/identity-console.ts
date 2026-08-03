import { contextBridge, ipcRenderer } from 'electron';
import type { IdentityConsoleApiResult, IdentityConsoleItem, IdentityConsoleOperationResult } from '../shared/identity-console.js';
import type { IdentityConsoleLog } from '../shared/identity-console.js';
import type { IdentityManifest } from '../../../chrome-bridge/src/identity/model.js';

const identityConsole = {
  list(): Promise<IdentityConsoleApiResult<IdentityConsoleItem[]>> {
    return ipcRenderer.invoke('identity:list');
  },
  status(identityId: string): Promise<IdentityConsoleApiResult<IdentityConsoleItem>> {
    return ipcRenderer.invoke('identity:status', identityId);
  },
  start(identityId: string): Promise<IdentityConsoleApiResult<IdentityConsoleOperationResult>> {
    return ipcRenderer.invoke('identity:start', identityId);
  },
  stop(identityId: string): Promise<IdentityConsoleApiResult<IdentityConsoleOperationResult>> {
    return ipcRenderer.invoke('identity:stop', identityId);
  },
  create(manifest: IdentityManifest): Promise<IdentityConsoleApiResult<IdentityConsoleItem>> { return ipcRenderer.invoke('identity:create', manifest); },
  update(manifest: IdentityManifest): Promise<IdentityConsoleApiResult<IdentityConsoleItem>> { return ipcRenderer.invoke('identity:update', manifest); },
  delete(identityId: string): Promise<IdentityConsoleApiResult<void>> { return ipcRenderer.invoke('identity:delete', identityId); },
  refreshAll(): Promise<IdentityConsoleApiResult<IdentityConsoleItem[]>> { return ipcRenderer.invoke('identity:refreshAll'); },
  validateAll(): Promise<IdentityConsoleApiResult<unknown[]>> { return ipcRenderer.invoke('identity:validateAll'); },
  stopAll(): Promise<IdentityConsoleApiResult<IdentityConsoleOperationResult[]>> { return ipcRenderer.invoke('identity:stopAll'); },
  logs(): Promise<IdentityConsoleApiResult<IdentityConsoleLog[]>> { return ipcRenderer.invoke('identity:logs'); },
  discover(): Promise<IdentityConsoleApiResult<unknown>> { return ipcRenderer.invoke('identity:discover'); },
  installBridge(): Promise<IdentityConsoleApiResult<unknown>> { return ipcRenderer.invoke('identity:installBridge'); },
};

export type IdentityConsoleBridge = typeof identityConsole;

contextBridge.exposeInMainWorld('identityConsole', identityConsole);
