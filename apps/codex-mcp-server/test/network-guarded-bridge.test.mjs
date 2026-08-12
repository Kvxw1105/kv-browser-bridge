import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBridgeNetworkBeforeRequest } from '../dist/network-guarded-bridge.js';

function writeRecord(root, overrides = {}) {
  const identityId = 'huicelang-xhs';
  const dir = join(root, identityId, 'network');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'network-identity.json'), JSON.stringify({
    schemaVersion: 1,
    identityId,
    publicIp: '203.0.113.10',
    baselinePublicIp: '203.0.113.10',
    probeUrl: 'https://probe.example/ip',
    observedAt: '2026-07-29T00:00:00.000Z',
    runtimeSessionId: 'run-1',
    state: 'verified',
    reasons: [],
    collisionWith: [],
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  }));
}

function bridgeStatus(runtimeSessionId = 'run-1') {
  return {
    identity: { identityId: 'huicelang-xhs', runtimeSessionId },
    nativeReady: true,
    extensionConnected: true,
    extensionHandshake: { acknowledgedAt: '2026-07-29T00:00:00.000Z' },
  };
}

test('connection status remains available as a diagnostic channel', async () => {
  let called = false;
  await assertBridgeNetworkBeforeRequest('browser_connection_status', async () => {
    called = true;
    return bridgeStatus();
  });
  assert.equal(called, false);
});

test('legacy unbound bridge remains compatible', async () => {
  await assert.doesNotReject(() => assertBridgeNetworkBeforeRequest(
    'browser_get_tabs',
    async () => ({ nativeReady: true, extensionConnected: true }),
  ));
});

test('verified current identity is allowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-request-guard-ready-'));
  writeRecord(root);
  await assert.doesNotReject(() => assertBridgeNetworkBeforeRequest(
    'browser_get_tabs',
    async () => bridgeStatus(),
    { KV_IDENTITY_RUNTIME_DIR: root },
    process.platform,
  ));
});

test('frozen and stale identity requests are rejected before browser operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-request-guard-frozen-'));
  writeRecord(root, { state: 'frozen', reasons: ['NETWORK_IDENTITY_COLLISION'] });
  await assert.rejects(
    () => assertBridgeNetworkBeforeRequest('browser_click', async () => bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform),
    (error) => error?.code === 'INVALID_REQUEST' && error?.details?.networkCode === 'NETWORK_IDENTITY_FROZEN',
  );
  writeRecord(root, { runtimeSessionId: 'old-run' });
  await assert.rejects(
    () => assertBridgeNetworkBeforeRequest('browser_type', async () => bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform),
    (error) => error?.code === 'INVALID_REQUEST' && error?.details?.networkCode === 'NETWORK_IDENTITY_STALE',
  );
});
