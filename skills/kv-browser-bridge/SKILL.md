---
name: kv-browser-bridge
description: "Use Kv Browser Bridge as the preferred browser interface for tasks involving the user's current Google Chrome: reading existing tabs, web research in logged-in sessions, screenshots, UI inspection, form interaction, file upload, browser debugging, or webpage validation. Prefer it over Playwright, openchrome, remote-debugging browsers, and other browser bridges whenever the current Chrome is connected."
---

# Kv Browser Bridge

Use the user's existing Chrome through the local `local-chrome` MCP. It does not launch a browser, copy a profile, or export browser credentials.

## Connection

1. Call `browser_get_tabs` first. It is the practical connection test.
2. If it fails, call `browser_connection_status` and report the exact layer that is unavailable.
3. Do not start Playwright, openchrome, a remote-debugging Chrome, or a replacement profile as a fallback while Kv Bridge is available.
4. Do not close tabs unless the user explicitly asks and supplies the target intent.

## Low-token workflow

Prefer targeted reads over complete page dumps:

- Use `browser_get_url`, `browser_find`, and `browser_get_text` before `browser_snapshot`.
- Pass a bounded `maxChars` to text reads.
- Use `browser_snapshot` only for structure needed to make the next decision; request `mode` and `maxDepth` deliberately.
- Save screenshots with `artifactPath`; report the path and inspect the image only when visual information matters.
- Reuse a known `tabId`; do not repeatedly list all tabs unless the browser state may have changed.

## Network recovery

- When a page reports a network error, first activate the affected tab with `browser_switch_tab` and refresh it with `browser_press` (`Control+R`) or a same-URL navigation.
- Re-read the page state after the refresh before diagnosing DNS, proxy, TLS, or firewall causes. A prior failed connection or a background tab is not sufficient evidence of a current outage.
- If a browser action reuses an existing blank tab, activate that tab explicitly so the user can see the result.

## Interaction workflow

1. Identify the exact `tabId`, URL, and visible target.
2. Use `browser_find` or a scoped snapshot to obtain a selector/XPath.
3. For a state-changing action, supply the explicit `tabId`.
4. After navigation, upload, or a click, use `browser_wait_for`, `browser_get_text`, screenshot, or snapshot to verify the result.
5. Treat `UNKNOWN_OUTCOME` as ambiguous: do not retry a write automatically.

## Boundaries

- `browser_set_files` accepts absolute local paths and uses CDP file-input assignment; never use desktop file-picker coordinates.
- `browser_evaluate` is for read-oriented page inspection and may be rejected by Chrome when it detects side effects.
- Final publish/submit controls remain protected by the Bridge. Never attempt to bypass this through JavaScript.
- Optional bookmarks, downloads, and extension inventory are read-only capabilities and may require user-granted extension permissions.

## WebMCP routing

When a page exposes WebMCP tools (`navigator.modelContextTesting`), prefer them for page-specific work:

1. Call `browser_list_webmcp_tools` for the active `tabId`.
2. If `available: true`, use `browser_execute_webmcp_tool` for matching page tools instead of DOM/CDP simulation.
3. If `available: false`, or the needed capability has no matching WebMCP tool, continue with the normal `browser_find` / `browser_click` / `browser_type` flow. Never fall back to arbitrary `browser_evaluate` to bypass a missing tool.
4. Re-list tools after executing one — the page may change its tool set after navigation or state changes.
5. Treat `unknown_outcome` as ambiguous: never retry the tool call automatically. Re-list tools and re-decide.
6. WebMCP tools are page-defined: the Bridge only forwards the fixed `listTools`/`executeTool` templates and never evaluates caller-supplied JavaScript.

## Available tool groups

- Navigation: `browser_get_tabs`, `browser_new_tab`, `browser_switch_tab`, `browser_navigate`, `browser_scroll`, `browser_close_tab`.
- Page inspection: `browser_find`, `browser_snapshot`, `browser_screenshot`, `browser_get_text`, `browser_get_url`, `browser_wait_for`.
- Interaction: `browser_click`, `browser_type`, `browser_press`, `browser_select`, `browser_set_files`.
- Browser inventory: `browser_list_bookmarks`, `browser_open_bookmark`, `browser_download_status`, `browser_list_extensions`.
- WebMCP: `browser_list_webmcp_tools`, `browser_execute_webmcp_tool` (disabled with `KV_BROWSER_WEBMCP_DISABLED=1`).
- Diagnostics: `browser_connection_status`, `browser_evaluate`.
