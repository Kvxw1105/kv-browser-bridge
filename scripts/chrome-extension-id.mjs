import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Return the stable Chrome ID for an unpacked extension with a manifest key.
 * Chrome derives this ID from the DER-encoded public key, not the source path.
 */
export function chromeExtensionIdFromManifest(extensionPath) {
  const root = resolve(extensionPath);
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new Error('Extension manifest must contain a stable base64 public key: ' + manifestPath);
  }
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return id;
}
