import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IdentityConsoleService } from '../dist/identity/console-service.js';

function manifest(identityId, port = 7890) {
  return {
    schemaVersion: 1,
    identityId,
    workspaceId: 'console',
    platform: 'local',
    accountLabel: identityId,
    mode: 'native-stable',
    browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), identityId) },
    environment: { osFamily: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1280, height: 720, deviceScaleFactor: 1 } },
    proxy: { id: `proxy-${port}`, protocol: 'http', host: '127.0.0.1', port, countryCode: 'CN', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function stoppedStatus(identityId) {
  return { identityId, state: 'stopped', alive: false, lockPresent: false, receiptPresent: true };
}

test('console persists identities and rejects duplicate profile and proxy bindings', () => {
  const service = new IdentityConsoleService(mkdtempSync(join(tmpdir(), 'console-')));
  service.createIdentity(manifest('account-a'));
  assert.equal(service.listIdentities()[0].status, 'not-started');
  assert.throws(() => service.createIdentity({ ...manifest('account-b', 7891), browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), 'ACCOUNT-A') } }), /PROFILE_PATH_DUPLICATE/);
  assert.throws(() => service.createIdentity({ ...manifest('account-b', 7890), browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), 'other-profile') } }), /PROXY_ENDPOINT_DUPLICATE/);
});

test('lightweight setup entries are not mistaken for full identity manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'console-lightweight-'));
  writeFileSync(join(root, 'network-identities.setup.json'), JSON.stringify({
    chromeExecutablePath: process.execPath,
    baseProfileDir: join(root, 'profiles'),
    identities: [{ identityId: 'account-a', accountLabel: 'A', proxyPort: 7890 }],
  }));
  const service = new IdentityConsoleService(root);
  assert.deepEqual(service.listIdentities(), []);
});

test('start and stop preserve structured operation failures for the renderer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-operations-'));
  const runtime = {
    status: ({ identityId }) => stoppedStatus(identityId),
    startVerified: async () => ({ ok: false, error: { code: 'PROXY_UNREACHABLE', message: 'Proxy is offline.' } }),
    stop: () => ({ ok: false, error: { code: 'STOP_FAILED', message: 'Unable to stop target identity.' } }),
  };
  const service = new IdentityConsoleService(root, join(root, 'runtime'), runtime);
  service.createIdentity(manifest('account-a'));

  const started = await service.startIdentity('account-a');
  assert.equal(started.ok, false);
  assert.equal(started.error.code, 'PROXY_UNREACHABLE');
  assert.equal(started.identity.lastError.code, 'PROXY_UNREACHABLE');

  const stopped = service.stopIdentity('account-a');
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, 'STOP_FAILED');
  assert.equal(stopped.identity.lastError.code, 'STOP_FAILED');
});
