# Windows installation and diagnostics

Build the local Chrome path, load `apps/extension/dist` as an unpacked extension, then copy the displayed extension ID.

```powershell
npm install
npm run build:local-chrome
node apps/chrome-bridge/dist/install.js install <extension-id>
```

The installer accepts only a Chrome extension ID and writes the Kv Native Messaging manifest under the current user's Chrome data directory. It registers only `io.kv.browser_bridge` in `HKCU\Software\Google\Chrome\NativeMessagingHosts`. The manifest and its wrapper are written atomically, checked against the registry value, and are restored if registration or verification fails. Existing non-Kv artifacts are never overwritten.

Reload the extension (or restart Chrome) after a successful install.

The installer also creates a standalone repair launcher at
`%LOCALAPPDATA%\KvBrowserBridge\bin\kv-browser-bridge-repair.cmd`. It is the
preferred entry point for any local terminal Agent; it does not require the
Agent to start in this repository. Use the extension's dynamically displayed
ID, not an ID copied from another Chrome installation:

```powershell
& "$env:LOCALAPPDATA\KvBrowserBridge\bin\kv-browser-bridge-repair.cmd" repair <current-extension-id>
& "$env:LOCALAPPDATA\KvBrowserBridge\bin\kv-browser-bridge-repair.cmd" doctor --json
```

The extension repair panel generates a self-contained prompt for Codex,
Claude Code, New Max, WorkBuddy, or another local Agent. It first uses this
helper and falls back to locating `apps/chrome-bridge/dist/install.js` only
when the helper is missing. The prompt never assumes a fixed extension ID or
prior conversation context.

## Doctor

`doctor` is read-only. It does not create or modify the Chrome profile, registry, discovery configuration, logs, manifest, or wrapper.

```powershell
npm run doctor-local-chrome
# Equivalent JSON output for scripts:
node apps/chrome-bridge/dist/install.js doctor --json
```

It checks the Node runtime and bridge path, the standalone repair helper,
Native Messaging manifest schema/path/origin, current-user registry
registration, discovery config, and log-directory writability. It reports
discovery metadata for the Named Pipe but does not currently open or probe Pipe
connectivity. Required failures produce a nonzero exit code.

If a check fails, rebuild with `npm run build:local-chrome`, re-run installation with the exact unpacked extension ID, then reload the extension. Do not delete or replace an artifact the installer identifies as non-Kv-owned.

## Uninstall

```powershell
npm run uninstall-local-chrome
```

Uninstall removes only an exact Kv manifest, the Kv-owned wrapper, and a current-user registry value that points to that exact manifest. It leaves foreign and legacy Native Messaging registrations untouched.
