import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from './health.js';
import type { IdentityManifest, RuntimeStatus } from './model.js';
import { IdentityRuntime } from './session.js';
import { readNetworkIdentityRecord } from './network-observation.js';
import { runIdentityDoctor } from './windows-doctor.js';

export type ConsoleStatus = 'not-started' | 'starting' | 'running' | 'stopped' | 'failed' | 'frozen' | 'unverified' | 'warning';
export interface ConsoleLog { operation: string; identityId?: string; startedAt: string; completedAt: string; ok: boolean; errorCode?: string; errorMessage?: string; }
export interface ConsoleIdentity { manifest: IdentityManifest; status: ConsoleStatus; runtime: RuntimeStatus; publicIp?: string; frozen: boolean; lastError?: { code: string; message: string }; }

/** Structured local service used by desktop IPC. It deliberately owns only console setup, not browser policy. */
export class IdentityConsoleService {
  private readonly setupPath: string;
  private readonly logPath: string;
  private readonly runtime: IdentityRuntime;

  constructor(private readonly localDir: string, runtimeRoot = join(localDir, 'runtime'), runtime?: IdentityRuntime) {
    mkdirSync(localDir, { recursive: true, mode: 0o700 });
    this.setupPath = join(localDir, 'network-identities.setup.json');
    this.logPath = join(localDir, 'operations.json');
    this.runtime = runtime ?? new IdentityRuntime(runtimeRoot);
  }

  listIdentities(): ConsoleIdentity[] { return this.readManifests().map((manifest) => this.toConsoleIdentity(manifest)); }
  getIdentityStatus(identityId: string): ConsoleIdentity { return this.toConsoleIdentity(this.get(identityId)); }

  createIdentity(manifest: IdentityManifest): ConsoleIdentity { this.assertValid(manifest); const all = this.readManifests(); this.assertUnique(manifest, all); this.writeManifests([...all, manifest]); this.log('createIdentity', manifest.identityId, true); return this.toConsoleIdentity(manifest); }
  updateIdentity(manifest: IdentityManifest): ConsoleIdentity { this.assertValid(manifest); const all = this.readManifests(); if (!all.some((item) => item.identityId === manifest.identityId)) throw new Error(`Identity ${manifest.identityId} does not exist.`); this.assertUnique(manifest, all.filter((item) => item.identityId !== manifest.identityId)); this.writeManifests(all.map((item) => item.identityId === manifest.identityId ? manifest : item)); this.log('updateIdentity', manifest.identityId, true); return this.toConsoleIdentity(manifest); }
  deleteIdentity(identityId: string): void { const all = this.readManifests(); if (!all.some((item) => item.identityId === identityId)) throw new Error(`Identity ${identityId} does not exist.`); this.writeManifests(all.filter((item) => item.identityId !== identityId)); this.log('deleteIdentity', identityId, true); }

  async startIdentity(identityId: string): Promise<ConsoleIdentity> { const manifest = this.get(identityId); const result = await this.runtime.startVerified(manifest); this.log('startIdentity', identityId, result.ok, result.error?.code, result.error?.message); return this.toConsoleIdentity(manifest); }
  stopIdentity(identityId: string): ConsoleIdentity { const manifest = this.get(identityId); const result = this.runtime.stop(manifest); this.log('stopIdentity', identityId, result.ok, result.error?.code, result.error?.message); return this.toConsoleIdentity(manifest); }
  stopAll(): ConsoleIdentity[] { return this.readManifests().map((manifest) => this.stopIdentity(manifest.identityId)); }
  validateAllIdentities(): Array<{ identityId: string; ok: boolean; report: ReturnType<typeof runIdentityDoctor> }> { return this.readManifests().map((manifest) => { const report = runIdentityDoctor(manifest, this.runtime.status(manifest)); const ok = report.checks.every((check) => check.status !== 'fail'); this.log('validateIdentity', manifest.identityId, ok); return { identityId: manifest.identityId, ok, report }; }); }
  listLogs(): ConsoleLog[] { return existsSync(this.logPath) ? JSON.parse(readFileSync(this.logPath, 'utf8')) : []; }

  private get(identityId: string): IdentityManifest { const manifest = this.readManifests().find((item) => item.identityId === identityId); if (!manifest) throw new Error(`Identity ${identityId} does not exist.`); return manifest; }
  private readManifests(): IdentityManifest[] { return existsSync(this.setupPath) ? JSON.parse(readFileSync(this.setupPath, 'utf8')).identities ?? [] : []; }
  private writeManifests(identities: IdentityManifest[]): void { writeFileSync(this.setupPath, `${JSON.stringify({ schemaVersion: 1, identities }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
  private assertValid(manifest: IdentityManifest): void { const report = validateManifest(manifest); const failure = report.findings.find((item) => item.severity === 'error'); if (failure) throw new Error(`${failure.code}: ${failure.message}`); }
  private assertUnique(manifest: IdentityManifest, existing: IdentityManifest[]): void { if (existing.some((item) => item.identityId === manifest.identityId)) throw new Error('IDENTITY_ID_DUPLICATE'); if (existing.some((item) => item.browser.userDataDir === manifest.browser.userDataDir)) throw new Error('PROFILE_PATH_DUPLICATE'); if (existing.some((item) => item.proxy.host === manifest.proxy.host && item.proxy.port === manifest.proxy.port)) throw new Error('PROXY_ENDPOINT_DUPLICATE'); }
  private toConsoleIdentity(manifest: IdentityManifest): ConsoleIdentity { const runtime = this.runtime.status(manifest); const network = readNetworkIdentityRecord(join(this.localDir, 'runtime'), manifest.identityId); const frozen = network?.state === 'frozen'; const status: ConsoleStatus = frozen ? 'frozen' : runtime.state === 'running' ? 'running' : runtime.state === 'starting' ? 'starting' : runtime.state === 'stopped' ? 'stopped' : runtime.state === 'not-started' ? 'not-started' : runtime.state === 'failed' || runtime.state === 'crashed' ? 'failed' : network ? 'warning' : 'unverified'; return { manifest, status, runtime, publicIp: network?.publicIp, frozen, lastError: runtime.message ? { code: runtime.state.toUpperCase(), message: runtime.message } : undefined }; }
  private log(operation: string, identityId: string | undefined, ok: boolean, errorCode?: string, errorMessage?: string): void { const now = new Date().toISOString(); const logs = this.listLogs(); logs.unshift({ operation, identityId, startedAt: now, completedAt: now, ok, errorCode, errorMessage }); writeFileSync(this.logPath, `${JSON.stringify(logs.slice(0, 100), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
}
