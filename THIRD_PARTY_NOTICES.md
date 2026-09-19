# Third-Party Notices

This file records license-relevant reuse and interface references for the
Kv Browser Bridge codebase, in addition to the root LICENSE (MIT) and NOTICE.

## WebMCP support (added 2026-08)

The WebMCP feature (browser_list_webmcp_tools,
browser_execute_webmcp_tool, packages/browser-protocol/src/webmcp.ts)
implements the public WebMCP browser API. No source code was copied from any
external project; the implementation was written from scratch against the
published interface semantics and observed runtime behavior.

### WebMCP specification (interface reference only)

- Project: Web Machine Learning working group — WebMCP proposal.
- Source URL: https://github.com/webmachinelearning/webmcp
- License: repository documentation/specification material; no code copied.
- Reference commit: latest public main at implementation time (2026-08-11).
- Modification: none — interface semantics used as-is
  (navigator.modelContextTesting.listTools() /
  executeTool(name, JSON.stringify(input))).

### Cloudflare WebMCP developer preview (test environment only)

- Source URL: https://developers.cloudflare.com/agents/guides/
- License: documentation reference only; no code copied.
- Usage: Cloudflare is used exclusively as a test target for real Chrome
  integration verification. The Bridge depends only on the standard browser
  API and does not depend on Cloudflare accounts, Browser Run, or any
  Cloudflare service.

### Browser Use (design reference, no code copied)

- Project: browser-use/browser-use
- Source URL: https://github.com/browser-use/browser-use
- License: MIT
- Usage: reviewed its agent/browser action-and-result modeling for design ideas
  only. No source code from this project is included in this repository.

### chrome-devtools-mcp (design reference, no code copied)

- Project: ChromeDevTools/chrome-devtools-mcp
- Source URL: https://github.com/ChromeDevTools/chrome-devtools-mcp
- License: Apache-2.0
- Usage: reviewed its CDP/page-execution interaction patterns as a reference
  for how the Bridge browser_evaluate fits into the extension service worker.
  No source code from this project is included in this repository.

## BrowserSkill renderer and transaction safety integration (vendored, adapted)

- Project: Tencent/BrowserSkill
- Source URL: https://github.com/Tencent/BrowserSkill
- License: MIT
- Upstream commit: fa953dc6fcd868827b93164e3bea26198e691224
- Vendor record: vendor/browser-skill/SOURCE.json
- Copied/adapted paths (upstream layout):
  - packages/vom/src/index.ts, types.ts, layers.ts, render.ts — pure VOM
    rendering algorithm, vendored into packages/vom/src as
    @kv-browser-bridge/vom.
  - apps/extension/src/session-manager/ref-store.ts — ref identity and
    generation invalidation state machine, adapted to local identity/runtime
    session ownership in apps/extension/src/background/ref-store.ts.
  - apps/extension/src/tools/transfer-transaction.ts — bounded-wait time
    boundary helper; algorithm reused locally.
  - apps/extension/src/tools/file-input-transaction.ts — file-input upload
    transaction state machine, adapted in
    apps/extension/src/background/upload-transaction.ts with local
    chrome.debugger helpers, RefStore ownership, and content-package
    validation.
  - apps/extension/src/tools/file-drop-transaction.ts — vendored for
    reference; the local bridge currently uses the file-input path.
- Adaptation: relative imports were rewritten with .js extensions for the
  built ESM output, and the local VOM package targets ES2023. The VOM core and
  transaction state-machine algorithms are retained in spirit; local code adds
  effect classification, absolute-path/content-package/SHA-256 validation,
  adapter limits, and structured UNKNOWN_OUTCOME / STALE_REF /
  REF_SCOPE_MISMATCH failures.
- Explicitly not copied: credentials, browser profiles, cookies, transport,
  daemon, Native Messaging, Named Pipe, MCP, branding, or publish machinery.
  Local identity, credential, Native Messaging, Named Pipe, MCP, and publish
  boundaries remain governed by Kv Browser Bridge rules. Vendored files are
  provenance/reference material; compiled behavior is implemented under
  packages/vom and apps/extension/src/background/*.

## Existing notices

The root NOTICE covers the Claude Code Browser baseline lineage (MIT,
Fineguide.AI / Corneliu Maftuleac) that portions of this codebase retain.
