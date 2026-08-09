#!/usr/bin/env node

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KV_NATIVE_HOST_NAME,
  createKvWrapper,
  createRepairHelper,
  createNativeHostManifest,
  isKvOwnedRepairHelper,
  isValidNativeHostManifest,
  parseInstallerArgs,
  validateBridgePath,
} from './install-helpers.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${KV_NATIVE_HOST_NAME}`;

export type RegistryResult = { status: number | null; stdout: string; stderr: string; error?: string };
export type RegistryRunner = (args: string[]) => RegistryResult;
export type InstallerFs = Pick<typeof import('node:fs'), 'accessSync' | 'existsSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'writeFileSync'>;

const realFs: InstallerFs = { accessSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync };

export function defaultRegistryRunner(args: string[]): RegistryResult {
  const result: SpawnSyncReturns<Buffer> = spawnSync('reg.exe', args, { encoding: 'buffer' });
  return {
    status: result.status,
    stdout: result.stdout?.toString('utf8') ?? '',
    stderr: result.stderr?.toString('utf8') ?? '',
    error: result.error?.message,
  };
}

export function appData(env = process.env): string {
  return env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

export function pathsForInstall(options: { appDataDir?: string; distDir?: string } = {}) {
  const distDir = options.distDir ?? currentDir;
  const appDataDir = options.appDataDir ?? appData();
  return {
    bridge: resolve(distDir, 'bridge.js'),
    installer: resolve(distDir, 'install.js'),
    wrapper: join(distDir, `${KV_NATIVE_HOST_NAME}.cmd`),
    manifest: join(appDataDir, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', `${KV_NATIVE_HOST_NAME}.json`),
    discovery: join(appDataDir, 'KvBrowserBridge', 'bridge.json'),
    logDir: join(appDataDir, 'KvBrowserBridge', 'logs'),
    repairHelper: join(appDataDir, 'KvBrowserBridge', 'bin', 'kv-browser-bridge-repair.cmd'),
    testBackup: join(appDataDir, 'KvBrowserBridge', 'shadow-test-backup.json'),
  };
}

export function atomicWriteFile(fs: InstallerFs, target: string, content: string): void {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readJson(fs: InstallerFs, path: string): unknown | undefined {
  if (!fs.existsSync(path)) return undefined;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return undefined; }
}

function artifactContents(fs: InstallerFs, path: string): string | undefined {
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
}

function restoreArtifact(fs: InstallerFs, path: string, previous: string | undefined, expectedCurrent: string): void {
  // Do not clobber a file another process changed after our write.
  if (artifactContents(fs, path) !== expectedCurrent) return;
  if (previous === undefined) fs.rmSync(path, { force: true });
  else atomicWriteFile(fs, path, previous);
}

function registryValue(result: RegistryResult): string | undefined {
  if (result.status !== 0) return undefined;
  const line = result.stdout.split(/\r?\n/).find((item) => /REG_SZ/i.test(item));
  return line?.replace(/^.*REG_SZ\s+/i, '').trim() || undefined;
}

type RegistrySnapshot = { keyExists: boolean; value?: string };

function readRegistrySnapshot(runner: RegistryRunner, action: string): RegistrySnapshot {
  const key = runner(['query', registryKey]);
  if (key.status === 1) return { keyExists: false };
  if (key.status !== 0) requireRegistry(runner, action, ['query', registryKey]);
  const value = runner(['query', registryKey, '/ve']);
  if (value.status === 1) return { keyExists: true };
  if (value.status !== 0) requireRegistry(runner, `${action} value`, ['query', registryKey, '/ve']);
  return { keyExists: true, value: registryValue(value) };
}

function requireRegistry(runner: RegistryRunner, action: string, args: string[]): RegistryResult {
  const result = runner(args);
  if (result.status !== 0) {
    const details = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ');
    throw new Error(`Registry ${action} failed for ${registryKey}: ${details || `exit code ${result.status ?? 'unknown'}`}`);
  }
  return result;
}

function restoreRegistryIfUnchanged(runner: RegistryRunner, previous: RegistrySnapshot, expectedValue: string): void {
  const current = readRegistrySnapshot(runner, 'rollback query');
  if (!current.keyExists || current.value !== expectedValue) return;
  if (!previous.keyExists) requireRegistry(runner, 'rollback delete', ['delete', registryKey, '/f']);
  else if (previous.value === undefined) requireRegistry(runner, 'rollback delete value', ['delete', registryKey, '/ve', '/f']);
  else requireRegistry(runner, 'rollback restore value', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', previous.value, '/f']);
}

/** Node has no supported DACL descriptor API. This intentionally does not pretend chmod enforces Windows ACLs. */
export function tryApplyWindowsAcl(): { attempted: boolean; enforced: boolean; reason: string } {
  return { attempted: false, enforced: false, reason: 'Node cannot safely apply a Windows DACL descriptor.' };
}

export function install(extensionId: string, deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): void {
  if (platform() !== 'win32' && deps.appDataDir === undefined) throw new Error('This installer currently supports Windows only.');
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  validateBridgePath(paths.bridge);
  if (!isAbsolute(paths.bridge) || !fs.existsSync(paths.bridge)) throw new Error(`Bridge build is missing: ${paths.bridge}`);
  const nodePath = deps.nodePath ?? process.execPath;
  const wrapper = createKvWrapper(paths.bridge, nodePath);
  const repairHelper = repairHelperContent(paths, nodePath);
  const manifest = createNativeHostManifest(extensionId, paths.wrapper);
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const previousWrapper = artifactContents(fs, paths.wrapper);
  const previousManifest = artifactContents(fs, paths.manifest);
  const previousRepairHelper = artifactContents(fs, paths.repairHelper);
  assertRepairHelperOwnership(fs, paths.repairHelper);
  const previousRegistry = readRegistrySnapshot(runner, 'snapshot');
  const hasPriorState = previousWrapper !== undefined || previousManifest !== undefined || previousRegistry.keyExists;
  if (hasPriorState && (previousWrapper !== wrapper || previousManifest !== manifestContents || previousRegistry.value !== paths.manifest)) {
    throw new Error('Refusing to replace an inconsistent or non-Kv installation state.');
  }
  fs.mkdirSync(dirname(paths.manifest), { recursive: true });
  let registryAdded = false;
  try {
    atomicWriteFile(fs, paths.wrapper, wrapper);
    if (artifactContents(fs, paths.wrapper) !== wrapper) throw new Error('Wrapper changed while installation was in progress.');
    atomicWriteFile(fs, paths.manifest, manifestContents);
    requireRegistry(runner, 'add', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f']);
    registryAdded = true;
    const registeredPath = registryValue(requireRegistry(runner, 'verification query', ['query', registryKey, '/ve']));
    if (artifactContents(fs, paths.manifest) !== manifestContents || artifactContents(fs, paths.wrapper) !== wrapper || registeredPath !== paths.manifest) {
      throw new Error('Installation consistency verification failed: exact manifest, wrapper, and HKCU registration must agree.');
    }
    fs.mkdirSync(dirname(paths.repairHelper), { recursive: true });
    atomicWriteFile(fs, paths.repairHelper, repairHelper);
    if (artifactContents(fs, paths.repairHelper) !== repairHelper) throw new Error('Repair helper changed while installation was in progress.');
  } catch (error) {
    restoreArtifact(fs, paths.manifest, previousManifest, manifestContents);
    restoreArtifact(fs, paths.wrapper, previousWrapper, wrapper);
    restoreArtifact(fs, paths.repairHelper, previousRepairHelper, repairHelper);
    if (registryAdded) restoreRegistryIfUnchanged(runner, previousRegistry, paths.manifest);
    throw error;
  }
  tryApplyWindowsAcl();
}

function repairHelperContent(paths: ReturnType<typeof pathsForInstall>, nodePath: string): string {
  return createRepairHelper(paths.installer, nodePath);
}

function assertRepairHelperOwnership(fs: InstallerFs, path: string): void {
  const current = artifactContents(fs, path);
  if (current !== undefined && !isKvOwnedRepairHelper(current)) {
    throw new Error(`Refusing to replace a non-Kv repair helper: ${path}`);
  }
}

export function repairInstall(extensionId: string, deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): string {
  if (platform() !== 'win32' && deps.appDataDir === undefined) throw new Error('This installer currently supports Windows only.');
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  validateBridgePath(paths.bridge);
  if (!fs.existsSync(paths.bridge)) throw new Error(`Bridge build is missing: ${paths.bridge}`);
  const currentManifest = artifactContents(fs, paths.manifest);
  const currentParsed = readJson(fs, paths.manifest);
  if (currentManifest !== undefined && !isValidNativeHostManifest(currentParsed)) {
    throw new Error('Refusing to repair a non-Kv Native Messaging registration.');
  }
  const previousWrapper = artifactContents(fs, paths.wrapper);
  const previousRepairHelper = artifactContents(fs, paths.repairHelper);
  assertRepairHelperOwnership(fs, paths.repairHelper);
  const previousRegistry = readRegistrySnapshot(runner, 'repair snapshot');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(deps.appDataDir ?? appData(), 'KvBrowserBridge', 'repair-backups', stamp);
  fs.mkdirSync(backupPath, { recursive: true });
  if (currentManifest !== undefined) atomicWriteFile(fs, join(backupPath, 'native-host.json'), currentManifest);
  if (previousWrapper !== undefined) atomicWriteFile(fs, join(backupPath, 'native-host.cmd'), previousWrapper);
  if (previousRepairHelper !== undefined) atomicWriteFile(fs, join(backupPath, 'repair-helper.cmd'), previousRepairHelper);
  atomicWriteFile(fs, join(backupPath, 'registry.json'), JSON.stringify(previousRegistry, null, 2) + '\n');

  const nodePath = deps.nodePath ?? process.execPath;
  const wrapper = createKvWrapper(paths.bridge, nodePath);
  const repairHelper = repairHelperContent(paths, nodePath);
  const manifestContents = `${JSON.stringify(createNativeHostManifest(extensionId, paths.wrapper), null, 2)}\n`;
  try {
    fs.mkdirSync(dirname(paths.manifest), { recursive: true });
    atomicWriteFile(fs, paths.wrapper, wrapper);
    atomicWriteFile(fs, paths.manifest, manifestContents);
    requireRegistry(runner, 'repair add', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f']);
    const registeredPath = registryValue(requireRegistry(runner, 'repair verification query', ['query', registryKey, '/ve']));
    if (artifactContents(fs, paths.manifest) !== manifestContents || artifactContents(fs, paths.wrapper) !== wrapper || registeredPath !== paths.manifest) {
      throw new Error('Repair consistency verification failed.');
    }
    fs.mkdirSync(dirname(paths.repairHelper), { recursive: true });
    atomicWriteFile(fs, paths.repairHelper, repairHelper);
    if (artifactContents(fs, paths.repairHelper) !== repairHelper) throw new Error('Repair helper changed while repair was in progress.');
  } catch (error) {
    restoreArtifact(fs, paths.manifest, currentManifest, manifestContents);
    restoreArtifact(fs, paths.wrapper, previousWrapper, wrapper);
    restoreArtifact(fs, paths.repairHelper, previousRepairHelper, repairHelper);
    restoreRegistryIfUnchanged(runner, previousRegistry, paths.manifest);
    throw error;
  }
  tryApplyWindowsAcl();
  return backupPath;
}

export function uninstall(deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): void {
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  const manifestContents = artifactContents(fs, paths.manifest);
  const wrapperContents = artifactContents(fs, paths.wrapper);
  const repairHelperContents = artifactContents(fs, paths.repairHelper);
  const manifest = readJson(fs, paths.manifest) as { allowed_origins?: unknown } | undefined;
  const origin = Array.isArray(manifest?.allowed_origins) ? manifest.allowed_origins[0] : undefined;
  const extensionId = typeof origin === 'string' ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1] : undefined;
  const expectedManifest = extensionId ? `${JSON.stringify(createNativeHostManifest(extensionId, paths.wrapper), null, 2)}\n` : undefined;
  const nodePath = deps.nodePath ?? process.execPath;
  const expectedWrapper = createKvWrapper(paths.bridge, nodePath);
  const expectedRepairHelper = repairHelperContent(paths, nodePath);
  const registry = readRegistrySnapshot(runner, 'query before uninstall');
  const exactTriad = manifestContents === expectedManifest && wrapperContents === expectedWrapper && registry.value === paths.manifest;
  if (!exactTriad) return;
  requireRegistry(runner, 'delete', ['delete', registryKey, '/f']);
  fs.rmSync(paths.manifest, { force: true });
  fs.rmSync(paths.wrapper, { force: true });
  if (repairHelperContents === expectedRepairHelper) fs.rmSync(paths.repairHelper, { force: true });
}

type TestBackup = { manifest?: string; wrapperPath?: string; wrapper?: string; registry: RegistrySnapshot };

function testBackup(fs: InstallerFs, path: string): TestBackup | undefined {
  const value = readJson(fs, path);
  if (!value || typeof value !== 'object') return undefined;
  const backup = value as Partial<TestBackup>;
  if (!backup.registry || typeof backup.registry.keyExists !== 'boolean') return undefined;
  return { manifest: typeof backup.manifest === 'string' ? backup.manifest : undefined, wrapperPath: typeof backup.wrapperPath === 'string' ? backup.wrapperPath : undefined, wrapper: typeof backup.wrapper === 'string' ? backup.wrapper : undefined, registry: backup.registry };
}

export function testInstall(extensionId: string, deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): void {
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  if (fs.existsSync(paths.testBackup)) throw new Error(`A Shadow test backup already exists: ${paths.testBackup}. Run test-restore first.`);
  validateBridgePath(paths.bridge);
  if (!fs.existsSync(paths.bridge)) throw new Error(`Bridge build is missing: ${paths.bridge}`);
  const currentManifest = artifactContents(fs, paths.manifest);
  const currentParsed = readJson(fs, paths.manifest) as { path?: unknown } | undefined;
  const currentWrapperPath = typeof currentParsed?.path === 'string' ? currentParsed.path : undefined;
  const currentWrapper = currentWrapperPath && fs.existsSync(currentWrapperPath) ? artifactContents(fs, currentWrapperPath) : undefined;
  if (currentManifest !== undefined && (!isValidNativeHostManifest(currentParsed) || !currentWrapper || !currentWrapper.includes('REM Kv Browser Bridge wrapper - managed by Kv'))) {
    throw new Error('Refusing to replace a non-Kv Native Messaging registration.');
  }
  const registry = readRegistrySnapshot(runner, 'snapshot');
  const backup: TestBackup = { manifest: currentManifest, wrapperPath: currentWrapperPath, wrapper: currentWrapper, registry };
  const wrapper = createKvWrapper(paths.bridge, deps.nodePath ?? process.execPath, 'shadow');
  const manifestContents = `${JSON.stringify(createNativeHostManifest(extensionId, paths.wrapper), null, 2)}\n`;
  fs.mkdirSync(dirname(paths.manifest), { recursive: true });
  fs.mkdirSync(dirname(paths.testBackup), { recursive: true });
  atomicWriteFile(fs, paths.testBackup, JSON.stringify(backup, null, 2) + '\n');
  try {
    atomicWriteFile(fs, paths.wrapper, wrapper);
    atomicWriteFile(fs, paths.manifest, manifestContents);
    requireRegistry(runner, 'add Shadow test', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f']);
  } catch (error) {
    fs.rmSync(paths.testBackup, { force: true });
    throw error;
  }
}

export function testRestore(deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): void {
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  const backup = testBackup(fs, paths.testBackup);
  if (!backup) throw new Error('No valid Shadow test backup was found.');
  const expectedWrapper = createKvWrapper(paths.bridge, deps.nodePath ?? process.execPath, 'shadow');
  const currentManifest = artifactContents(fs, paths.manifest);
  const currentWrapper = artifactContents(fs, paths.wrapper);
  const registry = readRegistrySnapshot(runner, 'restore snapshot');
  if (currentWrapper !== expectedWrapper || registry.value !== paths.manifest || !currentManifest) throw new Error('Refusing to restore because the Shadow test registration changed.');
  if (backup.wrapperPath && backup.wrapper) atomicWriteFile(fs, backup.wrapperPath, backup.wrapper);
  if (backup.manifest === undefined) fs.rmSync(paths.manifest, { force: true });
  else atomicWriteFile(fs, paths.manifest, backup.manifest);
  if (!backup.registry.keyExists) requireRegistry(runner, 'restore delete', ['delete', registryKey, '/f']);
  else if (backup.registry.value) requireRegistry(runner, 'restore registry', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', backup.registry.value, '/f']);
  fs.rmSync(paths.testBackup, { force: true });
}

export type DoctorCheck = { name: string; required: boolean; ok: boolean; message: string; details?: Record<string, unknown> };
export type DoctorReport = { ok: boolean; checks: DoctorCheck[] };

function check(name: string, required: boolean, ok: boolean, message: string, details?: Record<string, unknown>): DoctorCheck {
  return { name, required, ok, message, details };
}

export function doctor(deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string; nodePath?: string } = {}): DoctorReport {
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  const checks: DoctorCheck[] = [];
  const nodePath = deps.nodePath ?? process.execPath;
  checks.push(check('node-runtime', true, Boolean(nodePath) && fs.existsSync(nodePath), `Node ${process.version}`, { path: nodePath }));
  checks.push(check('bridge-path', true, fs.existsSync(paths.bridge) && isAbsolute(paths.bridge), fs.existsSync(paths.bridge) ? 'Bridge build found.' : 'Bridge build is missing.', { path: paths.bridge }));
  const expectedRepairHelper = repairHelperContent(paths, nodePath);
  const actualRepairHelper = artifactContents(fs, paths.repairHelper);
  checks.push(check('repair-helper', true, actualRepairHelper === expectedRepairHelper, actualRepairHelper === expectedRepairHelper ? 'Standalone repair helper checked.' : 'Standalone repair helper is missing or stale.', { path: paths.repairHelper, installer: paths.installer }));
  const manifest = readJson(fs, paths.manifest);
  checks.push(check('manifest', true, isValidNativeHostManifest(manifest) && (manifest as { path: string }).path === paths.wrapper, manifest ? 'Native host manifest checked.' : 'Native host manifest is missing.', { path: paths.manifest }));
  const registry = runner(['query', registryKey, '/ve']);
  const target = registryValue(registry);
  checks.push(check('registry-hkcu', true, registry.status === 0 && target === paths.manifest, registry.status === 0 ? 'HKCU native host registration checked.' : 'HKCU native host registration is missing.', { key: registryKey, target }));
  const discovery = readJson(fs, paths.discovery) as Record<string, unknown> | undefined;
  const validDiscovery = Boolean(discovery && typeof discovery.pipeName === 'string' && discovery.pipeName.length > 0 && typeof discovery.token === 'string' && discovery.token.length > 0);
  checks.push(check('discovery-config', true, validDiscovery, validDiscovery ? 'Discovery config is valid.' : 'Discovery config is missing or invalid.', { path: paths.discovery }));
  let logWritable = false;
  try { fs.accessSync(paths.logDir, fsConstants.W_OK); logWritable = true; } catch { /* read-only diagnostic */ }
  checks.push(check('log-directory', true, logWritable, logWritable ? 'Log directory is writable.' : 'Log directory is not writable or does not exist.', { path: paths.logDir }));
  checks.push(check('bridge-pipe', false, false, validDiscovery ? 'Pipe status is best-effort only; no connection was opened.' : 'No valid discovery config for pipe status.', { pipeName: discovery?.pipeName }));
  return { ok: checks.filter((item) => item.required).every((item) => item.ok), checks };
}

function main(): void {
  const command = parseInstallerArgs(process.argv.slice(2));
  if (command.command === 'install') {
    install(command.extensionId);
    process.stdout.write(`Kv Browser Bridge registered for ${command.extensionId}. Reload the extension or restart Chrome.\n`);
  } else if (command.command === 'repair') {
    const backupPath = repairInstall(command.extensionId);
    process.stdout.write(`Kv Browser Bridge repaired for ${command.extensionId}. Backup: ${backupPath}. Reload the extension or restart Chrome.\n`);
  } else if (command.command === 'uninstall') {
    uninstall();
    process.stdout.write('Kv Browser Bridge registration removed when it was Kv-owned.\n');
  } else if (command.command === 'test-install') {
    testInstall(command.extensionId);
    process.stdout.write(`Shadow test host registered for ${command.extensionId}. Reload the test extension.\n`);
  } else if (command.command === 'test-restore') {
    testRestore();
    process.stdout.write('Stable Kv Native Messaging registration restored.\n');
  } else {
    const report = doctor();
    if (command.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else for (const item of report.checks) process.stdout.write(`${item.ok ? 'OK' : item.required ? 'FAIL' : 'INFO'} ${item.name}: ${item.message}\n`);
    if (!report.ok) process.exitCode = 1;
  }
}

if (process.env.KV_BRIDGE_TEST !== '1') main();
