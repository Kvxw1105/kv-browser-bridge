#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { ActionSequenceExecutor } from './action-sequence.js';
import { BridgeClient } from './bridge-client.js';
import {
  MAX_SEQUENCE_STEPS,
  MAX_SEQUENCE_TIMEOUT_MS,
  NATIVE_APP_ID_PATTERN,
  SEQUENCE_ID_PATTERN,
  STEP_ID_PATTERN,
  type ComputerActionSequence,
} from './computer-contracts.js';
import { BrowserComputerRuntime } from './computer-runtime.js';
import { NativeAppLauncher } from './native-app-launcher.js';
import { ReceiptStore } from './receipt-store.js';
import { WindowsUiaClient } from './windows-uia-client.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const requestTimeoutMs = Number.parseInt(process.env.LOCAL_CHROME_REQUEST_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;
const log = (event: string, fields: Record<string, unknown> = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'kv-computer-use-mcp', event, ...fields })}\n`);
};

const bridge = new BridgeClient({ requestTimeoutMs, log });
const windows = new WindowsUiaClient(Math.min(requestTimeoutMs, 30_000));
const nativeApps = new NativeAppLauncher();
const runtime = new BrowserComputerRuntime(bridge, windows, nativeApps);
const receipts = new ReceiptStore();
const server = new McpServer({ name: 'kv-computer-use', version: '0.4.0' });
const json = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] });
const sequenceExecutor = new ActionSequenceExecutor(
  (envelope) => runtime.execute(envelope),
  {
    defaultStepTimeoutMs: Math.min(requestTimeoutMs, 120_000),
    onStepReceipt: (receipt) => receipts.append(receipt),
  },
);

const computerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('browser_command'),
    command: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('focus_window'),
    windowHandle: z.number().int().positive(),
  }).passthrough(),
  z.object({
    type: z.literal('invoke_ref'),
    windowHandle: z.number().int().positive().optional(),
    targetRef: z.string().min(1),
    maxSearchElements: z.number().int().min(1).max(10_000).optional(),
    maxSearchDepth: z.number().int().min(0).max(50).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('set_value_ref'),
    windowHandle: z.number().int().positive().optional(),
    targetRef: z.string().min(1),
    value: z.string(),
    maxSearchElements: z.number().int().min(1).max(10_000).optional(),
    maxSearchDepth: z.number().int().min(0).max(50).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('launch_app'),
    appId: z.string().regex(NATIVE_APP_ID_PATTERN),
  }).passthrough(),
]);

const postconditionSchema = z.object({
  kind: z.enum(['none', 'url_contains', 'text_present', 'driver_result', 'window_focused', 'value_equals', 'process_started']),
  value: z.string().optional(),
  windowHandle: z.number().int().positive().optional(),
  targetRef: z.string().min(1).optional(),
  appId: z.string().regex(NATIVE_APP_ID_PATTERN).optional(),
  processId: z.number().int().positive().optional(),
}).strict();

const sequenceStepSchema = z.object({
  stepId: z.string().regex(STEP_ID_PATTERN),
  action: computerActionSchema,
  reason: z.string().min(1),
  expectedPostcondition: postconditionSchema,
  risk: z.enum(['read', 'reversible-write', 'external-write', 'destructive']),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  approved: z.boolean().optional(),
}).strict();

server.tool('computer_runtime_status', 'Return installed Computer Use drivers, capabilities, health, Native App Launcher availability, and receipt-log location.', {}, async () => json({ ...(await runtime.status()), receiptLog: receipts.path() }));
server.tool('computer_list_apps', 'Return allowlisted native applications and their current availability without exposing arbitrary executable control.', {}, async () => json(await runtime.listApps()));
server.tool('computer_observe', 'Observe Chrome and the Windows desktop through one bounded Computer Use contract.', {
  browser: z.boolean().optional(),
  windows: z.boolean().optional(),
  windowHandle: z.number().int().positive().optional(),
  maxWindows: z.number().int().min(1).max(100).optional(),
  maxElements: z.number().int().min(1).max(2_000).optional(),
  maxDepth: z.number().int().min(0).max(20).optional(),
}, async (params) => json(await runtime.observe(params)));
server.tool('computer_execute', 'Execute one policy-checked browser, controlled Windows UIA, or allowlisted native application action, persist its receipt, and return it.', {
  actionId: z.string().min(1),
  action: computerActionSchema,
  reason: z.string().min(1),
  expectedPostcondition: postconditionSchema,
  risk: z.enum(['read', 'reversible-write', 'external-write', 'destructive']),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  approved: z.boolean().optional(),
}, async ({ timeoutMs = requestTimeoutMs, ...params }) => {
  const receipt = await runtime.execute({ ...params, timeoutMs } as Parameters<typeof runtime.execute>[0]);
  await receipts.append(receipt);
  return json(receipt);
});
server.tool('computer_execute_sequence', 'Execute a bounded sequence of policy-checked Computer Use actions serially, stop at the first blocked or failed step, and persist both step and sequence receipts.', {
  sequenceId: z.string().regex(SEQUENCE_ID_PATTERN),
  steps: z.array(sequenceStepSchema).min(1).max(MAX_SEQUENCE_STEPS),
  stopOnFailure: z.literal(true).optional(),
  timeoutMs: z.number().int().positive().max(MAX_SEQUENCE_TIMEOUT_MS).optional(),
}, async (params) => {
  const receipt = await sequenceExecutor.execute(params as ComputerActionSequence);
  await receipts.appendSequence(receipt);
  return json(receipt);
});
server.tool('computer_recent_receipts', 'Return recent persisted Computer Use action receipts.', {
  limit: z.number().int().min(1).max(200).optional(),
}, async ({ limit = 20 }) => json(await receipts.recent(limit)));
server.tool('computer_get_receipt', 'Find one persisted Computer Use action receipt by actionId.', {
  actionId: z.string().min(1),
}, async ({ actionId }) => json((await receipts.find(actionId)) ?? { found: false, actionId }));
server.tool('computer_recent_sequences', 'Return recent persisted bounded Computer Use sequence receipts.', {
  limit: z.number().int().min(1).max(100).optional(),
}, async ({ limit = 20 }) => json(await receipts.recentSequences(limit)));
server.tool('computer_get_sequence', 'Find one persisted bounded Computer Use sequence receipt by sequenceId.', {
  sequenceId: z.string().regex(SEQUENCE_ID_PATTERN),
}, async ({ sequenceId }) => json((await receipts.findSequence(sequenceId)) ?? { found: false, sequenceId }));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log('mcp_started', { requestTimeoutMs, receiptLog: receipts.path() });
  void bridge.request('browser_connection_status').catch(() => undefined);
}
void main().catch((error) => { log('mcp_fatal', { message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void Promise.all([bridge.close(), runtime.close()]); });
