import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeterministicZip, validateExtensionDist } from '../scripts/package-extension.mjs';
import { assertVersionConsistency } from '../scripts/check-versions.mjs';

test('release package versions are consistent', async () => {
  assert.equal(await assertVersionConsistency(), '0.2.10');
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
