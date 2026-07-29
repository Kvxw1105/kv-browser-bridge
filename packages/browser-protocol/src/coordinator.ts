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

export interface CoordinationStatusView {
  mode: CoordinatorMode;
  clients: Array<Pick<AgentSession, 'clientId' | 'clientName' | 'defaultTabId'>>;
  leases: Array<Pick<ResourceLease, 'resource' | 'purpose' | 'state' | 'expiresAt'>>;
}

/**
 * Project the in-process coordination state onto the transport-safe view.
 * Keep this explicit so newly added session or lease fields cannot leak by
 * accident through a spread or JSON serialization of the full status.
 */
export function toCoordinationStatusView(status: CoordinationStatus): CoordinationStatusView {
  return {
    mode: status.mode,
    clients: status.clients.map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName,
      ...(client.defaultTabId === undefined ? {} : { defaultTabId: client.defaultTabId }),
    })),
    leases: status.leases.map((lease) => ({
      resource: lease.resource,
      purpose: lease.purpose,
      state: lease.state,
      expiresAt: lease.expiresAt,
    })),
  };
}

/** Return the transport-safe coordination status object used by bridge/native messages. */
export function serializeCoordinationStatus(status: CoordinationStatus): CoordinationStatusView {
  return toCoordinationStatusView(status);
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
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
