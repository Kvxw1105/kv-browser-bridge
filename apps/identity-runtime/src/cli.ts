#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildLaunchPlan } from './launch-plan.js';
import { validateManifest } from './health.js';
import type { IdentityManifest } from './model.js';

const [command, manifestPath] = process.argv.slice(2);
if (!command || !manifestPath || !['check', 'plan'].includes(command)) {
  console.error('Usage: kv-identity-runtime <check|plan> <identity-manifest.json>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IdentityManifest;
const result = command === 'check' ? validateManifest(manifest) : buildLaunchPlan(manifest);
console.log(JSON.stringify(result, null, 2));
if ('healthy' in result && !result.healthy) process.exit(1);
if ('blockedReasons' in result && result.blockedReasons.length > 0) process.exit(1);
