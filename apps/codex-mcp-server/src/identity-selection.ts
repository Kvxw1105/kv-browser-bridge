import type { BridgeStatus } from './bridge-client.js';
import type { IdentitySessionSummary } from './identity-registry.js';

export interface SelectedIdentityState {
  identityId?: string;
  discoveryPath?: string;
  selectedAt?: string;
}

export function publicIdentitySession(summary: IdentitySessionSummary): Record<string, unknown> {
  return {
    identity: summary.identity,
    pid: summary.pid,
    startedAt: summary.startedAt,
    protocolVersion: summary.protocolVersion,
    processAlive: summary.processAlive,
    discoveryPresent: summary.discoveryPresent,
    selectable: summary.processAlive && summary.discoveryPresent,
  };
}

export function publicSelectedIdentity(state: SelectedIdentityState): Record<string, unknown> | null {
  if (!state.identityId) return null;
  return {
    identityId: state.identityId,
    selectedAt: state.selectedAt,
  };
}

export function publicBridgeClientStatus(status: BridgeStatus, identitySelected: boolean): Record<string, unknown> {
  const { endpoint: _privateEndpoint, ...safe } = status;
  return identitySelected ? safe : status;
}

export function bridgeIdentityId(status: unknown): string | undefined {
  if (typeof status !== 'object' || status === null) return undefined;
  const identity = (status as { identity?: unknown }).identity;
  if (typeof identity !== 'object' || identity === null) return undefined;
  const identityId = (identity as { identityId?: unknown }).identityId;
  return typeof identityId === 'string' ? identityId : undefined;
}

export function assertSelectedBridge(expectedIdentityId: string, bridgeStatus: unknown): void {
  const actualIdentityId = bridgeIdentityId(bridgeStatus);
  if (actualIdentityId !== expectedIdentityId) {
    throw new Error(`Selected identity ${expectedIdentityId} resolved to Bridge identity ${actualIdentityId ?? 'unbound'}.`);
  }
  const status = bridgeStatus as { nativeReady?: unknown; extensionConnected?: unknown; extensionHandshake?: unknown };
  if (status.nativeReady !== true || status.extensionConnected !== true || typeof status.extensionHandshake !== 'object' || status.extensionHandshake === null) {
    throw new Error(`Selected identity ${expectedIdentityId} has not completed its extension handshake.`);
  }
}
