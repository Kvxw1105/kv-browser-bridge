import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { MultiAgentCoordinator, CoordinatorError } from '../apps/chrome-bridge/dist/coordinator.js';
import { createClientIdentity } from '../apps/codex-mcp-server/dist/client-identity.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'multi-agent-page.html');
const TAB_A = 101;
const TAB_B = 202;

const CHILD_SOURCE = String.raw`
  import { createClientIdentity } from './apps/codex-mcp-server/dist/client-identity.js';
  import { createInterface } from 'node:readline';
  const identity = createClientIdentity(process.env);
  process.stdout.write(JSON.stringify({ type: 'hello', identity }) + '\n');
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.type === 'shutdown') { input.close(); process.exit(0); }
    process.stdout.write(JSON.stringify({ type: 'request', id: request.id, method: request.method, params: request.params ?? {} }) + '\n');
  });
`;

class StdioMcpIdentity {
  #child;
  #lines;
  #hello;
  #nextId = 1;

  constructor(env) {
    this.env = env;
    this.#child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.#lines = createInterface({ input: this.#child.stdout });
    this.#hello = new Promise((resolve, reject) => {
      const onLine = (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type !== 'hello') throw new Error('stdio child sent an invalid hello');
          this.#lines.off('line', onLine);
          resolve(message.identity);
        } catch (error) {
          this.#lines.off('line', onLine);
          reject(error);
        }
      };
      this.#lines.on('line', onLine);
      this.#child.once('error', reject);
      this.#child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`stdio child exited before hello: ${code}`));
      });
    });
  }

  async identity() {
    return this.#hello;
  }

  async stop() {
    if (this.#child.exitCode !== null) return;
    this.#child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    await new Promise((resolve) => this.#child.once('exit', resolve));
    this.#lines.close();
  }
}

class FakeBridge {
  constructor(mode = 'observe') {
    this.mode = mode;
    this.coordinator = new MultiAgentCoordinator({ mode });
    this.sessions = new Map();
    this.logs = [];
    this.buttons = new Map([['button-a', 0], ['button-b', 0]]);
    this.fixtureText = 'Button A 0\nButton B 0';
  }

  connect(identity, sessionId) {
    this.sessions.set(sessionId, identity);
    this.coordinator.connect(identity, sessionId);
    this.logs.push({ event: 'client.connected', clientId: identity.clientId });
  }

  disconnect(sessionId) {
    this.coordinator.disconnect(sessionId);
    this.sessions.delete(sessionId);
    this.logs.push({ event: 'client.disconnected', sessionId });
  }

  async request(sessionId, method, params = {}) {
    const started = Date.now();
    this.logs.push({ event: 'request.started', clientId: this.sessions.get(sessionId)?.clientId, method });
    try {
      let result;
      if (method === 'browser_get_text') {
        result = await this.read({ text: this.fixtureText, tabId: params.tabId ?? TAB_A });
      } else if (method === 'browser_snapshot') {
        result = await this.read({ tabId: params.tabId ?? TAB_A, nodes: ['button-a', 'counter-a', 'button-b', 'counter-b'] });
      } else if (method === 'browser_lease_acquire') {
        result = this.coordinator.acquire(sessionId, params.resource, params.purpose, params.ttlMs ?? 5_000);
      } else if (method === 'browser_lease_release') {
        this.coordinator.release(sessionId, params.leaseId);
        result = { released: true };
      } else if (method === 'browser_click') {
        const tabId = params.tabId ?? TAB_A;
        this.coordinator.assertWriteAllowed(sessionId, tabId);
        result = await this.coordinator.runTabWrite(tabId, async () => {
          const button = params.selector === '#button-b' ? 'button-b' : 'button-a';
          this.buttons.set(button, this.buttons.get(button) + 1);
          this.fixtureText = `Button A ${this.buttons.get('button-a')}\nButton B ${this.buttons.get('button-b')}`;
          return { clicked: button, count: this.buttons.get(button) };
        });
      } else if (method === 'browser_record_start') {
        result = this.coordinator.acquire(sessionId, 'global:recorder', params.intent ?? 'fixture recording', 5_000);
      } else if (method === 'browser_record_stop') {
        const lease = this.coordinator.status().leases.find((entry) => entry.resource === 'global:recorder' && entry.ownerSessionId === sessionId);
        if (lease) this.coordinator.release(sessionId, lease.id);
        result = { stopped: true };
      } else if (method === 'browser_connection_status') {
        result = { mode: this.mode, clients: this.coordinator.status().clients.length };
      } else {
        throw new Error(`Unknown fake method: ${method}`);
      }
      this.logs.push({ event: 'request.completed', clientId: this.sessions.get(sessionId)?.clientId, method, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const normalized = error instanceof CoordinatorError
        ? { code: error.code, retryable: error.retryable, details: error.details }
        : { code: 'INTERNAL_ERROR', retryable: false, details: {} };
      this.logs.push({ event: 'request.failed', clientId: this.sessions.get(sessionId)?.clientId, method, error: normalized });
      throw Object.assign(new Error(normalized.code), normalized);
    }
  }

  async read(value) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return value;
  }
}

async function startClient(clientId, clientName) {
  const client = new StdioMcpIdentity({ KBB_CLIENT_ID: clientId, KBB_CLIENT_NAME: clientName, KBB_CLIENT_INSTANCE: `${clientId}-instance` });
  const identity = await client.identity();
  assert.equal(identity.clientId, clientId);
  assert.equal(identity.clientName, clientName);
  return { client, identity };
}

test('dual stdio clients coordinate reads, writes, leases, recorder ownership, and disconnect cleanup', async (t) => {
  const html = await readFile(FIXTURE, 'utf8');
  assert.equal((html.match(/<button\b/g) ?? []).length, 2);
  assert.equal((html.match(/id="counter-/g) ?? []).length, 2);
  assert.doesNotMatch(html, /fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/);

  const agentA = await startClient('codex-test', 'Codex Acceptance');
  const agentB = await startClient('newmax-test', 'New Max Acceptance');
  t.after(async () => { await agentA.client.stop(); await agentB.client.stop(); });

  const observe = new FakeBridge('observe');
  observe.connect(agentA.identity, 'session-a');
  observe.connect(agentB.identity, 'session-b');
  const [text, snapshot] = await Promise.all([
    observe.request('session-a', 'browser_get_text', { tabId: TAB_A }),
    observe.request('session-b', 'browser_snapshot', { tabId: TAB_A }),
  ]);
  assert.match(text.text, /Button A 0/);
  assert.deepEqual(snapshot.nodes, ['button-a', 'counter-a', 'button-b', 'counter-b']);

  const observeLease = await observe.request('session-a', 'browser_lease_acquire', { resource: `tab:${TAB_A}`, purpose: 'observe fixture', ttlMs: 5_000 });
  const observeSecondLease = await observe.request('session-b', 'browser_lease_acquire', { resource: `tab:${TAB_A}`, purpose: 'observe conflict', ttlMs: 5_000 });
  assert.equal(observeSecondLease.ownerSessionId, 'session-b');
  assert.ok(observe.coordinator.conflicts().some((event) => event.resource === `tab:${TAB_A}`));

  const enforce = new FakeBridge('enforce');
  enforce.connect(agentA.identity, 'session-a');
  enforce.connect(agentB.identity, 'session-b');
  const leaseA = await enforce.request('session-a', 'browser_lease_acquire', { resource: `tab:${TAB_A}`, purpose: 'exclusive fixture click', ttlMs: 5_000 });
  await assert.rejects(
    enforce.request('session-b', 'browser_click', { tabId: TAB_A, selector: '#button-a' }),
    (error) => error.code === 'RESOURCE_BUSY' && error.details.owner === 'Codex Acceptance',
  );
  assert.equal(enforce.buttons.get('button-a'), 0, 'blocked click must not reach the fixture');
  assert.equal(enforce.logs.filter((entry) => entry.event === 'request.failed').at(-1).error.code, 'RESOURCE_BUSY');

  await enforce.request('session-a', 'browser_lease_release', { leaseId: leaseA.id });
  const click = await enforce.request('session-b', 'browser_click', { tabId: TAB_A, selector: '#button-a' });
  assert.deepEqual(click, { clicked: 'button-a', count: 1 });
  const otherTabClick = await enforce.request('session-a', 'browser_click', { tabId: TAB_B, selector: '#button-b' });
  assert.deepEqual(otherTabClick, { clicked: 'button-b', count: 1 });

  const recorder = await enforce.request('session-a', 'browser_record_start', { intent: 'record fixture' });
  assert.equal(recorder.resource, 'global:recorder');
  await assert.rejects(
    enforce.request('session-b', 'browser_record_start', { intent: 'record fixture' }),
    (error) => error.code === 'RESOURCE_BUSY',
  );
  await enforce.request('session-a', 'browser_record_stop');
  const recorderB = await enforce.request('session-b', 'browser_record_start', { intent: 'record fixture' });
  assert.equal(recorderB.ownerSessionId, 'session-b');

  const disconnectLease = await enforce.request('session-a', 'browser_lease_acquire', { resource: `tab:${TAB_B}`, purpose: 'disconnect cleanup', ttlMs: 5_000 });
  enforce.disconnect('session-a');
  assert.equal(enforce.coordinator.status().clients.some((client) => client.clientId === 'codex-test'), false);
  assert.equal(enforce.coordinator.status().leases.some((lease) => lease.id === disconnectLease.id), false);

  const serializedLogs = JSON.stringify([...observe.logs, ...enforce.logs]);
  assert.doesNotMatch(serializedLogs, /token|cookie|password|secret|\\\\\.\\pipe|profile|storage/i);
});
