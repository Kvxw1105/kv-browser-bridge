import { contextBridge, ipcRenderer } from 'electron';
import type { ComputerStatusReport } from '../main/computer-status.js';

export type ComputerStatusApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const computerStatus = {
  doctor(): Promise<ComputerStatusApiResult<unknown>> {
    return ipcRenderer.invoke('computer:doctor');
  },
  status(): Promise<ComputerStatusApiResult<unknown>> {
    return ipcRenderer.invoke('computer:status');
  },
  bridge(): Promise<ComputerStatusApiResult<ComputerStatusReport>> {
    return ipcRenderer.invoke('bridge:status');
  },
};

export type ComputerStatusBridge = typeof computerStatus;

contextBridge.exposeInMainWorld('computerStatus', computerStatus);
