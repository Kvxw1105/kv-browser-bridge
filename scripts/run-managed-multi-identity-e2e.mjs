import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { IdentityRuntime } from '../apps/chrome-bridge/dist/identity/session.js';
import { SessionSupervisor } from '../apps/chrome-bridge/dist/identity/session-supervisor.js';
import { ChromePipeProcessAdapter } from '../apps/chrome-bridge/dist/identity/chrome-process-adapter.js';

const repo = resolve('.');
const root = resolve(process.env.MANAGED_E2E_ROOT ?? 'local/e2e-managed-multi-identity-pipe');
const runtimeRoot = join(root, 'runtime');
const profileRoot = join(root, 'profiles');
const manifestRoot = join(root, 'manifests');
const evidencePath = join(root, 'acceptance-report.json');
const chromePath = process.argv[2] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = resolve(process.argv[3] ?? 'apps/extension/dist');
const ids = ['managed-alpha-a', 'managed-alpha-b'];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), chromeFlavor: 'official', identityIds: ids, extensionPath, checks: [], ok: false };

async function main() {
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(profileRoot, { recursive: true });
mkdirSync(manifestRoot, { recursive: true });
if (!existsSync(chromePath)) return fail('CHROME_MISSING', `Chrome executable does not exist: ${chromePath}`);
if (!existsSync(join(extensionPath, 'manifest.json'))) return fail('EXTENSION_MANIFEST_MISSING', `Extension manifest does not exist: ${extensionPath}`);

process.env.KV_IDENTITY_RUNTIME_DIR = runtimeRoot;
process.env.KV_BROWSER_CDP_PIPE = '1';
process.env.KV_BROWSER_CHROME_STDERR_DIR = join(root, 'chrome-stderr');
process.env.KV_BROWSER_CHROME_VERBOSE_LOGGING = '1';
delete process.env.KV_BROWSER_EXTENSION_PATH;

const extensionId = chromeUnpackedExtensionId(extensionPath);
report.extensionId = extensionId;
const install = spawnSync(process.execPath, [join(repo, 'apps/chrome-bridge/dist/install.js'), 'install', extensionId], { cwd: repo, encoding: 'utf8', windowsHide: true });
writeFileSync(join(root, 'native-host-install.log'), `${install.stdout ?? ''}${install.stderr ?? ''}`, 'utf8');
if (install.status !== 0) return fail('NATIVE_HOST_INSTALL_FAILED', 'Native Messaging Host installation failed.');

// Keep installation compatible with the user's existing Kv-owned registry
// state, then isolate all managed Chrome/Bridge artifacts for this run.
if (process.env.MANAGED_E2E_LOCALAPPDATA) process.env.LOCALAPPDATA = resolve(process.env.MANAGED_E2E_LOCALAPPDATA);

const manifests = Object.fromEntries(ids.map((id) => [id, createManifest(id)]));
const adapter = new ChromePipeProcessAdapter();
const runtime = new IdentityRuntime(runtimeRoot, adapter);
const supervisor = new SessionSupervisor(runtimeRoot, { runtime, processAdapter: adapter, extensionPath, env: process.env, bridgeTimeoutMs: 30_000 });
const started = {};

try {
  for (const id of ids) {
    const result = await supervisor.start(manifests[id]);
    started[id] = result;
    if (!result.ok) return fail('MANAGED_SESSION_START_FAILED', `${id}: ${result.snapshot.error?.code ?? 'UNKNOWN'} ${result.snapshot.error?.message ?? ''}`);
  }
  report.checks.push({ name: 'dual_process_bridge_handshake', ok: true, sessions: ids.map((id) => sessionEvidence(started[id].snapshot)) });

  const initial = runMcp('initial');
  report.checks.push({ name: 'mcp_selection_and_routing', ok: initial.status === 0, output: 'mcp-initial.log' });
  if (initial.status !== 0) return fail('MCP_INITIAL_FAILED', 'MCP identity selection/routing check failed.');

  const profileBefore = ids.map((id) => profileEvidence(manifests[id].browser.userDataDir));
  const stopA = supervisor.stop(manifests[ids[0]]);
  const afterStop = runMcp('after-stop');
  report.checks.push({ name: 'stop_a_preserves_b', ok: stopA.ok && afterStop.status === 0, output: 'mcp-after-stop.log' });
  if (!stopA.ok || afterStop.status !== 0) return fail('STOP_A_B_FAILED', 'Stopping A affected B or MCP could not use B.');

  const oldRuntimeSessionId = started[ids[0]].snapshot.runtimeSessionId;
  const restartA = await supervisor.start(manifests[ids[0]]);
  const profileAfter = profileEvidence(manifests[ids[0]].browser.userDataDir);
  const afterRestart = restartA.ok ? runMcp('after-restart', oldRuntimeSessionId) : { status: 1 };
  report.checks.push({ name: 'restart_a_profile_and_runtime_session', ok: restartA.ok && restartA.snapshot.runtimeSessionId !== oldRuntimeSessionId && profileAfter.exists && afterRestart.status === 0, output: 'mcp-after-restart.log' });
  if (!restartA.ok || restartA.snapshot.runtimeSessionId === oldRuntimeSessionId || !profileAfter.exists || afterRestart.status !== 0) return fail('RESTART_A_FAILED', 'A did not restart with a new runtime session and retained profile state.');
  report.checks.push({ name: 'profile_persistence', ok: profileBefore[0].exists && profileAfter.exists, before: profileBefore[0], after: profileAfter });

  const stopped = ids.map((id) => supervisor.stop(manifests[id]));
  report.checks.push({ name: 'both_stopped', ok: stopped.every((result) => result.ok) });
  report.ok = report.checks.every((check) => check.ok);
  writeReport();
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  fail('E2E_FAILED', error instanceof Error ? error.message : String(error));
} finally {
  if (!report.ok) {
    for (const id of ids) { try { supervisor.stop(manifests[id]); } catch { /* best effort cleanup */ } }
  }
}
}

await main();

function createManifest(identityId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, identityId, workspaceId: 'managed-alpha', platform: 'windows', accountLabel: identityId, mode: 'native-stable',
    browser: { executablePath: chromePath, userDataDir: join(profileRoot, identityId) },
    environment: { osFamily: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1280, height: 720, deviceScaleFactor: 1 } },
    proxy: { id: 'shared-local-proxy', protocol: 'http', host: '127.0.0.1', port: 7897, authMode: 'none', countryCode: 'CN', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    policies: { webrtc: 'proxy-only', dns: 'system', ipv6: 'disabled', allowConcurrentSessions: false },
    networkVerification: { publicIpProbeUrl: 'https://api.ipify.org?format=json', timeoutMs: 30_000 },
    createdAt: now, updatedAt: now,
  };
}

function runMcp(phase, oldSessionId) {
  const env = { ...process.env, MANAGED_E2E_ALPHA: ids[0], MANAGED_E2E_BETA: ids[1], MANAGED_E2E_PHASE: phase };
  if (oldSessionId) env.MANAGED_E2E_OLD_ALPHA_SESSION = oldSessionId;
  const result = spawnSync(process.execPath, [join(repo, 'scripts/managed-multi-identity-mcp-check.mjs')], { cwd: repo, env, encoding: 'utf8', windowsHide: true });
  writeFileSync(join(root, `mcp-${phase}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`, 'utf8');
  return result;
}

function sessionEvidence(snapshot) {
  return { identityId: snapshot.identityId, runtimeSessionId: snapshot.runtimeSessionId, processAlive: snapshot.process.alive, bridgeDiscovery: snapshot.bridge.privateDiscoveryPresent, publicSession: snapshot.bridge.publicSessionPresent, extensionHandshake: snapshot.bridge.extensionHandshake, effectiveState: snapshot.effectiveState };
}

function profileEvidence(profile) {
  const preferences = join(profile, 'Default', 'Preferences');
  return { exists: existsSync(profile), preferencesPresent: existsSync(preferences), fileCount: existsSync(profile) ? countFiles(profile) : 0 };
}

function countFiles(directory) {
  try { return statSync(directory).isDirectory() ? readFileSync(join(directory, 'Local State'), 'utf8').length > 0 ? 1 : 0 : 0; } catch { return 0; }
}

function chromeUnpackedExtensionId(path) {
  const hash = createHash('sha256').update(path, 'utf16le').digest();
  let id = '';
  for (const byte of hash.subarray(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return id;
}

function writeReport() { writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
function fail(code, message) { report.error = { code, message }; writeReport(); process.exitCode = 1; }
