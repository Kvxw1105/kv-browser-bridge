#!/usr/bin/env node

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KV_NATIVE_HOST_NAME,
  createKvWrapper,
  createNativeHostManifest,
  isKvOwnedManifest,
  isKvOwnedWrapper,
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
    wrapper: join(distDir, `${KV_NATIVE_HOST_NAME}.cmd`),
    manifest: join(appDataDir, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', `${KV_NATIVE_HOST_NAME}.json`),
    discovery: join(appDataDir, 'KvBrowserBridge', 'bridge.json'),
    logDir: join(appDataDir, 'KvBrowserBridge', 'logs'),
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

function requireManagedPriorArtifact(path: string, contents: string | undefined, owned: boolean): void {
  if (contents !== undefined && !owned) throw new Error(`Refusing to overwrite a non-Kv artifact: ${path}`);
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

function requireRegistry(runner: RegistryRunner, action: string, args: string[]): RegistryResult {
  const result = runner(args);
  if (result.status !== 0) {
    const details = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ');
    throw new Error(`Registry ${action} failed for ${registryKey}: ${details || `exit code ${result.status ?? 'unknown'}`}`);
  }
  return result;
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
  const wrapper = createKvWrapper(paths.bridge, deps.nodePath ?? process.execPath);
  const manifest = createNativeHostManifest(extensionId, paths.wrapper);
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const previousWrapper = artifactContents(fs, paths.wrapper);
  const previousManifest = artifactContents(fs, paths.manifest);
  requireManagedPriorArtifact(paths.wrapper, previousWrapper, previousWrapper === undefined || isKvOwnedWrapper(previousWrapper));
  requireManagedPriorArtifact(paths.manifest, previousManifest, previousManifest === undefined || isKvOwnedManifest(readJson(fs, paths.manifest)));
  fs.mkdirSync(dirname(paths.manifest), { recursive: true });
  try {
    atomicWriteFile(fs, paths.wrapper, wrapper);
    if (artifactContents(fs, paths.wrapper) !== wrapper) throw new Error('Wrapper changed while installation was in progress.');
    atomicWriteFile(fs, paths.manifest, manifestContents);
    requireRegistry(runner, 'add', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f']);
    const registeredPath = registryValue(requireRegistry(runner, 'verification query', ['query', registryKey, '/ve']));
    if (artifactContents(fs, paths.manifest) !== manifestContents || artifactContents(fs, paths.wrapper) !== wrapper || registeredPath !== paths.manifest) {
      throw new Error('Installation consistency verification failed: exact manifest, wrapper, and HKCU registration must agree.');
    }
  } catch (error) {
    restoreArtifact(fs, paths.manifest, previousManifest, manifestContents);
    restoreArtifact(fs, paths.wrapper, previousWrapper, wrapper);
    throw error;
  }
  tryApplyWindowsAcl();
}

export function uninstall(deps: { fs?: InstallerFs; runner?: RegistryRunner; appDataDir?: string; distDir?: string } = {}): void {
  const fs = deps.fs ?? realFs;
  const runner = deps.runner ?? defaultRegistryRunner;
  const paths = pathsForInstall(deps);
  const manifest = readJson(fs, paths.manifest);
  const wrapper = fs.existsSync(paths.wrapper) ? fs.readFileSync(paths.wrapper, 'utf8') : '';
  const query = runner(['query', registryKey, '/ve']);
  if (query.status !== 0 && query.status !== 1) requireRegistry(runner, 'query before uninstall', ['query', registryKey, '/ve']);
  const registeredPath = registryValue(query);
  const ownedManifest = isKvOwnedManifest(manifest, paths.wrapper);
  const ownedWrapper = isKvOwnedWrapper(wrapper);
  if (registeredPath === paths.manifest && ownedManifest) {
    requireRegistry(runner, 'delete', ['delete', registryKey, '/f']);
  }
  if (ownedManifest) fs.rmSync(paths.manifest, { force: true });
  if (ownedWrapper) fs.rmSync(paths.wrapper, { force: true });
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
  } else if (command.command === 'uninstall') {
    uninstall();
    process.stdout.write('Kv Browser Bridge registration removed when it was Kv-owned.\n');
  } else {
    const report = doctor();
    if (command.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else for (const item of report.checks) process.stdout.write(`${item.ok ? 'OK' : item.required ? 'FAIL' : 'INFO'} ${item.name}: ${item.message}\n`);
    if (!report.ok) process.exitCode = 1;
  }
}

if (process.env.KV_BRIDGE_TEST !== '1') main();
