import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromeExtensionIdFromManifest } from './chrome-extension-id.mjs';

const repo = resolve('.');
const extensionPath = resolve(process.argv[2] ?? 'apps/extension/dist');
const installer = resolve('apps/chrome-bridge/dist/install.js');

if (!existsSync(installer)) {
  throw new Error('Chrome Bridge installer is missing: ' + installer);
}

const extensionId = chromeExtensionIdFromManifest(extensionPath);
const result = spawnSync(process.execPath, [installer, 'install', extensionId], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) process.exitCode = result.status ?? 1;
