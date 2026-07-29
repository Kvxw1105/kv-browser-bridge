import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  commandWrapper,
  computerUseRcRequiredFiles,
  controlPanelScript,
  installScript,
  smokeScript,
  uninstallScript,
} from '../scripts/computer-use-rc-templates.mjs';
import { validateComputerUseRc } from '../scripts/package-computer-use-rc.mjs';

test('RC required-file contract includes unified status and all Windows entrypoints', () => {
  const expected = [
    'apps/codex-mcp-server/dist/computer-status.js',
    'apps/codex-mcp-server/dist/computer-doctor.js',
    'apps/codex-mcp-server/dist/computer-server.js',
    'apps/codex-mcp-server/dist/codex-install.js',
    'apps/chrome-bridge/dist/install.js',
    'apps/extension/dist/manifest.json',
    'apps/windows-uia-driver/publish/kv-windows-uia-driver.exe',
    'CONTROL_PANEL.ps1',
    'OPEN_CONTROL_PANEL.cmd',
    'INSTALL.ps1',
    'INSTALL.cmd',
    'SMOKE.ps1',
    'SMOKE.cmd',
    'VERIFY.ps1',
    'VERIFY.cmd',
    'UNINSTALL.ps1',
    'UNINSTALL.cmd',
    'README.md',
    'release-manifest.json',
    'SHA256SUMS.txt',
  ];
  assert.deepEqual([...computerUseRcRequiredFiles].sort(), expected.sort());
});

test('RC validator consumes the shared required-file contract', async () => {
  const source = await readFile(
    new URL('../scripts/package-computer-use-rc.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /for \(const path of computerUseRcRequiredFiles\)/);
  assert.match(source, /computerUseRcRequiredFiles\.length/);

  const stage = await mkdtemp(join(tmpdir(), 'kv-computer-use-rc-test-'));
  try {
    const checksumTargets = [];
    for (const path of computerUseRcRequiredFiles) {
      if (path === 'SHA256SUMS.txt') continue;
      const target = join(stage, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', 'utf8');
      checksumTargets.push(path);
    }
    await writeFile(join(stage, 'extra-package-file.txt'), 'fixture', 'utf8');
    checksumTargets.push('extra-package-file.txt');
    const checksums = [];
    for (const path of checksumTargets) {
      const content = await readFile(join(stage, ...path.split('/')));
      checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${path}`);
    }
    await writeFile(join(stage, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');

    const result = await validateComputerUseRc(stage);
    assert.equal(result.files, checksumTargets.length);

    await unlink(join(stage, 'apps/codex-mcp-server/dist/computer-status.js'));
    await assert.rejects(
      validateComputerUseRc(stage),
      /missing apps\/codex-mcp-server\/dist\/computer-status\.js/,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('control center uses unified status and accepts valid JSON before judging exit code', () => {
  const script = controlPanelScript();
  assert.match(script, /computer-status\.js/);
  assert.doesNotMatch(script, /codex-install\.js status/);
  assert.match(script, /RedirectStandardOutput = \$true/);
  assert.match(script, /RedirectStandardError = \$true/);
  assert.match(script, /ExitCode = \[int\]\$ExitCode/);

  const jsonParse = script.indexOf('$Data = ConvertFrom-CommandJson $Result.Stdout');
  const exitHandling = script.indexOf('if ($Result.ExitCode -ne 0)', jsonParse);
  assert.ok(jsonParse >= 0);
  assert.ok(exitHandling > jsonParse);
  assert.match(script, /valid stdout JSON was accepted/);
});

test('control center exposes refresh, copy, readable diagnostics, and timestamped output', () => {
  const script = controlPanelScript();
  assert.match(script, /Add-ActionButton 'Refresh Status'/);
  assert.match(script, /Add-ActionButton 'Copy Status'/);
  assert.match(script, /\[\$Timestamp\] \[\$Level\]/);
  assert.match(script, /Human-readable diagnostics:/);
  assert.match(script, /PASS.*FAIL/s);
  assert.match(script, /remediation:/);
  assert.match(script, /computer-doctor-latest\.json/);
  assert.match(script, /failed checks:/);
  assert.match(script, /UIA Driver path:/);
  assert.match(script, /MCP server path:/);
  assert.match(script, /RC root:/);
  assert.match(script, /logs directory:/);
});

test('control center opens Chrome URL through a discovered Chrome executable', () => {
  const script = controlPanelScript();
  assert.match(script, /Get-Command \$CommandName/);
  assert.match(script, /LOCALAPPDATA/);
  assert.match(script, /GetEnvironmentVariable\('ProgramFiles'\)/);
  assert.match(script, /GetEnvironmentVariable\('ProgramFiles\(x86\)'\)/);
  assert.match(
    script,
    /Start-Process -FilePath \$Chrome -ArgumentList @\('chrome:\/\/extensions'\)/,
  );
  assert.doesNotMatch(script, /Start-Process 'chrome:\/\/extensions'/);
});

test('control center creates and opens logs with visible failure reporting', () => {
  const script = controlPanelScript();
  assert.match(script, /New-Item -ItemType Directory -Path \$LogDir -Force/);
  assert.match(script, /Start-Process -FilePath explorer\.exe -ArgumentList @\(\$LogDir\)/);
  assert.match(script, /Could not open logs directory/);
});

test('generated install, smoke, and uninstall scripts form the unified-status loop', () => {
  const install = installScript();
  assert.match(install, /VERIFY\.ps1/);
  assert.match(install, /Node\.js 22 or newer/);
  assert.match(install, /npm ci --omit=dev --ignore-scripts/);
  assert.match(install, /computer-doctor\.js --json/);
  assert.match(install, /computer-status\.js --json/);
  assert.match(install, /nextActions/);

  const smoke = smokeScript();
  assert.match(smoke, /VERIFY\.ps1/);
  assert.match(smoke, /computer-doctor\.js --json/);
  assert.match(smoke, /computer-status\.js --json/);
  assert.doesNotMatch(smoke, /codex-install\.js status/);
  assert.match(smoke, /valid.*snapshot remains authoritative/s);

  const uninstall = uninstallScript();
  assert.match(uninstall, /codex-install\.js uninstall/);
  assert.match(uninstall, /KeepChromeHost/);
  assert.match(uninstall, /computer-status\.js --json/);
  assert.match(uninstall, /Existing Codex configuration and KV-created backups were preserved/);
});

test('CMD wrappers preserve exit codes and pause for double-click users', () => {
  const wrapper = commandWrapper('SMOKE.ps1');
  assert.match(wrapper, /set EXIT_CODE=%ERRORLEVEL%/);
  assert.match(wrapper, /pause/);
  assert.match(wrapper, /exit \/b %EXIT_CODE%/);
});
