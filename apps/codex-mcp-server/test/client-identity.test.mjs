import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientIdentity, normalizeClientIdentifier, normalizeClientName } from '../dist/client-identity.js';

test('uses stable defaults and a per-process UUID instance', () => {
  const identity = createClientIdentity({});
  assert.equal(identity.clientId, 'codex');
  assert.equal(identity.clientName, 'Codex');
  assert.match(identity.instanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(identity.capabilities, ['read', 'write', 'record']);
});

test('normalizes identifier punctuation and whitespace without leaking paths', () => {
  assert.equal(normalizeClientIdentifier(' New Max/desktop ', 'fallback'), 'New-Max-desktop');
});

test('rejects empty and oversized fallback identifiers', () => {
  assert.throws(() => normalizeClientIdentifier('   ', 'fallback'), /must not be empty/);
  assert.throws(() => normalizeClientIdentifier('x'.repeat(101), 'fallback'), /at most 100/);
});

test('rejects names that normalize to whitespace', () => {
  assert.throws(() => normalizeClientName('\u007f'), /must not be empty/);
  assert.throws(() => normalizeClientName('\u0000\u001f\u007f'), /must not be empty/);
});

test('honors explicit identity environment values', () => {
  const identity = createClientIdentity({ KBB_CLIENT_ID: 'new max', KBB_CLIENT_NAME: 'New Max', KBB_CLIENT_INSTANCE: 'desktop-1' });
  assert.deepEqual(identity, {
    clientId: 'new-max',
    clientName: 'New Max',
    instanceId: 'desktop-1',
    capabilities: ['read', 'write', 'record'],
  });
});
