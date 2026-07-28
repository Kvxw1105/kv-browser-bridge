import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeIdentityFromEnv,
  discoveryPathForIdentity,
  publicSessionRecord,
  validateExtensionIdentityHello,
} from '../dist/identity/bridge-context.js';

const identity = {
  identityId: 'huicelang-douyin',
  workspaceId: 'huicelang',
  platform: 'douyin',
  runtimeSessionId: 'session-001',
};

test('reads a stable identity from the dedicated browser process environment', () => {
  assert.deepEqual(bridgeIdentityFromEnv({
    KV_BROWSER_IDENTITY_ID: identity.identityId,
    KV_BROWSER_WORKSPACE_ID: identity.workspaceId,
    KV_BROWSER_PLATFORM: identity.platform,
    KV_BROWSER_RUNTIME_SESSION_ID: identity.runtimeSessionId,
  }), identity);
});

test('writes identity bridges to independent discovery paths', () => {
  const env = { LOCALAPPDATA: 'C:\\KvTest' };
  assert.equal(discoveryPathForIdentity(identity, env), 'C:\\KvTest/KvBrowserBridge/identities/huicelang-douyin/bridge.json');
  assert.equal(discoveryPathForIdentity(undefined, env), 'C:\\KvTest/KvBrowserBridge/bridge.json');
});

test('accepts only an extension hello that exactly matches the bridge identity', () => {
  const hello = {
    type: 'extension:hello',
    protocolVersion: 1,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '0.2.10',
    identity,
  };
  assert.doesNotThrow(() => validateExtensionIdentityHello(identity, hello));
  assert.throws(() => validateExtensionIdentityHello(identity, {
    ...hello,
    identity: { ...identity, identityId: 'xuanqi-xhs' },
  }), /does not match/);
  assert.throws(() => validateExtensionIdentityHello(identity, { ...hello, identity: undefined }), /requires/);
});

test('public session records never expose pipe names or bearer tokens', () => {
  const record = publicSessionRecord({
    protocolVersion: 1,
    pipeName: '\\\\.\\pipe\\secret',
    token: 'super-secret',
    pid: 42,
    startedAt: '2026-07-29T00:00:00.000Z',
    identity,
  });
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('pipe'), false);
  assert.deepEqual(record.identity, identity);
});

test('rejects malformed environment identity values', () => {
  assert.throws(() => bridgeIdentityFromEnv({ KV_BROWSER_IDENTITY_ID: '../escape' }), /stable lowercase slug/);
  assert.throws(() => bridgeIdentityFromEnv({ KV_BROWSER_IDENTITY_ID: 'valid-id', KV_BROWSER_PLATFORM: 'Bad Value' }), /lowercase slug/);
});
