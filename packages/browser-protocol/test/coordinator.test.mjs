import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAgentIdentity,
  isBrowserToolName,
  isPipeHello,
  serializeCoordinationStatus,
  toCoordinationStatusView,
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
  assert.equal(isPipeHello({
    type: 'hello', token: 'TOKEN', version: 1, clientName: 42,
  }), false, 'clientName-only hello type');
  for (const field of ['clientId', 'clientName', 'instanceId']) {
    const identity = {
      clientId: 'client-1', clientName: 'Coordinator', instanceId: 'instance-1', capabilities: ['read'],
      [field]: ` ${identityValue(field)} `,
    };
    assert.equal(isAgentIdentity(identity), false, `${field} surrounding whitespace`);
    assert.equal(isPipeHello({ type: 'hello', token: 'TOKEN', version: 1, ...identity }), false, `${field} hello surrounding whitespace`);
  }
});

function identityValue(field) {
  return field === 'clientName' ? 'Coordinator' : `${field}-1`;
}

test('projects full coordination status before transport serialization', () => {
  const fullStatus = {
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
  const projected = toCoordinationStatusView(fullStatus);
  assert.deepEqual(projected, {
    mode: 'enforce',
    clients: [{ clientId: 'client-1', clientName: 'Coordinator', defaultTabId: 42 }],
    leases: [{ resource: 'tab:42', purpose: 'recording', state: 'active', expiresAt: '2026-07-30T00:01:00.000Z' }],
  });
  assert.deepEqual(serializeCoordinationStatus(fullStatus), projected);
  const payload = JSON.stringify({
    native: { type: 'bridge:coordination_status', status: serializeCoordinationStatus(fullStatus) },
    pipe: { type: 'event', event: 'coordination:status', data: serializeCoordinationStatus(fullStatus) },
  });
  for (const field of ['instanceId', 'sessionId', 'ownerSessionId', 'connectedAt', 'lastSeenAt', 'acquiredAt']) {
    assert.equal(payload.includes(field), false, field);
  }
  assert.equal(payload.includes('"id"'), false, 'lease id');
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
