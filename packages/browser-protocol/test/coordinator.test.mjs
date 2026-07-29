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
  for (const field of ['clientId', 'clientName', 'instanceId']) {
    const identity = {
      clientId: 'client-1', clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['read'],
      [field]: '   ',
    };
    assert.equal(isAgentIdentity(identity), false, `${field} whitespace`);
    assert.equal(isPipeHello({ type: 'hello', token: 'TOKEN', version: 1, ...identity }), false, `${field} hello`);
  }
  assert.equal(isAgentIdentity({
    clientId: 'client-1', clientName: 42, instanceId: 'instance-1', capabilities: ['read'],
  }), false);
  assert.equal(isPipeHello({
    type: 'hello', token: 'TOKEN', version: 1,
    clientId: 'x'.repeat(101), clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['read'],
  }), false);
});

test('round-trips redacted coordination status transport messages', () => {
  const statusView = {
    mode: 'enforce',
    clients: [{
      clientId: 'client-1', clientName: 'Coordinator', defaultTabId: 42,
    }],
    leases: [{
      resource: 'tab:42', purpose: 'recording', state: 'active', expiresAt: '2026-07-30T00:01:00.000Z',
    }],
  };
  const messages = [
    { type: 'event', event: 'coordination:status', data: statusView },
    { type: 'bridge:coordination_status', status: statusView },
  ];
  const payload = JSON.stringify(messages);
  const roundTripped = JSON.parse(payload);
  assert.deepEqual(roundTripped, messages);
  assert.deepEqual(Object.keys(roundTripped[0].data.leases[0]).sort(), ['expiresAt', 'purpose', 'resource', 'state']);
  for (const field of ['instanceId', 'sessionId', 'ownerSessionId', 'connectedAt', 'lastSeenAt', 'acquiredAt']) {
    assert.equal(payload.includes(field), false, field);
  }
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
