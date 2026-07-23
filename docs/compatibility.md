# MCP client compatibility

Kv Browser Bridge exposes one local **stdio MCP** server after the extension and local bridge have been built and installed. The examples below configure only that client-to-server process; they do not install the Chrome extension or Native Messaging host.

## Codex

Codex can register the local stdio server directly:

```powershell
codex mcp add kv-browser-bridge -- node C:\path\to\kv-browser-bridge\apps\codex-mcp-server\dist\server.js
```

## Generic stdio MCP clients and Claude Code

For a client that accepts standard stdio MCP server definitions (including Claude Code when configured for a local stdio server), use its MCP-server configuration with this command and argument:

```json
{
  "mcpServers": {
    "kv-browser-bridge": {
      "command": "node",
      "args": ["C:\\path\\to\\kv-browser-bridge\\apps\\codex-mcp-server\\dist\\server.js"]
    }
  }
}
```

The exact configuration file name and placement are owned by the chosen client. Kv Browser Bridge does not require a cloud endpoint, browser automation daemon, or non-stdio transport.

## WorkBuddy

WorkBuddy compatibility is conditional: use the same configuration only if the installed WorkBuddy version supports starting a local stdio MCP server. This repository does not verify or claim WorkBuddy MCP support; consult WorkBuddy's own documentation before adding the server.
