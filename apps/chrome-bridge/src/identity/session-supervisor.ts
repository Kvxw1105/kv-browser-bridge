import { existsSync, readFileSync, rmSync } from 'node:fs';
import { discoveryPathForIdentity, publicSessionPathForIdentity } from './bridge-context.js';
import { enforceNetworkAssessment, type NetworkEnforcementDecision, type NetworkEnforcementPolicy } from './network-enforcement.js';
import type { NetworkLeakAcceptanceReport } from './network-leak-report.js';
import type { IdentityManifest, RuntimeStatus } from './model.js';
import { IdentityRuntime, type StartResult, type StopResult } from './session.js';
import { probeProxyEndpoint, type ProxyReachabilityResult } from './network-preflight.js';
import { waitForDevToolsEndpoint } from './browser-network-probe.js';
import type { DevToolsEndpoint } from './windows-doctor.js';
import { ChromePipeProcessAdapter } from './chrome-process-adapter.js';
import type { ChromeCdpTransport } from './chrome-cdp-transport.js';
import { provisionManagedExtension, type ManagedExtensionProvisionResult } from './managed-extension-provisioner.js';

export type EffectiveSessionState = 'starting' | 'process-running' | 'bridge-ready' | 'ready' | 'warning' | 'frozen' | 'stopped' | 'failed';

export interface BridgeReadiness {
  privateDiscoveryPresent: boolean;
  publicSessionPresent: boolean;
  extensionHandshake: boolean;
  runtimeSessionId?: string;
}

export interface ManagedSessionSnapshot {
  identityId: string;
  runtimeSessionId?: string;
  process: RuntimeStatus;
  bridge: BridgeReadiness;
  devtools: { ready: boolean; port?: number };
  network?: { report: NetworkLeakAcceptanceReport; enforcement: NetworkEnforcementDecision };
  effectiveState: EffectiveSessionState;
  error?: { code: string; message: string };
}

export interface SupervisorStartResult {
  ok: boolean;
  snapshot: ManagedSessionSnapshot;
  start?: StartResult;
  stop?: StopResult;
}

export interface SessionSupervisorOptions {
  runtime?: IdentityRuntime;
  networkPolicy?: NetworkEnforcementPolicy;
  bridgeTimeoutMs?: number;
  devtoolsTimeoutMs?: number;
  probe?: (manifest: IdentityManifest) => Promise<ProxyReachabilityResult>;
  networkAssessment?: (manifest: IdentityManifest, snapshot: ManagedSessionSnapshot) => Promise<NetworkLeakAcceptanceReport | undefined>;
  env?: NodeJS.ProcessEnv;
  processAdapter?: ChromePipeProcessAdapter;
  extensionPath?: string;
}

/** Composes process, bridge and optional network observations for managed sessions. */
export class SessionSupervisor {
  private readonly runtime: IdentityRuntime;
  private readonly options: SessionSupervisorOptions;

  constructor(private readonly runtimeRoot: string, options: SessionSupervisorOptions = {}) {
    this.options = options;
    this.runtime = options.runtime ?? new IdentityRuntime(runtimeRoot, options.processAdapter);
  }

  async start(manifest: IdentityManifest): Promise<SupervisorStartResult> {
    const runtimeEnv = this.options.processAdapter ? { ...globalThis.process.env, ...this.options.env, KV_BROWSER_CDP_PIPE: '1' } : this.options.env;
    const started = await this.runtime.startVerified(manifest, runtimeEnv, this.options.probe ?? probeProxyEndpoint);
    if (!started.ok) return { ok: false, start: started, snapshot: this.snapshot(manifest, this.runtime.status(manifest), undefined, undefined, undefined, 'failed', started.error) };
    const runtimeStatus = this.runtime.status(manifest);
    const devtools = this.options.processAdapter
      ? { ready: true }
      : await waitForDevToolsEndpoint(manifest.browser.userDataDir, this.options.devtoolsTimeoutMs ?? 15_000);
    if (!devtools) return this.failAndStop(manifest, started, 'DEVTOOLS_NOT_READY', 'Chrome did not expose a DevTools endpoint.');
    let provision: ManagedExtensionProvisionResult | undefined;
    let transport: ChromeCdpTransport | undefined;
    if (this.options.extensionPath) {
      const pid = started.receipt?.pid;
      transport = pid ? this.options.processAdapter?.transportFor(pid) : undefined;
      if (!transport) return this.failAndStop(manifest, started, 'CDP_PIPE_UNAVAILABLE', 'Managed extension provisioning requires a live Chrome CDP pipe.');
      provision = await provisionManagedExtension(transport, this.options.extensionPath);
      if (!provision.ok) return this.failAndStop(manifest, started, provision.error?.code ?? 'EXTENSION_LOAD_FAILED', provision.error?.message ?? 'Managed extension provisioning failed.');
    }
    const bridge = await this.waitForBridge(manifest, this.options.bridgeTimeoutMs ?? 15_000);
    if (transport && provision?.activationTargetId) {
      await transport.request('Target.closeTarget', { targetId: provision.activationTargetId }).catch(() => undefined);
    }
    if (!bridge.extensionHandshake) return this.failAndStop(manifest, started, 'BRIDGE_NOT_READY', 'Identity Bridge discovery or extension handshake was not ready.');
    let snapshot = this.snapshot(manifest, runtimeStatus, bridge, devtools);
    const report = this.options.networkAssessment ? await this.options.networkAssessment(manifest, snapshot) : undefined;
    if (report) {
      const enforcement = enforceNetworkAssessment(report, this.options.networkPolicy);
      snapshot = { ...snapshot, network: { report, enforcement }, effectiveState: enforcement.action === 'freeze' ? 'frozen' : enforcement.action === 'stop' ? 'stopped' : enforcement.action === 'warn' ? 'warning' : 'ready' };
      if (enforcement.action === 'stop') return { ok: false, start: started, stop: this.runtime.stop(manifest), snapshot: this.snapshot(manifest, this.runtime.status(manifest), bridge, devtools, snapshot.network, 'stopped') };
    }
    return { ok: true, start: started, snapshot };
  }

  stop(manifest: IdentityManifest): StopResult {
    const runtimeSessionId = readRuntimeSessionId(this.runtimeRoot, manifest.identityId);
    const result = this.runtime.stop(manifest);
    if (result.ok) removeBridgeArtifacts(manifest, this.options.env, runtimeSessionId);
    return result;
  }

  status(manifest: IdentityManifest): ManagedSessionSnapshot { return this.snapshot(manifest); }

  private async waitForBridge(manifest: IdentityManifest, timeoutMs: number): Promise<BridgeReadiness> {
    const deadline = Date.now() + timeoutMs;
    let readiness = this.bridgeReadiness(manifest);
    while (!readiness.extensionHandshake && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      readiness = this.bridgeReadiness(manifest);
    }
    return readiness;
  }

  private bridgeReadiness(manifest: IdentityManifest): BridgeReadiness {
    const env = this.options.env;
    const privatePath = discoveryPathForIdentity({ identityId: manifest.identityId, workspaceId: manifest.workspaceId, platform: manifest.platform, runtimeSessionId: readRuntimeSessionId(this.runtimeRoot, manifest.identityId) }, env);
    const publicPath = publicSessionPathForIdentity({ identityId: manifest.identityId, workspaceId: manifest.workspaceId, platform: manifest.platform, runtimeSessionId: readRuntimeSessionId(this.runtimeRoot, manifest.identityId) }, env);
    const privateDiscoveryPresent = existsSync(privatePath);
    const publicSessionPresent = existsSync(publicPath);
    const runtimeSessionId = readRuntimeSessionId(this.runtimeRoot, manifest.identityId);
    let handshakeRuntimeSessionId: string | undefined;
    try {
      const value = JSON.parse(readFileSync(publicPath, 'utf8')) as { identity?: { runtimeSessionId?: unknown } };
      handshakeRuntimeSessionId = typeof value.identity?.runtimeSessionId === 'string' ? value.identity.runtimeSessionId : undefined;
    } catch { /* The extension may be between atomic writes. */ }
    return { privateDiscoveryPresent, publicSessionPresent, extensionHandshake: Boolean(privateDiscoveryPresent && publicSessionPresent && runtimeSessionId && handshakeRuntimeSessionId === runtimeSessionId), runtimeSessionId: handshakeRuntimeSessionId };
  }

  private snapshot(manifest: IdentityManifest, process = this.runtime.status(manifest), bridge = this.bridgeReadiness(manifest), devtools?: DevToolsEndpoint | { ready: boolean; port?: number }, network?: ManagedSessionSnapshot['network'], effectiveState?: EffectiveSessionState, error?: { code: string; message: string }): ManagedSessionSnapshot {
    const devtoolsReady = 'ready' in (devtools ?? {}) ? Boolean((devtools as { ready: boolean }).ready) : Boolean((devtools as DevToolsEndpoint | undefined)?.websocketUrl);
    return { identityId: manifest.identityId, runtimeSessionId: bridge.runtimeSessionId ?? readRuntimeSessionId(this.runtimeRoot, manifest.identityId), process, bridge, devtools: { ready: devtoolsReady, port: devtools && 'port' in devtools ? devtools.port : undefined }, network, effectiveState: effectiveState ?? (process.state === 'running' ? bridge.extensionHandshake ? 'ready' : 'process-running' : process.state === 'stopped' ? 'stopped' : 'failed'), error };
  }

  private async failAndStop(manifest: IdentityManifest, started: StartResult, code: string, message: string): Promise<SupervisorStartResult> {
    const stop = this.runtime.stop(manifest);
    if (stop.ok) removeBridgeArtifacts(manifest, this.options.env, started.receipt?.runtimeSessionId);
    return { ok: false, start: started, stop, snapshot: this.snapshot(manifest, this.runtime.status(manifest), undefined, undefined, undefined, 'failed', { code, message }) };
  }
}

function readRuntimeSessionId(rootDir: string, identityId: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(`${rootDir}/${identityId}/runtime/session-receipt.json`, 'utf8')) as { runtimeSessionId?: unknown };
    return typeof value.runtimeSessionId === 'string' ? value.runtimeSessionId : undefined;
  } catch { return undefined; }
}

function removeBridgeArtifacts(manifest: IdentityManifest, env: NodeJS.ProcessEnv | undefined, runtimeSessionId: string | undefined): void {
  if (!runtimeSessionId) return;
  const identity = { identityId: manifest.identityId, workspaceId: manifest.workspaceId, platform: manifest.platform, runtimeSessionId };
  const privatePath = discoveryPathForIdentity(identity, env);
  const publicPath = publicSessionPathForIdentity(identity, env);
  removeIfOwned(privatePath, identity);
  removeIfOwned(publicPath, identity);
}

function removeIfOwned(path: string, identity: { identityId: string; runtimeSessionId: string }): void {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { identity?: { identityId?: unknown; runtimeSessionId?: unknown } };
    if (value.identity?.identityId === identity.identityId && value.identity.runtimeSessionId === identity.runtimeSessionId) rmSync(path, { force: true });
  } catch { /* Missing or concurrently removed artifacts are already clean. */ }
}
