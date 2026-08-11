import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { provisionManagedExtension } from '../dist/identity/managed-extension-provisioner.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kv-extension-provision-'));
  mkdirSync(join(root, 'chunks'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, background: { service_worker: 'service-worker.js' }, content_scripts: [{ js: ['content-script.js'], css: ['element-picker.css'] }] }));
  for (const file of ['service-worker.js', 'content-script.js', 'element-picker.css']) writeFileSync(join(root, file), '');
  return root;
}

test('loads and verifies an unpacked extension through the CDP domain', async () => {
  const path = fixture();
  const calls = [];
  const result = await provisionManagedExtension({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'Extensions.loadUnpacked') return { id: 'abcdefghijklmnopabcdefghijklmnop' };
    if (method === 'Extensions.getExtensions') return { extensions: [{ id: 'abcdefghijklmnopabcdefghijklmnop', path, enabled: true }] };
    if (method === 'Target.createTarget') return { targetId: 'activation-target' };
    return {};
  } }, path);
  assert.equal(result.ok, true);
  // Already-listed enabled extensions are reused (no uninstall+reload) and
  // only activated; the fresh-path activation target is not reported.
  assert.deepEqual(calls.map((call) => call.method), ['Extensions.getExtensions', 'Target.createTarget']);
  assert.equal(result.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(result.activationTargetId, undefined);
});

test('loads a fresh extension when it is not listed yet', async () => {
  const path = fixture();
  const calls = [];
  const result = await provisionManagedExtension({ request: async (method) => {
    calls.push(method);
    if (method === 'Extensions.loadUnpacked') return { id: 'abcdefghijklmnopabcdefghijklmnop' };
    if (method === 'Extensions.getExtensions') return { extensions: [] };
    if (method === 'Target.createTarget') return { targetId: 'activation-target' };
    return {};
  } }, path);
  assert.equal(result.ok, true);
  // Fresh path: loadUnpacked is authoritative when getExtensions returns an
  // empty list (current Chrome versions do this); activation still runs.
  assert.deepEqual(calls, ['Extensions.getExtensions', 'Extensions.loadUnpacked', 'Extensions.getExtensions', 'Target.createTarget']);
  assert.equal(result.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(result.activationTargetId, 'activation-target');
});

test('reports missing manifest and disabled extension as structured errors', async () => {
  const missing = await provisionManagedExtension({ request: async () => ({}) }, join(tmpdir(), 'does-not-exist-kv-extension'));
  assert.equal(missing.error.code, 'EXTENSION_DIST_MISSING');
  const path = fixture();
  const disabled = await provisionManagedExtension({ request: async (method) => method === 'Extensions.loadUnpacked' ? { id: 'abcdefghijklmnopabcdefghijklmnop' } : { extensions: [{ id: 'abcdefghijklmnopabcdefghijklmnop', path, enabled: false }] } }, path);
  assert.equal(disabled.error.code, 'EXTENSION_DISABLED');
});
