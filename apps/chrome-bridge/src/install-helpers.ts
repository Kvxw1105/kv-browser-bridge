import { basename, isAbsolute } from 'node:path';

export const KV_NATIVE_HOST_NAME = 'io.kv.browser_bridge';
export const LEGACY_NATIVE_HOST_NAME = 'com.claude_code_browser';

export type InstallerCommand =
  | { command: 'install'; extensionId: string }
  | { command: 'repair'; extensionId: string }
  | { command: 'test-install'; extensionId: string }
  | { command: 'test-restore' }
  | { command: 'uninstall' }
  | { command: 'doctor'; json: boolean };

export type CoordinationMode = 'off' | 'observe' | 'enforce';

export function validateExtensionId(extensionId: string): string {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('Chrome extension ID must be 32 lowercase letters from a to p.');
  }
  return extensionId;
}

export function parseInstallerArgs(args: string[]): InstallerCommand {
  const [command = 'install', value, ...extra] = args;
  if (command === 'doctor') {
    if (extra.length > 0 || (value !== undefined && value !== '--json')) {
      throw new Error('Usage: kv-browser-bridge-install install <extension-id> | uninstall | doctor [--json]');
    }
    return { command, json: value === '--json' };
  }
  if (extra.length > 0 || (command !== 'install' && command !== 'repair' && command !== 'uninstall' && command !== 'test-install' && command !== 'test-restore')) {
    throw new Error('Usage: kv-browser-bridge-install install <extension-id> | repair <extension-id> | test-install <extension-id> | test-restore | uninstall | doctor [--json]');
  }
  if (command === 'uninstall' || command === 'test-restore') {
    if (value !== undefined) throw new Error('Usage: kv-browser-bridge-install install <extension-id> | uninstall | doctor [--json]');
    return { command };
  }
  if (value === undefined) throw new Error('Chrome extension ID is required.');
  return { command, extensionId: validateExtensionId(value) };
}

export function createNativeHostManifest(extensionId: string, wrapperPath: string): Record<string, unknown> {
  return {
    name: KV_NATIVE_HOST_NAME,
    description: 'Kv Browser Bridge',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${validateExtensionId(extensionId)}/`],
  };
}

export function validateBridgePath(bridgePath: string): string {
  if (!bridgePath || !isAbsolute(bridgePath) || !/\.js$/i.test(bridgePath)) throw new Error('Bridge path must be an absolute JavaScript file path.');
  return bridgePath;
}

export function createKvWrapper(
  bridgePath: string,
  nodePath: string,
  runtimeMode?: 'shadow',
  coordinationMode?: CoordinationMode,
): string {
  validateBridgePath(bridgePath);
  if (!nodePath) throw new Error('Node runtime path is required.');
  const runtime = runtimeMode ? `set "KBB_RUNTIME_MODE=${runtimeMode}"\r\n` : '';
  const coordination = coordinationMode ? `set "KBB_COORDINATION_MODE=${coordinationMode}"\r\n` : '';
  // Resolve the bridge relative to this wrapper. This keeps cmd.exe from
  // reparsing a repository path that may contain non-ASCII directory names.
  return `@echo off\r\nREM Kv Browser Bridge wrapper - managed by Kv\r\n${runtime}${coordination}"${nodePath}" "%~dp0${basename(bridgePath)}" %*\r\n`;
}

/**
 * Generate a user-facing repair launcher outside the source checkout. The
 * launcher keeps repair usable when an Agent is not started in the repository
 * and exposes no browser data or credentials.
 */
export function createRepairHelper(installerPath: string, nodePath: string): string {
  if (!isAbsolute(installerPath) || !/\.js$/i.test(installerPath)) throw new Error('Installer path must be an absolute JavaScript file path.');
  if (!nodePath || !isAbsolute(nodePath)) throw new Error('Node runtime path must be absolute.');
  return `@echo off\r\nREM Kv Browser Bridge repair helper - managed by Kv\r\n"${nodePath}" "${installerPath}" %*\r\n`;
}

export function isKvOwnedRepairHelper(contents: string): boolean {
  return contents.includes('REM Kv Browser Bridge repair helper - managed by Kv');
}

export function isKvOwnedWrapper(contents: string): boolean {
  return contents.includes('REM Kv Browser Bridge wrapper - managed by Kv');
}

export function isValidNativeHostManifest(value: unknown): value is {
  name: string; description: string; path: string; type: string; allowed_origins: string[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.name === KV_NATIVE_HOST_NAME
    && manifest.description === 'Kv Browser Bridge'
    && typeof manifest.path === 'string' && /\.cmd$/i.test(manifest.path)
    && manifest.type === 'stdio'
    && Array.isArray(manifest.allowed_origins)
    && manifest.allowed_origins.length === 1
    && typeof manifest.allowed_origins[0] === 'string'
    && /^chrome-extension:\/\/[a-p]{32}\/$/.test(manifest.allowed_origins[0]);
}

export function isKvOwnedManifest(value: unknown, expectedWrapperPath?: string): boolean {
  return isValidNativeHostManifest(value)
    && (expectedWrapperPath === undefined || value.path === expectedWrapperPath);
}
