import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersionConsistency } from './check-versions.mjs';
import {
  commandWrapper,
  computerUseRcRequiredFiles,
  controlPanelScript,
  installScript,
  readme,
  smokeScript,
  uninstallScript,
  verifyScript,
} from './computer-use-rc-templates.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseRoot = resolve(root, 'release');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.isFile() ? [full] : [];
  }));
  return nested.flat().sort();
}

async function copyRequired(source, destination) {
  if (!await exists(source)) {
    throw new Error(`Required RC input is missing: ${relative(root, source)}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function copyWorkspaceManifests(stage) {
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(groupDir, entry.name, 'package.json');
      if (!await exists(manifest)) continue;
      await copyRequired(manifest, join(stage, group, entry.name, 'package.json'));
    }
  }
}

async function writeChecksums(stage) {
  const lines = [];
  for (const file of await listFiles(stage)) {
    if (basename(file) === 'SHA256SUMS.txt') continue;
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    lines.push(`${digest}  ${relative(stage, file).split(sep).join('/')}`);
  }
  await writeFile(join(stage, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
}

export async function validateComputerUseRc(stage) {
  for (const path of computerUseRcRequiredFiles) {
    if (!await exists(join(stage, path))) {
      throw new Error(`RC validation failed; missing ${path}`);
    }
  }

  const checksumLines = (await readFile(join(stage, 'SHA256SUMS.txt'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  if (checksumLines.length < computerUseRcRequiredFiles.length) {
    throw new Error('RC checksum manifest is unexpectedly small.');
  }
  for (const line of checksumLines) {
    const separator = line.indexOf('  ');
    if (separator < 0) throw new Error(`Malformed checksum line: ${line}`);
    const expected = line.slice(0, separator);
    const path = line.slice(separator + 2);
    const target = join(stage, ...path.split('/'));
    const actual = createHash('sha256').update(await readFile(target)).digest('hex');
    if (actual !== expected) throw new Error(`RC checksum mismatch: ${path}`);
  }
  return { files: checksumLines.length };
}

export async function packageComputerUseRc() {
  const version = await assertVersionConsistency();
  const stage = join(releaseRoot, `kv-computer-use-runtime-rc-v${version}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await copyRequired(join(root, 'package.json'), join(stage, 'package.json'));
  await copyRequired(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
  await copyWorkspaceManifests(stage);
  await copyRequired(
    join(root, 'apps', 'codex-mcp-server', 'dist'),
    join(stage, 'apps', 'codex-mcp-server', 'dist'),
  );
  await copyRequired(
    join(root, 'apps', 'chrome-bridge', 'dist'),
    join(stage, 'apps', 'chrome-bridge', 'dist'),
  );
  await copyRequired(
    join(root, 'packages', 'browser-protocol', 'dist'),
    join(stage, 'packages', 'browser-protocol', 'dist'),
  );
  await copyRequired(
    join(root, 'apps', 'extension', 'dist'),
    join(stage, 'apps', 'extension', 'dist'),
  );
  await copyRequired(
    join(root, 'apps', 'windows-uia-driver', 'publish'),
    join(stage, 'apps', 'windows-uia-driver', 'publish'),
  );

  await writeFile(join(stage, 'VERIFY.ps1'), verifyScript(), 'utf8');
  await writeFile(join(stage, 'INSTALL.ps1'), installScript(), 'utf8');
  await writeFile(join(stage, 'UNINSTALL.ps1'), uninstallScript(), 'utf8');
  await writeFile(join(stage, 'SMOKE.ps1'), smokeScript(), 'utf8');
  await writeFile(join(stage, 'CONTROL_PANEL.ps1'), controlPanelScript(), 'utf8');
  await writeFile(join(stage, 'VERIFY.cmd'), commandWrapper('VERIFY.ps1'), 'utf8');
  await writeFile(join(stage, 'INSTALL.cmd'), commandWrapper('INSTALL.ps1'), 'utf8');
  await writeFile(join(stage, 'SMOKE.cmd'), commandWrapper('SMOKE.ps1'), 'utf8');
  await writeFile(join(stage, 'UNINSTALL.cmd'), commandWrapper('UNINSTALL.ps1'), 'utf8');
  await writeFile(
    join(stage, 'OPEN_CONTROL_PANEL.cmd'),
    commandWrapper('CONTROL_PANEL.ps1'),
    'utf8',
  );
  await writeFile(join(stage, 'README.md'), readme(version), 'utf8');
  await writeFile(join(stage, 'release-manifest.json'), `${JSON.stringify({
    name: 'kv-computer-use-runtime-alpha-rc',
    version,
    platform: 'windows-x64',
    node: '>=22',
    generatedAt: new Date().toISOString(),
    entrypoints: {
      controlPanel: 'OPEN_CONTROL_PANEL.cmd',
      install: 'INSTALL.cmd',
      smoke: 'SMOKE.cmd',
      verify: 'VERIFY.cmd',
      uninstall: 'UNINSTALL.cmd',
      extension: 'apps/extension/dist',
      status: 'apps/codex-mcp-server/dist/computer-status.js',
      doctor: 'apps/codex-mcp-server/dist/computer-doctor.js',
      logs: '%LOCALAPPDATA%\\KvBrowserBridge\\computer-use',
    },
    safety: {
      receipts: 'redacted-by-default',
      codexConfig: 'managed-block-with-backup',
      packageIntegrity: 'sha256-per-file',
      rawInput: false,
      arbitraryLaunch: false,
    },
  }, null, 2)}\n`, 'utf8');
  await writeChecksums(stage);
  const validation = await validateComputerUseRc(stage);
  return { stage, version, validation };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await packageComputerUseRc();
  console.log(`Created ${relative(root, result.stage)} (${result.validation.files} verified files)`);
}
