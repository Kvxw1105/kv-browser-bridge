#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeBrowserLeakSignals } from './identity/browser-leak-probe.js';
import { probeBrowserPublicIp, waitForDevToolsEndpoint } from './identity/browser-network-probe.js';
import { buildLaunchPlan } from './identity/launch-plan.js';
import { validateManifest } from './identity/health.js';
import type { IdentityManifest, RuntimeReceipt } from './identity/model.js';
import { buildNetworkLeakAcceptanceReport, writeNetworkLeakAcceptanceReport } from './identity/network-leak-report.js';
import { DEFAULT_NETWORK_ENFORCEMENT_POLICY, enforceNetworkAssessment, type NetworkEnforcementPolicy } from './identity/network-enforcement.js';
import { freezeNetworkIdentityRecord, readNetworkIdentityRecord, recordNetworkObservation, resetNetworkIdentityRecord } from './identity/network-observation.js';
import { probeProxyEndpoint } from './identity/network-preflight.js';
import { defaultRuntimeRoot, runtimePaths } from './identity/paths.js';
import { IdentityRuntime } from './identity/session.js';
import { acceptanceReportPath, runIdentityDoctor } from './identity/windows-doctor.js';

const [command, manifestArgument, confirmation] = process.argv.slice(2);
const commands = ['check', 'plan', 'proxy-check', 'network-check', 'network-leak-check', 'network-status', 'network-reset', 'start', 'start-process', 'stop', 'status', 'doctor', 'acceptance'];
if (!command || !manifestArgument || !commands.includes(command)) {
  console.error('Usage: node dist/identity-cli.js <check|plan|proxy-check|network-check|network-leak-check|network-status|network-reset|start|start-process|stop|status|doctor|acceptance> <identity-manifest.json> [--confirm]');
  process.exit(2);
}

async function main(): Promise<void> {
  const manifestPath = resolve(manifestArgument);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IdentityManifest;
  const rootDir = defaultRuntimeRoot();
  const runtime = new IdentityRuntime(rootDir);
  let result: unknown;
  if (command === 'check') result = validateManifest(manifest);
  else if (command === 'plan') result = buildLaunchPlan(manifest);
  else if (command === 'proxy-check') result = await probeProxyEndpoint(manifest);
  else if (command === 'start-process') result = await runtime.startVerified(manifest);
  else if (command === 'start') {
    const started = await runtime.startVerified(manifest);
    if (!started.ok) result = started;
    else {
      const network = await verifyRunningNetwork(manifest, runtime, rootDir, started.receipt?.runtimeSessionId);
      result = network.ok ? { ...started, networkVerification: network } : { ok: false, start: started, networkVerification: network };
    }
  } else if (command === 'network-check') result = await verifyRunningNetwork(manifest, runtime, rootDir, readRuntimeSessionId(rootDir, manifest.identityId));
  else if (command === 'network-leak-check') result = await verifyNetworkLeaks(manifest, runtime, rootDir, readRuntimeSessionId(rootDir, manifest.identityId));
  else if (command === 'network-status') {
    const network = readNetworkIdentityRecord(rootDir, manifest.identityId);
    result = { ok: true, identityId: manifest.identityId, state: network?.state ?? 'unverified', network: network ?? null };
  } else if (command === 'network-reset') {
    if (confirmation !== '--confirm') result = { ok: false, error: { code: 'NETWORK_RESET_CONFIRMATION_REQUIRED', message: 'Pass --confirm to archive and reset the network identity baseline.' } };
    else if (runtime.status(manifest).alive) result = { ok: false, error: { code: 'NETWORK_RESET_RUNNING', message: 'Stop the identity browser before resetting its network baseline.' } };
    else result = { ok: true, identityId: manifest.identityId, ...resetNetworkIdentityRecord(rootDir, manifest.identityId) };
  } else if (command === 'stop') result = runtime.stop(manifest);
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
    if ('state' in value && !['running', 'stopped', 'not-started', 'verified', 'unverified'].includes(String(value.state))) process.exitCode = 1;
    if ((command === 'doctor' || command === 'acceptance') && value.ready !== true) process.exitCode = 1;
  }
}

async function verifyRunningNetwork(
  manifest: IdentityManifest,
  runtime: IdentityRuntime,
  rootDir: string,
  runtimeSessionId?: string,
): Promise<Record<string, unknown>> {
  const status = runtime.status(manifest);
  if (!status.alive || status.state !== 'running') {
    return { ok: false, error: { code: 'IDENTITY_NOT_RUNNING', message: `Identity ${manifest.identityId} must be running before browser network verification.` } };
  }
  const endpoint = await waitForDevToolsEndpoint(manifest.browser.userDataDir);
  if (!endpoint?.websocketUrl) {
    const stopped = runtime.stop(manifest);
    return { ok: false, stopped, error: { code: 'DEVTOOLS_ENDPOINT_UNAVAILABLE', message: 'Chrome did not expose a loopback DevTools endpoint for browser-side network verification.' } };
  }
  const probe = await probeBrowserPublicIp(endpoint, {
    probeUrl: manifest.networkVerification?.publicIpProbeUrl,
    timeoutMs: manifest.networkVerification?.timeoutMs,
  });
  if (!probe.ok || !probe.publicIp) {
    const stopped = runtime.stop(manifest);
    return { ok: false, probe, stopped, error: probe.error ?? { code: 'BROWSER_NETWORK_PROBE_FAILED', message: 'Browser public IP verification failed.' } };
  }
  const network = recordNetworkObservation(rootDir, manifest.identityId, {
    publicIp: probe.publicIp,
    probeUrl: probe.probeUrl,
    observedAt: probe.observedAt,
    runtimeSessionId,
  });
  if (network.state === 'frozen') {
    const stopped = runtime.stop(manifest);
    return { ok: false, probe, network, stopped, error: { code: 'NETWORK_IDENTITY_FROZEN', message: `Identity ${manifest.identityId} was frozen because its observed browser network is unsafe.` } };
  }
  return { ok: true, probe, network };
}

async function verifyNetworkLeaks(
  manifest: IdentityManifest,
  runtime: IdentityRuntime,
  rootDir: string,
  runtimeSessionId?: string,
): Promise<Record<string, unknown>> {
  const status = runtime.status(manifest);
  if (!status.alive || status.state !== 'running' || !runtimeSessionId) {
    return { ok: false, error: { code: 'IDENTITY_NOT_RUNNING', message: `Identity ${manifest.identityId} must be running with a current runtime session before leak verification.` } };
  }
  const network = readNetworkIdentityRecord(rootDir, manifest.identityId);
  if (!network || network.state !== 'verified' || network.runtimeSessionId !== runtimeSessionId) {
    return { ok: false, error: { code: 'NETWORK_IDENTITY_UNVERIFIED', message: 'Run network-check successfully for the current browser session before leak verification.' } };
  }
  const endpoint = await waitForDevToolsEndpoint(manifest.browser.userDataDir);
  if (!endpoint?.websocketUrl) return { ok: false, error: { code: 'DEVTOOLS_ENDPOINT_UNAVAILABLE', message: 'Chrome DevTools endpoint is unavailable.' } };
  const evidence = await probeBrowserLeakSignals(endpoint, {
    timeoutMs: manifest.networkVerification?.timeoutMs,
    ipv6ProbeUrl: manifest.networkVerification?.ipv6ProbeUrl,
    dnsProbeUrl: manifest.networkVerification?.dnsProbeUrl,
  });
  const allowedWebrtcCandidates = manifest.policies.webrtc === 'default'
    ? manifest.networkVerification?.allowedWebrtcCandidates
    : manifest.networkVerification?.allowedWebrtcCandidates ?? [];
  const report = buildNetworkLeakAcceptanceReport({
    identityId: manifest.identityId,
    runtimeSessionId,
    publicIp: network.publicIp,
    baselinePublicIp: network.baselinePublicIp,
    dnsResolvers: evidence.dnsResolvers,
    expectedDnsResolvers: manifest.networkVerification?.expectedDnsResolvers,
    webrtcCandidates: evidence.webrtcCandidates,
    allowedWebrtcCandidates,
    ipv6Addresses: evidence.ipv6Addresses,
    ipv6Policy: manifest.policies.ipv6,
    generatedAt: evidence.observedAt,
  });
  const reportPath = writeNetworkLeakAcceptanceReport(rootDir, report);
  // Probe modules must not apply lifecycle actions directly (NETWORK_ISOLATION_ACCEPTANCE_V1).
  // The enforcement policy decides whether an observation warrants a hard action:
  // Observe mode (the default) only warns and keeps the browser running; Strict mode
  // may freeze/stop for configured hard failures.
  const policy: NetworkEnforcementPolicy = { ...DEFAULT_NETWORK_ENFORCEMENT_POLICY };
  const decision = enforceNetworkAssessment(report, policy);
  if (decision.action === 'stop' || decision.action === 'freeze') {
    const frozenNetwork = freezeNetworkIdentityRecord(rootDir, manifest.identityId, report.blockedReasons);
    const stopped = runtime.stop(manifest);
    return { ok: false, evidence, report, reportPath, network: frozenNetwork, stopped, enforcement: decision, error: { code: 'NETWORK_LEAK_ACCEPTANCE_FAILED', message: 'Identity browser was frozen and stopped because network leak acceptance did not pass under the enforcement policy.' } };
  }
  return { ok: true, evidence, report, reportPath, enforcement: decision, warnings: decision.warnings };
}

function readRuntimeSessionId(rootDir: string, identityId: string): string | undefined {
  try {
    const receipt = JSON.parse(readFileSync(runtimePaths(rootDir, identityId).receiptPath, 'utf8')) as RuntimeReceipt;
    return receipt.runtimeSessionId;
  } catch {
    return undefined;
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: 'CLI_FAILED', message: error instanceof Error ? error.message : String(error) } }, null, 2));
  process.exitCode = 1;
});
