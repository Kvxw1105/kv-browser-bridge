# Codex Local Chrome

This integration controls the Chrome instance already running under the current Windows user. It does not start Playwright, launch a second Chrome, copy a Chrome profile, or read and export browser storage.

## Build and install

Build the extension, Chrome Bridge, and independent Codex MCP server:

```powershell
npm run build:local-chrome
```

Load `apps/extension/dist` as an unpacked Chrome extension, then note its extension ID from `chrome://extensions`. Register the Native Messaging Bridge with that ID:

```powershell
node apps/chrome-bridge/dist/install.js install <extension-id>
```

Register the separate stdio MCP server with Codex:

```powershell
codex mcp add local-chrome -- node <absolute-path-to>\apps\codex-mcp-server\dist\server.js
```

The MCP process uses only its own stdin/stdout. The Chrome Bridge owns Native Messaging stdin/stdout and communicates with MCP over a per-process Windows Named Pipe. Discovery metadata and a short-lived random authentication token are written to `%LOCALAPPDATA%\CodexLocalChrome\bridge.json`; logs are JSONL files in `%LOCALAPPDATA%\CodexLocalChrome\logs`.

## First-phase safety

- Open the extension once in the Chrome tab you want to control, or call `browser_switch_tab` after `browser_get_tabs`.
- `browser_new_tab` creates a tab inside an existing Chrome window; it never starts a second Chrome process or profile.
- `browser_set_files` validates absolute paths and uses CDP `DOM.setFileInputFiles`; it never uses Windows file-picker coordinates.
- `browser_click` blocks controls whose accessible text looks like final Publish/Post/Submit controls. Do not bypass this policy with `browser_evaluate`.
- `browser_evaluate` is sent with CDP `throwOnSideEffect: true`; operations Chrome considers effectful are rejected.
- Request screenshots with an `artifactPath` to persist audit evidence, for example `D:\artifacts\run-1\before-publish.png`.

## Legacy code

`apps/host`, `packages/agent-core`, and `skills/browse` remain in the repository for the old Claude Code Browser product. They are not started or referenced by the Codex local-Chrome path. New browser capabilities live in `apps/extension/src/background/browser-executor.ts`, `apps/chrome-bridge`, and `apps/codex-mcp-server`.
