# Kv Browser Bridge — Agent Install Guide

You are an Agent configuring Kv Browser Bridge for the user. This guide
configures the Agent Skill and local MCP connection; it does not install a
browser extension, copy a Chrome profile, or expose browser credentials.

Done means all of these are true:

1. the intended Agent can discover `kv-browser-bridge`;
2. the local stdio MCP server is registered;
3. `node apps/chrome-bridge/dist/install.js doctor --json` has no required
   failure when a source checkout is being used;
4. `browser_capabilities`, `browser_connection_status`, and
   `browser_get_tabs` are visible/callable;
5. any page read uses an explicit user-approved tab and is reported as
   `LIVE_VERIFIED` only after the result is observed.

Do not claim completion from a copied `SKILL.md`, a static configuration file,
or an extension ID alone.

## 1. Choose the runtime source

Prefer an installed Kv Browser Bridge release that provides the MCP server.
When working from source, use the repository root that contains `package.json`,
`apps/extension`, `apps/chrome-bridge`, and `apps/codex-mcp-server`.

Do not guess a sibling checkout or overwrite another project. If the runtime
root is unknown, ask the user for that one path and continue with the rest of
the guide only after it is supplied.

The current source path supports Windows + Google Chrome. It intentionally uses
the user's existing Chrome identity and does not start a replacement browser.

## 2. Install the Skill into the intended Agent

From the runtime root:

```powershell
node scripts/install-agent-skill.mjs --list --json
node scripts/install-agent-skill.mjs --harness codex --json
```

For Claude Code use `--harness claude-code`. For another Agent, use the exact
Skill directory documented by that Agent:

```powershell
node scripts/install-agent-skill.mjs --destination <absolute-skill-directory> --json
```

The installer copies the canonical Skill and `capabilities.json`. It refuses to
replace a different existing Skill unless `--force` is explicitly supplied.
Preserve unrelated files in the destination. After installation, restart the
Agent or start a new Agent session so the Skill can be discovered.

## 3. Build and check a source runtime

Only run these commands when using a source checkout:

```powershell
npm ci
npm run build:local-chrome
node apps/chrome-bridge/dist/install.js doctor --json
```

If the extension is not already loaded, the user must load
`apps/extension/dist` at `chrome://extensions` and provide the exact extension
ID. Registering Native Messaging is then:

```powershell
node apps/chrome-bridge/dist/install.js install <extension-id>
```

Reload the extension after registration and run `doctor --json` again. Do not
read or export cookies, tokens, passwords, proxy credentials, or Native
Messaging bearer tokens while diagnosing the connection.

## 4. Register the stdio MCP server

Use the guarded entrypoint so identity and network checks remain active:

```powershell
codex mcp add kv-browser-bridge -- node <absolute-path-to>\apps\codex-mcp-server\dist\guarded-server.js
```

For a generic stdio MCP client, use:

```json
{
  "mcpServers": {
    "kv-browser-bridge": {
      "command": "node",
      "args": ["<absolute-path-to>\\apps\\codex-mcp-server\\dist\\guarded-server.js"]
    }
  }
}
```

The exact configuration file and restart action belong to the chosen Agent.
Do not invent a cloud endpoint or a second browser transport.

## 5. Verify the Agent-facing contract

After restarting or creating a new Agent session:

1. call `browser_capabilities` and confirm the returned `transport`, tool groups,
   first-use tools, and safety semantics;
2. call `browser_connection_status` and report the exact readiness state;
3. call `browser_get_tabs` with no write action;
4. only if the user identifies a non-sensitive target, call
   `browser_snapshot` with its explicit `tabId` and bounded output.

If the extension is not connected, report `NOT_VERIFIED` and the missing layer.
Do not substitute Playwright, raw CDP, a replacement profile, or an unrelated
browser bridge to make the check pass.

## 6. Report the result

Use this compact handoff:

```text
EDITED:
- <Skill/runtime files changed, if any>

LOCALLY_VERIFIED:
- <installer / build / doctor / MCP discovery evidence>

LIVE_VERIFIED:
- <browser tool call and observed result, or none>

NOT_VERIFIED:
- <extension, Chrome identity, account, network, upload, or publish path>

NEXT:
- <one next action>
```

Never report a publish, payment, deletion, account-security action, or unknown
write outcome as successful without explicit authorization and platform evidence.
