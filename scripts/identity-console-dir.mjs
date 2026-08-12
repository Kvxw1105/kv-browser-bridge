// Desktop identity-console directory resolution (pure, unit-testable).
// The desktop console shares one identity world with the CLI runtime:
// manifests live under %LOCALAPPDATA%\KvBrowserBridge\identity-console.
// KV_BROWSER_IDENTITY_HOME overrides the location for development.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveIdentityConsoleDir(
  env = process.env,
  _cwd = process.cwd(),
  defaultDir = join(env.LOCALAPPDATA || join(env.USERPROFILE || '', 'AppData', 'Local'), 'KvBrowserBridge', 'identity-console'),
) {
  const configured = env['KV_BROWSER_IDENTITY_HOME']?.trim();
  if (configured) return resolve(configured);
  return defaultDir;
}

/** Migrate manifests written by older desktop builds into the unified location. */
export function migrateLegacyConsoleDir(
  localDir,
  userDataDir,
  fs = { existsSync, mkdirSync, copyFileSync },
) {
  const legacy = join(userDataDir, 'identity-console');
  if (resolve(legacy) === resolve(localDir)) return false;
  const legacyStore = join(legacy, 'identity-console.manifests.json');
  const targetStore = join(localDir, 'identity-console.manifests.json');
  if (!fs.existsSync(legacyStore) || fs.existsSync(targetStore)) return false;
  fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(legacyStore, targetStore);
  return true;
}
