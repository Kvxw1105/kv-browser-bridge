# Windows installation and diagnostics

Build the local Chrome path, load `apps/extension/dist` as an unpacked extension, then copy the displayed extension ID.

```powershell
npm install
npm run build:local-chrome
node apps/chrome-bridge/dist/install.js install <extension-id>
```

The installer accepts only a Chrome extension ID and writes the Kv Native Messaging manifest under the current user's Chrome data directory. It registers only `io.kv.browser_bridge` in `HKCU\Software\Google\Chrome\NativeMessagingHosts`. The manifest and its wrapper are written atomically, checked against the registry value, and are restored if registration or verification fails. Existing non-Kv artifacts are never overwritten.

Reload the extension (or restart Chrome) after a successful install.

## Doctor

`doctor` is read-only. It does not create or modify the Chrome profile, registry, discovery configuration, logs, manifest, or wrapper.

```powershell
npm run doctor-local-chrome
# Equivalent JSON output for scripts:
node apps/chrome-bridge/dist/install.js doctor --json
```

It checks the Node runtime and bridge path, Native Messaging manifest schema/path/origin, current-user registry registration, discovery config, log-directory writability, and reports Named Pipe status on a best-effort basis. Required failures produce a nonzero exit code.

If a check fails, rebuild with `npm run build:local-chrome`, re-run installation with the exact unpacked extension ID, then reload the extension. Do not delete or replace an artifact the installer identifies as non-Kv-owned.

## Uninstall

```powershell
npm run uninstall-local-chrome
```

Uninstall removes only an exact Kv manifest, the Kv-owned wrapper, and a current-user registry value that points to that exact manifest. It leaves foreign and legacy Native Messaging registrations untouched.
