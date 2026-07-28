import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSelectedBridge,
  bridgeIdentityId,
  publicBridgeClientStatus,
  publicBridgeStatus,
  publicIdentitySession,
  publicSelectedIdentity,
} from '../dist/identity-selection.js';

const summary = {
  schemaVersion: 1,
  identity: { identityId: 'huicelang-douyin', workspaceId: 'huicelang', platform: 'douyin' },
  pid: 42,
  startedAt: '2026-07-29T00:00:00.000Z',
  protocolVersion: 1,
  registryPath: 'C:\\private\\sessions\\huicelang-douyin.json',
  discoveryPath: 'C:\\private\\identities\\huicelang-douyin\\bridge.json',
  discoveryPresent: true,
  processAlive: true,
};

const readyStatus = {
  identity: summary.identity,
  pipeName: '\\\\.\\pipe\\private-identity',
  extensionConnected: true,
  nativeReady: true,
  extensionHandshake: {
    acknowledgedAt: '2026-07-29T00:00:01.000Z',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '0.2.10',
  },
};

test('public identity lists omit registry and private discovery paths', () => {
  const value = publicIdentitySession(summary);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('registryPath'), false);
  assert.equal(serialized.includes('discoveryPath'), false);
  assert.equal(value.selectable, true);
});

test('selected identity output omits its private discovery path', () => {
  const value = publicSelectedIdentity({
    identityId: 'huicelang-douyin',
    discoveryPath: summary.discoveryPath,
    selectedAt: '2026-07-29T00:00:02.000Z',
  });
  assert.deepEqual(value, {
    identityId: 'huicelang-douyin',
    selectedAt: '2026-07-29T00:00:02.000Z',
  });
});

test('identity-bound status omits client endpoints and Bridge pipe names', () => {
  const client = publicBridgeClientStatus({
    connected: true,
    authenticated: true,
    endpoint: '\\\\.\\pipe\\private-identity',
    reconnectAttempts: 0,
    ready: true,
    degraded: false,
  }, true);
  assert.equal('endpoint' in client, false);
  const bridge = publicBridgeStatus(readyStatus, true);
  assert.equal(JSON.stringify(bridge).includes('pipeName'), false);
  assert.equal(JSON.stringify(bridge).includes('private-identity'), false);
});

test('accepts only a ready Bridge with the exact selected identity', () => {
  assert.doesNotThrow(() => assertSelectedBridge('huicelang-douyin', readyStatus));
  assert.equal(bridgeIdentityId(readyStatus), 'huicelang-douyin');
  assert.throws(() => assertSelectedBridge('xuanqi-xhs', readyStatus), /resolved to Bridge identity/);
});

test('rejects an identity Bridge before extension handshake completion', () => {
  assert.throws(() => assertSelectedBridge('huicelang-douyin', {
    ...readyStatus,
    nativeReady: false,
    extensionHandshake: undefined,
  }), /has not completed/);
});

test('rejects an unbound legacy Bridge when an identity was selected', () => {
  assert.throws(() => assertSelectedBridge('huicelang-douyin', {
    extensionConnected: true,
    nativeReady: true,
  }), /Bridge identity unbound/);
});
