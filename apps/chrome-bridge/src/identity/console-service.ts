import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ChromePipeProcessAdapter } from './chrome-process-adapter.js';
import { validateManifest } from './health.js';
import type { IdentityManifest, RuntimeStatus } from './model.js';
import { IdentityRuntime } from './session.js';
import { readNetworkIdentityRecord } from './network-observation.js';
import { runIdentityDoctor } from './windows-doctor.js';
import { SessionSupervisor, type ManagedSessionSnapshot } from './session-supervisor.js';

/** Chrome's deterministic unpacked-extension id derivation from its path. */
function unpackedExtensionId(extensionPath: string): string {
  const hash = createHash('sha256').update(extensionPath, 'utf16le').digest();
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}

/** Idempotently register the Native Host for the managed extension path. */
function registerNativeHostForExtension(extensionPath: string): { ok: boolean; error?: ConsoleError } {
  const installJs = resolve(extensionPath, '..', '..', 'chrome-bridge', 'dist', 'install.js');
  if (!existsSync(installJs)) return { ok: false, error: { code: 'NATIVE_HOST_INSTALLER_NOT_FOUND', message: `install.js not found: ${installJs}` } };
  const extensionId = unpackedExtensionId(extensionPath);
  const result = spawnSync(process.execPath, [installJs, 'install', extensionId], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status !== 0) {
    return { ok: false, error: { code: 'NATIVE_HOST_REGISTER_FAILED', message: (result.stderr || result.stdout || '').slice(0, 300) } };
  }
  return { ok: true };
}

export type ConsoleStatus = 'not-started' | 'starting' | 'running' | 'stopped' | 'failed' | 'frozen' | 'unverified' | 'warning';
export interface ConsoleLog { operation: string; identityId?: string; startedAt: string; completedAt: string; ok: boolean; errorCode?: string; errorMessage?: string; }
export interface ConsoleError { code: string; message: string; }
export interface ConsoleIdentity { manifest: IdentityManifest; status: ConsoleStatus; runtime: RuntimeStatus; publicIp?: string; frozen: boolean; session?: ManagedSessionSnapshot; lastError?: ConsoleError; }
export interface ConsoleOperationResult { ok: boolean; identity: ConsoleIdentity; error?: ConsoleError; }

/** Structured local service used by desktop IPC. It deliberately owns only console setup, not browser policy. */
export class IdentityConsoleService {
  private readonly manifestStorePath: string;
  private readonly generatedManifestDir: string;
  private readonly legacySetupPath: string;
  private readonly logPath: string;
  private readonly runtimeRoot: string;
  private readonly runtime: IdentityRuntime;
  private readonly supervisor?: SessionSupervisor;

  constructor(
    private readonly localDir: string,
    runtimeRoot = join(localDir, 'runtime'),
    runtime?: IdentityRuntime,
    private readonly supervisorOptions: { extensionPath?: string } = {},
  ) {
    mkdirSync(localDir, { recursive: true, mode: 0o700 });
    this.manifestStorePath = join(localDir, 'identity-console.manifests.json');
    this.generatedManifestDir = join(localDir, 'generated-identities');
    this.legacySetupPath = join(localDir, 'network-identities.setup.json');
    this.logPath = join(localDir, 'operations.json');
    this.runtimeRoot = runtimeRoot;
    // When the caller does not supply its own runtime, own a CDP-pipe adapter so
    // managed-extension provisioning (extension handshake) can actually run.
    // Without it, startIdentity always fails with CDP_PIPE_UNAVAILABLE.
    if (runtime) {
      this.runtime = runtime;
    } else {
      const adapter = new ChromePipeProcessAdapter();
      this.runtime = new IdentityRuntime(runtimeRoot, adapter);
      this.supervisor = new SessionSupervisor(runtimeRoot, { runtime: this.runtime, processAdapter: adapter, ...supervisorOptions });
    }
  }

  listIdentities(): ConsoleIdentity[] {
    return this.readManifests().map((manifest) => this.toConsoleIdentity(manifest));
  }

  getIdentityStatus(identityId: string): ConsoleIdentity {
    return this.toConsoleIdentity(this.get(identityId));
  }

  createIdentity(manifest: IdentityManifest): ConsoleIdentity {
    this.assertValid(manifest);
    const all = this.readManifests();
    this.assertUnique(manifest, all);
    this.writeManifests([...all, manifest]);
    this.log('createIdentity', manifest.identityId, true);
    return this.toConsoleIdentity(manifest);
  }

  updateIdentity(manifest: IdentityManifest): ConsoleIdentity {
    this.assertValid(manifest);
    const all = this.readManifests();
    if (!all.some((item) => item.identityId === manifest.identityId)) throw new Error(`IDENTITY_NOT_FOUND: Identity ${manifest.identityId} does not exist.`);
    this.assertUnique(manifest, all.filter((item) => item.identityId !== manifest.identityId));
    this.writeManifests(all.map((item) => item.identityId === manifest.identityId ? manifest : item));
    this.log('updateIdentity', manifest.identityId, true);
    return this.toConsoleIdentity(manifest);
  }

  deleteIdentity(identityId: string): void {
    const all = this.readManifests();
    if (!all.some((item) => item.identityId === identityId)) throw new Error(`IDENTITY_NOT_FOUND: Identity ${identityId} does not exist.`);
    this.writeManifests(all.filter((item) => item.identityId !== identityId));
    this.log('deleteIdentity', identityId, true);
  }

  async startIdentity(identityId: string): Promise<ConsoleOperationResult> {
    const manifest = this.get(identityId);
    if (this.supervisor) {
      // The managed extension is provisioned into the identity profile via CDP;
      // Chrome derives its unpacked extension id from the extension path. The
      // Native Host manifest must allow-list exactly that id or the extension
      // handshake can never complete. Register it idempotently up front.
      const register = this.supervisorOptions.extensionPath ? registerNativeHostForExtension(this.supervisorOptions.extensionPath) : undefined;
      if (register && !register.ok) {
        const error: ConsoleError = { code: register.error?.code ?? 'NATIVE_HOST_REGISTER_FAILED', message: register.error?.message ?? 'Native Host registration failed.' };
        this.log('startIdentity', identityId, false, error.code, error.message);
        return { ok: false, identity: this.toConsoleIdentity(manifest, error), error };
      }
      const result = await this.supervisor.start(manifest);
      const error = result.snapshot.error;
      this.log('startIdentity', identityId, result.ok, error?.code, error?.message);
      return { ok: result.ok, identity: this.toConsoleIdentity(manifest, error, result.snapshot), error };
    }
    const result = await this.runtime.startVerified(manifest);
    this.log('startIdentity', identityId, result.ok, result.error?.code, result.error?.message);
    return { ok: result.ok, identity: this.toConsoleIdentity(manifest, result.error), error: result.error };
  }

  stopIdentity(identityId: string): ConsoleOperationResult {
    const manifest = this.get(identityId);
    const result = this.supervisor?.stop(manifest) ?? this.runtime.stop(manifest);
    this.log('stopIdentity', identityId, result.ok, result.error?.code, result.error?.message);
    return { ok: result.ok, identity: this.toConsoleIdentity(manifest, result.error), error: result.error };
  }

  stopAll(): ConsoleOperationResult[] {
    return this.readManifests().map((manifest) => this.stopIdentity(manifest.identityId));
  }

  validateAllIdentities(): Array<{ identityId: string; ok: boolean; report: ReturnType<typeof runIdentityDoctor> }> {
    return this.readManifests().map((manifest) => {
      const report = runIdentityDoctor(manifest, this.runtime.status(manifest));
      const ok = report.checks.every((check) => check.status !== 'fail');
      this.log('validateIdentity', manifest.identityId, ok);
      return { identityId: manifest.identityId, ok, report };
    });
  }

  listLogs(): ConsoleLog[] {
    return existsSync(this.logPath) ? JSON.parse(readFileSync(this.logPath, 'utf8')) as ConsoleLog[] : [];
  }

  private get(identityId: string): IdentityManifest {
    const manifest = this.readManifests().find((item) => item.identityId === identityId);
    if (!manifest) throw new Error(`IDENTITY_NOT_FOUND: Identity ${identityId} does not exist.`);
    return manifest;
  }

  private readManifests(): IdentityManifest[] {
    if (existsSync(this.manifestStorePath)) return this.readManifestCollection(this.manifestStorePath);

    if (existsSync(this.generatedManifestDir)) {
      return readdirSync(this.generatedManifestDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.readManifestFile(join(this.generatedManifestDir, entry.name)))
        .filter((manifest): manifest is IdentityManifest => manifest !== undefined)
        .sort((left, right) => left.identityId.localeCompare(right.identityId));
    }

    // PR #5 originally stored full manifests in this path. Only accept it when
    // the entries are actually manifests; the setup generator uses a lighter schema.
    if (existsSync(this.legacySetupPath)) return this.readManifestCollection(this.legacySetupPath, true);
    return [];
  }

  private readManifestCollection(path: string, allowLightweightSetup = false): IdentityManifest[] {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { identities?: unknown[] };
    const identities = Array.isArray(parsed.identities) ? parsed.identities : [];
    const manifests = identities.filter((value): value is IdentityManifest => this.isManifest(value));
    if (!allowLightweightSetup && manifests.length !== identities.length) throw new Error(`IDENTITY_STORE_INVALID: ${path} contains an invalid identity manifest.`);
    return manifests;
  }

  private readManifestFile(path: string): IdentityManifest | undefined {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!this.isManifest(parsed)) return undefined;
    return parsed;
  }

  private isManifest(value: unknown): value is IdentityManifest {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<IdentityManifest>;
    return candidate.schemaVersion === 1
      && typeof candidate.identityId === 'string'
      && Boolean(candidate.browser?.executablePath)
      && Boolean(candidate.browser?.userDataDir)
      && Boolean(candidate.proxy?.host)
      && Number.isInteger(candidate.proxy?.port);
  }

  private writeManifests(identities: IdentityManifest[]): void {
    writeFileSync(this.manifestStorePath, `${JSON.stringify({ schemaVersion: 1, identities }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private assertValid(manifest: IdentityManifest): void {
    const report = validateManifest(manifest);
    const failure = report.findings.find((item) => item.severity === 'error');
    if (failure) throw new Error(`${failure.code}: ${failure.message}`);
  }

  private assertUnique(manifest: IdentityManifest, existing: IdentityManifest[]): void {
    if (existing.some((item) => item.identityId === manifest.identityId)) throw new Error('IDENTITY_ID_DUPLICATE');
    const profilePath = this.normalizePath(manifest.browser.userDataDir);
    if (existing.some((item) => this.normalizePath(item.browser.userDataDir) === profilePath)) throw new Error('PROFILE_PATH_DUPLICATE');
  }

  private normalizePath(path: string): string {
    return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  }

  private toConsoleIdentity(manifest: IdentityManifest, operationError?: ConsoleError, snapshot?: ManagedSessionSnapshot): ConsoleIdentity {
    const runtime = this.runtime.status(manifest);
    const network = readNetworkIdentityRecord(this.runtimeRoot, manifest.identityId);
    const frozen = network?.state === 'frozen';
    const status: ConsoleStatus = frozen
      ? 'frozen'
      : runtime.state === 'running'
        ? 'running'
        : runtime.state === 'starting'
          ? 'starting'
          : runtime.state === 'stopped'
            ? 'stopped'
            : runtime.state === 'not-started'
              ? 'not-started'
              : runtime.state === 'failed' || runtime.state === 'crashed'
                ? 'failed'
                : network
                  ? 'warning'
                  : 'unverified';
    const lastError = operationError ?? (runtime.message ? { code: runtime.state.toUpperCase(), message: runtime.message } : undefined);
    const session = snapshot ?? this.supervisor?.status(manifest);
    return { manifest, status, runtime, publicIp: network?.publicIp, frozen, session, lastError };
  }

  private log(operation: string, identityId: string | undefined, ok: boolean, errorCode?: string, errorMessage?: string): void {
    const now = new Date().toISOString();
    const logs = this.listLogs();
    logs.unshift({ operation, identityId, startedAt: now, completedAt: now, ok, errorCode, errorMessage });
    writeFileSync(this.logPath, `${JSON.stringify(logs.slice(0, 100), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
