import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNetworkIdentityReady, NetworkGuardError, networkIdentityRecordPath } from '../dist/network-guard.js';

function writeRecord(root, overrides = {}) {
  const identityId = overrides.identityId ?? 'account-a';
  const path = networkIdentityRecordPath(identityId, { KV_IDENTITY_RUNTIME_DIR: root }, process.platform);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    identityId,
    publicIp: '1.1.1.1',
    baselinePublicIp: '1.1.1.1',
    probeUrl: 'https://api.ipify.org?format=json',
    observedAt: '2026-07-29T12:00:00.000Z',
    runtimeSessionId: 'session-1',
    state: 'verified',
    reasons: [],
    collisionWith: [],
    updatedAt: '2026-07-29T12:00:00.000Z',
    ...overrides,
  }));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof NetworkGuardError && error.code === code);
}

test('rejects an identity without a network observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-guard-'));
  expectCode(() => assertNetworkIdentityReady('account-a', { identity: { identityId: 'account-a', runtimeSessionId: 'session-1' } }, { KV_IDENTITY_RUNTIME_DIR: root }, process.platform), 'NETWORK_IDENTITY_UNVERIFIED');
});

test('rejects a frozen identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-guard-'));
  writeRecord(root, { state: 'frozen', reasons: ['NETWORK_IDENTITY_COLLISION'], collisionWith: ['account-b'] });
  expectCode(() => assertNetworkIdentityReady('account-a', { identity: { identityId: 'account-a', runtimeSessionId: 'session-1' } }, { KV_IDENTITY_RUNTIME_DIR: root }, process.platform), 'NETWORK_IDENTITY_FROZEN');
});

test('rejects a verification from an old runtime session', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-guard-'));
  writeRecord(root);
  expectCode(() => assertNetworkIdentityReady('account-a', { identity: { identityId: 'account-a', runtimeSessionId: 'session-2' } }, { KV_IDENTITY_RUNTIME_DIR: root }, process.platform), 'NETWORK_IDENTITY_STALE');
});

test('accepts a verified observation for the current runtime session', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-guard-'));
  writeRecord(root);
  const record = assertNetworkIdentityReady('account-a', { identity: { identityId: 'account-a', runtimeSessionId: 'session-1' } }, { KV_IDENTITY_RUNTIME_DIR: root }, process.platform);
  assert.equal(record.state, 'verified');
  assert.equal(record.publicIp, '1.1.1.1');
});
