/** Transport-neutral contracts for coordinating multiple bridge clients. */

export type CoordinatorMode = 'off' | 'observe' | 'enforce';
export type AgentCapability = 'read' | 'write' | 'record';
export type LeaseResource = `tab:${number}` | 'global:recorder';
export type LeaseState = 'active' | 'quarantined';

export interface AgentIdentity {
  clientId: string;
  clientName: string;
  instanceId: string;
  capabilities: AgentCapability[];
}

export interface AgentSession extends AgentIdentity {
  sessionId: string;
  connectedAt: string;
  lastSeenAt: string;
  defaultTabId?: number;
}

export interface ResourceLease {
  id: string;
  resource: LeaseResource;
  ownerSessionId: string;
  purpose: string;
  state: LeaseState;
  acquiredAt: string;
  expiresAt: string;
}

export interface CoordinationStatus {
  mode: CoordinatorMode;
  clients: AgentSession[];
  leases: ResourceLease[];
}

export type CoordinationPipeMethod =
  | 'browser_get_clients'
  | 'browser_lease_acquire'
  | 'browser_lease_renew'
  | 'browser_lease_release'
  | 'browser_lease_status';

export function isAgentCapability(value: unknown): value is AgentCapability {
  return value === 'read' || value === 'write' || value === 'record';
}

export function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (!isRecord(value)
    || !isNonEmptyString(value.clientId)
    || !isNonEmptyString(value.clientName)
    || !isNonEmptyString(value.instanceId)
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every(isAgentCapability)) {
    return false;
  }
  return new Set(value.capabilities).size === value.capabilities.length;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
