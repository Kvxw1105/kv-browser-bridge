# Third-Party Notices

This file records license-relevant reuse and interface references for the
Kv Browser Bridge codebase, in addition to the root `LICENSE` (MIT) and
`NOTICE`.

## WebMCP support (added 2026-08)

The WebMCP feature (`browser_list_webmcp_tools`,
`browser_execute_webmcp_tool`, `packages/browser-protocol/src/webmcp.ts`)
implements the public WebMCP browser API. No source code was copied from any
external project; the implementation was written from scratch against the
published interface semantics and observed runtime behavior.

### WebMCP specification (interface reference only)

- Project: Web Machine Learning working group — WebMCP (Model Context Protocol
  for the web) proposal.
- Source URL: https://github.com/webmachinelearning/webmcp
- License: the repository is documentation/specification material; no code was
  copied.
- Reference commit: latest public main at the time of implementation
  (2026-08-11).
- Modification: none — interface semantics used as-is
  (`navigator.modelContextTesting.listTools()` /
  `executeTool(name, JSON.stringify(input))`).

### Cloudflare WebMCP developer preview (test environment only)

- Source URL: https://developers.cloudflare.com/agents/guides/ (WebMCP
  developer preview documentation and demo pages)
- License: documentation reference only; no code was copied.
- Usage: Cloudflare is used exclusively as a test target for real Chrome
  integration verification. The Bridge depends only on the standard browser
  API and does not depend on Cloudflare accounts, Browser Run, or any
  Cloudflare service.

### Browser Use (design reference, no code copied)

- Project: browser-use/browser-use
- Source URL: https://github.com/browser-use/browser-use
- License: MIT
- Usage: reviewed its agent/browser action-and-result modeling for design
  ideas only. No source code from this project is included in this repository.
  Nothing to reproduce in this file.

### chrome-devtools-mcp (design reference, no code copied)

- Project: ChromeDevTools/chrome-devtools-mcp
- Source URL: https://github.com/ChromeDevTools/chrome-devtools-mcp
- License: Apache-2.0
- Usage: reviewed its CDP/page-execution interaction patterns as a reference
  for how the Bridge's existing `browser_evaluate` fits into the extension
  service worker. No source code from this project is included in this
  repository.

## Existing notices

The root `NOTICE` covers the Claude Code Browser baseline lineage (MIT,
Fineguide.AI / Corneliu Maftuleac) that portions of this codebase retain.
