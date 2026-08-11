import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserActionFromTool,
  isBrowserToolName,
  operationClassFor,
  executeWebMcpToolInPage,
  listWebMcpToolsInPage,
} from '@kv-browser-bridge/browser-protocol';

/**
 * The WebMCP page templates read `globalThis.navigator` / `globalThis.location`
 * at call time, so Node tests can mock them exactly like a page would.
 */
function withGlobals(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return fn();
  } finally {
    for (const [key] of Object.entries(overrides)) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const TEST_URL = 'https://example.test/webmcp';

function webmcpApi({ tools, executeResult, executeError, listError, relistError }) {
  let listCalls = 0;
  return {
    modelContextTesting: {
      async listTools() {
        listCalls += 1;
        if (listError && listCalls === 1) throw listError;
        if (relistError && listCalls > 1) throw relistError;
        return tools;
      },
      async executeTool(name, input) {
        if (executeError) throw executeError;
        return executeResult;
      },
    },
  };
}

const sampleTools = [
  { name: 'search_hotels', description: 'Search hotels by destination', inputSchema: { type: 'object', properties: { destination: { type: 'string' } } } },
  { name: 'no_schema_tool', description: '' },
  { name: 42 },
  { description: 'missing name' },
];

test('protocol registry accepts the two WebMCP tool names', () => {
  assert.equal(isBrowserToolName('browser_list_webmcp_tools'), true);
  assert.equal(isBrowserToolName('browser_execute_webmcp_tool'), true);
  assert.equal(browserActionFromTool('browser_list_webmcp_tools'), 'list_webmcp_tools');
  assert.equal(browserActionFromTool('browser_execute_webmcp_tool'), 'execute_webmcp_tool');
  assert.equal(isBrowserToolName('browser_execute_webmcp_tool_evil'), false);
});

test('list is a read; execute is a write so an ambiguous timeout surfaces UNKNOWN_OUTCOME instead of retrying', () => {
  assert.equal(operationClassFor('list_webmcp_tools'), 'read');
  // bridge-reliability.test.mjs proves non_idempotent_write disconnects/timeouts
  // reject with UNKNOWN_OUTCOME (never retried) — the same policy covers
  // execute_webmcp_tool, whose page-side tool call may have side effects.
  assert.equal(operationClassFor('execute_webmcp_tool'), 'non_idempotent_write');
});

test('no WebMCP API: list returns available:false and execute returns unavailable, never an exception', async () => {
  await withGlobals({ navigator: {} }, async () => {
    const listed = await listWebMcpToolsInPage();
    assert.deepEqual(listed, { available: false, tools: [], url: '' });
    const executed = await executeWebMcpToolInPage('search_hotels', { q: 1 });
    assert.equal(executed.status, 'unavailable');
  });
});

test('no WebMCP API at all (navigator absent): same graceful fallback', async () => {
  await withGlobals({ navigator: undefined }, async () => {
    const listed = await listWebMcpToolsInPage();
    assert.equal(listed.available, false);
    assert.deepEqual(listed.tools, []);
    assert.equal((await executeWebMcpToolInPage('t', {})).status, 'unavailable');
  });
});

test('tool discovery returns available:true with normalized descriptors and the page URL', async () => {
  const globals = webmcpApi({ tools: sampleTools });
  await withGlobals({ navigator: globals, location: { href: TEST_URL } }, async () => {
    const result = await listWebMcpToolsInPage();
    assert.equal(result.available, true);
    assert.equal(result.url, TEST_URL);
    assert.equal(result.tools.length, 2); // invalid entries (non-string name / missing name) filtered out
    assert.equal(result.tools[0].name, 'search_hotels');
    assert.equal(result.tools[0].description, 'Search hotels by destination');
    assert.deepEqual(result.tools[0].inputSchema.properties.destination, { type: 'string' });
    assert.equal(result.tools[1].name, 'no_schema_tool');
    assert.equal(result.tools[1].inputSchema, undefined);
  });
});

test('listTools throwing is reported as unavailable (fall back to DOM/CDP), not a failure', async () => {
  const globals = webmcpApi({ tools: [], listError: new Error('boom') });
  await withGlobals({ navigator: globals, location: { href: TEST_URL } }, async () => {
    const result = await listWebMcpToolsInPage();
    assert.equal(result.available, false);
    assert.deepEqual(result.tools, []);
  });
});

test('successful execution: verifies the tool exists, returns structured result, and re-lists toolsAfter', async () => {
  const globals = webmcpApi({ tools: sampleTools, executeResult: JSON.stringify({ hotel: 'Grand', nights: 2 }) });
  let receivedInput = '';
  globals.modelContextTesting.executeTool = async (name, input) => {
    receivedInput = input;
    return JSON.stringify({ hotel: 'Grand', nights: 2 });
  };
  await withGlobals({ navigator: globals, location: { href: TEST_URL } }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', { destination: 'Paris', nights: 2 });
    assert.equal(result.status, 'completed');
    assert.equal(receivedInput, JSON.stringify({ destination: 'Paris', nights: 2 }));
    assert.deepEqual(result.result, { hotel: 'Grand', nights: 2 }); // JSON string parsed to structured data
    assert.equal(result.toolsAfter.length, 2); // re-listed after execution
    assert.equal(result.url, TEST_URL);
  });
});

test('non-JSON string output is preserved as { raw } instead of failing', async () => {
  const globals = webmcpApi({ tools: sampleTools, executeResult: 'plain text answer' });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', {});
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { raw: 'plain text answer' });
  });
});

test('object output passes through unchanged', async () => {
  const globals = webmcpApi({ tools: sampleTools, executeResult: { ok: true } });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', {});
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { ok: true });
  });
});

test('tool missing from the current list is tool_not_found with the fresh toolsAfter', async () => {
  const globals = webmcpApi({ tools: sampleTools });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('vanished_tool', {});
    assert.equal(result.status, 'tool_not_found');
    assert.equal(result.error, undefined);
    assert.equal(result.toolsAfter.length, 2);
  });
});

test('tool execution throwing is failed with the error message, not an exception', async () => {
  const globals = webmcpApi({ tools: sampleTools, executeError: new Error('tool rejected input') });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', { destination: 7 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'tool rejected input');
    assert.equal(result.toolsAfter.length, 2);
  });
});

test('re-list failing after execution (navigation/teardown) keeps completed with toolsAfter:null', async () => {
  const globals = webmcpApi({ tools: sampleTools, executeResult: '{"ok":true}', relistError: new Error('context destroyed') });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', {});
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.toolsAfter, null);
  });
});

test('execute with a listTools that throws is unavailable, never an exception', async () => {
  const globals = webmcpApi({ tools: sampleTools, listError: new Error('list failed') });
  await withGlobals({ navigator: globals }, async () => {
    const result = await executeWebMcpToolInPage('search_hotels', {});
    assert.equal(result.status, 'unavailable');
  });
});

test('unknown_outcome is the Bridge-layer contract: page-side template never retries', async () => {
  // The templates never retry and never throw for tool-side errors; ambiguous
  // outcomes (navigation, disconnect, timeout) are converted to
  // UNKNOWN_OUTCOME by the Bridge for this write-class action. Prove the
  // classification that drives that conversion.
  assert.equal(operationClassFor('execute_webmcp_tool'), 'non_idempotent_write');
  // And that an executing page function that never settles is simply awaited —
  // the caller (extension executor) relies on the Bridge deadline to surface
  // unknown_outcome rather than re-invoking the tool.
  const globals = {
    modelContextTesting: {
      async listTools() { return [{ name: 'slow' }]; },
      executeTool() { return new Promise(() => { /* never settles */ }); },
    },
  };
  await withGlobals({ navigator: globals }, async () => {
    const pending = executeWebMcpToolInPage('slow', {});
    const raced = await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending').then((v) => new Promise((r) => setTimeout(() => r(v), 20)))]);
    assert.equal(raced, 'pending'); // still pending — caller-side deadline decides unknown_outcome
  });
});
