import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertOperationalIdentityReady, networkIdentitySummary } from '../dist/operational-guard.js';

function writeRecord(root, identityId, overrides = {}) {
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

function bridgeStatus(identityId = 'huicelang-xhs', runtimeSessionId = 'run-1') {
  return {
    identity: { identityId, runtimeSessionId },
    nativeReady: true,
    extensionConnected: true,
    extensionHandshake: { acknowledgedAt: '2026-07-29T00:00:00.000Z' },
  };
}

test('operational guard accepts only the exact selected bridge and current verified network runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-operational-ready-'));
  writeRecord(root, 'huicelang-xhs');
  const result = assertOperationalIdentityReady('huicelang-xhs', bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform);
  assert.equal(result.state, 'verified');
  assert.equal(result.runtimeSessionId, 'run-1');
});

test('operational guard rejects a bridge identity mismatch before network use', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-operational-mismatch-'));
  writeRecord(root, 'huicelang-xhs');
  assert.throws(
    () => assertOperationalIdentityReady('huicelang-xhs', bridgeStatus('xuanqi-xhs'), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform),
    /resolved to Bridge identity xuanqi-xhs/,
  );
});

test('operational guard rejects frozen and stale network sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-operational-frozen-'));
  writeRecord(root, 'huicelang-xhs', { state: 'frozen', reasons: ['NETWORK_IDENTITY_COLLISION'] });
  assert.throws(
    () => assertOperationalIdentityReady('huicelang-xhs', bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform),
    (error) => error?.code === 'NETWORK_IDENTITY_FROZEN',
  );
  writeRecord(root, 'huicelang-xhs', { runtimeSessionId: 'old-run' });
  assert.throws(
    () => assertOperationalIdentityReady('huicelang-xhs', bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform),
    (error) => error?.code === 'NETWORK_IDENTITY_STALE',
  );
});

test('network summary is safe for UI and distinguishes current runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-operational-summary-'));
  writeRecord(root, 'huicelang-xhs');
  const current = networkIdentitySummary('huicelang-xhs', bridgeStatus(), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform);
  assert.equal(current.state, 'verified');
  assert.equal(current.runtimeSessionCurrent, true);
  const stale = networkIdentitySummary('huicelang-xhs', bridgeStatus('huicelang-xhs', 'run-2'), { KV_IDENTITY_RUNTIME_DIR: root }, process.platform);
  assert.equal(stale.runtimeSessionCurrent, false);
});
