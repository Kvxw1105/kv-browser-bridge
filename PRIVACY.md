# Kv Browser Bridge Privacy

**Last updated:** July 23, 2026

Kv Browser Bridge is a local Windows integration between a Chrome extension, a Native Messaging host, and an MCP server. It does not include a Kv cloud service or claim to transmit data to one.

## What the extension can access

- `activeTab`, `tabs`, `scripting`, and host permissions let the extension work with the tab selected for browser automation, including page DOM and element details required by requested operations.
- `debugger` lets the extension use Chrome DevTools Protocol functions for navigation, snapshots, screenshots, page interaction, and guarded evaluation. Chrome displays its debugging notice when this is active.
- `storage` (`chrome.storage.local`) keeps the extension's own settings and UI
  state locally; it is not a copy of a Chrome profile.
- `nativeMessaging` connects the extension to the Kv host running on the same Windows user account.
- `bookmarks`, `downloads`, and `management` are optional permissions requested through the extension UI. They respectively support bookmark access, download-status access (without local paths or source URLs), and read-only extension inventory. They are not granted unless the user approves them.

## Local data flow

Chrome starts the Kv host through Native Messaging. The host and the separate stdio MCP server communicate through a Windows Named Pipe. The host publishes local discovery metadata and a random bearer token in `%LOCALAPPDATA%\KvBrowserBridge\bridge.json`; the token is needed to connect to that pipe. This design is intended for the current Windows user, not as a network-accessible service.

The host writes JSONL diagnostic logs under `%LOCALAPPDATA%\KvBrowserBridge\logs`. Screenshots are written only when an MCP request supplies an artifact path. The contents, retention, and access controls of requested screenshot destinations are chosen by the current user and their client workflow. Local logs and discovery files remain until removed by the user or the operating system's normal profile management; they are not automatically uploaded by Kv Browser Bridge.

## Cookies, profile data, and page context

Kv Browser Bridge does not automatically export Chrome cookies or Chrome profile
data. It does not copy a Chrome profile, launch a second browser, or use
Playwright. It does not include analytics, advertising, or a cloud collection
service.

`browser_evaluate` runs a caller-provided expression in the selected page's
context. Depending on that expression and the page, it can read data available
to page JavaScript, including page storage. Kv Browser Bridge does not claim to
prevent this; use only trusted MCP clients and prompts.

Browser automation and screenshots can necessarily expose content in the tabs a user directs an MCP client to control. Use only trusted MCP clients and prompts, and do not request screenshots or actions on sensitive pages unless that is your intent.

## Source and attribution

Kv Browser Bridge is an MIT derivative of Claude Code Browser. Upstream attribution is preserved in [NOTICE](NOTICE); the root [LICENSE](LICENSE) remains unchanged.
