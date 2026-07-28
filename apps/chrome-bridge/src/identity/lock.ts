import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeLockRecord } from './model.js';
import { runtimePaths } from './paths.js';
import { writeJsonAtomic } from './atomic-json.js';

export interface ProcessLiveness {
  isAlive(pid: number): boolean;
}

export class SystemProcessLiveness implements ProcessLiveness {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

export class IdentityLockError extends Error {
  constructor(readonly code: 'IDENTITY_ALREADY_RUNNING' | 'LOCK_CORRUPT' | 'LOCK_OWNERSHIP', message: string) {
    super(message);
    this.name = 'IdentityLockError';
  }
}

export class IdentityLockManager {
  constructor(
    private readonly rootDir: string,
    private readonly liveness: ProcessLiveness = new SystemProcessLiveness(),
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  read(identityId: string): RuntimeLockRecord | undefined {
    const { lockPath } = runtimePaths(this.rootDir, identityId);
    if (!existsSync(lockPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf8')) as RuntimeLockRecord;
      if (value.schemaVersion !== 1 || value.identityId !== identityId || !value.lockId || !Number.isInteger(value.pid)) throw new Error('invalid lock shape');
      return value;
    } catch {
      throw new IdentityLockError('LOCK_CORRUPT', `Identity lock is unreadable or invalid: ${lockPath}`);
    }
  }

  acquire(identityId: string, userDataDir: string, ownerPid = process.pid): RuntimeLockRecord {
    const paths = runtimePaths(this.rootDir, identityId);
    mkdirSync(paths.identityDir, { recursive: true, mode: 0o700 });
    try {
      const fd = openSync(paths.lockPath, 'wx', 0o600);
      const at = this.now().toISOString();
      const record: RuntimeLockRecord = {
        schemaVersion: 1,
        identityId,
        lockId: this.idFactory(),
        pid: ownerPid,
        phase: 'starting',
        acquiredAt: at,
        updatedAt: at,
        userDataDir,
      };
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      closeSync(fd);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = this.read(identityId);
      if (existing && this.liveness.isAlive(existing.pid)) throw new IdentityLockError('IDENTITY_ALREADY_RUNNING', `Identity ${identityId} is already locked by PID ${existing.pid}.`);
      if (existing) this.archiveStale(existing);
      return this.acquire(identityId, userDataDir, ownerPid);
    }
  }

  promote(identityId: string, lockId: string, browserPid: number): RuntimeLockRecord {
    const existing = this.read(identityId);
    if (!existing || existing.lockId !== lockId) throw new IdentityLockError('LOCK_OWNERSHIP', `Lock ownership changed for ${identityId}.`);
    const updated: RuntimeLockRecord = { ...existing, pid: browserPid, phase: 'running', updatedAt: this.now().toISOString() };
    writeJsonAtomic(runtimePaths(this.rootDir, identityId).lockPath, updated);
    return updated;
  }

  release(identityId: string, lockId: string): void {
    const paths = runtimePaths(this.rootDir, identityId);
    if (!existsSync(paths.lockPath)) return;
    const existing = this.read(identityId);
    if (!existing || existing.lockId !== lockId) throw new IdentityLockError('LOCK_OWNERSHIP', `Refusing to release a lock owned by another session for ${identityId}.`);
    unlinkSync(paths.lockPath);
  }

  private archiveStale(record: RuntimeLockRecord): void {
    const paths = runtimePaths(this.rootDir, record.identityId);
    mkdirSync(paths.staleDir, { recursive: true, mode: 0o700 });
    const safeTime = this.now().toISOString().replace(/[:.]/g, '-');
    renameSync(paths.lockPath, join(paths.staleDir, `${safeTime}-${basename(record.lockId)}.json`));
  }
}
