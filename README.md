# Kv Browser Bridge

Kv Browser Bridge gives an MCP client controlled access to the Chrome already running for the current Windows user. It uses a Chrome extension, a local Native Messaging bridge, and a standalone stdio MCP server. It does not launch Playwright, start a second Chrome process, copy a profile, or act as a cloud browser service.

Kv Browser Bridge is an MIT derivative of Claude Code Browser. See [NOTICE](NOTICE) for upstream attribution; the original root [LICENSE](LICENSE) is unchanged.

## Supported environment

- Windows (the installer registers a Chrome Native Messaging host under HKCU)
- Google Chrome with unpacked-extension developer mode available
- Node.js and npm
- Codex or another MCP client that can start a stdio server

The extension controls only the Chrome instance running as the same Windows user. The bridge and MCP server communicate over a per-process Windows Named Pipe.

## Architecture

```text
Chrome extension --Native Messaging--> Kv host --Named Pipe + bearer token--> Kv MCP server --stdio--> MCP client
       |                                  |
       +-- chrome.debugger on current Chrome +-- local discovery/config and JSONL logs
```

The extension's `chrome.debugger` access enables browser operations such as navigation, snapshots, screenshots, and element interaction. The Kv host writes local discovery metadata containing a random bearer token; only a client with that token can connect to its Named Pipe.

## Install from source

```powershell
npm install
npm run build:local-chrome
```

Then load `apps/extension/dist` from `chrome://extensions` using **Load unpacked**. Copy its extension ID and register the host with that exact ID:

```powershell
node apps/chrome-bridge/dist/install.js install <extension-id>
```

The extension ID is required: Chrome Native Messaging manifests allow only the extension origin that was registered. Reload the extension (or restart Chrome) after registration.

To remove the registration:

```powershell
npm run uninstall-local-chrome
```

To inspect the local installation without changing Chrome, the registry, or discovery configuration:

```powershell
npm run doctor-local-chrome
# or: node apps/chrome-bridge/dist/install.js doctor --json
```

The command exits nonzero when a required check fails and emits structured JSON for automation. See [Windows installation diagnostics](docs/release/windows-install.md) for the checks and repair steps.

## MCP configuration examples

Build before configuring a client. The MCP server is stdio-only; it connects to the locally running Kv host using discovery metadata in `%LOCALAPPDATA%\KvBrowserBridge\bridge.json`.

Codex configuration example:

```powershell
codex mcp add kv-browser-bridge -- node C:\path\to\kv-browser-bridge\apps\codex-mcp-server\dist\server.js
```

Generic MCP client or Claude Code configuration example:

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

See the [MCP client compatibility matrix](docs/compatibility.md) for the supported configuration scopes and WorkBuddy's conditional status.

## Security boundaries

- Chrome shows its debugging indicator when the `debugger` permission is active.
- Native Messaging is bound to the explicitly registered extension ID.
- The Kv host accepts local Named Pipe connections authenticated by its generated bearer token.
- Optional bookmark, download-status, and extension-inventory permissions are requested only from the extension UI. Extension inventory is read-only.
- Screenshot files are created only when an MCP request specifies an artifact path. Browser actions can still affect the currently selected tab, so use the bridge only with clients and prompts you trust.

## What Kv Browser Bridge does not do

- It does not provide a hosted/cloud service, telemetry service, or account.
- It does not automatically export Chrome cookies or Chrome profile data. The
  extension uses `chrome.storage.local` for its own settings and UI state, and a
  caller-provided `browser_evaluate` expression can read data available in the
  selected page context; use that tool only with trusted clients and prompts.
- It does not start another browser, clone a profile, or use Playwright.
- It does not make the inactive legacy product path part of the Kv runtime.

## Development and checks

```powershell
npm run test:branding
npm run test:local-chrome
npm run build:local-chrome
npm run check:local-chrome
```

## Legacy directories

`apps/host`, `apps/server`, `apps/desktop`, `packages/agent-core`, and `skills` are retained legacy code from the prior product. They are not part of the Kv Browser Bridge path. The active Kv path is `apps/extension`, `apps/chrome-bridge`, `apps/codex-mcp-server`, and `packages/browser-protocol`.
