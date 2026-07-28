import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listNetworkIdentityRecords, readNetworkIdentityRecord, recordNetworkObservation, resetNetworkIdentityRecord } from '../dist/identity/network-observation.js';

const at = '2026-07-29T12:00:00.000Z';
const now = () => new Date(at);
const observation = (ip) => ({ publicIp: ip, probeUrl: 'https://api.ipify.org?format=json', observedAt: at, runtimeSessionId: 'session-1' });

test('creates a verified baseline on first observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-net-'));
  const record = recordNetworkObservation(root, 'account-a', observation('1.1.1.1'), { now });
  assert.equal(record.state, 'verified');
  assert.equal(record.baselinePublicIp, '1.1.1.1');
});

test('freezes an identity when its public IP drifts from baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-net-'));
  recordNetworkObservation(root, 'account-a', observation('1.1.1.1'), { now });
  const record = recordNetworkObservation(root, 'account-a', observation('2.2.2.2'), { now });
  assert.equal(record.state, 'frozen');
  assert.deepEqual(record.reasons, ['NETWORK_EGRESS_DRIFT']);
});

test('freezes both identities when their recent public IP collides', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-net-'));
  recordNetworkObservation(root, 'account-a', observation('1.1.1.1'), { now });
  const second = recordNetworkObservation(root, 'account-b', observation('1.1.1.1'), { now });
  assert.equal(second.state, 'frozen');
  assert.deepEqual(second.collisionWith, ['account-a']);
  const first = readNetworkIdentityRecord(root, 'account-a');
  assert.equal(first.state, 'frozen');
  assert.deepEqual(first.collisionWith, ['account-b']);
});

test('ignores stale observations outside the collision window', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-net-'));
  recordNetworkObservation(root, 'account-a', { ...observation('1.1.1.1'), observedAt: '2026-07-20T00:00:00Z' }, { now });
  const second = recordNetworkObservation(root, 'account-b', observation('1.1.1.1'), { now, collisionWindowMs: 60_000 });
  assert.equal(second.state, 'verified');
});

test('archives the baseline on explicit reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-net-'));
  recordNetworkObservation(root, 'account-a', observation('1.1.1.1'), { now });
  const result = resetNetworkIdentityRecord(root, 'account-a', now);
  assert.equal(result.reset, true);
  assert.equal(existsSync(result.archivedPath), true);
  assert.equal(readNetworkIdentityRecord(root, 'account-a'), undefined);
  assert.equal(listNetworkIdentityRecords(root).length, 0);
});
