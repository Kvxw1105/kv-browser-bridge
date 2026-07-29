import { contextBridge, ipcRenderer } from 'electron';
import type { IdentityConsoleApiResult, IdentityConsoleItem, IdentityConsoleOperationResult } from '../shared/identity-console.js';

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
};

export type IdentityConsoleBridge = typeof identityConsole;

contextBridge.exposeInMainWorld('identityConsole', identityConsole);
