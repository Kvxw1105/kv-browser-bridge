import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoveryPathForIdentity, publicSessionPathForIdentity } from '../dist/identity/bridge-context.js';
import { SessionSupervisor } from '../dist/identity/session-supervisor.js';

function manifest(id, root) {
  return {
    schemaVersion: 1, identityId: id, workspaceId: 'alpha', platform: 'windows', accountLabel: id, mode: 'native-stable',
    browser: { executablePath: process.execPath, userDataDir: join(root, 'profiles', id) },
    environment: { osFamily: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1280, height: 720, deviceScaleFactor: 1 } },
    proxy: { id: `${id}-proxy`, protocol: 'http', host: '127.0.0.1', port: 7890, countryCode: 'CN', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('supervisor composes process, DevTools and identity handshake readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-supervisor-'));
  const localAppData = join(root, 'appdata');
  const runtimeRoot = join(root, 'runtime');
  const env = { LOCALAPPDATA: localAppData };
  const profiles = [manifest('identity-a', root), manifest('identity-b', root)];
  const running = new Map();
  const fakeRuntime = {
    async startVerified(config) {
      const runtimeSessionId = `session-${config.identityId}`;
      const pid = config.identityId === 'identity-a' ? 41001 : 41002;
      running.set(config.identityId, { pid, runtimeSessionId });
      return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, runtimeSessionId, state: 'running', pid, updatedAt: new Date().toISOString() } };
    },
    status(config) {
      const value = running.get(config.identityId);
      return value ? { identityId: config.identityId, state: 'running', pid: value.pid, alive: true, lockPresent: true, receiptPresent: true } : { identityId: config.identityId, state: 'stopped', alive: false, lockPresent: false, receiptPresent: true };
    },
    stop(config) { running.delete(config.identityId); return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, state: 'stopped', updatedAt: new Date().toISOString() } }; },
  };
  for (const config of profiles) {
    const runtime = running;
    const session = `session-${config.identityId}`;
    mkdirSync(config.browser.userDataDir, { recursive: true });
    writeFileSync(join(config.browser.userDataDir, 'DevToolsActivePort'), `9222\n/devtools/browser/${config.identityId}`);
    mkdirSync(join(runtimeRoot, config.identityId, 'runtime'), { recursive: true });
    writeFileSync(join(runtimeRoot, config.identityId, 'runtime', 'session-receipt.json'), JSON.stringify({ runtimeSessionId: session }));
    const identity = { identityId: config.identityId, workspaceId: config.workspaceId, platform: config.platform, runtimeSessionId: session };
    mkdirSync(join(localAppData, 'KvBrowserBridge', 'identities', config.identityId), { recursive: true });
    mkdirSync(join(localAppData, 'KvBrowserBridge', 'sessions'), { recursive: true });
    writeFileSync(discoveryPathForIdentity(identity, env), JSON.stringify({ identity, token: 'private-token' }));
    writeFileSync(publicSessionPathForIdentity(identity, env), JSON.stringify({ schemaVersion: 1, identity, pid: config.identityId === 'identity-a' ? 41001 : 41002, startedAt: new Date().toISOString(), protocolVersion: 1 }));
    assert.equal(runtime.has(config.identityId), false);
  }
  const supervisor = new SessionSupervisor(runtimeRoot, { runtime: fakeRuntime, env, devtoolsTimeoutMs: 100, bridgeTimeoutMs: 100, probe: async () => ({ ok: true, host: '127.0.0.1', port: 7890 }) });
  const started = await Promise.all(profiles.map((config) => supervisor.start(config)));
  assert.deepEqual(started.map((result) => result.ok), [true, true]);
  assert.deepEqual(started.map((result) => result.snapshot.effectiveState), ['ready', 'ready']);
  assert.notEqual(started[0].snapshot.runtimeSessionId, started[1].snapshot.runtimeSessionId);
  assert.equal(started[0].snapshot.bridge.extensionHandshake, true);
});
