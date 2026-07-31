import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IdentityRuntime } from '../apps/chrome-bridge/dist/identity/session.js';
import { SessionSupervisor } from '../apps/chrome-bridge/dist/identity/session-supervisor.js';
import { ChromePipeProcessAdapter } from '../apps/chrome-bridge/dist/identity/chrome-process-adapter.js';
import { discoveryPathForIdentity, publicSessionPathForIdentity } from '../apps/chrome-bridge/dist/identity/bridge-context.js';

const repo = resolve('.');
const root = resolve(process.env.MANAGED_BOOTSTRAP_ROOT ?? 'local/e2e-managed-extension-bootstrap');
const runtimeRoot = join(root, 'runtime');
const profilePath = join(root, 'profile-acceptance');
const evidencePath = join(root, 'evidence.json');
const chromePath = process.argv[2] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = resolve(process.argv[3] ?? 'apps/extension/dist');
const identityId = 'managed-bootstrap';
const workspaceId = 'managed-alpha';
const extensionId = chromeUnpackedExtensionId(extensionPath);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  chromeFlavor: 'official',
  profileIdentifier: 'profile-acceptance',
  extensionId,
  nativeHostConnected: false,
  bridgeReady: false,
  identityHandshakeMatched: false,
  discoveryPresent: false,
  publicSessionPresent: false,
  checks: [],
  ok: false,
};

let supervisor;
let manifest;

async function main() {
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(profilePath, { recursive: true });
  if (!existsSync(chromePath)) return fail('CHROME_MISSING', 'Official Chrome executable does not exist.');
  if (!existsSync(join(extensionPath, 'manifest.json'))) return fail('EXTENSION_MANIFEST_MISSING', 'Extension manifest does not exist.');

  process.env.KV_IDENTITY_RUNTIME_DIR = runtimeRoot;
  process.env.KV_BROWSER_CDP_PIPE = '1';
  process.env.KV_BROWSER_CHROME_STDERR_DIR = join(root, 'chrome-stderr');
  process.env.KV_BROWSER_CHROME_VERBOSE_LOGGING = '1';
  delete process.env.KV_BROWSER_EXTENSION_PATH;

  const install = spawnSync(process.execPath, [join(repo, 'apps/chrome-bridge/dist/install.js'), 'install', extensionId], { cwd: repo, encoding: 'utf8', windowsHide: true });
  writeFileSync(join(root, 'native-host-install.log'), `${install.stdout ?? ''}${install.stderr ?? ''}`, 'utf8');
  if (install.status !== 0) return fail('NATIVE_HOST_INSTALL_FAILED', 'Native Messaging Host installation failed.');

  manifest = createManifest();
  const adapter = new ChromePipeProcessAdapter();
  const runtime = new IdentityRuntime(runtimeRoot, adapter);
  supervisor = new SessionSupervisor(runtimeRoot, { runtime, processAdapter: adapter, extensionPath, env: process.env, bridgeTimeoutMs: 30_000 });

  const first = await supervisor.start(manifest);
  if (!first.ok) return fail(first.snapshot.error?.code ?? 'FIRST_START_FAILED', first.snapshot.error?.message ?? 'First managed bootstrap failed.');
  report.chromeVersion = await chromeVersion(adapter, first.start?.receipt?.pid);
  report.firstStart = sessionEvidence(first.snapshot);
  report.nativeHostConnected = first.snapshot.bridge.extensionHandshake;
  report.bridgeReady = first.snapshot.effectiveState === 'ready';
  report.identityHandshakeMatched = first.snapshot.bridge.extensionHandshake && first.snapshot.runtimeSessionId === first.snapshot.bridge.runtimeSessionId;
  report.discoveryPresent = first.snapshot.bridge.privateDiscoveryPresent;
  report.publicSessionPresent = first.snapshot.bridge.publicSessionPresent;
  report.checks.push({ name: 'first_start_handshake', ok: report.nativeHostConnected && report.bridgeReady && report.identityHandshakeMatched && report.discoveryPresent && report.publicSessionPresent });
  const profileBefore = profileEvidence(profilePath);

  const firstStop = supervisor.stop(manifest);
  await waitForArtifactsToClear(first.start?.receipt?.runtimeSessionId);
  const afterFirstStop = runtime.status(manifest);
  const firstStopClean = firstStop.ok && !afterFirstStop.alive && !afterFirstStop.lockPresent && !bridgeArtifactsPresent(first.start?.receipt?.runtimeSessionId);
  report.checks.push({ name: 'first_stop_cleanup', ok: firstStopClean });

  const second = await supervisor.start(manifest);
  if (!second.ok) return fail(second.snapshot.error?.code ?? 'SECOND_START_FAILED', second.snapshot.error?.message ?? 'Second managed bootstrap failed.');
  report.secondStart = sessionEvidence(second.snapshot);
  const profileAfter = profileEvidence(profilePath);
  report.checks.push({ name: 'second_start_new_session_profile_retained', ok: second.snapshot.bridge.extensionHandshake && second.snapshot.runtimeSessionId !== first.snapshot.runtimeSessionId && profileAfter.exists && profileBefore.exists });
  const secondStop = supervisor.stop(manifest);
  await waitForArtifactsToClear(second.start?.receipt?.runtimeSessionId);
  const afterSecondStop = runtime.status(manifest);
  report.checks.push({ name: 'second_stop_cleanup', ok: secondStop.ok && !afterSecondStop.alive && !afterSecondStop.lockPresent && !bridgeArtifactsPresent(second.start?.receipt?.runtimeSessionId) });
  report.profile = { before: profileBefore, after: profileAfter, retained: profileBefore.exists && profileAfter.exists };
  report.completedAt = new Date().toISOString();
  report.ok = report.checks.every((check) => check.ok);
  writeReport();
  if (!report.ok) process.exitCode = 1;
}

await main();

function createManifest() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, identityId, workspaceId, platform: 'windows', accountLabel: identityId, mode: 'native-stable',
    browser: { executablePath: chromePath, userDataDir: profilePath },
    environment: { osFamily: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1280, height: 720, deviceScaleFactor: 1 } },
    proxy: { id: 'shared-local-proxy', protocol: 'http', host: '127.0.0.1', port: 7897, authMode: 'none', countryCode: 'CN', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    policies: { webrtc: 'proxy-only', dns: 'system', ipv6: 'disabled', allowConcurrentSessions: false },
    networkVerification: { publicIpProbeUrl: 'https://api.ipify.org?format=json', timeoutMs: 30_000 },
    createdAt: now, updatedAt: now,
  };
}

function sessionEvidence(snapshot) {
  return { pid: snapshot.process.pid, runtimeSessionId: snapshot.runtimeSessionId, processAlive: snapshot.process.alive, extensionId, nativeHostConnected: snapshot.bridge.extensionHandshake, bridgeReady: snapshot.effectiveState === 'ready', identityHandshakeMatched: snapshot.bridge.extensionHandshake && snapshot.runtimeSessionId === snapshot.bridge.runtimeSessionId, discoveryPresent: snapshot.bridge.privateDiscoveryPresent, publicSessionPresent: snapshot.bridge.publicSessionPresent };
}

async function chromeVersion(adapter, pid) {
  try {
    const value = pid ? await adapter.transportFor(pid)?.request('Browser.getVersion') : undefined;
    return typeof value?.product === 'string' ? value.product : undefined;
  } catch { return undefined; }
}

function profileEvidence(path) {
  return { exists: existsSync(path), preferencesPresent: existsSync(join(path, 'Default', 'Preferences')), localStatePresent: existsSync(join(path, 'Local State')) };
}

function bridgeArtifactsPresent(runtimeSessionId) {
  if (!runtimeSessionId) return false;
  const env = process.env;
  const identity = { identityId, workspaceId, platform: 'windows', runtimeSessionId };
  return existsSync(discoveryPathForIdentity(identity, env)) || existsSync(publicSessionPathForIdentity(identity, env));
}

async function waitForArtifactsToClear(runtimeSessionId) {
  const deadline = Date.now() + 5_000;
  while (bridgeArtifactsPresent(runtimeSessionId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}

function writeReport() { writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
function fail(code, message) { report.completedAt = new Date().toISOString(); report.error = { code, message }; writeReport(); process.exitCode = 1; }

function chromeUnpackedExtensionId(path) {
  const hash = createHash('sha256').update(path, 'utf16le').digest();
  let id = '';
  for (const byte of hash.subarray(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return id;
}
