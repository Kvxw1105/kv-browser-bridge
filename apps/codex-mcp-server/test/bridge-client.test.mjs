import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHelloParams, selectUsableBridgeConfig } from '../dist/bridge-client.js';
import { createClientIdentity } from '../dist/client-identity.js';
import { disconnectErrorFor, healthState, IdempotencyCache, operationClassForMethod, PerTabWriteQueue, timeoutErrorForMethod } from '../dist/reliability.js';

test('falls back from an incomplete Kv discovery candidate to a usable legacy candidate', () => {
  const legacy = { pipeName: '\\\\.\\pipe\\local-chrome-legacy', token: 'legacy-token' };

  assert.deepEqual(
    selectUsableBridgeConfig([
      { pipeName: '\\\\.\\pipe\\kv-browser-bridge-stale' },
      legacy,
    ]),
    legacy,
  );
});

test('timeouts conservatively classify writes as unknown outcomes', () => {
  assert.equal(operationClassForMethod('browser_get_url'), 'read');
  assert.deepEqual(timeoutErrorForMethod('browser_get_url'), { code: 'BRIDGE_TIMEOUT', retryable: true });
  assert.deepEqual(timeoutErrorForMethod('browser_click'), { code: 'UNKNOWN_OUTCOME', retryable: false });
});

test('per-tab write queue serializes one tab but permits another tab', async () => {
  const queue = new PerTabWriteQueue();
  const events = [];
  let release;
  const first = queue.run(1, 'non_idempotent_write', async () => { events.push('first'); await new Promise((resolve) => { release = resolve; }); events.push('first-end'); });
  const second = queue.run(1, 'non_idempotent_write', async () => { events.push('second'); });
  const other = queue.run(2, 'non_idempotent_write', async () => { events.push('other'); });
  await other;
  assert.deepEqual(events, ['first', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'first-end', 'second']);
});

test('fake MCP transport classifies a disconnected write as an unknown outcome', () => {
  assert.deepEqual(disconnectErrorFor('non_idempotent_write'), { code: 'UNKNOWN_OUTCOME', retryable: false });
  assert.deepEqual(disconnectErrorFor('read'), { code: 'BRIDGE_UNAVAILABLE', retryable: true });
});

test('fake transport reconnect joins and replays the same stable idempotency key', async () => {
  const cache = new IdempotencyCache();
  let executions = 0;
  const execute = async () => { executions += 1; return { ok: true }; };
  const first = cache.run('codex-mcp-server', 'publish-42', execute);
  const reconnectedDuplicate = cache.run('codex-mcp-server', 'publish-42', execute);
  assert.equal(first, reconnectedDuplicate);
  assert.deepEqual(await reconnectedDuplicate, { ok: true });
  assert.equal(executions, 1);
});

test('idempotency cache expires and bounds entries', async () => {
  let now = 0;
  const cache = new IdempotencyCache(2, 10, () => now);
  await cache.run('a', '1', async () => 1);
  await cache.run('a', '2', async () => 2);
  await cache.run('a', '3', async () => 3);
  assert.ok(cache.size() <= 2);
  now = 11;
  await cache.run('a', '4', async () => 4);
  assert.equal(cache.size(), 1);
});

test('health exposes ready and degraded transitions', () => {
  assert.deepEqual(healthState(true, { extensionConnected: true, nativeReady: true }), { ready: true, degraded: false });
  assert.deepEqual(healthState(true, { extensionConnected: true, nativeReady: false }), { ready: false, degraded: true });
  assert.deepEqual(healthState(false, { extensionConnected: true, nativeReady: true }), { ready: false, degraded: false });
});

test('hello carries identity, capabilities, token, and legacy compatibility fields', () => {
  const identity = createClientIdentity({ KBB_CLIENT_ID: 'newmax', KBB_CLIENT_NAME: 'New Max', KBB_CLIENT_INSTANCE: 'instance-1' });
  assert.deepEqual(buildHelloParams(identity, 'secret-token'), {
    token: 'secret-token',
    client: 'codex-mcp-server',
    version: '0.1.0',
    clientId: 'newmax',
    clientName: 'New Max',
    instanceId: 'instance-1',
    capabilities: ['read', 'write', 'record'],
  });
});
