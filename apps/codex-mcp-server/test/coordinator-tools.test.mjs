import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeError } from '../dist/bridge-client.js';
import { registerCoordinationTools } from '../dist/server.js';
import { operationClassForMethod, timeoutErrorForMethod } from '../dist/reliability.js';

function setup(invoke = async () => ({ clients: [], leases: [], mode: 'observe' })) {
  const calls = [];
  const server = new McpServer({ name: 'test', version: '1' });
  registerCoordinationTools(server, async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return invoke(method, params, timeoutMs);
  });
  return { server, calls };
}

function textResult(result) {
  return JSON.parse(result.content[0].text);
}

test('discovers all five coordination tools with bounded schemas', () => {
  const { server } = setup();
  assert.deepEqual(Object.keys(server._registeredTools).sort(), [
    'browser_get_clients', 'browser_lease_acquire', 'browser_lease_release',
    'browser_lease_renew', 'browser_lease_status',
  ]);
  const acquire = server._registeredTools.browser_lease_acquire;
  assert.deepEqual(acquire.inputSchema.safeParse({ resource: 'tab:12', purpose: 'upload', ttlMs: 5_000 }).success, true);
  assert.equal(acquire.inputSchema.safeParse({ resource: 'tab:0', purpose: 'upload' }).success, false);
  assert.equal(acquire.inputSchema.safeParse({ resource: 'global:recorder', purpose: 'x' }).success, false);
  assert.equal(acquire.inputSchema.safeParse({ resource: 'tab:12', purpose: 'upload', ttlMs: 4_999 }).success, false);
  assert.equal(acquire.inputSchema.safeParse({ resource: 'tab:12', purpose: 'upload', ttlMs: 300_001 }).success, false);
});

test('forwards exact methods and parameters, with status tools classified as reads', async () => {
  assert.equal(operationClassForMethod('browser_get_clients'), 'read');
  assert.equal(operationClassForMethod('browser_lease_status'), 'read');
  assert.deepEqual(timeoutErrorForMethod('browser_lease_status'), { code: 'BRIDGE_TIMEOUT', retryable: true });
  const { server, calls } = setup(async (method) => method === 'browser_get_clients'
    ? { clients: [{ clientId: 'codex', clientName: 'Codex', defaultTabId: 12, instanceId: 'hidden' }] }
    : { mode: 'enforce', clients: [], leases: [] });
  const acquireResult = await server._registeredTools.browser_lease_acquire.handler({ resource: 'tab:12', purpose: 'upload', ttlMs: 10_000 });
  const clientsResult = await server._registeredTools.browser_get_clients.handler({});
  assert.deepEqual(calls, [
    { method: 'browser_lease_acquire', params: { resource: 'tab:12', purpose: 'upload', ttlMs: 10_000 }, timeoutMs: undefined },
    { method: 'browser_get_clients', params: {}, timeoutMs: undefined },
  ]);
  assert.equal(textResult(acquireResult), null);
  assert.deepEqual(textResult(clientsResult), { clients: [{ clientId: 'codex', clientName: 'Codex', defaultTabId: 12 }] });
});

test('maps Bridge lease id to leaseId for acquire callers', async () => {
  const { server, calls } = setup(async (method) => method === 'browser_lease_acquire'
    ? { id: 'lease-1', resource: 'tab:12', purpose: 'upload', state: 'active', ownerSessionId: 'hidden' }
    : {});
  const result = textResult(await server._registeredTools.browser_lease_acquire.handler({ resource: 'tab:12', purpose: 'upload' }));
  assert.deepEqual(result, { leaseId: 'lease-1', resource: 'tab:12', purpose: 'upload', state: 'active' });
  assert.equal(calls[0].method, 'browser_lease_acquire');
});

test('bounds status output and strips transport secrets and browsing content', async () => {
  const { server } = setup(async () => ({
    mode: 'observe', pipeName: '\\\\.\\pipe\\secret', token: 'secret', url: 'https://private',
    clients: Array.from({ length: 110 }, (_, index) => ({ clientId: `client-${index}`, clientName: 'Agent', sessionId: 'hidden' })),
    leases: [{ leaseId: 'lease-1', resource: 'tab:12', purpose: 'test', ownerSessionId: 'hidden', state: 'active', expiresAt: '2030-01-01T00:00:00.000Z' }],
  }));
  const result = textResult(await server._registeredTools.browser_lease_status.handler({}));
  assert.equal(result.mode, 'observe');
  assert.equal(result.clients.length, 100);
  assert.equal(result.leases[0].leaseId, 'lease-1');
  assert.equal('token' in result, false);
  assert.equal('pipeName' in result, false);
  assert.equal('ownerSessionId' in result.leases[0], false);
});

test('returns structured Bridge errors without rewriting their code', async () => {
  const { server } = setup(async () => { throw new BridgeError('RESOURCE_BUSY', 'tab is leased', true, { retryAfterMs: 5_000 }); });
  const result = await server._registeredTools.browser_lease_acquire.handler({ resource: 'tab:12', purpose: 'test' });
  assert.equal(result.isError, true);
  assert.deepEqual(textResult(result), { error: { code: 'RESOURCE_BUSY', message: 'tab is leased', retryable: true, details: { retryAfterMs: 5_000 } } });
});
