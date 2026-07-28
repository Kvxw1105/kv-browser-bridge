import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type NetworkIdentityRecord = {
  schemaVersion: 1;
  identityId: string;
  publicIp: string;
  baselinePublicIp: string;
  probeUrl: string;
  observedAt: string;
  runtimeSessionId?: string;
  state: 'verified' | 'frozen';
  reasons: string[];
  collisionWith: string[];
  updatedAt: string;
};

export type BridgeIdentityStatus = {
  identity?: {
    identityId?: string;
    runtimeSessionId?: string;
  };
};

export type NetworkGuardErrorCode =
  | 'NETWORK_IDENTITY_UNVERIFIED'
  | 'NETWORK_IDENTITY_FROZEN'
  | 'NETWORK_IDENTITY_STALE';

export class NetworkGuardError extends Error {
  constructor(
    readonly code: NetworkGuardErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NetworkGuardError';
  }
}

export function networkIdentityRecordPath(
  identityId: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const root = defaultRuntimeRoot(env, platform);
  return join(root, identityId, 'network', 'network-identity.json');
}

export function readNetworkIdentityRecord(
  identityId: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): NetworkIdentityRecord | undefined {
  const path = networkIdentityRecordPath(identityId, env, platform);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as NetworkIdentityRecord;
    return record.schemaVersion === 1 && record.identityId === identityId ? record : undefined;
  } catch {
    return undefined;
  }
}

export function assertNetworkIdentityReady(
  identityId: string,
  bridgeStatus: BridgeIdentityStatus,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): NetworkIdentityRecord {
  const record = readNetworkIdentityRecord(identityId, env, platform);
  if (!record) {
    throw new NetworkGuardError(
      'NETWORK_IDENTITY_UNVERIFIED',
      `Identity ${identityId} has no verified browser network observation for the current runtime.`,
    );
  }
  if (record.state === 'frozen') {
    throw new NetworkGuardError(
      'NETWORK_IDENTITY_FROZEN',
      `Identity ${identityId} is frozen because its network identity is unsafe.`,
      { reasons: record.reasons, collisionWith: record.collisionWith, publicIp: record.publicIp },
    );
  }
  const runtimeSessionId = bridgeStatus.identity?.runtimeSessionId;
  if (!runtimeSessionId || record.runtimeSessionId !== runtimeSessionId) {
    throw new NetworkGuardError(
      'NETWORK_IDENTITY_STALE',
      `Identity ${identityId} network verification does not belong to the current browser runtime session.`,
      { verifiedRuntimeSessionId: record.runtimeSessionId, currentRuntimeSessionId: runtimeSessionId },
    );
  }
  return record;
}

function defaultRuntimeRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.KV_IDENTITY_RUNTIME_DIR) return env.KV_IDENTITY_RUNTIME_DIR;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'KvBrowserBridge', 'identities');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'KvBrowserBridge', 'identities');
}
