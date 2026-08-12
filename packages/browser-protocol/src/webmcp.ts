/**
 * WebMCP page-context function templates for the Bridge.
 *
 * These functions are executed inside the target Chrome tab (via
 * chrome.scripting.executeScript) and are the ONLY way the Bridge talks to
 * `navigator.modelContextTesting`: they never accept caller-supplied
 * JavaScript, only a tool name and a JSON-serializable input object.
 *
 * Serialization constraint: `chrome.scripting.executeScript({ func })`
 * serializes ONLY the function source plus its captured closure variables.
 * Module-scope helper functions are NOT available in the page, so every
 * helper below is defined INSIDE the template body. The same code runs in
 * Node for unit tests, where `navigator.modelContextTesting` is absent or
 * mocked.
 *
 * The WebMCP interface follows the public WebMCP specification
 * (https://github.com/webmachinelearning/webmcp): `listTools()` returns tool
 * descriptors and `executeTool(name, JSON.stringify(input))` returns the raw
 * tool result. Cloudflare is only one deployment of that interface; this
 * code depends on the standard browser API, not on Cloudflare.
 */

export interface WebMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface WebMcpListResult {
  available: boolean;
  tools: WebMcpToolDescriptor[];
  url: string;
}

export type WebMcpExecuteStatus = 'completed' | 'unavailable' | 'tool_not_found' | 'failed' | 'unknown_outcome';

export interface WebMcpExecuteResult {
  status: WebMcpExecuteStatus;
  /** Raw tool output normalized to structured JSON when possible. */
  result?: unknown;
  error?: string;
  /** Fresh tool list gathered after execution (null when the page could not be re-listed). */
  toolsAfter?: WebMcpToolDescriptor[] | null;
  url: string;
}

/**
 * Page template: detect and list WebMCP tools in the current tab.
 * A page without `navigator.modelContextTesting` (or a listing failure) is
 * reported as `available: false` — it is not an error and the caller should
 * fall back to the regular Bridge browser operations.
 */
export async function listWebMcpToolsInPage(): Promise<WebMcpListResult> {
  const normalizeTool = (tool: unknown): { name: string; description: string; inputSchema?: unknown } | null => {
    if (typeof tool !== 'object' || tool === null) return null;
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === 'string' && t.name.length > 0 ? t.name : '';
    if (!name) return null;
    const descriptor: { name: string; description: string; inputSchema?: unknown } = {
      name,
      description: typeof t.description === 'string' ? t.description : '',
    };
    if (t.inputSchema !== undefined) descriptor.inputSchema = t.inputSchema;
    return descriptor;
  };
  const normalizeToolList = (value: unknown): { name: string; description: string; inputSchema?: unknown }[] => {
    if (!Array.isArray(value)) return [];
    const tools: { name: string; description: string; inputSchema?: unknown }[] = [];
    for (const entry of value) {
      const normalized = normalizeTool(entry);
      if (normalized) tools.push(normalized);
    }
    return tools;
  };
  let url = '';
  try {
    const g = globalThis as Record<string, unknown>;
    const location = g.location as { href?: unknown } | undefined;
    if (typeof location === 'object' && location !== null && typeof location.href === 'string') url = location.href;
  } catch { /* worker-style context without location */ }

  let api: unknown;
  try {
    const g = globalThis as Record<string, unknown>;
    const navigator = g.navigator as Record<string, unknown> | undefined;
    api = typeof navigator === 'object' && navigator !== null ? navigator.modelContextTesting : undefined;
  } catch { api = undefined; }
  if (typeof api !== 'object' || api === null) return { available: false, tools: [], url };
  const candidate = api as Record<string, unknown>;
  if (typeof candidate.listTools !== 'function') return { available: false, tools: [], url };

  try {
    const listed = await (candidate.listTools as () => Promise<unknown>)();
    return { available: true, tools: normalizeToolList(listed), url };
  } catch (error) {
    // Listing itself failed; treat as unavailable so the Agent falls back to
    // the normal DOM/CDP browser operations instead of surfacing a failure.
    void error;
    return { available: false, tools: [], url };
  }
}

/**
 * Page template: execute one WebMCP tool by name with a structured input.
 *
 * The tool list is re-read before execution (the tool may have disappeared
 * after navigation) and again after execution (page state may have changed).
 * Execution errors from the tool itself are `failed`; a missing tool is
 * `tool_not_found`; a page without WebMCP is `unavailable`. Navigation or
 * context teardown that makes the outcome unknowable is surfaced by the
 * Bridge layer as `unknown_outcome` (timeout / disconnect) — this template
 * never retries the tool call.
 */
export async function executeWebMcpToolInPage(name: string, input: unknown): Promise<WebMcpExecuteResult> {
  const normalizeTool = (tool: unknown): { name: string; description: string; inputSchema?: unknown } | null => {
    if (typeof tool !== 'object' || tool === null) return null;
    const t = tool as Record<string, unknown>;
    const toolName = typeof t.name === 'string' && t.name.length > 0 ? t.name : '';
    if (!toolName) return null;
    const descriptor: { name: string; description: string; inputSchema?: unknown } = {
      name: toolName,
      description: typeof t.description === 'string' ? t.description : '',
    };
    if (t.inputSchema !== undefined) descriptor.inputSchema = t.inputSchema;
    return descriptor;
  };
  const normalizeToolList = (value: unknown): { name: string; description: string; inputSchema?: unknown }[] => {
    if (!Array.isArray(value)) return [];
    const tools: { name: string; description: string; inputSchema?: unknown }[] = [];
    for (const entry of value) {
      const normalized = normalizeTool(entry);
      if (normalized) tools.push(normalized);
    }
    return tools;
  };
  const normalizeOutput = (out: unknown): unknown => {
    // WebMCP executeTool returns a JSON string per the specification; parse
    // it when possible so the Agent receives structured data instead of text.
    if (typeof out === 'string') {
      try {
        return JSON.parse(out);
      } catch {
        return { raw: out };
      }
    }
    return out;
  };
  const errorText = (error: unknown): string => {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  let url = '';
  try {
    const g = globalThis as Record<string, unknown>;
    const location = g.location as { href?: unknown } | undefined;
    if (typeof location === 'object' && location !== null && typeof location.href === 'string') url = location.href;
  } catch { /* worker-style context without location */ }

  let api: unknown;
  try {
    const g = globalThis as Record<string, unknown>;
    const navigator = g.navigator as Record<string, unknown> | undefined;
    api = typeof navigator === 'object' && navigator !== null ? navigator.modelContextTesting : undefined;
  } catch { api = undefined; }
  if (typeof api !== 'object' || api === null) return { status: 'unavailable', url };
  const candidate = api as Record<string, unknown>;
  if (typeof candidate.listTools !== 'function' || typeof candidate.executeTool !== 'function') {
    return { status: 'unavailable', url };
  }

  let tools: { name: string; description: string; inputSchema?: unknown }[] = [];
  try {
    tools = normalizeToolList(await (candidate.listTools as () => Promise<unknown>)());
  } catch (error) {
    // Cannot even enumerate tools; treat like a page without WebMCP.
    void error;
    return { status: 'unavailable', url };
  }
  if (!tools.some((tool) => tool.name === name)) {
    return { status: 'tool_not_found', toolsAfter: tools, url };
  }

  let out: unknown;
  try {
    out = await (candidate.executeTool as (toolName: string, inputText: string) => Promise<unknown>)(name, JSON.stringify(input));
  } catch (error) {
    return { status: 'failed', error: errorText(error), toolsAfter: tools, url };
  }

  // Re-list after execution so the Agent sees the page's new tool state. A
  // failure here usually means navigation or context teardown, which is not
  // a failure of the tool call itself.
  let toolsAfter: { name: string; description: string; inputSchema?: unknown }[] | null = null;
  try {
    toolsAfter = normalizeToolList(await (candidate.listTools as () => Promise<unknown>)());
  } catch {
    toolsAfter = null;
  }

  return { status: 'completed', result: normalizeOutput(out), toolsAfter, url };
}
