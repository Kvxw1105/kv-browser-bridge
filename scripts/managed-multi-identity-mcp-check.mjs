import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const phase = process.env.MANAGED_E2E_PHASE ?? 'initial';
const alpha = process.env.MANAGED_E2E_ALPHA ?? 'managed-alpha-a';
const beta = process.env.MANAGED_E2E_BETA ?? 'managed-alpha-b';
const oldAlphaSession = process.env.MANAGED_E2E_OLD_ALPHA_SESSION;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['apps/codex-mcp-server/dist/server.js'],
  env: process.env,
  stderr: 'pipe',
});
const client = new Client({ name: 'managed-multi-identity-e2e', version: '1.0.0' });
await client.connect(transport);

function value(result) {
  if (result.isError) throw new Error(text(result));
  const item = result.content?.find((entry) => entry.type === 'text');
  if (!item) throw new Error('MCP tool returned no text content.');
  return JSON.parse(item.text);
}
function text(result) { return result.content?.map((entry) => entry.type === 'text' ? entry.text : '').join('') ?? ''; }
async function call(name, args = {}) { return value(await client.callTool({ name, arguments: args })); }
function assert(condition, message) { if (!condition) throw new Error(message); }

const report = { schemaVersion: 1, phase, identityIds: [alpha, beta], checks: [] };
const sessions = (await call('browser_identity_sessions')).sessions ?? [];
const sessionIds = new Map(sessions.map((session) => [session.identity.identityId, session.identity.runtimeSessionId]));
if (phase === 'after-stop') {
  assert(!sessionIds.has(alpha) && sessionIds.has(beta), 'MCP did not remove stopped A while preserving managed identity B.');
  report.checks.push({ name: 'mcp_lists_remaining_identity', ok: true, identities: [...sessionIds.keys()] });
} else {
  assert(sessionIds.has(alpha) && sessionIds.has(beta), 'MCP did not list both managed identities.');
  report.checks.push({ name: 'mcp_lists_both_identities', ok: true, identities: [...sessionIds.keys()] });
}

async function marker(identityId) {
  await call('browser_select_identity', { identityId });
  const markerUrl = `data:text/plain,${identityId}-marker`;
  await call('browser_new_tab', { url: markerUrl, activate: true });
  const deadline = Date.now() + 5_000;
  let tabs = [];
  do {
    tabs = await call('browser_get_tabs');
    if (tabs.some((tab) => String(tab.url ?? '').includes(`${identityId}-marker`))) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  assert(tabs.some((tab) => String(tab.url ?? '').includes(`${identityId}-marker`)), `Marker was not routed to ${identityId}.`);
  return tabs.map((tab) => String(tab.url ?? ''));
}

if (phase === 'initial') {
  const alphaTabs = await marker(alpha);
  const betaTabs = await marker(beta);
  const alphaAgain = await call('browser_select_identity', { identityId: alpha });
  assert(alphaAgain.selectedIdentity?.identityId === alpha, 'MCP selection did not return identity A.');
  const alphaRead = await call('browser_get_tabs');
  assert(alphaRead.every((tab) => !String(tab.url ?? '').includes(`${beta}-marker`)), 'Identity A exposed identity B marker.');
  report.checks.push({ name: 'identity_selection_routes_markers', ok: true, alphaTabs: alphaTabs.length, betaTabs: betaTabs.length });
} else if (phase === 'after-stop') {
  await call('browser_select_identity', { identityId: beta });
  const tabs = await call('browser_get_tabs');
  assert(Array.isArray(tabs), 'Identity B was not usable after stopping A.');
  report.checks.push({ name: 'stop_a_preserves_b', ok: true, betaTabs: tabs.length });
} else if (phase === 'after-restart') {
  assert(oldAlphaSession && sessionIds.get(alpha) !== oldAlphaSession, 'Identity A did not receive a new runtimeSessionId after restart.');
  await marker(alpha);
  report.checks.push({ name: 'restart_a_changes_session_and_routes', ok: true, oldRuntimeSessionId: oldAlphaSession, newRuntimeSessionId: sessionIds.get(alpha) });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await client.close();
