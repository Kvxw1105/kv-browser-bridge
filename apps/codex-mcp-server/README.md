# Local Chrome Codex MCP Server

This is a standalone stdio MCP server. It never starts Chrome, Playwright, or a browser profile. It connects to a separately running Chrome Bridge through a local Windows named pipe.

Register a built server with Codex:

```powershell
codex mcp add local-chrome -- node C:\path\to\claude-code-browser\apps\codex-mcp-server\dist\server.js
```

By default the server reads `%LOCALAPPDATA%\CodexLocalChrome\bridge.json`:

```json
{
  "pipeName": "\\\\.\\pipe\\local-chrome-user-random",
  "token": "bridge-generated-secret"
}
```

Environment variables are useful for development or an alternate location:

- `LOCAL_CHROME_BRIDGE_CONFIG`: absolute path to the bridge config JSON.
- `LOCAL_CHROME_PIPE`: named pipe endpoint; overrides `pipeName`.
- `LOCAL_CHROME_TOKEN`: bridge token; overrides `token`.
- `LOCAL_CHROME_REQUEST_TIMEOUT_MS`: default per-tool timeout (30 seconds by default).

The bridge protocol is newline-delimited JSON-RPC-like messages:

```json
{"id":"uuid","method":"hello","params":{"token":"...","client":"codex-mcp-server","version":"0.1.0"}}
{"id":"uuid","method":"browser_snapshot","params":{"tabId":123}}
```

Responses use `{ "id", "result" }` or `{ "id", "error": { "code", "message", "retryable", "details" } }`.
