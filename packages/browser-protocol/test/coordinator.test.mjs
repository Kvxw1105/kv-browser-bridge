import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAgentIdentity,
  isBrowserToolName,
  isPipeHello,
} from '../dist/index.js';

test('accepts legacy pipe hello fields', () => {
  assert.equal(isPipeHello({
    type: 'hello', token: 'TOKEN', client: 'legacy-client', clientName: 'Legacy', protocolVersion: 1,
  }), true);
});

test('accepts pipe hello with a multi-agent identity', () => {
  const identity = {
    clientId: 'client-1', clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['read', 'write'],
  };
  assert.equal(isAgentIdentity(identity), true);
  assert.equal(isPipeHello({ type: 'hello', token: 'TOKEN', version: 1, ...identity }), true);
});

test('rejects malformed agent identities in pipe hello', () => {
  assert.equal(isAgentIdentity({
    clientId: 'client-1', clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['admin'],
  }), false);
  assert.equal(isPipeHello({
    type: 'hello', token: 'TOKEN', version: 1, clientId: 'client-1', capabilities: ['admin'],
  }), false);
});

test('represents a coordination status without transport-sensitive data', () => {
  const status = {
    mode: 'enforce',
    clients: [{
      clientId: 'client-1', clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['record'],
      sessionId: 'session-1', connectedAt: '2026-07-30T00:00:00.000Z', lastSeenAt: '2026-07-30T00:00:01.000Z', defaultTabId: 42,
    }],
    leases: [{
      id: 'lease-1', resource: 'tab:42', ownerSessionId: 'session-1', purpose: 'recording', state: 'active',
      acquiredAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-07-30T00:01:00.000Z',
    }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
});

test('keeps coordination pipe methods separate from browser actions', () => {
  for (const method of [
    'browser_get_clients', 'browser_lease_acquire', 'browser_lease_renew',
    'browser_lease_release', 'browser_lease_status',
  ]) {
    assert.equal(isBrowserToolName(method), false, method);
  }
  assert.equal(isBrowserToolName('browser_get_tabs'), true);
});
