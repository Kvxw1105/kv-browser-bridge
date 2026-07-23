# Kv Browser Bridge for Codex

Kv Browser Bridge connects Codex to the Chrome already running for the current Windows user. The active path is the Kv extension, Kv host, and Kv MCP server; it neither starts Playwright nor launches another Chrome profile.

## Build and register

```powershell
npm run build:local-chrome
```

Load `apps/extension/dist` as an unpacked extension in `chrome://extensions`, then copy its ID. Register the Kv host for that exact extension ID:

```powershell
node apps/chrome-bridge/dist/install.js install <extension-id>
```

An extension ID is required because the Native Messaging manifest allows only the registered extension origin. Reload the extension or restart Chrome after registration.

Register the built Kv MCP server with Codex:

```powershell
codex mcp add kv-browser-bridge -- node <absolute-path-to>\apps\codex-mcp-server\dist\server.js
```

The MCP server uses stdio only. It discovers the Kv host via `%LOCALAPPDATA%\KvBrowserBridge\bridge.json` and connects using a per-process Windows Named Pipe plus a random bearer token. JSONL logs are stored under `%LOCALAPPDATA%\KvBrowserBridge\logs`.

## Safety notes

- Select a target tab in the extension, or use `browser_get_tabs` and `browser_switch_tab`.
- `browser_new_tab` opens a tab in an existing Chrome window; it never creates a separate Chrome process or profile.
- Optional bookmark, download-status, and extension-inventory permissions are requested from the extension UI. Extension inventory is read-only.
- `browser_set_files` requires absolute paths and uses CDP file-input support.
- `browser_click` blocks likely final Publish/Post/Submit controls. Do not use `browser_evaluate` to circumvent that safeguard.
- Supply an `artifactPath` with a screenshot request only when you intend to retain the resulting local image.

## Legacy code

`apps/host`, `apps/server`, `apps/desktop`, `packages/agent-core`, and `skills` remain legacy code and are not part of the Kv Browser Bridge path. New Kv browser capabilities live in `apps/extension/src/background/browser-executor.ts`, `apps/chrome-bridge`, and `apps/codex-mcp-server`.
