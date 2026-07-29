import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiAgentCoordinator, CoordinatorError } from '../dist/coordinator.js';

const identity = (clientId, clientName = clientId) => ({
  clientId,
  clientName,
  instanceId: `${clientId}-instance`,
  capabilities: ['read', 'write', 'record'],
});

function setup(mode = 'enforce') {
  let now = 1_700_000_000_000;
  const conflicts = [];
  const coordinator = new MultiAgentCoordinator({ mode, now: () => now, onConflict: (event) => conflicts.push(event) });
  return { coordinator, conflicts, advance: (ms) => { now += ms; } };
}

test('connects clients, scopes default tabs, and exposes status', () => {
  const { coordinator } = setup();
  const first = coordinator.connect(identity('codex', 'Codex'), 'session-a');
  coordinator.connect(identity('newmax', 'New Max'), 'session-b');
  coordinator.setDefaultTab('session-a', 11);

  assert.equal(first.clientName, 'Codex');
  assert.equal(coordinator.resolveTab('session-a'), 11);
  assert.equal(coordinator.resolveTab('session-a', 12), 12);
  assert.equal(coordinator.resolveTab('session-b'), undefined);
  assert.deepEqual(coordinator.status().clients.map((client) => client.clientId), ['codex', 'newmax']);
});

test('validates identity, resources, and lease TTL', () => {
  const { coordinator } = setup();
  assert.throws(() => coordinator.connect(identity('   '), 'session-a'), (error) => error.code === 'INVALID_REQUEST');
  coordinator.connect(identity('codex'), 'session-a');
  assert.throws(() => coordinator.acquire('session-a', 'tab:1', 'write', 4_999), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => coordinator.acquire('session-a', 'tab:0', 'write', 5_000), (error) => error.code === 'INVALID_REQUEST');
});

test('enforce mode rejects another owner with bounded conflict details', () => {
  const { coordinator } = setup('enforce');
  coordinator.connect(identity('codex', 'Codex'), 'session-a');
  coordinator.connect(identity('newmax', 'New Max'), 'session-b');
  const lease = coordinator.acquire('session-a', 'tab:7', 'upload test', 5_000);
  assert.throws(() => coordinator.acquire('session-b', 'tab:7', 'reply', 5_000), (error) => {
    assert.ok(error instanceof CoordinatorError);
    assert.equal(error.code, 'RESOURCE_BUSY');
    assert.deepEqual(error.details, {
      resource: 'tab:7',
      owner: 'Codex',
      purpose: 'upload test',
      retryAfterMs: 5_000,
    });
    return true;
  });
  assert.equal(coordinator.acquire('session-a', lease.resource, 'updated', 10_000).id, lease.id);
});

test('observe records conflicts and allows a second owner to proceed', () => {
  const { coordinator, conflicts } = setup('observe');
  coordinator.connect(identity('a', 'Agent A'), 'session-a');
  coordinator.connect(identity('b', 'Agent B'), 'session-b');
  coordinator.acquire('session-a', 'tab:2', 'task a', 5_000);
  const second = coordinator.acquire('session-b', 'tab:2', 'task b', 5_000);
  assert.equal(second.ownerSessionId, 'session-b');
  assert.equal(conflicts.length, 1);
  coordinator.assertWriteAllowed('session-b', 2);
  assert.equal(conflicts.length, 2);
});

test('off mode keeps legacy writes unblocked', () => {
  const { coordinator } = setup('off');
  coordinator.connect(identity('a'), 'session-a');
  coordinator.connect(identity('b'), 'session-b');
  coordinator.acquire('session-a', 'tab:3', 'task', 5_000);
  assert.doesNotThrow(() => coordinator.assertWriteAllowed('session-b', 3));
  assert.doesNotThrow(() => coordinator.acquire('session-b', 'tab:3', 'other', 5_000));
});

test('lease renew/release ownership, TTL expiry, and disconnect cleanup', () => {
  const { coordinator, advance } = setup();
  coordinator.connect(identity('a'), 'session-a');
  coordinator.connect(identity('b'), 'session-b');
  const lease = coordinator.acquire('session-a', 'tab:4', 'task', 5_000);
  assert.throws(() => coordinator.renew('session-b', lease.id, 5_000), (error) => error.code === 'LEASE_NOT_OWNED');
  const renewed = coordinator.renew('session-a', lease.id, 10_000);
  assert.equal(Date.parse(renewed.expiresAt), 1_700_000_010_000);
  coordinator.release('session-a', lease.id);
  assert.equal(coordinator.status().leases.length, 0);
  const second = coordinator.acquire('session-a', 'tab:4', 'task', 5_000);
  advance(5_001);
  assert.equal(coordinator.status().leases.length, 0);
  const third = coordinator.acquire('session-a', 'tab:4', 'task', 5_000);
  coordinator.disconnect('session-a');
  assert.equal(coordinator.status().leases.some((entry) => entry.id === third.id), false);
});

test('quarantine blocks other owners and remains until TTL', () => {
  const { coordinator, advance } = setup('enforce');
  coordinator.connect(identity('a', 'Agent A'), 'session-a');
  coordinator.connect(identity('b', 'Agent B'), 'session-b');
  const quarantine = coordinator.quarantineTab('session-a', 5);
  assert.equal(quarantine.state, 'quarantined');
  assert.throws(() => coordinator.assertWriteAllowed('session-b', 5), (error) => error.code === 'RESOURCE_QUARANTINED');
  coordinator.disconnect('session-a');
  assert.throws(() => coordinator.assertWriteAllowed('session-b', 5), (error) => error.code === 'RESOURCE_QUARANTINED');
  advance(30_001);
  assert.doesNotThrow(() => coordinator.assertWriteAllowed('session-b', 5));
});

test('recorder is globally exclusive', () => {
  const { coordinator } = setup('enforce');
  coordinator.connect(identity('a'), 'session-a');
  coordinator.connect(identity('b'), 'session-b');
  coordinator.acquire('session-a', 'global:recorder', 'record flow', 5_000);
  assert.throws(() => coordinator.acquire('session-b', 'global:recorder', 'record flow', 5_000), (error) => error.code === 'RESOURCE_BUSY');
});

test('same-tab writes are serialized while different tabs overlap', async () => {
  const { coordinator } = setup();
  const events = [];
  let releaseFirst;
  const first = coordinator.runTabWrite(1, async () => {
    events.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:end');
    return 'first';
  });
  const second = coordinator.runTabWrite(1, async () => {
    events.push('second:start');
    return 'second';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);

  let releaseTabTwo;
  const tabOne = coordinator.runTabWrite(1, async () => new Promise((resolve) => setTimeout(() => resolve('one'), 5)));
  const tabTwo = coordinator.runTabWrite(2, async () => new Promise((resolve) => { releaseTabTwo = () => resolve('two'); }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseTabTwo, 'function');
  releaseTabTwo();
  assert.deepEqual(await Promise.all([tabOne, tabTwo]), ['one', 'two']);
});
