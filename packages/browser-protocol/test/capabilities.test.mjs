import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const skillCapabilitiesPath = join(here, '../../../skills/kv-browser-bridge/capabilities.json');

test('capability contract describes the current local MCP runtime', () => {
  assert.ok(BROWSER_BRIDGE_CAPABILITIES, 'browser protocol must export the capability contract');
  assert.equal(BROWSER_BRIDGE_CAPABILITIES.protocolVersion, BRIDGE_PROTOCOL_VERSION);
  assert.equal(BROWSER_BRIDGE_CAPABILITIES.transport, 'stdio-mcp');
  assert.deepEqual(BROWSER_BRIDGE_CAPABILITIES.firstUse.readOnlyTools, [
    'browser_connection_status',
    'browser_get_tabs',
    'browser_snapshot',
  ]);
  assert.ok(BROWSER_BRIDGE_CAPABILITIES.toolGroups.observation.includes('browser_snapshot'));
  assert.ok(BROWSER_BRIDGE_CAPABILITIES.toolGroups.diagnostics.includes('browser_page_metrics'));
  assert.ok(BROWSER_BRIDGE_CAPABILITIES.safety.neverExpose.includes('cookies'));
});

test('installed Skill capability manifest exactly matches the protocol contract', () => {
  assert.ok(BROWSER_BRIDGE_CAPABILITIES, 'browser protocol must export the capability contract');
  const installedManifest = JSON.parse(readFileSync(skillCapabilitiesPath, 'utf8'));
  assert.deepEqual(installedManifest, BROWSER_BRIDGE_CAPABILITIES);
});
