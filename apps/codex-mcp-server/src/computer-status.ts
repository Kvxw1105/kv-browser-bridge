#!/usr/bin/env node
import { codexConfigStatus } from './codex-install.js';
import { runComputerDoctor, type DoctorCheck } from './computer-doctor.js';

export type ComputerStatusSnapshot = {
  ok: boolean;
  state: 'ready' | 'degraded' | 'not-installed' | 'unavailable';
  generatedAt: string;
  codex: {
    installed: boolean;
    configPath: string;
    serverPath: string;
  };
  runtime: {
    requiredPassed: number;
    requiredTotal: number;
    optionalPassed: number;
    optionalTotal: number;
    checks: DoctorCheck[];
  };
  nextActions: string[];
};

export function summarizeComputerStatus(
  doctor: Awaited<ReturnType<typeof runComputerDoctor>>,
  codex: Awaited<ReturnType<typeof codexConfigStatus>>,
): ComputerStatusSnapshot {
  const required = doctor.checks.filter((check) => check.required);
  const optional = doctor.checks.filter((check) => !check.required);
  const requiredPassed = required.filter((check) => check.ok).length;
  const optionalPassed = optional.filter((check) => check.ok).length;
  const nextActions: string[] = [];

  if (!codex.installed) nextActions.push('Install the managed Codex MCP configuration.');
  for (const check of required.filter((item) => !item.ok)) nextActions.push(`Fix ${check.name}: ${check.message}`);
  const chrome = optional.find((item) => item.name === 'chrome-bridge');
  if (chrome && !chrome.ok) nextActions.push('Load the Chrome extension and confirm the Native Messaging host is installed.');

  const state = !doctor.ok
    ? 'unavailable'
    : !codex.installed
      ? 'not-installed'
      : optional.some((check) => !check.ok)
        ? 'degraded'
        : 'ready';

  return {
    ok: doctor.ok && codex.installed,
    state,
    generatedAt: new Date().toISOString(),
    codex: {
      installed: codex.installed,
      configPath: codex.configPath,
      serverPath: codex.serverPath,
    },
    runtime: {
      requiredPassed,
      requiredTotal: required.length,
      optionalPassed,
      optionalTotal: optional.length,
      checks: doctor.checks,
    },
    nextActions,
  };
}

export async function getComputerStatus(): Promise<ComputerStatusSnapshot> {
  const [doctor, codex] = await Promise.all([
    runComputerDoctor(),
    codexConfigStatus(),
  ]);
  return summarizeComputerStatus(doctor, codex);
}

async function main(): Promise<void> {
  const status = await getComputerStatus();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } else {
    process.stdout.write(`STATE ${status.state}\n`);
    process.stdout.write(`CODEX ${status.codex.installed ? 'installed' : 'not-installed'}\n`);
    process.stdout.write(`REQUIRED ${status.runtime.requiredPassed}/${status.runtime.requiredTotal}\n`);
    process.stdout.write(`OPTIONAL ${status.runtime.optionalPassed}/${status.runtime.optionalTotal}\n`);
    for (const action of status.nextActions) process.stdout.write(`NEXT ${action}\n`);
  }
  if (!status.ok) process.exitCode = 1;
}

if (process.env.KV_COMPUTER_STATUS_TEST !== '1') {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
