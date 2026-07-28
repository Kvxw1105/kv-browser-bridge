import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLaunchPlan } from '../dist/identity/launch-plan.js';
import { IdentityLockManager } from '../dist/identity/lock.js';
import { IdentityRuntime } from '../dist/identity/session.js';

function manifest(root) {
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
  };
}

class FakeProcesses {
  nextPid = 4000;
  alive = new Set();
  plans = [];
  spawn(plan) { this.plans.push(plan); const pid = this.nextPid++; this.alive.add(pid); return pid; }
  isAlive(pid) { return this.alive.has(pid); }
  terminate(pid) { this.alive.delete(pid); }
}

test('launch plan binds one runtime session ID into the browser environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-session-plan-'));
  const plan = buildLaunchPlan(manifest(root), process.env, 'runtime-session-001');
  assert.equal(plan.env.KV_BROWSER_RUNTIME_SESSION_ID, 'runtime-session-001');
});

test('verified start refuses to launch when the assigned proxy is unreachable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-proxy-block-'));
  const fake = new FakeProcesses();
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-29T00:00:00Z'), new IdentityLockManager(root, fake), () => 'runtime-session-001');
  const result = await runtime.startVerified(manifest(root), process.env, async () => ({ ok: false, host: '127.0.0.1', port: 1080, error: { code: 'PROXY_UNREACHABLE', message: 'connection refused' } }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROXY_UNREACHABLE');
  assert.equal(fake.plans.length, 0);
});

test('verified start records and propagates the exact runtime session ID after proxy preflight passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-proxy-pass-'));
  const fake = new FakeProcesses();
  const runtime = new IdentityRuntime(root, fake, () => new Date('2026-07-29T00:00:00Z'), new IdentityLockManager(root, fake, () => new Date('2026-07-29T00:00:00Z'), () => 'lock-1'), () => 'runtime-session-001');
  const result = await runtime.startVerified(manifest(root), process.env, async () => ({ ok: true, host: '127.0.0.1', port: 1080, latencyMs: 3 }));
  assert.equal(result.ok, true);
  assert.equal(result.receipt.runtimeSessionId, 'runtime-session-001');
  assert.equal(fake.plans[0].env.KV_BROWSER_RUNTIME_SESSION_ID, 'runtime-session-001');
});
