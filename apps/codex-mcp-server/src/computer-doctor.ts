#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from './bridge-client.js';
import { NativeAppLauncher, type NativeAppListResult } from './native-app-launcher.js';
import { ReceiptStore } from './receipt-store.js';
import { WindowsUiaClient } from './windows-uia-client.js';

export type DoctorCheck = {
  name: string;
  required: boolean;
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
};

export type ComputerDoctorReport = {
  ok: boolean;
  generatedAt: string;
  checks: DoctorCheck[];
  mcpConfig: ReturnType<typeof buildMcpConfig>;
  codexToml: string;
};

export function buildMcpConfig(serverPath: string, nodePath = process.execPath) {
  return {
    command: nodePath,
    args: [serverPath],
    env: {
      LOCAL_CHROME_REQUEST_TIMEOUT_MS: '30000',
    },
  };
}

export function buildCodexToml(serverPath: string, nodePath = process.execPath): string {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '[mcp_servers.kv-computer-use]',
    `command = "${escape(nodePath)}"`,
    `args = ["${escape(serverPath)}"]`,
    'env = { LOCAL_CHROME_REQUEST_TIMEOUT_MS = "30000" }',
    'startup_timeout_ms = 20000',
    '',
  ].join('\n');
}

export function finalizeReport(checks: DoctorCheck[], serverPath: string, nodePath = process.execPath): ComputerDoctorReport {
  return {
    ok: checks.filter((item) => item.required).every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    checks,
    mcpConfig: buildMcpConfig(serverPath, nodePath),
    codexToml: buildCodexToml(serverPath, nodePath),
  };
}

export function nativeAppDoctorCheck(status: NativeAppListResult): DoctorCheck {
  const configurationValid = status.configurationErrors.length === 0;
  const ok = status.platform === 'win32' && status.available && status.availableApps > 0 && configurationValid;
  let message = 'Native App Launcher is available.';
  if (status.platform !== 'win32') {
    message = `Native App Launcher is unsupported on ${status.platform}.`;
  } else if (!configurationValid) {
    message = 'Native App Launcher rejected one or more allowlist configuration entries.';
  } else if (!status.available || status.availableApps === 0) {
    message = status.error?.message ?? 'No allowlisted native applications are available.';
  }
  return {
    name: 'native-app-launcher',
    required: false,
    ok,
    message,
    details: {
      platform: status.platform,
      configuredApps: status.configuredApps,
      availableApps: status.availableApps,
      configurationErrors: status.configurationErrors,
    },
  };
}

export async function runComputerDoctor(): Promise<ComputerDoctorReport> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(moduleDir, 'computer-server.js');
  const checks: DoctorCheck[] = [];

  try {
    await access(process.execPath);
    checks.push({ name: 'node-runtime', required: true, ok: true, message: `Node ${process.version} is available.`, details: { path: process.execPath } });
  } catch (error) {
    checks.push({ name: 'node-runtime', required: true, ok: false, message: error instanceof Error ? error.message : String(error) });
  }

  try {
    await access(serverPath);
    checks.push({ name: 'computer-mcp-build', required: true, ok: true, message: 'Computer Use MCP build found.', details: { path: serverPath } });
  } catch {
    checks.push({ name: 'computer-mcp-build', required: true, ok: false, message: 'Computer Use MCP build is missing.', details: { path: serverPath } });
  }

  const windows = new WindowsUiaClient(10_000);
  try {
    const status = await windows.status();
    checks.push({ name: 'windows-uia-sidecar', required: true, ok: status.available, message: status.available ? 'Windows UIA sidecar is available.' : status.error?.message ?? 'Windows UIA sidecar is unavailable.', details: { executable: status.executable, capabilities: status.capabilities } });
    if (status.available) {
      try {
        const observation = await windows.observe({ maxWindows: 10, maxElements: 50, maxDepth: 3 });
        checks.push({ name: 'windows-uia-observe', required: true, ok: true, message: 'Windows UIA observation completed.', details: { observationId: observation.observationId, windows: observation.windows.length, elements: observation.elements.length } });
      } catch (error) {
        checks.push({ name: 'windows-uia-observe', required: true, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await windows.close();
  }

  const receipts = new ReceiptStore();
  const receiptPath = receipts.path();
  try {
    await mkdir(dirname(receiptPath), { recursive: true });
    checks.push({ name: 'receipt-directory', required: true, ok: true, message: 'Receipt directory is writable.', details: { path: receiptPath } });
  } catch (error) {
    checks.push({ name: 'receipt-directory', required: true, ok: false, message: error instanceof Error ? error.message : String(error), details: { path: receiptPath } });
  }

  const bridge = new BridgeClient({ requestTimeoutMs: 5_000, log: () => undefined });
  try {
    await bridge.request('browser_connection_status');
    checks.push({ name: 'chrome-bridge', required: false, ok: true, message: 'Chrome Bridge responded.', details: bridge.getStatus() as Record<string, unknown> });
  } catch (error) {
    checks.push({ name: 'chrome-bridge', required: false, ok: false, message: error instanceof Error ? error.message : String(error), details: bridge.getStatus() as Record<string, unknown> });
  } finally {
    await bridge.close();
  }

  try {
    const nativeApps = new NativeAppLauncher();
    checks.push(nativeAppDoctorCheck(await nativeApps.status()));
  } catch (error) {
    checks.push({
      name: 'native-app-launcher',
      required: false,
      ok: false,
      message: `Native App Launcher failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return finalizeReport(checks, serverPath);
}

async function main(): Promise<void> {
  const report = await runComputerDoctor();
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const item of report.checks) {
      process.stdout.write(`${item.ok ? 'OK' : item.required ? 'FAIL' : 'INFO'} ${item.name}: ${item.message}\n`);
    }
    process.stdout.write(`MCP_CONFIG ${JSON.stringify(report.mcpConfig)}\n`);
    process.stdout.write(`CODEX_TOML_BEGIN\n${report.codexToml}CODEX_TOML_END\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.env.KV_COMPUTER_DOCTOR_TEST !== '1') {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
