#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(repoRoot, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const serverJs = fileURLToPath(new URL('../../apps/codex-mcp-server/dist/server.js', import.meta.url));
const RUNS_ROOT =
  process.env.GO_RUNS_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'go-runs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = /^-?\d+$/.test(next) ? Number(next) : next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function callTool(name, args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], cwd: repoRoot });
  const client = new Client({ name: 'kvg-cli', version: '0.1.0' });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.find((i) => i.type === 'text')?.text ?? '{}';
    return JSON.parse(text);
  } finally {
    await client.close().catch(() => {});
  }
}

function printLedger(key) {
  const file = join(RUNS_ROOT, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ok: true, path: file, events: lines.slice(-20) };
  } catch {
    return { ok: false, error: 'no ledger at ' + file };
  }
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const tab = args.tab;

try {
  let result;
  switch (command) {
    case 'resolve':
      result = await callTool('go_resolve_conversation', { tabId: tab });
      break;
    case 'status':
      result = await callTool('go_status', { tabId: tab });
      break;
    case 'start': {
      const nudgePool = typeof args.pool === 'string' ? args.pool.split('|').map((s) => s.trim()).filter(Boolean) : undefined;
      result = await callTool('go_start', {
        tabId: tab,
        goal: args.goal,
        keyword: args.keyword,
        maxRounds: args.maxRounds,
        nudgePool,
        injectProtocol: args.protocol === false ? false : undefined,
      });
      break;
    }
    case 'stop':
      result = await callTool('go_stop', { tabId: tab });
      break;
    case 'continue':
      result = await callTool('go_continue', { tabId: tab, goal: args.goal });
      break;
    case 'configure':
      result = await callTool('go_configure_decision', {
        tabId: tab,
        preset: args.preset,
        apiKey: args.apiKey,
        model: args.model,
        baseUrl: args.baseUrl,
      });
      break;
    case 'ledger':
      result = printLedger(args.key);
      break;
    case 'wait':
      result = await callTool('go_wait', {
        tabId: tab,
        until: args.until,
        timeoutMs: args.timeout,
        pollMs: args.poll,
      });
      break;
    case 'events':
      result = await callTool('go_events', { tabId: tab, clear: args.clear === true });
      break;
    default:
      result = {
        usage: 'kvg <resolve|status|start|stop|continue|configure|ledger|wait|events>',
        options: '--tab N --goal "..." --keyword "..." --max-rounds N --pool "a|b|c" --preset deepseek --api-key ... --model ... --base-url ... --key <conversationKey> --until change|checkpoint --timeout 120000 --poll 2000 --clear',
      };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write('kvg error: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
