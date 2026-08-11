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

test('supervisor reactivates the extension worker until the identity handshake lands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-supervisor-react-'));
  const localAppData = join(root, 'appdata');
  const runtimeRoot = join(root, 'runtime');
  const env = { LOCALAPPDATA: localAppData };
  const config = manifest('identity-react', root);
  const session = 'session-identity-react';
  const running = new Map();
  const fakeRuntime = {
    async startVerified() {
      const pid = 42001;
      running.set(config.identityId, { pid, runtimeSessionId: session });
      return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, runtimeSessionId: session, state: 'running', pid, updatedAt: new Date().toISOString() } };
    },
    status() {
      const value = running.get(config.identityId);
      return value ? { identityId: config.identityId, state: 'running', pid: value.pid, alive: true, lockPresent: true, receiptPresent: true } : { identityId: config.identityId, state: 'stopped', alive: false, lockPresent: false, receiptPresent: true };
    },
    stop() { running.delete(config.identityId); return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, state: 'stopped', updatedAt: new Date().toISOString() } }; },
  };
  mkdirSync(config.browser.userDataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, config.identityId, 'runtime'), { recursive: true });
  writeFileSync(join(runtimeRoot, config.identityId, 'runtime', 'session-receipt.json'), JSON.stringify({ runtimeSessionId: session }));

  // A real-looking extension dist for provisionManagedExtension validation.
  const extDist = join(root, 'extension-dist');
  mkdirSync(join(extDist, 'chunks'), { recursive: true });
  writeFileSync(join(extDist, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    background: { service_worker: 'sw.js', type: 'module' },
    content_scripts: [{ matches: ['http://*/*'], js: ['cs.js'], css: ['cs.css'], run_at: 'document_idle' }],
  }));
  writeFileSync(join(extDist, 'sw.js'), '');
  writeFileSync(join(extDist, 'cs.js'), '');
  writeFileSync(join(extDist, 'cs.css'), '');

  // The first worker connect attempt happens before the Native Host
  // allow-list matches (no bridge artifacts yet). The second loadUnpacked
  // (reactivation) simulates the worker restarting and reconnecting: it
  // writes the discovery + public session artifacts that complete the
  // identity handshake.
  let loadCalls = 0;
  let registered = 0;
  const fakeTransport = {
    async request(method, params = {}) {
      if (method === 'Extensions.getExtensions') return { extensions: [] };
      if (method === 'Extensions.loadUnpacked') {
        loadCalls += 1;
        if (loadCalls >= 2) {
          const identity = { identityId: config.identityId, workspaceId: config.workspaceId, platform: config.platform, runtimeSessionId: session };
          mkdirSync(join(localAppData, 'KvBrowserBridge', 'identities', config.identityId), { recursive: true });
          mkdirSync(join(localAppData, 'KvBrowserBridge', 'sessions'), { recursive: true });
          writeFileSync(discoveryPathForIdentity(identity, env), JSON.stringify({ identity, token: 'private-token' }));
          writeFileSync(publicSessionPathForIdentity(identity, env), JSON.stringify({ schemaVersion: 1, identity, pid: 42001, startedAt: new Date().toISOString(), protocolVersion: 1 }));
        }
        return { id: 'extension-react-id' };
      }
      if (method === 'Target.createTarget') return { targetId: 'activation-target-1' };
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.closeTarget') return {};
      throw new Error(`Unexpected method ${method}`);
    },
  };

  const supervisor = new SessionSupervisor(runtimeRoot, {
    runtime: fakeRuntime,
    env,
    processAdapter: { transportFor: () => fakeTransport },
    extensionPath: extDist,
    devtoolsTimeoutMs: 100,
    bridgeTimeoutMs: 900,
    probe: async () => ({ ok: true, host: '127.0.0.1', port: 7890 }),
    onExtensionProvisioned: async (extensionId) => { registered += 1; return { ok: true }; },
  });
  const started = await supervisor.start(config);
  assert.equal(started.ok, true, JSON.stringify(started.snapshot?.error));
  assert.equal(started.snapshot.bridge.extensionHandshake, true);
  assert.equal(started.snapshot.effectiveState, 'ready');
  // The provision load + at least one reactivation load.
  assert.ok(loadCalls >= 2, `expected >=2 loadUnpacked calls, got ${loadCalls}`);
  assert.equal(registered, 1, 'native host registered exactly once for the stable extension id');
});

test('supervisor fails with BRIDGE_NOT_READY when the worker never reconnects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-supervisor-noready-'));
  const localAppData = join(root, 'appdata');
  const runtimeRoot = join(root, 'runtime');
  const env = { LOCALAPPDATA: localAppData };
  const config = manifest('identity-noready', root);
  const session = 'session-identity-noready';
  const running = new Map();
  const fakeRuntime = {
    async startVerified() {
      const pid = 43001;
      running.set(config.identityId, { pid, runtimeSessionId: session });
      return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, runtimeSessionId: session, state: 'running', pid, updatedAt: new Date().toISOString() } };
    },
    status() {
      const value = running.get(config.identityId);
      return value ? { identityId: config.identityId, state: 'running', pid: value.pid, alive: true, lockPresent: true, receiptPresent: true } : { identityId: config.identityId, state: 'stopped', alive: false, lockPresent: false, receiptPresent: true };
    },
    stop() { running.delete(config.identityId); return { ok: true, receipt: { schemaVersion: 1, identityId: config.identityId, state: 'stopped', updatedAt: new Date().toISOString() } }; },
  };
  mkdirSync(config.browser.userDataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, config.identityId, 'runtime'), { recursive: true });
  writeFileSync(join(runtimeRoot, config.identityId, 'runtime', 'session-receipt.json'), JSON.stringify({ runtimeSessionId: session }));
  const extDist = join(root, 'extension-dist');
  mkdirSync(extDist, { recursive: true });
  writeFileSync(join(extDist, 'manifest.json'), JSON.stringify({ manifest_version: 3, background: { service_worker: 'sw.js', type: 'module' } }));
  writeFileSync(join(extDist, 'sw.js'), '');
  let loadCalls = 0;
  const fakeTransport = {
    async request(method) {
      if (method === 'Extensions.getExtensions') return { extensions: [] };
      if (method === 'Extensions.loadUnpacked') { loadCalls += 1; return { id: 'extension-noready-id' }; }
      if (method === 'Target.createTarget') return { targetId: 'activation-target-2' };
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.closeTarget') return {};
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const supervisor = new SessionSupervisor(runtimeRoot, {
    runtime: fakeRuntime,
    env,
    processAdapter: { transportFor: () => fakeTransport },
    extensionPath: extDist,
    devtoolsTimeoutMs: 100,
    bridgeTimeoutMs: 700,
    probe: async () => ({ ok: true, host: '127.0.0.1', port: 7890 }),
    onExtensionProvisioned: async () => ({ ok: true }),
  });
  const started = await supervisor.start(config);
  assert.equal(started.ok, false);
  assert.equal(started.snapshot.effectiveState, 'failed');
  assert.equal(started.snapshot.error?.code, 'BRIDGE_NOT_READY');
  assert.ok(loadCalls >= 2, `expected reactivation retries, got ${loadCalls} loadUnpacked calls`);
  assert.equal(running.has(config.identityId), false, 'failed session must be stopped');
});
