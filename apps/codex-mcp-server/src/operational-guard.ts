import { assertSelectedBridge } from './identity-selection.js';
import {
  assertNetworkIdentityReady,
  readNetworkIdentityRecord,
  type BridgeIdentityStatus,
  type NetworkIdentityRecord,
} from './network-guard.js';

export function assertOperationalIdentityReady(
  expectedIdentityId: string,
  bridgeStatus: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): NetworkIdentityRecord {
  assertSelectedBridge(expectedIdentityId, bridgeStatus);
  return assertNetworkIdentityReady(expectedIdentityId, bridgeStatus as BridgeIdentityStatus, env, platform);
}

export function networkIdentitySummary(
  identityId: string,
  bridgeStatus?: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Record<string, unknown> {
  const record = readNetworkIdentityRecord(identityId, env, platform);
  const runtimeSessionId = typeof bridgeStatus === 'object' && bridgeStatus !== null
    ? (bridgeStatus as { identity?: { runtimeSessionId?: unknown } }).identity?.runtimeSessionId
    : undefined;
  return {
    identityId,
    state: record?.state ?? 'unverified',
    publicIp: record?.publicIp,
    baselinePublicIp: record?.baselinePublicIp,
    observedAt: record?.observedAt,
    reasons: record?.reasons ?? [],
    collisionWith: record?.collisionWith ?? [],
    runtimeSessionCurrent: typeof runtimeSessionId === 'string'
      && typeof record?.runtimeSessionId === 'string'
      && runtimeSessionId === record.runtimeSessionId,
  };
}
