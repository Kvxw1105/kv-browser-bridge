#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { BridgeClient, BridgeError } from './bridge-client.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const requestTimeoutMs = Number.parseInt(process.env.LOCAL_CHROME_REQUEST_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

function log(event: string, fields: Record<string, unknown> = {}): void {
  // stderr is deliberately the sole log stream: stdout belongs exclusively to MCP stdio.
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'local-chrome-mcp', event, ...fields })}\n`);
}

const bridge = new BridgeClient({ requestTimeoutMs, log });
const server = new McpServer({ name: 'local-chrome', version: '0.1.0' });

const tabId = z.number().int().positive().optional().describe('Target Chrome tab ID. Uses the Bridge-selected tab when omitted.');
const locator = {
  selector: z.string().min(1).optional().describe('CSS selector for the target element.'),
  xpath: z.string().min(1).optional().describe('XPath for the target element.'),
};

function json(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function bridgeErrorResult(error: unknown) {
  const bridgeError = error instanceof BridgeError
    ? error
    : new BridgeError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  log('tool_error', { code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable });
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: { code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable, details: bridgeError.details } }, null, 2),
    }],
  };
}

async function callBridge(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
  log('tool_request', { method });
  try {
    return json(await bridge.request(method, params, timeoutMs));
  } catch (error) {
    return bridgeErrorResult(error);
  }
}

server.tool('browser_get_tabs', 'List the tabs in the currently connected Chrome instance.', {}, async () => callBridge('browser_get_tabs'));

server.tool('browser_new_tab', 'Create a tab in the existing Chrome window without launching a new browser process or profile.', {
  url: z.string().url().optional().describe('Optional URL. Defaults to Chrome New Tab.'),
  windowId: z.number().int().positive().optional().describe('Existing Chrome window ID. Defaults to the currently focused window.'),
  activate: z.boolean().optional().describe('Whether the created tab should become active. Defaults to true.'),
}, async (params) => callBridge('browser_new_tab', params));

server.tool('browser_switch_tab', 'Select a tab as the default target for later browser tools.', {
  tabId: z.number().int().positive().describe('Chrome tab ID to select.'),
  activate: z.boolean().optional().describe('Whether Chrome should activate the selected tab.'),
}, async (params) => callBridge('browser_switch_tab', params));

server.tool('browser_scroll', 'Scroll the page or a located scrollable element by a bounded amount.', {
  ...{ tabId },
  ...locator,
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(1).max(10_000).optional(),
  behavior: z.enum(['auto', 'smooth']).optional(),
}, async (params) => callBridge('browser_scroll', params));

server.tool('browser_find', 'Read-only search for visible page elements by text, role, CSS selector, or XPath.', {
  ...{ tabId },
  ...locator,
  text: z.string().min(1).max(500).optional(),
  role: z.string().min(1).max(100).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
}, async (params) => callBridge('browser_find', params));

server.tool('browser_close_tab', 'Close one explicitly identified Chrome tab. Requires confirm=true and refuses pinned or last-window tabs by default.', {
  tabId: z.number().int().positive().describe('Exact Chrome tab ID to close.'),
  confirm: z.literal(true).describe('Must be true to acknowledge closing the specified tab.'),
  allowPinned: z.boolean().optional().describe('Allow closing a pinned tab. Defaults to false.'),
}, async (params) => callBridge('browser_close_tab', params));

server.tool('browser_download_status', 'Read a bounded, privacy-sanitized view of recent Chrome download status. Does not open, erase, or accept downloads.', {
  downloadId: z.number().int().positive().optional(),
  state: z.enum(['in_progress', 'complete', 'interrupted']).optional(),
  startedAfter: z.string().datetime().optional().describe('Optional ISO-8601 lower time bound.'),
  limit: z.number().int().min(1).max(20).optional(),
}, async (params) => callBridge('browser_download_status', params));

server.tool('browser_list_bookmarks', 'Read or search Chrome bookmarks. Bookmark changes are intentionally not supported.', {
  folderId: z.string().min(1).optional(),
  query: z.string().min(1).max(500).optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
}, async (params) => callBridge('browser_list_bookmarks', params));

server.tool('browser_open_bookmark', 'Open one HTTP(S) bookmark in a tab inside an existing Chrome window.', {
  bookmarkId: z.string().min(1),
  windowId: z.number().int().positive().optional(),
  activate: z.boolean().optional(),
}, async (params) => callBridge('browser_open_bookmark', params));

server.tool('browser_list_extensions', 'Read installed Chrome extension metadata. Enabling, disabling, installing, and uninstalling extensions are intentionally not automated.', {
  includeDisabled: z.boolean().optional(),
  includePermissions: z.boolean().optional(),
}, async (params) => callBridge('browser_list_extensions', params));

server.tool('browser_navigate', 'Navigate a Chrome tab to a URL.', {
  ...{ tabId },
  url: z.string().url().describe('URL to open.'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('Navigation readiness condition.'),
  timeoutMs: z.number().int().positive().max(120_000).optional().describe('Navigation timeout in milliseconds.'),
}, async ({ timeoutMs, ...params }) => callBridge('browser_navigate', params, timeoutMs));

server.tool('browser_snapshot', 'Return an accessibility or DOM-oriented page structure snapshot.', {
  ...{ tabId },
  mode: z.enum(['accessibility', 'dom', 'auto']).optional().describe('Snapshot representation.'),
  maxDepth: z.number().int().positive().max(100).optional().describe('Maximum tree depth.'),
}, async (params) => callBridge('browser_snapshot', params));

server.tool('browser_screenshot', 'Capture a PNG screenshot from an existing Chrome tab. The optional artifact path is handled by the Bridge.', {
  ...{ tabId },
  artifactPath: z.string().min(1).optional().describe('Optional absolute path where the Bridge should save the PNG.'),
}, async (params) => {
  log('tool_request', { method: 'browser_screenshot' });
  try {
    const result = await bridge.request('browser_screenshot', params) as { dataUrl?: string; data?: string; base64?: string; mimeType?: string; artifactPath?: string };
    const raw = result.data ?? result.base64 ?? result.dataUrl?.replace(/^data:[^;]+;base64,/, '');
    const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];
    if (raw) content.push({ type: 'image', data: raw, mimeType: result.mimeType ?? 'image/png' });
    content.push({ type: 'text', text: JSON.stringify({ artifactPath: result.artifactPath, captured: Boolean(raw) }, null, 2) });
    return { content };
  } catch (error) {
    return bridgeErrorResult(error);
  }
});

server.tool('browser_click', 'Click one element using exactly one CSS selector or XPath.', {
  ...{ tabId },
  ...locator,
  allowCommentSend: z.literal(true).optional().describe('Allow only a comment-composer button whose exact text is 发送. Final publish controls remain blocked.'),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
}, async ({ timeoutMs, ...params }) => callBridge('browser_click', params, timeoutMs));

server.tool('browser_type', 'Focus an input and type text without using desktop coordinate automation.', {
  ...{ tabId },
  ...locator,
  text: z.string().describe('Text to enter.'),
  clear: z.boolean().optional().describe('Clear existing input before typing.'),
}, async (params) => callBridge('browser_type', params));

server.tool('browser_press', 'Send a keyboard key or shortcut to a Chrome tab or focused element.', {
  ...{ tabId },
  ...locator,
  key: z.string().min(1).describe('Key name such as Enter, Tab, Control+A, or Escape.'),
}, async (params) => callBridge('browser_press', params));

server.tool('browser_select', 'Set a select element by option value or visible label.', {
  ...{ tabId },
  ...locator,
  value: z.string().optional().describe('Option value.'),
  label: z.string().optional().describe('Visible option label.'),
}, async (params) => callBridge('browser_select', params));

server.tool('browser_evaluate', 'Evaluate a JavaScript expression in a Chrome page through the Bridge CDP implementation.', {
  ...{ tabId },
  expression: z.string().min(1).describe('JavaScript expression to evaluate.'),
  allowSideEffects: z.boolean().optional().describe('Must be explicitly true for a Bridge that permits side effects.'),
}, async (params) => callBridge('browser_evaluate', params));

server.tool('browser_set_files', 'Set files on an input[type=file] using Chrome DevTools Protocol. Paths must be absolute local paths.', {
  ...{ tabId },
  ...locator,
  files: z.array(z.string().min(1).refine(isAbsolute, 'Each file path must be absolute.')).min(1).describe('Absolute local file paths to set on the upload input.'),
}, async (params) => callBridge('browser_set_files', params, 120_000));

server.tool('browser_wait_for', 'Wait for a selector, XPath, text, URL, or load condition in an existing Chrome tab.', {
  ...{ tabId },
  selector: z.string().min(1).optional(),
  xpath: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  state: z.enum(['attached', 'visible', 'hidden', 'detached', 'load']).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
}, async ({ timeoutMs, ...params }) => callBridge('browser_wait_for', params, timeoutMs));

server.tool('browser_get_text', 'Read text from a page or one located element.', {
  ...{ tabId },
  ...locator,
  maxChars: z.number().int().positive().max(1_000_000).optional().describe('Maximum characters returned.'),
}, async (params) => callBridge('browser_get_text', params));

server.tool('browser_get_url', 'Return the URL and title of a Chrome tab.', { ...{ tabId } }, async (params) => callBridge('browser_get_url', params));

server.tool('browser_connection_status', 'Return Chrome Bridge connection and authentication status without starting a browser.', {}, async () => json(bridge.getStatus()));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('mcp_started', { requestTimeoutMs });
  // Connecting is intentionally best-effort. Codex can still call browser_connection_status while the Bridge starts.
  void bridge.request('browser_connection_status').catch(() => undefined);
}

void main().catch((error) => {
  log('mcp_fatal', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bridge.close());
}
