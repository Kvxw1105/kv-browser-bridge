import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeterministicZip, validateExtensionDist } from '../scripts/package-extension.mjs';
import { assertVersionConsistency } from '../scripts/check-versions.mjs';

test('release package versions are consistent', async () => {
  assert.equal(await assertVersionConsistency(), '0.3.0');
});

test('extension archive generation is deterministic', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'chunks'));
  await writeFile(join(directory, 'b.txt'), 'beta');
  await writeFile(join(directory, 'chunks', 'a.txt'), 'alpha');
  assert.deepEqual(await createDeterministicZip(directory), await createDeterministicZip(directory));
});

test('extension dist validation rejects a missing required asset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-extension-dist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, background: { service_worker: 'service-worker.js' } }));
  await assert.rejects(validateExtensionDist(directory), /missing required file/);
});

test('extension dist validation rejects a missing content script asset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-extension-content-script-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const required = ['sidepanel.html', 'service-worker.js', 'content-script.js', 'element-picker.css', 'icon-16.png', 'icon-48.png', 'icon-128.png'];
  await Promise.all(required.map((file) => writeFile(join(directory, file), '')));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    background: { service_worker: 'service-worker.js' },
    icons: { 16: 'icon-16.png', 48: 'icon-48.png', 128: 'icon-128.png' },
    content_scripts: [{ js: ['content-script.js', 'missing-content-script.js'], css: ['element-picker.css'] }],
  }));
  await assert.rejects(validateExtensionDist(directory), /content_scripts\[0\]\.js.*missing-content-script\.js/);
});
