import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChromeCdpTransportLike } from './chrome-cdp-transport.js';

export interface ManagedExtensionProvisionResult {
  ok: boolean;
  extensionId?: string;
  path: string;
  installed: boolean;
  enabled: boolean;
  activationTargetId?: string;
  error?: { code: string; message: string };
}

export async function provisionManagedExtension(
  transport: ChromeCdpTransportLike,
  extensionPath: string,
): Promise<ManagedExtensionProvisionResult> {
  const path = resolve(extensionPath);
  const manifestPath = join(path, 'manifest.json');
  if (!existsSync(path)) return failure(path, 'EXTENSION_DIST_MISSING', 'Extension dist directory does not exist.');
  if (!existsSync(manifestPath)) return failure(path, 'EXTENSION_MANIFEST_MISSING', 'Extension manifest.json does not exist.');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { background?: { service_worker?: string }; content_scripts?: Array<{ js?: string[]; css?: string[] }> };
    const required = [manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap((item) => [...(item.js ?? []), ...(item.css ?? [])])].filter((value): value is string => Boolean(value));
    const missing = required.find((file) => !existsSync(join(path, file)));
    if (missing) return failure(path, 'EXTENSION_DIST_MISSING', `Extension dist is missing ${missing}.`);
    const beforeLoad = await transport.request<{ extensions?: Array<{ id?: string; path?: string }> }>('Extensions.getExtensions');
    const previous = (beforeLoad.extensions ?? []).find((item) => normalize(item.path) === normalize(path));
    if (previous?.id) {
      try {
        await transport.request('Extensions.uninstall', { id: previous.id });
      } catch (error) {
        return failure(path, 'EXTENSION_RELOAD_FAILED', error instanceof Error ? error.message : String(error));
      }
    }
    const loaded = await transport.request<{ id?: string; extensionId?: string }>('Extensions.loadUnpacked', { path });
    const extensionId = loaded.id ?? loaded.extensionId;
    const listed = await transport.request<{ extensions?: Array<{ id?: string; path?: string; enabled?: boolean }> }>('Extensions.getExtensions');
    const extension = (listed.extensions ?? []).find((item) => item.id === extensionId || normalize(item.path) === normalize(path));
    if (!extension) return { ok: false, extensionId, path, installed: false, enabled: false, error: { code: 'EXTENSION_NOT_LISTED', message: 'Extensions.getExtensions did not list the loaded extension.' } };
    if (extension.enabled !== true) return { ok: false, extensionId: extension.id, path, installed: true, enabled: false, error: { code: 'EXTENSION_DISABLED', message: 'The managed extension is listed but disabled.' } };
    // Chrome creates a service-worker target for a dynamically loaded unpacked
    // extension, but does not dispatch its startup event until the extension
    // is activated. Opening a real extension page provides that activation
    // without relying on the deprecated --load-extension flag.
    let activated: { targetId?: string };
    try {
      activated = await transport.request<{ targetId?: string }>('Target.createTarget', { url: `chrome-extension://${extension.id}/sidepanel.html` });
    } catch (error) {
      return { ok: false, extensionId: extension.id, path, installed: true, enabled: true, error: { code: 'EXTENSION_ACTIVATION_FAILED', message: error instanceof Error ? error.message : String(error) } };
    }
    if (!activated.targetId) return { ok: false, extensionId: extension.id, path, installed: true, enabled: true, error: { code: 'EXTENSION_ACTIVATION_FAILED', message: 'Chrome did not return a target ID while activating the managed extension.' } };
    return { ok: true, extensionId: extension.id, path, installed: true, enabled: true, activationTargetId: activated.targetId };
  } catch (error) {
    return failure(path, 'EXTENSION_LOAD_FAILED', error instanceof Error ? error.message : String(error));
  }
}

function failure(path: string, code: string, message: string): ManagedExtensionProvisionResult {
  return { ok: false, path, installed: false, enabled: false, error: { code, message } };
}

function normalize(value: string | undefined): string | undefined { return value ? value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() : undefined; }
