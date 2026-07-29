# MCP Client Compatibility

Kv Browser Bridge exposes one local **stdio MCP** server after the extension and local bridge have been built and installed. The examples below configure only that client-to-server process; they do not install the Chrome extension or Native Messaging host.

## Client identity and coordination

Every stdio MCP process should identify itself so the Bridge can show ownership and apply per-agent coordination. `KBB_CLIENT_ID` is a stable logical client id; `KBB_CLIENT_NAME` is the human-readable name; `KBB_CLIENT_INSTANCE` is optional and defaults to a process instance id. Do not put tokens, cookies, URLs, page content, or local paths in these values.

```json
{
  "mcpServers": {
    "kv-browser-bridge": {
      "command": "node",
      "args": ["C:\\path\\to\\apps\\codex-mcp-server\\dist\\server.js"],
      "env": {
        "KBB_CLIENT_ID": "agent-id",
        "KBB_CLIENT_NAME": "Agent Name"
      }
    }
  }
}
```

The Bridge coordination mode is intentionally omitted from normal client configuration. It is selected by the Bridge process (`KBB_COORDINATION_MODE=off|observe|enforce`) and defaults to `off` when unset. Use `observe` while validating telemetry, then `enforce` when shared-browser writes need conflict protection. Installer-generated wrappers do not set this variable unless an operator explicitly requests it.

Reads may run concurrently. A write must include an explicit `tabId`; multi-step writes should acquire a lease through the coordination tools and release only leases owned by that client. `RESOURCE_BUSY` means wait or choose another tab, with bounded backoff rather than a tight retry loop. `RESOURCE_QUARANTINED` requires re-reading the tab state before any retry. The recorder has one global owner. A disconnected client releases ordinary leases; unknown write outcomes keep the affected resource quarantined until its TTL expires or an operator verifies state.

## Codex

Codex can register the local stdio server directly:

```powershell
codex mcp add kv-browser-bridge -- node C:\path\to\kv-browser-bridge\apps\codex-mcp-server\dist\server.js
```

Set the same identity variables in Codex's MCP environment when more than one Agent uses the Bridge.

## Generic stdio MCP clients and Claude Code

For any client that accepts standard stdio MCP server definitions (including Claude Code when configured for a local stdio server), use the generic configuration above. The only client-specific part is where that client stores its MCP configuration.

Kv Browser Bridge does not require a cloud endpoint, browser automation daemon, or non-stdio transport.

## WorkBuddy

WorkBuddy and other Agent hosts can use the same generic stdio definition when their installed version supports local MCP servers. Give each process a distinct `KBB_CLIENT_ID` and `KBB_CLIENT_NAME`; do not share a process identity between simultaneous clients.
