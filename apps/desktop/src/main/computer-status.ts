/**
 * Read-only Computer Use / Bridge status surface for the desktop console.
 * Deliberately spawns the built computer-use CLI (isolated from the desktop
 * build graph) and never exposes bridge bearer tokens.
 */
import { app, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BridgeStatusSummary {
  present: boolean;
  protocolVersion?: number;
  pipeName?: string;
  pid?: number;
  startedAt?: string;
  extensionPath?: string;
  extensionPresent: boolean;
}

export interface ComputerStatusReport {
  doctor?: unknown;
  status?: unknown;
  bridge: BridgeStatusSummary;
  computerUseDir?: string;
  error?: { code: string; message: string };
}

function repositoryRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const configured = env['KV_BROWSER_BRIDGE_HOME']?.trim();
  if (configured && existsSync(configured)) return resolve(configured);
  // Development tree: run from the repository (npm workspace) or the packaged app.
  const candidates = [
    resolve(cwd, 'apps', 'codex-mcp-server', 'dist', 'computer-doctor.js'),
    resolve(cwd, '..', 'apps', 'codex-mcp-server', 'dist', 'computer-doctor.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? resolve(found, '..', '..', '..') : undefined;
}

function spawnJson(scriptPath: string, timeoutMs = 60_000): unknown {
  const output = execFileSync(process.execPath, [scriptPath, '--json'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return JSON.parse(output);
}

function readBridgeSummary(env: NodeJS.ProcessEnv = process.env): BridgeStatusSummary {
  const base = env.LOCALAPPDATA || app.getPath('userData');
  const bridgePath = join(base, 'KvBrowserBridge', 'bridge.json');
  const summary: BridgeStatusSummary = { present: false, extensionPresent: false };
  if (existsSync(bridgePath)) {
    try {
      const raw = JSON.parse(readFileSync(bridgePath, 'utf8')) as {
        protocolVersion?: number;
        pipeName?: string;
        pid?: number;
        startedAt?: string;
      };
      summary.present = true;
      // Token is deliberately not read or forwarded.
      summary.protocolVersion = raw.protocolVersion;
      summary.pipeName = raw.pipeName;
      summary.pid = raw.pid;
      summary.startedAt = raw.startedAt;
    } catch {
      summary.present = false;
    }
  }
  const extensionCandidates = [
    process.resourcesPath ? join(process.resourcesPath, 'extension', 'manifest.json') : '',
    join(process.cwd(), 'apps', 'extension', 'dist', 'manifest.json'),
  ].filter(Boolean);
  const extension = extensionCandidates.find((candidate) => existsSync(candidate));
  if (extension) {
    summary.extensionPresent = true;
    summary.extensionPath = resolve(extension, '..');
  }
  return summary;
}

async function safe<T>(operation: () => T): Promise<{ ok: boolean; data?: T; error?: { code: string; message: string } }> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const separator = message.indexOf(':');
    return {
      ok: false,
      error: separator > 0
        ? { code: message.slice(0, separator).trim(), message: message.slice(separator + 1).trim() }
        : { code: 'COMPUTER_STATUS_ERROR', message },
    };
  }
}

export function registerComputerStatusHandlers(): void {
  ipcMain.handle('computer:doctor', () => safe(() => {
    const root = repositoryRoot();
    if (!root) throw new Error('COMPUTER_USE_NOT_FOUND: Computer Use runtime not found. Run from the repository or set KV_BROWSER_BRIDGE_HOME.');
    return spawnJson(join(root, 'apps', 'codex-mcp-server', 'dist', 'computer-doctor.js'));
  }));
  ipcMain.handle('computer:status', () => safe(() => {
    const root = repositoryRoot();
    if (!root) throw new Error('COMPUTER_USE_NOT_FOUND: Computer Use runtime not found. Run from the repository or set KV_BROWSER_BRIDGE_HOME.');
    return spawnJson(join(root, 'apps', 'codex-mcp-server', 'dist', 'computer-status.js'));
  }));
  ipcMain.handle('bridge:status', () => safe(() => {
    const root = repositoryRoot();
    const report: ComputerStatusReport = {
      bridge: readBridgeSummary(),
      ...(root ? { computerUseDir: root } : {}),
    };
    if (root) {
      try {
        report.doctor = spawnJson(join(root, 'apps', 'codex-mcp-server', 'dist', 'computer-doctor.js'));
      } catch (error) {
        report.error = { code: 'DOCTOR_FAILED', message: error instanceof Error ? error.message : String(error) };
      }
    }
    return report;
  }));
}
