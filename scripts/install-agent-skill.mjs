#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(scriptDir, '..', 'skills', 'kv-browser-bridge');

const HARNESS_DESTINATIONS = {
  codex: join(homedir(), '.codex', 'skills', 'kv-browser-bridge'),
  'claude-code': join(homedir(), '.claude', 'skills', 'kv-browser-bridge'),
};

function usage() {
  return [
    'Usage:',
    '  node scripts/install-agent-skill.mjs --list [--json]',
    '  node scripts/install-agent-skill.mjs --harness codex|claude-code [--force] [--json]',
    '  node scripts/install-agent-skill.mjs --destination <skill-directory> [--force] [--json]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { json: false, force: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--harness' || arg === '--destination') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function listFiles(root, current = root) {
  const entries = readdirSync(current, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return listFiles(root, path);
    return [relative(root, path)];
  }).sort();
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function resolveDestination(options) {
  if (options.destination && options.harness) throw new Error('Use either --harness or --destination, not both.');
  if (options.destination) return resolve(options.destination);
  if (options.harness) {
    const destination = HARNESS_DESTINATIONS[options.harness];
    if (!destination) throw new Error(`Unsupported harness "${options.harness}". Use --list to inspect supported destinations.`);
    return destination;
  }
  throw new Error(`Choose --harness or --destination.\n\n${usage()}`);
}

function inspectDifferences(destination, files) {
  if (!existsSync(destination)) return { missing: files, different: [] };
  if (!statSync(destination).isDirectory()) throw new Error(`Destination is not a directory: ${destination}`);
  const missing = [];
  const different = [];
  for (const file of files) {
    const source = join(sourceDir, file);
    const target = join(destination, file);
    if (!existsSync(target)) missing.push(file);
    else if (!statSync(target).isFile() || hash(source) !== hash(target)) different.push(file);
  }
  return { missing, different };
}

function emit(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${value.message ?? value}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.list) {
    emit({ harnesses: Object.keys(HARNESS_DESTINATIONS), customDestination: true }, options.json);
    return;
  }
  if (!existsSync(sourceDir)) throw new Error(`Canonical Skill was not found: ${sourceDir}`);
  const destination = resolveDestination(options);
  const files = listFiles(sourceDir);
  const differences = inspectDifferences(destination, files);
  if ((differences.missing.length > 0 || differences.different.length > 0) && differences.different.length > 0 && !options.force) {
    throw new Error(`A different Skill already exists at ${destination}. Re-run with --force only after reviewing it.`);
  }
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, file), target);
  }
  emit({ destination, files, forced: options.force, status: differences.missing.length || differences.different.length ? 'installed' : 'current' }, options.json);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
