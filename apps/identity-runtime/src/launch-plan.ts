import { existsSync } from 'node:fs';
import type { IdentityManifest } from './model.js';
import { validateManifest } from './health.js';

export interface LaunchPlan {
  identityId: string;
  executablePath: string;
  args: string[];
  env: Record<string, string>;
  blockedReasons: string[];
}

export function buildLaunchPlan(manifest: IdentityManifest, env: NodeJS.ProcessEnv = process.env): LaunchPlan {
  const health = validateManifest(manifest);
  const blockedReasons = health.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => `${finding.code}: ${finding.message}`);
  if (!existsSync(manifest.browser.executablePath)) blockedReasons.push('BROWSER_NOT_FOUND: executablePath does not exist on this machine.');
  if (manifest.proxy.passwordEnv && !env[manifest.proxy.passwordEnv]) blockedReasons.push(`PROXY_SECRET_MISSING: ${manifest.proxy.passwordEnv} is not set.`);

  const proxyAuth = manifest.proxy.username
    ? `${encodeURIComponent(manifest.proxy.username)}:${encodeURIComponent(env[manifest.proxy.passwordEnv ?? ''] ?? '')}@`
    : '';
  const proxyServer = `${manifest.proxy.protocol}://${proxyAuth}${manifest.proxy.host}:${manifest.proxy.port}`;
  const args = [
    `--user-data-dir=${manifest.browser.userDataDir}`,
    `--proxy-server=${proxyServer}`,
    `--lang=${manifest.environment.locale}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (manifest.browser.profileDirectory) args.push(`--profile-directory=${manifest.browser.profileDirectory}`);
  if (manifest.policies.ipv6 === 'disabled') args.push('--disable-ipv6');

  return {
    identityId: manifest.identityId,
    executablePath: manifest.browser.executablePath,
    args,
    env: { TZ: manifest.environment.timezone, LANG: manifest.environment.locale },
    blockedReasons,
  };
}
