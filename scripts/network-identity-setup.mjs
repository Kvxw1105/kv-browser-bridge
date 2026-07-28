#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const IDENTITY_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function buildIdentityManifests(config, now = new Date()) {
  validateSetup(config);
  const timestamp = now.toISOString();
  const baseProfileDir = resolve(config.baseProfileDir);
  return config.identities.map((identity) => ({
    schemaVersion: 1,
    identityId: identity.identityId,
    workspaceId: identity.workspaceId ?? identity.identityId,
    platform: identity.platform ?? 'xiaohongshu',
    accountLabel: identity.accountLabel,
    mode: 'native-stable',
    browser: {
      executablePath: resolve(config.chromeExecutablePath),
      userDataDir: resolve(baseProfileDir, identity.identityId),
    },
    environment: {
      osFamily: 'windows',
      locale: config.locale ?? 'zh-CN',
      timezone: config.timezone ?? 'Asia/Shanghai',
      screen: config.screen ?? { width: 1920, height: 1080, deviceScaleFactor: 1 },
    },
    proxy: {
      id: identity.proxyId ?? `clash-${identity.proxyPort}`,
      protocol: identity.proxyProtocol ?? 'http',
      host: identity.proxyHost ?? '127.0.0.1',
      port: identity.proxyPort,
      authMode: 'none',
      countryCode: identity.countryCode ?? config.countryCode ?? 'CN',
      timezone: identity.timezone ?? config.timezone ?? 'Asia/Shanghai',
      locale: identity.locale ?? config.locale ?? 'zh-CN',
    },
    policies: {
      webrtc: 'proxy-only',
      dns: 'proxy',
      ipv6: config.disableIpv6 === false ? 'default' : 'disabled',
      allowConcurrentSessions: false,
    },
    networkVerification: {
      publicIpProbeUrl: config.publicIpProbeUrl ?? 'https://api.ipify.org?format=json',
      ipv6ProbeUrl: config.ipv6ProbeUrl ?? 'https://api6.ipify.org?format=json',
      ...(config.dnsProbeUrl ? { dnsProbeUrl: config.dnsProbeUrl } : {}),
      ...(config.expectedDnsResolvers ? { expectedDnsResolvers: config.expectedDnsResolvers } : {}),
      allowedWebrtcCandidates: identity.allowedWebrtcCandidates ?? [],
      timeoutMs: config.timeoutMs ?? 20_000,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

export function validateSetup(config) {
  if (!config || typeof config !== 'object') throw new Error('Setup configuration must be a JSON object.');
  if (typeof config.chromeExecutablePath !== 'string' || !config.chromeExecutablePath.trim()) throw new Error('chromeExecutablePath is required.');
  if (typeof config.baseProfileDir !== 'string' || !config.baseProfileDir.trim()) throw new Error('baseProfileDir is required.');
  if (!Array.isArray(config.identities) || config.identities.length === 0) throw new Error('At least one identity is required.');
  const ids = new Set();
  const endpoints = new Set();
  for (const identity of config.identities) {
    if (!IDENTITY_ID.test(identity.identityId ?? '')) throw new Error(`Invalid identityId: ${identity.identityId ?? ''}`);
    if (ids.has(identity.identityId)) throw new Error(`Duplicate identityId: ${identity.identityId}`);
    ids.add(identity.identityId);
    if (typeof identity.accountLabel !== 'string' || !identity.accountLabel.trim()) throw new Error(`accountLabel is required for ${identity.identityId}.`);
    if (!Number.isInteger(identity.proxyPort) || identity.proxyPort < 1 || identity.proxyPort > 65535) throw new Error(`Invalid proxyPort for ${identity.identityId}.`);
    const endpoint = `${identity.proxyHost ?? '127.0.0.1'}:${identity.proxyPort}`;
    if (endpoints.has(endpoint)) throw new Error(`Duplicate proxy endpoint: ${endpoint}. Each identity needs its own local inbound.`);
    endpoints.add(endpoint);
  }
}

export function writeIdentityManifests(config, outputDir, now = new Date()) {
  const manifests = buildIdentityManifests(config, now);
  const resolvedOutput = resolve(outputDir);
  mkdirSync(resolvedOutput, { recursive: true });
  const files = [];
  for (const manifest of manifests) {
    const path = resolve(resolvedOutput, `${manifest.identityId}.json`);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    files.push(path);
  }
  const acceptancePath = resolve(resolvedOutput, 'run-acceptance.ps1');
  const relativeFiles = files.map((path) => `'${path.replaceAll("'", "''")}'`).join(', ');
  writeFileSync(acceptancePath, [
    "$ErrorActionPreference = 'Stop'",
    `$manifests = @(${relativeFiles})`,
    `& '${resolve('scripts/accept-network-isolation.ps1').replaceAll("'", "''")}' -Manifest $manifests -StopAfter`,
    '',
  ].join('\r\n'), { encoding: 'utf8', mode: 0o700 });
  return { outputDir: resolvedOutput, manifests: files, acceptanceScript: acceptancePath };
}

async function main(argv = process.argv.slice(2)) {
  const configIndex = argv.indexOf('--config');
  const outputIndex = argv.indexOf('--output');
  if (configIndex < 0 || !argv[configIndex + 1]) throw new Error('Usage: node scripts/network-identity-setup.mjs --config <setup.json> [--output <directory>]');
  const configPath = resolve(argv[configIndex + 1]);
  if (!existsSync(configPath)) throw new Error(`Setup file not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const output = outputIndex >= 0 && argv[outputIndex + 1] ? argv[outputIndex + 1] : resolve(dirname(configPath), 'generated-identities');
  const result = writeIdentityManifests(config, output);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'IDENTITY_SETUP_FAILED', message: error instanceof Error ? error.message : String(error) } }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
