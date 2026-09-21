import { BRIDGE_PROTOCOL_VERSION } from './version.js';

/**
 * Transport-neutral capability contract consumed by the MCP server and the
 * distributed Skill. Keep this list aligned with the public MCP tool surface;
 * it is intentionally free of identity, profile, proxy, or bearer-token data.
 */
export const BROWSER_BRIDGE_CAPABILITIES = {
  schemaVersion: 1,
  product: 'Kv Browser Bridge',
  skillName: 'kv-browser-bridge',
  transport: 'stdio-mcp',
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  browser: {
    mode: 'current-user-chrome',
    profileOwnership: 'user-owned',
    supportedBrowsers: ['Google Chrome'],
    launchesReplacementBrowser: false,
  },
  install: {
    entrypoint: 'AGENT_INSTALL.md',
    skillInstaller: 'node scripts/install-agent-skill.mjs',
    supportedHarnesses: ['codex', 'claude-code', 'custom-destination'],
  },
  firstUse: {
    readOnlyTools: ['browser_connection_status', 'browser_get_tabs', 'browser_snapshot'],
    requiresExplicitTabIdForWrites: true,
    successEvidence: ['mcp_tool_visible', 'bridge_ready', 'tabs_read', 'snapshot_read'],
  },
  toolGroups: {
    controlPlane: [
      'browser_identity_sessions',
      'browser_select_identity',
      'browser_selected_identity',
      'browser_clear_identity',
      'browser_get_tabs',
      'browser_new_tab',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_open_bookmark',
    ],
    observation: [
      'browser_find',
      'browser_snapshot',
      'browser_screenshot',
      'browser_wait_for',
      'browser_get_text',
      'browser_get_url',
      'browser_list_webmcp_tools',
    ],
    interaction: [
      'browser_scroll',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_select',
      'browser_evaluate',
      'browser_set_files',
      'browser_execute_webmcp_tool',
      'browser_navigate',
    ],
    diagnostics: [
      'browser_connection_status',
      'browser_download_status',
      'browser_list_bookmarks',
      'browser_list_extensions',
      'browser_console_logs',
      'browser_console_errors',
      'browser_network_requests',
      'browser_network_failures',
      'browser_get_response_body',
      'browser_inspect_element',
      'browser_get_element_styles',
      'browser_page_metrics',
    ],
    meta: ['browser_capabilities'],
  },
  semantics: {
    observationFormat: 'vom',
    references: 'observation-scoped',
    staleReferences: 'fail-closed',
    ambiguousWrites: 'UNKNOWN_OUTCOME-no-automatic-retry',
    webmcp: 'prefer-page-defined-tools-when-available',
    publishProtection: 'bridge-enforced',
  },
  safety: {
    neverExpose: ['cookies', 'tokens', 'passwords', 'otp', 'proxy-credentials', 'named-pipe-bearer-token'],
    protectedActions: ['external.publish', 'payment', 'delete', 'account-security'],
    uploadPolicy: ['absolute-path', 'package-root', 'manifest-entry', 'sha256', 'adapter-limit'],
  },
} as const;
