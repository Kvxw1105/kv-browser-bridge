import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { LaunchPlan } from './launch-plan.js';
import { ChromeCdpTransport } from './chrome-cdp-transport.js';
import type { BrowserProcessAdapter } from './process-adapter.js';

export class ChromePipeProcessAdapter implements BrowserProcessAdapter {
  private readonly processes = new Map<number, { child: ChildProcess; transport: ChromeCdpTransport }>();

  spawn(plan: LaunchPlan): number {
    const child = spawn(plan.executablePath, plan.args, { detached: false, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: false, env: { ...process.env, ...plan.env } });
    if (!child.pid) throw new Error('Browser process did not return a PID.');
    const stderr = child.stdio[2] as Readable | null;
    const stderrDir = process.env.KV_BROWSER_CHROME_STDERR_DIR;
    if (stderr && stderrDir) {
      mkdirSync(stderrDir, { recursive: true });
      const stderrPath = join(stderrDir, `${child.pid}.log`);
      stderr.on('data', (chunk: Buffer | string) => {
        try { appendFileSync(stderrPath, chunk); } catch { /* diagnostics must not affect browser ownership */ }
      });
    }
    const writePipe = child.stdio[3] as Writable | null;
    const readPipe = child.stdio[4] as Readable | null;
    if (!writePipe || !readPipe) throw new Error('Chrome did not expose remote-debugging pipe handles.');
    const transport = new ChromeCdpTransport(writePipe, readPipe);
    this.processes.set(child.pid, { child, transport });
    child.once('exit', () => { void transport.close(); this.processes.delete(child.pid!); });
    return child.pid;
  }

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  transportFor(pid: number): ChromeCdpTransport | undefined { return this.processes.get(pid)?.transport; }

  terminate(pid: number): void {
    const item = this.processes.get(pid);
    void item?.transport.close();
    if (!this.isAlive(pid)) return;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      if (result.status !== 0 && this.isAlive(pid)) throw new Error(`taskkill failed for PID ${pid}: ${result.stderr || result.stdout}`);
      sleepSync(750);
      return;
    }
    process.kill(pid, 'SIGTERM');
  }
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}
