import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersionConsistency } from './check-versions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseRoot = resolve(root, 'release');

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
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
  if (!await exists(source)) throw new Error(`Required RC input is missing: ${relative(root, source)}`);
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

function installScript() {
  return `param([switch]$SkipChromeHost)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }\n$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()\nif ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required. Found major version $NodeMajor." }\nWrite-Host 'Installing production dependencies...'\nnpm ci --omit=dev --ignore-scripts\n$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'\nif (-not (Test-Path $Driver)) { throw "Windows UIA driver missing: $Driver" }\n$env:KV_WINDOWS_UIA_DRIVER = $Driver\nif (-not $SkipChromeHost) {\n  Write-Host 'Installing Chrome Native Messaging host...'\n  node apps/chrome-bridge/dist/install.js install\n}\nWrite-Host 'Registering KV Computer Use with Codex...'\nnode apps/codex-mcp-server/dist/codex-install.js install\nWrite-Host 'Running diagnostics...'\nnode apps/codex-mcp-server/dist/computer-doctor.js --json\nWrite-Host 'Installation completed. Load apps/extension/dist as an unpacked Chrome extension if it is not already installed.'\n`;
}

function uninstallScript() {
  return `param([switch]$KeepChromeHost)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\nnode apps/codex-mcp-server/dist/codex-install.js uninstall\nif (-not $KeepChromeHost) { node apps/chrome-bridge/dist/install.js uninstall }\nWrite-Host 'KV Computer Use integration removed. Existing Codex configuration backups were preserved.'\n`;
}

function smokeScript() {
  return `param([switch]$InstallCodex)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\n$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'\n$env:KV_WINDOWS_UIA_DRIVER = $Driver\nif ($InstallCodex) { node apps/codex-mcp-server/dist/codex-install.js install }\nnode apps/codex-mcp-server/dist/computer-doctor.js --json\nnode apps/codex-mcp-server/dist/codex-install.js status\n`;
}

function readme(version) {
  return `# KV Computer Use Runtime RC v${version}\n\nThis is a Windows test release candidate for local Codex-driven browser and desktop control. It is not yet a signed one-click installer.\n\n## Prerequisites\n\n- Windows 10/11 x64\n- Node.js 22 or newer\n- npm\n- Google Chrome\n- Codex CLI or another local MCP client\n\nThe Windows UIA driver is included as a published executable.\n\n## Install\n\nOpen PowerShell in this folder and run:\n\n\`\`\`powershell\nSet-ExecutionPolicy -Scope Process Bypass\n.\\INSTALL.ps1\n\`\`\`\n\nThen open chrome://extensions, enable Developer mode, choose Load unpacked, and select apps/extension/dist.\n\n## Verify\n\n\`\`\`powershell\n.\\SMOKE.ps1\n\`\`\`\n\n## Uninstall\n\n\`\`\`powershell\n.\\UNINSTALL.ps1\n\`\`\`\n\nThe installer only manages the marked KV Computer Use block in ~/.codex/config.toml and creates backups before changing an existing file. Receipts are redacted by default.\n`;
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

export async function packageComputerUseRc() {
  const version = await assertVersionConsistency();
  const stage = join(releaseRoot, `kv-computer-use-runtime-rc-v${version}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await copyRequired(join(root, 'package.json'), join(stage, 'package.json'));
  await copyRequired(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
  await copyWorkspaceManifests(stage);
  await copyRequired(join(root, 'apps', 'codex-mcp-server', 'dist'), join(stage, 'apps', 'codex-mcp-server', 'dist'));
  await copyRequired(join(root, 'apps', 'chrome-bridge', 'dist'), join(stage, 'apps', 'chrome-bridge', 'dist'));
  await copyRequired(join(root, 'packages', 'browser-protocol', 'dist'), join(stage, 'packages', 'browser-protocol', 'dist'));
  await copyRequired(join(root, 'apps', 'extension', 'dist'), join(stage, 'apps', 'extension', 'dist'));
  await copyRequired(join(root, 'apps', 'windows-uia-driver', 'publish'), join(stage, 'apps', 'windows-uia-driver', 'publish'));

  await writeFile(join(stage, 'INSTALL.ps1'), installScript(), 'utf8');
  await writeFile(join(stage, 'UNINSTALL.ps1'), uninstallScript(), 'utf8');
  await writeFile(join(stage, 'SMOKE.ps1'), smokeScript(), 'utf8');
  await writeFile(join(stage, 'README.md'), readme(version), 'utf8');
  await writeFile(join(stage, 'release-manifest.json'), `${JSON.stringify({
    name: 'kv-computer-use-runtime-rc',
    version,
    platform: 'windows-x64',
    node: '>=22',
    generatedAt: new Date().toISOString(),
    entrypoints: {
      install: 'INSTALL.ps1',
      smoke: 'SMOKE.ps1',
      uninstall: 'UNINSTALL.ps1',
      extension: 'apps/extension/dist',
    },
    safety: {
      receipts: 'redacted-by-default',
      codexConfig: 'managed-block-with-backup',
      rawInput: false,
      arbitraryLaunch: false,
    },
  }, null, 2)}\n`, 'utf8');
  await writeChecksums(stage);
  return { stage, version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await packageComputerUseRc();
  console.log(`Created ${relative(root, result.stage)}`);
}
