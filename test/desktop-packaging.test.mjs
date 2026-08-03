import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

test('desktop workspace exposes pack and dist scripts', async () => {
  const pkg = await readJson('apps/desktop/package.json');
  assert.match(pkg.scripts.pack, /electron-builder --dir/);
  assert.match(pkg.scripts.dist, /electron-builder --win nsis/);
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder devDependency is missing');
});

test('desktop electron-builder configuration declares Windows target and product identity', async () => {
  const config = await readFile(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
  assert.match(config, /appId:\s*io\.kv\.browser-bridge\.desktop/);
  assert.match(config, /productName:\s*KV Browser Bridge/);
  assert.match(config, /target:\s*nsis/);
  assert.match(config, /- dist\/\*\*/);
});

test('root workspace exposes one-command desktop packaging entry points', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.scripts['pack:desktop'], 'npm run pack -w apps/desktop');
  assert.equal(pkg.scripts['dist:desktop'], 'npm run dist -w apps/desktop');
});
