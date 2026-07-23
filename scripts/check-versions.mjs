import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['apps/extension/package.json', 'apps/chrome-bridge/package.json', 'apps/codex-mcp-server/package.json', 'packages/browser-protocol/package.json'];

export async function readReleaseVersions(baseDir = root) {
  const packages = await Promise.all(files.map(async (file) => ({ file, version: JSON.parse(await readFile(resolve(baseDir, file), 'utf8')).version })));
  const manifest = JSON.parse(await readFile(resolve(baseDir, 'apps/extension/manifest.json'), 'utf8'));
  return [...packages, { file: 'apps/extension/manifest.json', version: manifest.version }];
}

export async function assertVersionConsistency(baseDir = root) {
  const versions = await readReleaseVersions(baseDir);
  const expected = versions[0].version;
  const mismatches = versions.filter(({ version }) => version !== expected);
  if (mismatches.length) throw new Error(`Release versions must match ${expected}: ${mismatches.map(({ file, version }) => `${file}=${version}`).join(', ')}`);
  return expected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Release versions are consistent: ${await assertVersionConsistency()}`);
