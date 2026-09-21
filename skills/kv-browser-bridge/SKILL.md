---
name: kv-browser-bridge
description: "Use Kv Browser Bridge for tasks involving the user's current Google Chrome: reading tabs, inspecting pages, web research in logged-in sessions, UI interaction, screenshots, file upload, browser diagnostics, or webpage validation. If the Bridge is not configured, follow the repository's AGENT_INSTALL.md before using another browser backend."
---

# Kv Browser Bridge

Use the user's existing Chrome through the local stdio MCP server and the Kv
Native Messaging bridge. The Bridge does not launch a replacement browser,
copy a profile, export credentials, or act as a cloud browser.

## Capability and connection preflight

- During setup, after an upgrade, or when the available tool surface is unclear,
  call `browser_capabilities`. It returns the non-sensitive runtime contract.
- For a browser task, call `browser_get_tabs` first. It is the practical
  connection test. If it fails, call `browser_connection_status` and report the
  exact unavailable layer.
- Never start Playwright, openchrome, a remote-debugging Chrome, or a second
  profile as a fallback while Kv Bridge is available.
- If the MCP tools are missing, stop and follow the versioned `AGENT_INSTALL.md`.
  Do not claim that a Skill file alone installed the runtime.

## Task and tab scope

1. Define the observable success condition from the user's request.
2. Use an explicit `tabId` for every write or tab-targeted action. Do not rely
   on the currently selected tab when a target can be named.
3. When a task needs a new tab, use `browser_new_tab` with a concise
   `groupTitle` derived from the task. Reuse the same title for the same task.
   Do not put passwords, tokens, full URLs, or other secrets in a group title.
4. Reuse known tab IDs. Do not repeatedly enumerate tabs unless browser state
   may have changed.
5. Do not close tabs unless the user explicitly asks, or the user explicitly
   authorized cleanup of tabs created by this task.

Identity-bound sessions are part of the product boundary. Before identity-
sensitive work, use `browser_identity_sessions` and select the exact
`identityId`. Never mix `identityId`, Chrome Profile, proxy/IP evidence, or
`runtimeSessionId` across sessions.

## Observe before interacting

- Prefer targeted reads: `browser_get_url`, `browser_find`, and bounded
  `browser_get_text` before `browser_snapshot`.
- Use `browser_snapshot` when structure, roles, or fresh actionable references
  are needed. The snapshot uses the local VOM (structured observation) format
  when available; treat returned refs as observation-scoped.
- After navigation or a meaningful DOM change, observe again. Never reuse a ref
  from an earlier observation, tab, identity, or runtime session.
- Use `browser_screenshot` for visual evidence or visual-only content. Do not
  infer Canvas controls from nearby text; if visual information matters, take
  and inspect the screenshot.
- If `browser_list_webmcp_tools` reports matching page tools, prefer
  `browser_execute_webmcp_tool`. Re-list after navigation or execution.

## Interaction rules

- Locate the target with a fresh ref, CSS selector, or XPath. Prefer refs from
  the latest snapshot where the operation supports them.
- After navigation, clicking, typing, selecting, pressing a key, or uploading,
  verify the resulting state with `browser_wait_for`, `browser_get_text`, URL,
  snapshot, or screenshot before reporting success.
- `browser_evaluate` is a last-resort read-oriented diagnostic. Do not use page
  JavaScript to bypass the Bridge's publish blocker or to simulate a protected
  action.
- `browser_set_files` requires absolute paths inside the content package root,
  manifest membership, SHA-256 evidence, and the platform adapter limit. It is
  an upload transaction, not a desktop file-picker operation.
- A successful file dispatch is not proof that the site accepted the file;
  observe the attachment or preview.

## Effects, retries, and human steps

The Bridge classifies operations by effect. Passive reads may be retried after
a timeout. Any input, navigation, upload, WebMCP execution, or other write may
have happened before a timeout or disconnect:

- Treat `UNKNOWN_OUTCOME` / `unknown_outcome` as ambiguous.
- Never retry an ambiguous write automatically.
- Re-read the current page or connection state, then decide whether the user
  must intervene. Do not turn an unknown result into success.

For login, CAPTCHA, OTP, consent, payment confirmation, or other human-only
steps, stop at the handoff and ask the user to complete the step. After the
user confirms, observe again with fresh refs; do not repeat the action that may
already have been dispatched.

Final publish, payment, deletion, account-security, and other external commits
remain protected by the Bridge. Do not bypass the protection with JavaScript,
raw CDP, another browser backend, or a guessed selector.

## Multi-Agent coordination

- Always supply an explicit `tabId` for every write or tab-targeted action.
- For a multi-step write workflow, acquire an explicit lease before the first write and release it only after the workflow is verified. Never release another Agent's lease.
- Concurrent reads are allowed. Same-tab writes are serialized by the Bridge; different tabs can proceed in parallel.
- On `RESOURCE_BUSY`, wait with bounded backoff or choose another tab. Never spin in a tight retry loop.
- On `RESOURCE_QUARANTINED`, re-read and verify the tab state before retrying; an `UNKNOWN_OUTCOME` may have already changed the page.
- Only one Agent may own the recorder at a time. Stop or hand off recording explicitly before another Agent starts it.
- Use `browser_get_clients` and coordination status to diagnose ownership. Keep each MCP process's `KBB_CLIENT_ID` and `KBB_CLIENT_NAME` distinct.

## Efficient tool routing

| Need | Prefer |
| --- | --- |
| Connection and tabs | `browser_connection_status`, `browser_get_tabs`, `browser_get_url` |
| Page structure and text | `browser_find`, bounded `browser_get_text`, `browser_snapshot` |
| Visual evidence | `browser_screenshot` |
| Page-defined actions | `browser_list_webmcp_tools`, then `browser_execute_webmcp_tool` |
| Normal interaction | `browser_click`, `browser_type`, `browser_press`, `browser_select`, `browser_scroll` |
| Files | `browser_set_files`, then observe the resulting attachment/preview |
| Diagnostics | `browser_console_errors`, `browser_network_failures`, `browser_get_response_body`, `browser_inspect_element`, `browser_get_element_styles`, `browser_page_metrics` |

Keep reads bounded with `maxChars`, `limit`, and deliberate snapshot depth.
Response bodies and page content may contain sensitive data; request only the
smallest range needed.

## Multi-agent coordination

- Same-tab writes are serialized by the Bridge; concurrent reads are allowed.
- On `RESOURCE_BUSY`, wait with bounded backoff or choose another tab. Never
  spin in a tight retry loop.
- On `RESOURCE_QUARANTINED`, re-read the tab state before retrying. An earlier
  write may already have changed the page.
- Only one Agent may own a recorder at a time. Stop or hand off recording
  explicitly before another Agent starts it.
- Keep each MCP process's client identity distinct when the coordination layer
  exposes one.

## Privacy and evidence boundaries

Never read, export, print, or place in a prompt, screenshot, log, or group title:
cookies, tokens, passwords, OTPs, proxy credentials, Native Messaging bearer
tokens, or Named Pipe endpoints. The Skill does not grant authorization for
publishing or account actions.

Report the evidence level precisely:

- `EDITED`: files changed;
- `LOCALLY_VERIFIED`: commands/tests/builds passed;
- `SESSION_TOOL_VISIBLE`: MCP tools are visible to the current Agent;
- `LIVE_VERIFIED`: a real Chrome read or action was observed and verified;
- `NOT_VERIFIED`: remaining browser, account, network, upload, or publish paths.

Do not call a build, static manifest, or Skill installation an end-to-end
browser result. A live claim requires an actual Bridge call and observed state.
