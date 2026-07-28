#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { BridgeClient } from './bridge-client.js';
import { BrowserComputerRuntime } from './computer-runtime.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const requestTimeoutMs = Number.parseInt(process.env.LOCAL_CHROME_REQUEST_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;
const log = (event: string, fields: Record<string, unknown> = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'kv-computer-use-mcp', event, ...fields })}\n`);
};

const bridge = new BridgeClient({ requestTimeoutMs, log });
const runtime = new BrowserComputerRuntime(bridge);
const server = new McpServer({ name: 'kv-computer-use', version: '0.1.0' });
const json = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] });

server.tool('computer_runtime_status', 'Return installed and planned Computer Use drivers plus Chrome Bridge health.', {}, async () => json(runtime.status()));
server.tool('computer_observe', 'Observe the connected Chrome instance through the unified Computer Use observation contract.', {}, async () => json(await runtime.observe()));
server.tool('computer_execute', 'Execute one policy-checked Computer Use action and return a verification receipt.', {
  actionId: z.string().min(1),
  action: z.object({
    type: z.string().min(1),
    command: z.string().min(1).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  reason: z.string().min(1),
  expectedPostcondition: z.object({
    kind: z.enum(['none', 'url_contains', 'text_present', 'driver_result']),
    value: z.string().optional(),
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
  process.once(signal, () => void bridge.close());
}
