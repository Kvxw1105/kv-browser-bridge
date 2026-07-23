export const KV_NATIVE_HOST_NAME = 'io.kv.browser_bridge';
export const LEGACY_NATIVE_HOST_NAME = 'com.claude_code_browser';

export type InstallerCommand =
  | { command: 'install'; extensionId: string }
  | { command: 'uninstall' };

export function validateExtensionId(extensionId: string): string {
  if (!/^[a-z]{32}$/.test(extensionId)) {
    throw new Error('Chrome extension ID must be 32 lowercase letters.');
  }
  return extensionId;
}

export function parseInstallerArgs(args: string[]): InstallerCommand {
  const [command = 'install', extensionId, ...extra] = args;
  if (extra.length > 0 || (command !== 'install' && command !== 'uninstall')) {
    throw new Error('Usage: kv-browser-bridge-install install <extension-id> | uninstall');
  }
  if (command === 'uninstall') {
    if (extensionId !== undefined) throw new Error('Usage: kv-browser-bridge-install install <extension-id> | uninstall');
    return { command };
  }
  if (extensionId === undefined) throw new Error('Chrome extension ID is required.');
  return { command, extensionId: validateExtensionId(extensionId) };
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
