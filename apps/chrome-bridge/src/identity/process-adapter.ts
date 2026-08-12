import { spawn, spawnSync } from 'node:child_process';
import type { LaunchPlan } from './launch-plan.js';

export interface BrowserProcessAdapter {
  spawn(plan: LaunchPlan): number;
  isAlive(pid: number): boolean;
  terminate(pid: number): void;
}

export class NodeBrowserProcessAdapter implements BrowserProcessAdapter {
  spawn(plan: LaunchPlan): number {
    const child = spawn(plan.executablePath, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, ...plan.env },
    });
    if (!child.pid) throw new Error('Browser process did not return a PID.');
    child.unref();
    return child.pid;
  }

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  terminate(pid: number): void {
    if (!this.isAlive(pid)) return;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      if (result.status !== 0 && this.isAlive(pid)) throw new Error(`taskkill failed for PID ${pid}: ${result.stderr || result.stdout}`);
      sleepSync(750);
      return;
    }
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 2_000;
    while (this.isAlive(pid) && Date.now() < deadline) sleepSync(50);
    if (this.isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}
