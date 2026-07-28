import { existsSync } from 'node:fs';
import type { IdentityManifest, ProxyAuthMode } from './model.js';
import { validateManifest } from './health.js';

export interface LaunchPlan {
  identityId: string;
  executablePath: string;
  args: string[];
  env: Record<string, string>;
  proxyAuth: {
    mode: ProxyAuthMode;
    username?: string;
    passwordEnv?: string;
  };
  blockedReasons: string[];
}

export function buildLaunchPlan(
  manifest: IdentityManifest,
  env: NodeJS.ProcessEnv = process.env,
  runtimeSessionId?: string,
): LaunchPlan {
  const health = validateManifest(manifest);
  const blockedReasons = health.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => `${finding.code}: ${finding.message}`);
  if (!existsSync(manifest.browser.executablePath)) blockedReasons.push('BROWSER_NOT_FOUND: executablePath does not exist on this machine.');

  const authMode = manifest.proxy.authMode ?? (manifest.proxy.username ? 'native-adapter' : 'none');
  if (authMode === 'native-adapter') {
    if (manifest.proxy.passwordEnv && !env[manifest.proxy.passwordEnv]) blockedReasons.push(`PROXY_SECRET_MISSING: ${manifest.proxy.passwordEnv} is not set.`);
    blockedReasons.push('PROXY_AUTH_ADAPTER_REQUIRED: authenticated proxies require the KV native credential adapter; credentials are never placed in Chrome command-line arguments.');
  }

  const proxyServer = `${manifest.proxy.protocol}://${manifest.proxy.host}:${manifest.proxy.port}`;
  const args = [
    `--user-data-dir=${manifest.browser.userDataDir}`,
    `--proxy-server=${proxyServer}`,
    `--lang=${manifest.environment.locale}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (manifest.browser.profileDirectory) args.push(`--profile-directory=${manifest.browser.profileDirectory}`);
  if (manifest.policies.ipv6 === 'disabled') args.push('--disable-ipv6');
  args.push('about:blank');

  const launchEnv: Record<string, string> = {
    TZ: manifest.environment.timezone,
    LANG: manifest.environment.locale,
    KV_BROWSER_IDENTITY_ID: manifest.identityId,
    KV_BROWSER_WORKSPACE_ID: manifest.workspaceId,
    KV_BROWSER_PLATFORM: manifest.platform,
  };
  if (runtimeSessionId) launchEnv.KV_BROWSER_RUNTIME_SESSION_ID = runtimeSessionId;

  return {
    identityId: manifest.identityId,
    executablePath: manifest.browser.executablePath,
    args,
    env: launchEnv,
    proxyAuth: { mode: authMode, username: manifest.proxy.username, passwordEnv: manifest.proxy.passwordEnv },
    blockedReasons: [...new Set(blockedReasons)],
  };
}
