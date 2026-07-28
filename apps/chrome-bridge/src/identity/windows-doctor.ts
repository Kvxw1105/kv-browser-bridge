import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IdentityManifest, RuntimeStatus } from './model.js';
import { validateManifest } from './health.js';
import { discoveryPathForIdentity, publicSessionPathForIdentity } from './bridge-context.js';

export interface DevToolsEndpoint {
  port: number;
  websocketPath?: string;
  websocketUrl?: string;
  sourcePath: string;
}

export interface IdentityDoctorReport {
  schemaVersion: 1;
  identityId: string;
  platform: NodeJS.Platform;
  ready: boolean;
  checks: Array<{
    code: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    details?: Record<string, unknown>;
  }>;
  chromeCandidates: string[];
  detectedChromePath?: string;
  devTools?: DevToolsEndpoint;
  runtime: RuntimeStatus;
  generatedAt: string;
}

export function chromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [
    env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

export function detectChromePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return chromeCandidates(env).find((candidate) => existsSync(candidate));
}

export function readDevToolsActivePort(userDataDir: string): DevToolsEndpoint | undefined {
  const sourcePath = join(userDataDir, 'DevToolsActivePort');
  if (!existsSync(sourcePath)) return undefined;
  const [portLine, websocketPath] = readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/);
  const port = Number.parseInt(portLine ?? '', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DevToolsActivePort contains an invalid port.');
  const normalizedPath = websocketPath?.trim() || undefined;
  return {
    port,
    websocketPath: normalizedPath,
    websocketUrl: normalizedPath ? `ws://127.0.0.1:${port}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}` : undefined,
    sourcePath,
  };
}

export function runIdentityDoctor(
  manifest: IdentityManifest,
  runtime: RuntimeStatus,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): IdentityDoctorReport {
  const checks: IdentityDoctorReport['checks'] = [];
  const health = validateManifest(manifest);
  for (const finding of health.findings) {
    checks.push({
      code: finding.code,
      status: finding.severity === 'error' ? 'fail' : finding.severity === 'warning' ? 'warn' : 'pass',
      message: finding.message,
    });
  }
  if (health.findings.length === 0) checks.push({ code: 'MANIFEST_HEALTH', status: 'pass', message: 'Identity manifest passed deterministic health checks.' });

  const candidates = chromeCandidates(env);
  const detected = detectChromePath(env);
  const configuredExists = existsSync(manifest.browser.executablePath);
  checks.push({
    code: 'CHROME_EXECUTABLE',
    status: configuredExists ? 'pass' : detected ? 'warn' : 'fail',
    message: configuredExists
      ? 'Configured browser executable exists.'
      : detected
        ? 'Configured browser executable is missing, but a Chrome installation was detected.'
        : 'Configured browser executable is missing and Chrome was not detected in standard Windows locations.',
    details: { configuredPath: manifest.browser.executablePath, detectedPath: detected },
  });

  try {
    mkdirSync(manifest.browser.userDataDir, { recursive: true, mode: 0o700 });
    accessSync(manifest.browser.userDataDir, constants.R_OK | constants.W_OK);
    checks.push({ code: 'PROFILE_DIRECTORY', status: 'pass', message: 'Dedicated browser profile directory is readable and writable.' });
  } catch (error) {
    checks.push({ code: 'PROFILE_DIRECTORY', status: 'fail', message: `Dedicated browser profile directory is not writable: ${error instanceof Error ? error.message : String(error)}` });
  }

  const identity = {
    identityId: manifest.identityId,
    workspaceId: manifest.workspaceId,
    platform: manifest.platform,
  };
  const discoveryPath = discoveryPathForIdentity(identity, env);
  const sessionPath = publicSessionPathForIdentity(identity, env);
  const discoveryPresent = existsSync(discoveryPath);
  const sessionPresent = existsSync(sessionPath);
  checks.push({
    code: 'BRIDGE_DISCOVERY',
    status: runtime.alive ? (discoveryPresent ? 'pass' : 'fail') : (discoveryPresent ? 'warn' : 'pass'),
    message: discoveryPresent ? 'Private identity Bridge discovery file exists.' : runtime.alive ? 'Runtime is alive but its private Bridge discovery file is missing.' : 'No private Bridge discovery file is expected while stopped.',
  });
  checks.push({
    code: 'EXTENSION_HANDSHAKE_REGISTRY',
    status: runtime.alive ? (sessionPresent ? 'pass' : 'warn') : (sessionPresent ? 'warn' : 'pass'),
    message: sessionPresent ? 'Public identity session registry exists, indicating a completed extension handshake.' : runtime.alive ? 'Browser is alive but no completed extension identity handshake is registered yet.' : 'No active identity session registry is expected while stopped.',
  });

  let devTools: DevToolsEndpoint | undefined;
  try {
    devTools = readDevToolsActivePort(manifest.browser.userDataDir);
    checks.push({
      code: 'DEVTOOLS_ENDPOINT',
      status: runtime.alive ? (devTools ? 'pass' : 'warn') : (devTools ? 'warn' : 'pass'),
      message: devTools ? `Chrome DevTools endpoint was discovered on loopback port ${devTools.port}.` : runtime.alive ? 'Browser is alive but DevToolsActivePort is not available yet.' : 'No DevTools endpoint is expected while stopped.',
    });
  } catch (error) {
    checks.push({ code: 'DEVTOOLS_ENDPOINT', status: 'fail', message: error instanceof Error ? error.message : String(error) });
  }

  checks.push({
    code: 'RUNTIME_STATE',
    status: runtime.state === 'running' ? 'pass' : ['not-started', 'stopped'].includes(runtime.state) ? 'warn' : 'fail',
    message: `Identity runtime state is ${runtime.state}.`,
    details: { pid: runtime.pid, alive: runtime.alive, lockPresent: runtime.lockPresent, receiptPresent: runtime.receiptPresent },
  });

  return {
    schemaVersion: 1,
    identityId: manifest.identityId,
    platform: process.platform,
    ready: checks.every((check) => check.status !== 'fail') && runtime.state === 'running' && sessionPresent,
    checks,
    chromeCandidates: candidates,
    detectedChromePath: detected,
    devTools,
    runtime,
    generatedAt: now().toISOString(),
  };
}

export function acceptanceReportPath(manifestPath: string): string {
  return join(dirname(manifestPath), 'identity-acceptance-report.json');
}
