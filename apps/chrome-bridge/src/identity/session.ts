import { mkdirSync } from 'node:fs';
import type { IdentityManifest, RuntimeReceipt, RuntimeStatus } from './model.js';
import { buildLaunchPlan } from './launch-plan.js';
import { IdentityLockError, IdentityLockManager, SystemProcessLiveness } from './lock.js';
import { NodeBrowserProcessAdapter, type BrowserProcessAdapter } from './process-adapter.js';
import { RuntimeReceiptStore } from './receipt.js';

export interface StartResult {
  ok: boolean;
  receipt?: RuntimeReceipt;
  blockedReasons?: string[];
  error?: { code: string; message: string };
}

export interface StopResult {
  ok: boolean;
  receipt?: RuntimeReceipt;
  error?: { code: string; message: string };
}

export class IdentityRuntime {
  private readonly receipts: RuntimeReceiptStore;
  private readonly locks: IdentityLockManager;

  constructor(
    private readonly rootDir: string,
    private readonly processes: BrowserProcessAdapter = new NodeBrowserProcessAdapter(),
    private readonly now: () => Date = () => new Date(),
    lockManager?: IdentityLockManager,
  ) {
    this.receipts = new RuntimeReceiptStore(rootDir);
    this.locks = lockManager ?? new IdentityLockManager(rootDir, new SystemProcessLiveness(), now);
  }

  start(manifest: IdentityManifest, env: NodeJS.ProcessEnv = process.env): StartResult {
    const plan = buildLaunchPlan(manifest, env);
    if (plan.blockedReasons.length > 0) return { ok: false, blockedReasons: plan.blockedReasons };

    let lockId: string | undefined;
    let browserPid: number | undefined;
    try {
      mkdirSync(manifest.browser.userDataDir, { recursive: true, mode: 0o700 });
      const lock = this.locks.acquire(manifest.identityId, manifest.browser.userDataDir);
      lockId = lock.lockId;
      const pid = this.processes.spawn(plan);
      browserPid = pid;
      if (!this.processes.isAlive(pid)) throw new Error(`Browser process ${pid} exited before the session could be recorded.`);
      this.locks.promote(manifest.identityId, lock.lockId, pid);
      const receipt: RuntimeReceipt = {
        schemaVersion: 1,
        identityId: manifest.identityId,
        state: 'running',
        pid,
        lockId: lock.lockId,
        executablePath: plan.executablePath,
        args: plan.args,
        startedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      };
      this.receipts.save(receipt);
      return { ok: true, receipt };
    } catch (error) {
      const code = error instanceof IdentityLockError ? error.code : 'START_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      if (!lockId) return { ok: false, error: { code, message } };
      if (browserPid && this.processes.isAlive(browserPid)) {
        try { this.processes.terminate(browserPid); } catch { /* Preserve the original failure. */ }
      }
      try { this.locks.release(manifest.identityId, lockId); } catch { /* Preserve the original failure. */ }
      const receipt: RuntimeReceipt = {
        schemaVersion: 1,
        identityId: manifest.identityId,
        state: 'failed',
        updatedAt: this.now().toISOString(),
        failure: { code, message },
      };
      this.receipts.save(receipt);
      return { ok: false, receipt, error: { code, message } };
    }
  }

  stop(manifest: IdentityManifest): StopResult {
    const receipt = this.receipts.load(manifest.identityId);
    if (!receipt?.pid || !receipt.lockId) return { ok: true, receipt: receipt ?? this.stoppedReceipt(manifest.identityId, 'No recorded running session.') };
    try {
      const alive = this.processes.isAlive(receipt.pid);
      const lock = this.locks.read(manifest.identityId);
      if (alive && (!lock || lock.lockId !== receipt.lockId || lock.pid !== receipt.pid)) {
        return { ok: false, receipt, error: { code: 'STOP_OWNERSHIP_MISMATCH', message: 'Refusing to stop a live process without a matching identity lock and receipt.' } };
      }
      if (alive) this.processes.terminate(receipt.pid);
      if (lock && lock.lockId === receipt.lockId) this.locks.release(manifest.identityId, receipt.lockId);
      const stopped: RuntimeReceipt = { ...receipt, state: 'stopped', stoppedAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
      this.receipts.save(stopped);
      return { ok: true, receipt: stopped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, receipt, error: { code: 'STOP_FAILED', message } };
    }
  }

  status(manifest: IdentityManifest): RuntimeStatus {
    let lock;
    try {
      lock = this.locks.read(manifest.identityId);
    } catch (error) {
      return { identityId: manifest.identityId, state: 'corrupt-lock', alive: false, lockPresent: true, receiptPresent: Boolean(this.receipts.load(manifest.identityId)), message: error instanceof Error ? error.message : String(error) };
    }
    const receipt = this.receipts.load(manifest.identityId);
    if (!lock && !receipt) return { identityId: manifest.identityId, state: 'not-started', alive: false, lockPresent: false, receiptPresent: false };
    if (lock) {
      const alive = this.processes.isAlive(lock.pid);
      if (!alive) return { identityId: manifest.identityId, state: 'stale-lock', pid: lock.pid, alive: false, lockPresent: true, receiptPresent: Boolean(receipt), message: 'The recorded process is no longer alive; the next start will archive this lock.' };
      if (!receipt || receipt.pid !== lock.pid || receipt.lockId !== lock.lockId) return { identityId: manifest.identityId, state: 'orphaned-running', pid: lock.pid, alive: true, lockPresent: true, receiptPresent: Boolean(receipt), message: 'A live lock exists without a matching runtime receipt.' };
      return { identityId: manifest.identityId, state: 'running', pid: lock.pid, alive: true, lockPresent: true, receiptPresent: true };
    }
    if (receipt?.state === 'running' && receipt.pid) {
      const alive = this.processes.isAlive(receipt.pid);
      return { identityId: manifest.identityId, state: alive ? 'orphaned-running' : 'crashed', pid: receipt.pid, alive, lockPresent: false, receiptPresent: true, message: 'Runtime receipt exists without a matching lock.' };
    }
    return { identityId: manifest.identityId, state: receipt?.state ?? 'not-started', pid: receipt?.pid, alive: false, lockPresent: false, receiptPresent: Boolean(receipt) };
  }

  private stoppedReceipt(identityId: string, message: string): RuntimeReceipt {
    return { schemaVersion: 1, identityId, state: 'stopped', updatedAt: this.now().toISOString(), failure: { code: 'ALREADY_STOPPED', message } };
  }
}
