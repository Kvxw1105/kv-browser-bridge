#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildLaunchPlan } from './identity/launch-plan.js';
import { validateManifest } from './identity/health.js';
import type { IdentityManifest } from './identity/model.js';
import { defaultRuntimeRoot } from './identity/paths.js';
import { IdentityRuntime } from './identity/session.js';

const [command, manifestPath] = process.argv.slice(2);
const commands = ['check', 'plan', 'start', 'stop', 'status'];
if (!command || !manifestPath || !commands.includes(command)) {
  console.error('Usage: node dist/identity-cli.js <check|plan|start|stop|status> <identity-manifest.json>');
  process.exit(2);
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IdentityManifest;
  const runtime = new IdentityRuntime(defaultRuntimeRoot());
  const result = command === 'check'
    ? validateManifest(manifest)
    : command === 'plan'
      ? buildLaunchPlan(manifest)
      : command === 'start'
        ? runtime.start(manifest)
        : command === 'stop'
          ? runtime.stop(manifest)
          : runtime.status(manifest);
  console.log(JSON.stringify(result, null, 2));
  if ('healthy' in result && !result.healthy) process.exitCode = 1;
  if ('blockedReasons' in result && Array.isArray(result.blockedReasons) && result.blockedReasons.length > 0) process.exitCode = 1;
  if ('ok' in result && !result.ok) process.exitCode = 1;
  if ('state' in result && !['running', 'stopped', 'not-started'].includes(String(result.state))) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'CLI_FAILED', message: error instanceof Error ? error.message : String(error) } }, null, 2));
  process.exitCode = 1;
}
