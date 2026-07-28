#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLaunchPlan } from './identity/launch-plan.js';
import { validateManifest } from './identity/health.js';
import type { IdentityManifest } from './identity/model.js';
import { probeProxyEndpoint } from './identity/network-preflight.js';
import { defaultRuntimeRoot } from './identity/paths.js';
import { IdentityRuntime } from './identity/session.js';
import { acceptanceReportPath, runIdentityDoctor } from './identity/windows-doctor.js';

const [command, manifestArgument] = process.argv.slice(2);
const commands = ['check', 'plan', 'proxy-check', 'start', 'stop', 'status', 'doctor', 'acceptance'];
if (!command || !manifestArgument || !commands.includes(command)) {
  console.error('Usage: node dist/identity-cli.js <check|plan|proxy-check|start|stop|status|doctor|acceptance> <identity-manifest.json>');
  process.exit(2);
}

async function main(): Promise<void> {
  const manifestPath = resolve(manifestArgument);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IdentityManifest;
  const runtime = new IdentityRuntime(defaultRuntimeRoot());
  let result: unknown;
  if (command === 'check') result = validateManifest(manifest);
  else if (command === 'plan') result = buildLaunchPlan(manifest);
  else if (command === 'proxy-check') result = await probeProxyEndpoint(manifest);
  else if (command === 'start') result = await runtime.startVerified(manifest);
  else if (command === 'stop') result = runtime.stop(manifest);
  else if (command === 'status') result = runtime.status(manifest);
  else {
    const report = runIdentityDoctor(manifest, runtime.status(manifest));
    if (command === 'acceptance') {
      const outputPath = acceptanceReportPath(manifestPath);
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      result = { ...report, reportPath: outputPath };
    } else result = report;
  }

  console.log(JSON.stringify(result, null, 2));
  if (typeof result === 'object' && result !== null) {
    const value = result as Record<string, unknown>;
    if ('healthy' in value && value.healthy === false) process.exitCode = 1;
    if ('ok' in value && value.ok === false) process.exitCode = 1;
    if (Array.isArray(value.blockedReasons) && value.blockedReasons.length > 0) process.exitCode = 1;
    if ('state' in value && !['running', 'stopped', 'not-started'].includes(String(value.state))) process.exitCode = 1;
    if ((command === 'doctor' || command === 'acceptance') && value.ready !== true) process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: 'CLI_FAILED', message: error instanceof Error ? error.message : String(error) } }, null, 2));
  process.exitCode = 1;
});
