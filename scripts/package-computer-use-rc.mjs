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

function verifyScript() {
  return `param([switch]$Quiet)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\n$Manifest = Join-Path $Root 'SHA256SUMS.txt'\nif (-not (Test-Path $Manifest)) { throw \"Checksum manifest missing: $Manifest\" }\n$Checked = 0\nforeach ($Line in Get-Content -LiteralPath $Manifest) {\n  if ([string]::IsNullOrWhiteSpace($Line)) { continue }\n  $Parts = $Line -split '  ', 2\n  if ($Parts.Count -ne 2) { throw \"Malformed checksum entry: $Line\" }\n  $Expected = $Parts[0].Trim().ToLowerInvariant()\n  $Relative = $Parts[1].Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)\n  $Target = Join-Path $Root $Relative\n  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw \"Package file missing: $Relative\" }\n  $Actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()\n  if ($Actual -ne $Expected) { throw \"Checksum mismatch: $Relative\" }\n  $Checked += 1\n}\nif (-not $Quiet) { Write-Host \"Integrity verified: $Checked files.\" -ForegroundColor Green }\n`;
}

function installScript() {
  return `param([switch]$SkipChromeHost)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\n& (Join-Path $Root 'VERIFY.ps1') -Quiet\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }\nif (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }\n$NodeMajor = [int]((node -p \"process.versions.node.split('.')[0]\") | Out-String).Trim()\nif ($NodeMajor -lt 22) { throw \"Node.js 22 or newer is required. Found major version $NodeMajor.\" }\nWrite-Host 'Installing production dependencies...'\nnpm ci --omit=dev --ignore-scripts\n$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'\nif (-not (Test-Path $Driver)) { throw \"Windows UIA driver missing: $Driver\" }\n$env:KV_WINDOWS_UIA_DRIVER = $Driver\nif (-not $SkipChromeHost) {\n  Write-Host 'Installing Chrome Native Messaging host...'\n  node apps/chrome-bridge/dist/install.js install\n}\nWrite-Host 'Registering KV Computer Use with Codex...'\nnode apps/codex-mcp-server/dist/codex-install.js install\nWrite-Host 'Running diagnostics...'\nnode apps/codex-mcp-server/dist/computer-doctor.js --json\nWrite-Host 'Installation completed.' -ForegroundColor Green\nWrite-Host 'Open Chrome extensions and load apps/extension/dist as an unpacked extension if it is not already installed.'\n`;
}

function uninstallScript() {
  return `param([switch]$KeepChromeHost)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required to remove the Codex integration.' }\nnode apps/codex-mcp-server/dist/codex-install.js uninstall\nif (-not $KeepChromeHost) { node apps/chrome-bridge/dist/install.js uninstall }\nWrite-Host 'KV Computer Use integration removed. Existing Codex configuration backups were preserved.' -ForegroundColor Green\n`;
}

function smokeScript() {
  return `param([switch]$InstallCodex)\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\n& (Join-Path $Root 'VERIFY.ps1') -Quiet\n$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'\n$env:KV_WINDOWS_UIA_DRIVER = $Driver\nif ($InstallCodex) { node apps/codex-mcp-server/dist/codex-install.js install }\nnode apps/codex-mcp-server/dist/computer-doctor.js --json\nnode apps/codex-mcp-server/dist/codex-install.js status\n`;
}

function commandWrapper(script) {
  return `@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0${script}\"\r\nset EXIT_CODE=%ERRORLEVEL%\r\necho.\r\nif not \"%EXIT_CODE%\"==\"0\" echo Operation failed with exit code %EXIT_CODE%.\r\npause\r\nexit /b %EXIT_CODE%\r\n`;
}

function controlPanelScript() {
  return `param()\n$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\n$LogDir = Join-Path $env:LOCALAPPDATA 'KvBrowserBridge\\computer-use'\n\n$form = New-Object System.Windows.Forms.Form\n$form.Text = 'KV Computer Use Control Center'\n$form.StartPosition = 'CenterScreen'\n$form.Size = New-Object System.Drawing.Size(820, 600)\n$form.MinimumSize = New-Object System.Drawing.Size(760, 520)\n$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)\n\n$title = New-Object System.Windows.Forms.Label\n$title.Text = 'KV Computer Use Runtime'\n$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18)\n$title.AutoSize = $true\n$title.Location = New-Object System.Drawing.Point(24, 18)\n$form.Controls.Add($title)\n\n$subtitle = New-Object System.Windows.Forms.Label\n$subtitle.Text = 'Local Codex + Chrome + Windows UIA control center'\n$subtitle.ForeColor = [System.Drawing.Color]::DimGray\n$subtitle.AutoSize = $true\n$subtitle.Location = New-Object System.Drawing.Point(27, 56)\n$form.Controls.Add($subtitle)\n\n$status = New-Object System.Windows.Forms.Label\n$status.Text = 'Status: not checked'\n$status.AutoSize = $true\n$status.Location = New-Object System.Drawing.Point(27, 90)\n$form.Controls.Add($status)\n\n$output = New-Object System.Windows.Forms.TextBox\n$output.Multiline = $true\n$output.ReadOnly = $true\n$output.ScrollBars = 'Vertical'\n$output.WordWrap = $false\n$output.Anchor = 'Top,Bottom,Left,Right'\n$output.Location = New-Object System.Drawing.Point(24, 190)\n$output.Size = New-Object System.Drawing.Size(754, 350)\n$output.Font = New-Object System.Drawing.Font('Consolas', 9)\n$form.Controls.Add($output)\n\nfunction Append-Output([string]$Text) {\n  $output.AppendText($Text + [Environment]::NewLine)\n  $output.SelectionStart = $output.TextLength\n  $output.ScrollToCaret()\n  [System.Windows.Forms.Application]::DoEvents()\n}\n\nfunction Invoke-LocalScript([string]$Name, [string[]]$Arguments = @()) {\n  $Path = Join-Path $Root $Name\n  Append-Output \"--- $Name ---\"\n  try {\n    $Lines = & $Path @Arguments 2>&1\n    foreach ($Line in $Lines) { Append-Output ([string]$Line) }\n    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw \"Process exited with code $LASTEXITCODE\" }\n    Append-Output 'Completed.'\n    return $true\n  } catch {\n    Append-Output (\"ERROR: \" + $_.Exception.Message)\n    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'KV Computer Use', 'OK', 'Error') | Out-Null\n    return $false\n  }\n}\n\nfunction Refresh-Status {\n  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {\n    $status.Text = 'Status: Node.js is not installed'\n    $status.ForeColor = [System.Drawing.Color]::Firebrick\n    return\n  }\n  $Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'\n  $env:KV_WINDOWS_UIA_DRIVER = $Driver\n  try {\n    $Result = node apps/codex-mcp-server/dist/codex-install.js status | ConvertFrom-Json\n    if ($Result.installed) {\n      $status.Text = 'Status: Codex integration installed'\n      $status.ForeColor = [System.Drawing.Color]::ForestGreen\n    } else {\n      $status.Text = 'Status: Codex integration not installed'\n      $status.ForeColor = [System.Drawing.Color]::DarkOrange\n    }\n  } catch {\n    $status.Text = 'Status: check failed'\n    $status.ForeColor = [System.Drawing.Color]::Firebrick\n  }\n}\n\n$buttons = @(\n  @{ Text = 'Install / Repair'; X = 24; Action = { if (Invoke-LocalScript 'INSTALL.ps1') { Refresh-Status } } },\n  @{ Text = 'Run Diagnostics'; X = 170; Action = { Invoke-LocalScript 'SMOKE.ps1' | Out-Null } },\n  @{ Text = 'Verify Package'; X = 316; Action = { Invoke-LocalScript 'VERIFY.ps1' | Out-Null } },\n  @{ Text = 'Chrome Extensions'; X = 462; Action = { Start-Process 'chrome://extensions' } },\n  @{ Text = 'Open Logs'; X = 608; Action = { if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }; Start-Process explorer.exe $LogDir } }\n)\nforeach ($Spec in $buttons) {\n  $Button = New-Object System.Windows.Forms.Button\n  $Button.Text = $Spec.Text\n  $Button.Location = New-Object System.Drawing.Point($Spec.X, 125)\n  $Button.Size = New-Object System.Drawing.Size(132, 38)\n  $Button.Add_Click($Spec.Action)\n  $form.Controls.Add($Button)\n}\n\n$uninstall = New-Object System.Windows.Forms.Button\n$uninstall.Text = 'Uninstall'\n$uninstall.Anchor = 'Bottom,Right'\n$uninstall.Location = New-Object System.Drawing.Point(646, 548)\n$uninstall.Size = New-Object System.Drawing.Size(132, 34)\n$uninstall.Add_Click({\n  $Choice = [System.Windows.Forms.MessageBox]::Show('Remove the Codex integration and Chrome native host?', 'KV Computer Use', 'YesNo', 'Warning')\n  if ($Choice -eq 'Yes' -and (Invoke-LocalScript 'UNINSTALL.ps1')) { Refresh-Status }\n})\n$form.Controls.Add($uninstall)\n\n$form.Add_Shown({ Refresh-Status })\n[void]$form.ShowDialog()\n`;
}

function readme(version) {
  return `# KV Computer Use Runtime Alpha RC v${version}\n\nThis is a Windows test release candidate for local Codex-driven browser and desktop control. It includes a lightweight control center, integrity verification, rollback-aware Codex registration, the Chrome extension, and a self-contained Windows UIA driver. It is not yet a signed one-click installer.\n\n## Prerequisites\n\n- Windows 10/11 x64\n- Node.js 22 or newer\n- npm and internet access for the first dependency installation\n- Google Chrome\n- Codex CLI or another local MCP client\n\nThe Windows UIA driver is included as a self-contained executable; no separate .NET Runtime is required.\n\n## Recommended start\n\nDouble-click:\n\n- \`OPEN_CONTROL_PANEL.cmd\`\n\nThe control center provides Install / Repair, Diagnostics, Package Verification, Chrome Extensions, logs, and Uninstall.\n\n## Command-line route\n\n\`INSTALL.cmd\`, \`SMOKE.cmd\`, \`VERIFY.cmd\`, and \`UNINSTALL.cmd\` are double-clickable wrappers. The underlying PowerShell scripts remain available for advanced use.\n\nAfter installation, open chrome://extensions, enable Developer mode, choose Load unpacked, and select \`apps/extension/dist\`.\n\nThe installer only manages the marked KV Computer Use block in ~/.codex/config.toml and creates backups before changing an existing file. Receipts are redacted by default.\n`;
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
  const required = [
    'INSTALL.ps1', 'SMOKE.ps1', 'UNINSTALL.ps1', 'VERIFY.ps1', 'CONTROL_PANEL.ps1',
    'INSTALL.cmd', 'SMOKE.cmd', 'UNINSTALL.cmd', 'VERIFY.cmd', 'OPEN_CONTROL_PANEL.cmd',
    'README.md', 'release-manifest.json', 'SHA256SUMS.txt',
    'apps/codex-mcp-server/dist/computer-server.js',
    'apps/codex-mcp-server/dist/codex-install.js',
    'apps/codex-mcp-server/dist/computer-doctor.js',
    'apps/chrome-bridge/dist/install.js',
    'apps/extension/dist/manifest.json',
    'apps/windows-uia-driver/publish/kv-windows-uia-driver.exe',
  ];
  for (const path of required) {
    if (!await exists(join(stage, path))) throw new Error(`RC validation failed; missing ${path}`);
  }

  const checksumLines = (await readFile(join(stage, 'SHA256SUMS.txt'), 'utf8')).split(/\r?\n/).filter(Boolean);
  if (checksumLines.length < required.length) throw new Error('RC checksum manifest is unexpectedly small.');
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
  await copyRequired(join(root, 'apps', 'codex-mcp-server', 'dist'), join(stage, 'apps', 'codex-mcp-server', 'dist'));
  await copyRequired(join(root, 'apps', 'chrome-bridge', 'dist'), join(stage, 'apps', 'chrome-bridge', 'dist'));
  await copyRequired(join(root, 'packages', 'browser-protocol', 'dist'), join(stage, 'packages', 'browser-protocol', 'dist'));
  await copyRequired(join(root, 'apps', 'extension', 'dist'), join(stage, 'apps', 'extension', 'dist'));
  await copyRequired(join(root, 'apps', 'windows-uia-driver', 'publish'), join(stage, 'apps', 'windows-uia-driver', 'publish'));

  await writeFile(join(stage, 'VERIFY.ps1'), verifyScript(), 'utf8');
  await writeFile(join(stage, 'INSTALL.ps1'), installScript(), 'utf8');
  await writeFile(join(stage, 'UNINSTALL.ps1'), uninstallScript(), 'utf8');
  await writeFile(join(stage, 'SMOKE.ps1'), smokeScript(), 'utf8');
  await writeFile(join(stage, 'CONTROL_PANEL.ps1'), controlPanelScript(), 'utf8');
  await writeFile(join(stage, 'VERIFY.cmd'), commandWrapper('VERIFY.ps1'), 'utf8');
  await writeFile(join(stage, 'INSTALL.cmd'), commandWrapper('INSTALL.ps1'), 'utf8');
  await writeFile(join(stage, 'SMOKE.cmd'), commandWrapper('SMOKE.ps1'), 'utf8');
  await writeFile(join(stage, 'UNINSTALL.cmd'), commandWrapper('UNINSTALL.ps1'), 'utf8');
  await writeFile(join(stage, 'OPEN_CONTROL_PANEL.cmd'), commandWrapper('CONTROL_PANEL.ps1'), 'utf8');
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
