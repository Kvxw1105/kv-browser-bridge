#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { BridgeClient } from './bridge-client.js';
import { BrowserComputerRuntime } from './computer-runtime.js';
import { WindowsUiaClient } from './windows-uia-client.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const requestTimeoutMs = Number.parseInt(process.env.LOCAL_CHROME_REQUEST_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;
const log = (event: string, fields: Record<string, unknown> = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'kv-computer-use-mcp', event, ...fields })}\n`);
};

const bridge = new BridgeClient({ requestTimeoutMs, log });
const windows = new WindowsUiaClient(Math.min(requestTimeoutMs, 30_000));
const runtime = new BrowserComputerRuntime(bridge, windows);
const server = new McpServer({ name: 'kv-computer-use', version: '0.3.0' });
const json = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] });

server.tool('computer_runtime_status', 'Return installed Computer Use drivers, capabilities, and health.', {}, async () => json(await runtime.status()));
server.tool('computer_observe', 'Observe Chrome and the Windows desktop through one bounded Computer Use contract.', {
  browser: z.boolean().optional(),
  windows: z.boolean().optional(),
  windowHandle: z.number().int().positive().optional(),
  maxWindows: z.number().int().min(1).max(100).optional(),
  maxElements: z.number().int().min(1).max(2_000).optional(),
  maxDepth: z.number().int().min(0).max(20).optional(),
}, async (params) => json(await runtime.observe(params)));
server.tool('computer_execute', 'Execute one policy-checked browser or controlled Windows UIA action and return a verified receipt.', {
  actionId: z.string().min(1),
  action: z.object({
    type: z.string().min(1),
    command: z.string().min(1).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    windowHandle: z.number().int().positive().optional(),
    targetRef: z.string().min(1).optional(),
    value: z.string().optional(),
    maxSearchElements: z.number().int().min(1).max(10_000).optional(),
    maxSearchDepth: z.number().int().min(0).max(50).optional(),
  }).passthrough(),
  reason: z.string().min(1),
  expectedPostcondition: z.object({
    kind: z.enum(['none', 'url_contains', 'text_present', 'driver_result', 'window_focused', 'value_equals']),
    value: z.string().optional(),
    windowHandle: z.number().int().positive().optional(),
    targetRef: z.string().min(1).optional(),
  }),
  risk: z.enum(['read', 'reversible-write', 'external-write', 'destructive']),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  approved: z.boolean().optional(),
}, async ({ timeoutMs = requestTimeoutMs, ...params }) => json(await runtime.execute({ ...params, timeoutMs } as Parameters<typeof runtime.execute>[0])));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log('mcp_started', { requestTimeoutMs });
  void bridge.request('browser_connection_status').catch(() => undefined);
}

void main().catch((error) => {
  log('mcp_fatal', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void Promise.all([bridge.close(), runtime.close()]); });
}
