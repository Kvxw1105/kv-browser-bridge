import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateManifest } from '../dist/identity/health.js';
import { buildLaunchPlan } from '../dist/identity/launch-plan.js';
import { IdentityLockManager } from '../dist/identity/lock.js';
import { runtimePaths } from '../dist/identity/paths.js';
import { IdentityRuntime } from '../dist/identity/session.js';

function manifest(root, overrides = {}) {
  return {
    schemaVersion: 1,
    identityId: 'huicelang-douyin',
    workspaceId: 'huicelang',
    platform: 'douyin',
    accountLabel: 'main',
    mode: 'native-stable',
    browser: { executablePath: process.execPath, userDataDir: join(root, 'profile') },
    environment: { osFamily: process.platform === 'win32' ? 'windows' : 'linux', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1920, height: 1080, deviceScaleFactor: 1 } },
    proxy: { id: 'proxy-1', protocol: 'socks5', host: '127.0.0.1', port: 1080, authMode: 'ip-allowlist', countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
    ...overrides,
  };
}

class FakeProcesses {
  nextPid = 2000;
  alive = new Set();
  failSpawn = false;
  spawn() {
    if (this.failSpawn) throw new Error('spawn failed');
    const pid = this.nextPid++;
    this.alive.add(pid);
    return pid;
  }
  isAlive(pid) { return this.alive.has(pid); }
  terminate(pid) { this.alive.delete(pid); }
}

test('accepts a stable, internally consistent identity', () => {
  const report = validateManifest(manifest(mkdtempSync(join(tmpdir(), 'kv-health-'))));
  assert.equal(report.healthy, true);
});

test('blocks locale and concurrency conflicts', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-health-bad-'));
  const base = manifest(root);
  const report = validateManifest({ ...base, environment: { ...base.environment, locale: 'en-US' }, policies: { ...base.policies, allowConcurrentSessions: true } });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code).sort(), ['CONCURRENT_SESSION', 'LOCALE_MISMATCH']);
});

test('never places proxy credentials in browser command-line arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-plan-'));
  const base = manifest(root);
  const config = { ...base, proxy: { ...base.proxy, authMode: 'native-adapter', username: 'alice', passwordEnv: 'KV_PROXY_SECRET' } };
  const plan = buildLaunchPlan(config, { KV_PROXY_SECRET: 'top-secret' });
  assert.equal(plan.args.join(' ').includes('alice'), false);
  assert.equal(plan.args.join(' ').includes('top-secret'), false);
  assert.equal(plan.blockedReasons.some((reason) => reason.startsWith('PROXY_AUTH_ADAPTER_REQUIRED')), true);
  assert.equal(plan.args.includes('--remote-debugging-address=127.0.0.1'), true);
  assert.equal(plan.args.includes('--remote-debugging-port=0'), true);
});

test('starts, reports, blocks concurrent launch, and stops one identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-id-run-'));
  const fake = new FakeProcesses();
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-28T12:00:00Z'), new IdentityLockManager(root, fake, () => new Date('2026-07-28T12:00:00Z'), () => 'lock-1'));
  const config = manifest(root);
  const started = runtime.start(config);
  assert.equal(started.ok, true);
  assert.equal(runtime.status(config).state, 'running');
  const duplicate = runtime.start(config);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'IDENTITY_ALREADY_RUNNING');
  assert.equal(runtime.status(config).state, 'running');
  const stopped = runtime.stop(config);
  assert.equal(stopped.ok, true);
  assert.equal(runtime.status(config).state, 'stopped');
});

test('archives a stale lock before starting a new session', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-id-stale-'));
  const fake = new FakeProcesses();
  const lockManager = new IdentityLockManager(root, fake, () => new Date('2026-07-28T12:00:00Z'), () => 'lock-new');
  const paths = runtimePaths(root, 'huicelang-douyin');
  const first = lockManager.acquire('huicelang-douyin', join(root, 'profile'), 9999);
  assert.equal(first.pid, 9999);
  const second = lockManager.acquire('huicelang-douyin', join(root, 'profile'), 8888);
  assert.equal(second.lockId, 'lock-new');
  assert.equal(existsSync(paths.staleDir), true);
});

test('records failed startup and releases its lock when process spawn fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-id-fail-'));
  const fake = new FakeProcesses();
  fake.failSpawn = true;
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-28T12:00:00Z'), new IdentityLockManager(root, fake, () => new Date('2026-07-28T12:00:00Z'), () => 'lock-fail'));
  const config = manifest(root);
  const result = runtime.start(config);
  assert.equal(result.ok, false);
  assert.equal(result.receipt.state, 'failed');
  assert.equal(existsSync(runtimePaths(root, config.identityId).lockPath), false);
});

test('refuses to terminate a live PID when lock ownership does not match receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-id-owner-'));
  const fake = new FakeProcesses();
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-28T12:00:00Z'), new IdentityLockManager(root, fake, () => new Date('2026-07-28T12:00:00Z'), () => 'lock-owner'));
  const config = manifest(root);
  const started = runtime.start(config);
  const lockPath = runtimePaths(root, config.identityId).lockPath;
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.lockId = 'other-owner';
  writeFileSync(lockPath, JSON.stringify(lock));
  const stopped = runtime.stop(config);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, 'STOP_OWNERSHIP_MISMATCH');
  assert.equal(fake.alive.has(started.receipt.pid), true);
});

test('managed launch can opt into an explicit extension path without changing the default', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-extension-plan-'));
  const base = manifest(root);
  const defaultPlan = buildLaunchPlan(base, {});
  assert.equal(defaultPlan.args.some((arg) => arg.startsWith('--load-extension=')), false);
  const extensionPath = join(root, 'extension');
  mkdirSync(extensionPath, { recursive: true });
  const managedPlan = buildLaunchPlan(base, { KV_BROWSER_EXTENSION_PATH: extensionPath });
  assert.equal(managedPlan.args.includes(`--load-extension=${extensionPath}`), true);
});

test('runs two managed identities independently and preserves B while restarting A', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-id-dual-'));
  const fake = new FakeProcesses();
  let sessionNumber = 0;
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-28T12:00:00Z'), undefined, () => `runtime-session-${++sessionNumber}`);
  const a = manifest(root, { identityId: 'identity-a', browser: { executablePath: process.execPath, userDataDir: join(root, 'profile-a') } });
  const b = manifest(root, { identityId: 'identity-b', browser: { executablePath: process.execPath, userDataDir: join(root, 'profile-b') } });
  const startedA = runtime.start(a);
  const startedB = runtime.start(b);
  assert.equal(startedA.ok, true);
  assert.equal(startedB.ok, true);
  assert.notEqual(startedA.receipt.runtimeSessionId, startedB.receipt.runtimeSessionId);
  assert.notEqual(startedA.receipt.pid, startedB.receipt.pid);
  assert.equal(runtime.status(b).alive, true);
  assert.equal(runtime.stop(a).ok, true);
  assert.equal(runtime.status(a).alive, false);
  assert.equal(runtime.status(b).alive, true);
  const restartedA = runtime.start(a);
  assert.equal(restartedA.ok, true);
  assert.notEqual(restartedA.receipt.runtimeSessionId, startedA.receipt.runtimeSessionId);
  assert.equal(runtime.status(b).alive, true);
  assert.equal(runtime.stop(a).ok, true);
  assert.equal(runtime.stop(b).ok, true);
});
