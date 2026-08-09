#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(repoRoot, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const serverJs = fileURLToPath(new URL('../../apps/codex-mcp-server/dist/server.js', import.meta.url));
const RUNS_ROOT =
  process.env.GO_RUNS_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'go-runs');

const PORT = Number.parseInt(process.env.GO_API_PORT ?? '8735', 10);

const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], cwd: repoRoot });
const client = new Client({ name: 'kvgo-api', version: '0.1.0' });
await client.connect(transport);

async function tool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((i) => i.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

function readLedger(key) {
  const file = join(RUNS_ROOT, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ok: true, path: file, events: lines.slice(-30) };
  } catch {
    return { ok: false, error: 'no ledger at ' + file };
  }
}

async function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && parts[0] === 'health') {
      return send(res, 200, { ok: true, service: 'kvgo-api', version: '0.1.0' });
    }
    if (req.method === 'GET' && parts[0] === 'status' && parts[1]) {
      return send(res, 200, await tool('go_status', { tabId: Number(parts[1]) }));
    }
    if (req.method === 'GET' && parts[0] === 'ledger' && parts[1]) {
      return send(res, 200, readLedger(parts[1]));
    }
    if (req.method === 'POST' && parts[0] === 'resolve') {
      const b = await body(req);
      return send(res, 200, await tool('go_resolve_conversation', { tabId: b.tabId }));
    }
    if (req.method === 'POST' && parts[0] === 'start') {
      const b = await body(req);
      return send(res, 200, await tool('go_start', {
        tabId: b.tabId,
        goal: b.goal,
        keyword: b.keyword,
        maxRounds: b.maxRounds,
        nudgePool: b.nudgePool,
        injectProtocol: b.injectProtocol,
        decision: b.decision,
      }));
    }
    if (req.method === 'POST' && parts[0] === 'stop') {
      const b = await body(req);
      return send(res, 200, await tool('go_stop', { tabId: b.tabId }));
    }
    if (req.method === 'POST' && parts[0] === 'continue') {
      const b = await body(req);
      return send(res, 200, await tool('go_continue', { tabId: b.tabId, goal: b.goal }));
    }
    if (req.method === 'POST' && parts[0] === 'configure') {
      const b = await body(req);
      return send(res, 200, await tool('go_configure_decision', {
        tabId: b.tabId,
        preset: b.preset,
        apiKey: b.apiKey,
        model: b.model,
        baseUrl: b.baseUrl,
      }));
    }
    if (req.method === 'POST' && parts[0] === 'wait') {
      const b = await body(req);
      return send(res, 200, await tool('go_wait', {
        tabId: b.tabId,
        until: b.until,
        timeoutMs: b.timeoutMs,
        pollMs: b.pollMs,
      }));
    }
    return send(res, 404, {
      ok: false,
      endpoints: ['GET /health', 'GET /status/:tabId', 'GET /ledger/:key', 'POST /resolve', 'POST /start', 'POST /stop', 'POST /continue', 'POST /configure', 'POST /wait'],
    });
  } catch (error) {
    return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error('[kvgo-api] listening on http://127.0.0.1:' + PORT);
});

if (process.argv.includes('--smoke')) {
  await new Promise((r) => setTimeout(r, 300));
  const base = 'http://127.0.0.1:' + PORT;
  const health = await (await fetch(base + '/health')).json();
  const ledger = await (await fetch(base + '/ledger/ds-tab')).json();
  console.log(JSON.stringify({ health, ledger }, null, 2));
  await client.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => { void client.close(); process.exit(0); });
