#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareSetupConfig(discovery, options = {}) {
  if (!discovery || discovery.schemaVersion !== 1 || discovery.platform !== 'windows') {
    throw new Error('A schemaVersion 1 Windows discovery report is required.');
  }
  const accountCount = parseAccountCount(options.accountCount ?? 2);
  const chromeExecutablePath = options.chromeExecutablePath
    ?? discovery.recommendedChromePath
    ?? discovery.chromeCandidates?.[0]?.path;
  if (!chromeExecutablePath) {
    throw new Error('No Chrome executable was discovered. Set chromeExecutablePath manually.');
  }

  const candidates = uniqueProxyCandidates(discovery.proxyCandidates ?? []);
  const ports = candidates.slice(0, accountCount).map((candidate) => candidate.port);
  while (ports.length < accountCount) ports.push(17891 + ports.length);

  return {
    chromeExecutablePath,
    baseProfileDir: options.baseProfileDir ?? 'D:\\KvBrowserBridge\\profiles',
    locale: options.locale ?? 'zh-CN',
    timezone: options.timezone ?? 'Asia/Shanghai',
    countryCode: options.countryCode ?? 'CN',
    disableIpv6: true,
    publicIpProbeUrl: 'https://api.ipify.org?format=json',
    ipv6ProbeUrl: 'https://api6.ipify.org?format=json',
    timeoutMs: 20000,
    identities: Array.from({ length: accountCount }, (_, index) => ({
      identityId: `account-${String.fromCharCode(97 + index)}-xhs`,
      accountLabel: `小红书账号 ${index + 1}`,
      proxyHost: candidates[index]?.host ?? '127.0.0.1',
      proxyPort: ports[index],
      proxyProtocol: 'http',
    })),
  };
}

export function uniqueProxyCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const host = candidate?.host === '::1' ? '::1' : '127.0.0.1';
    const port = Number(candidate?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ host, port, kind: candidate?.kind ?? 'discovered' });
  }
  return result.sort((a, b) => a.port - b.port);
}

function parseAccountCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 26) {
    throw new Error('accountCount must be an integer from 1 to 26.');
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const discoveryIndex = argv.indexOf('--discovery');
  const outputIndex = argv.indexOf('--output');
  const countIndex = argv.indexOf('--accounts');
  if (discoveryIndex < 0 || !argv[discoveryIndex + 1]) {
    throw new Error('Usage: node scripts/prepare-network-identity-config.mjs --discovery <report.json> [--accounts <count>] [--output <setup.json>]');
  }
  const discoveryPath = resolve(argv[discoveryIndex + 1]);
  if (!existsSync(discoveryPath)) throw new Error(`Discovery report not found: ${discoveryPath}`);
  const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
  const config = prepareSetupConfig(discovery, {
    accountCount: countIndex >= 0 ? argv[countIndex + 1] : 2,
  });
  const outputPath = outputIndex >= 0 && argv[outputIndex + 1]
    ? resolve(argv[outputIndex + 1])
    : resolve(dirname(discoveryPath), 'network-identities.setup.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, accountCount: config.identities.length }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'IDENTITY_CONFIG_PREPARE_FAILED', message: error instanceof Error ? error.message : String(error) } }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
