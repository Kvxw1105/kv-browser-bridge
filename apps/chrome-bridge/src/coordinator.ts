import {
  type AgentCapability,
  type AgentIdentity,
  type AgentSession,
  type CoordinatorMode,
  type CoordinationStatus,
  type LeaseResource,
  type LeaseState,
  type ResourceLease,
} from '@kv-browser-bridge/browser-protocol';

const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 300_000;
const DEFAULT_QUARANTINE_TTL_MS = 30_000;
const MAX_CONFLICT_HISTORY = 1_000;

export type CoordinatorErrorCode =
  | 'INVALID_REQUEST'
  | 'RESOURCE_BUSY'
  | 'RESOURCE_QUARANTINED'
  | 'LEASE_NOT_OWNED';

export interface CoordinatorErrorDetails {
  [key: string]: unknown;
}

/** Error shape consumed by the Bridge's existing BridgeError mapper. */
export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly retryable: boolean;
  readonly details: CoordinatorErrorDetails;

  constructor(
    code: CoordinatorErrorCode,
    message: string,
    retryable: boolean,
    details: CoordinatorErrorDetails = {},
  ) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface CoordinationConflict {
  sessionId: string;
  resource: LeaseResource;
  owner: string;
  purpose: string;
  retryAfterMs: number;
}

export interface MultiAgentCoordinatorOptions {
  mode: CoordinatorMode;
  now?: () => number;
  onConflict?: (conflict: CoordinationConflict) => void;
}

interface QueueTail {
  done: Promise<void>;
  release: () => void;
}

/**
 * Process-local coordination state. It deliberately owns no sockets, timers,
 * filesystem state, or browser handles; Bridge integration drives its clock
 * and cleanup by calling the public methods.
 */
export class MultiAgentCoordinator {
  private readonly mode: CoordinatorMode;
  private readonly now: () => number;
  private readonly onConflict?: (conflict: CoordinationConflict) => void;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly leases = new Map<string, ResourceLease>();
  private readonly leasesByResource = new Map<LeaseResource, Set<string>>();
  private readonly queues = new Map<number, QueueTail>();
  private readonly conflictHistory: CoordinationConflict[] = [];
  private nextLeaseId = 1;

  constructor(options: MultiAgentCoordinatorOptions) {
    if (!options || !['off', 'observe', 'enforce'].includes(options.mode)) {
      throw new CoordinatorError('INVALID_REQUEST', 'Invalid coordinator mode', false);
    }
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    this.onConflict = options.onConflict;
  }

  connect(identity: AgentIdentity, sessionId: string): AgentSession {
    const normalizedSessionId = normalizeText(sessionId, 'sessionId');
    const normalizedIdentity = normalizeIdentity(identity);
    if (this.sessions.has(normalizedSessionId)) {
      throw new CoordinatorError('INVALID_REQUEST', 'Coordinator session is already connected', false, {
        sessionId: normalizedSessionId,
      });
    }
    this.cleanupExpired();
    const timestamp = iso(this.now());
    const session: AgentSession = {
      ...normalizedIdentity,
      sessionId: normalizedSessionId,
      connectedAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.sessions.set(normalizedSessionId, session);
    return copySession(session);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeenAt = iso(this.now());
    this.cleanupExpired();
  }

  disconnect(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.cleanupExpired();
    for (const lease of [...this.leases.values()]) {
      if (lease.ownerSessionId === sessionId && lease.state === 'active') {
        this.deleteLease(lease.id);
      }
    }
  }

  setDefaultTab(sessionId: string, tabId: number): void {
    const session = this.requireSession(sessionId);
    validateTabId(tabId);
    session.defaultTabId = tabId;
    session.lastSeenAt = iso(this.now());
  }

  resolveTab(sessionId: string, suppliedTabId?: number): number | undefined {
    const session = this.requireSession(sessionId);
    if (suppliedTabId !== undefined) {
      validateTabId(suppliedTabId);
      return suppliedTabId;
    }
    return session.defaultTabId;
  }

  status(): CoordinationStatus {
    this.cleanupExpired();
    return {
      mode: this.mode,
      clients: [...this.sessions.values()].map(copySession),
      leases: [...this.leases.values()].map(copyLease),
    };
  }

  /** Returns observed conflicts for diagnostics without exposing mutable state. */
  conflicts(): CoordinationConflict[] {
    return this.conflictHistory.map((conflict) => ({ ...conflict }));
  }

  acquire(sessionId: string, resource: LeaseResource, purpose: string, ttlMs: number): ResourceLease {
    this.requireSession(sessionId);
    const normalizedResource = validateResource(resource);
    const normalizedPurpose = normalizeText(purpose, 'purpose');
    const ttl = validateTtl(ttlMs);
    this.cleanupExpired();

    const resourceLeases = this.activeResourceLeases(normalizedResource);
    const ownLease = resourceLeases.find((lease) => lease.ownerSessionId === sessionId);
    if (ownLease) {
      ownLease.expiresAt = iso(this.now() + ttl);
      return copyLease(ownLease);
    }

    const blockingLease = resourceLeases.find((lease) => lease.state === 'quarantined');
    if (blockingLease) throw this.quarantinedError(blockingLease);
    const currentLease = resourceLeases[0];
    if (currentLease) {
      const conflict = this.recordConflict(sessionId, currentLease, this.retryAfter(currentLease));
      if (this.mode === 'enforce') {
        throw this.busyError(currentLease, this.retryAfter(currentLease));
      }
      if (this.mode === 'observe') this.emitConflict(conflict);
    }

    const lease = this.createLease(normalizedResource, sessionId, normalizedPurpose, ttl, 'active');
    return copyLease(lease);
  }

  renew(sessionId: string, leaseId: string, ttlMs: number): ResourceLease {
    const ttl = validateTtl(ttlMs);
    this.cleanupExpired();
    const lease = this.leases.get(leaseId);
    if (!lease || lease.ownerSessionId !== sessionId) {
      throw new CoordinatorError('LEASE_NOT_OWNED', 'Lease is not owned by this session', false, {
        leaseId,
      });
    }
    lease.expiresAt = iso(this.now() + ttl);
    return copyLease(lease);
  }

  release(sessionId: string, leaseId: string): void {
    this.cleanupExpired();
    const lease = this.leases.get(leaseId);
    if (!lease || lease.ownerSessionId !== sessionId) {
      throw new CoordinatorError('LEASE_NOT_OWNED', 'Lease is not owned by this session', false, {
        leaseId,
      });
    }
    this.deleteLease(leaseId);
  }

  assertWriteAllowed(sessionId: string, tabId: number): void {
    validateTabId(tabId);
    this.requireSession(sessionId);
    if (this.mode === 'off') return;
    this.cleanupExpired();
    const resource = `tab:${tabId}` as LeaseResource;
    const leases = this.activeResourceLeases(resource);
    const quarantine = leases.find((lease) => lease.state === 'quarantined' && lease.ownerSessionId !== sessionId);
    if (quarantine) throw this.quarantinedError(quarantine);
    const ownerLease = leases.find((lease) => lease.ownerSessionId !== sessionId && lease.state === 'active');
    if (!ownerLease) return;
    const conflict = this.recordConflict(sessionId, ownerLease, this.retryAfter(ownerLease));
    if (this.mode === 'enforce') throw this.busyError(ownerLease, conflict.retryAfterMs);
    this.emitConflict(conflict);
  }

  quarantineTab(sessionId: string, tabId: number, ttlMs = DEFAULT_QUARANTINE_TTL_MS): ResourceLease {
    this.requireSession(sessionId);
    validateTabId(tabId);
    const ttl = validateTtl(ttlMs);
    this.cleanupExpired();
    const resource = `tab:${tabId}` as LeaseResource;
    const resourceLeases = this.activeResourceLeases(resource);
    const otherActiveLease = resourceLeases.find(
      (lease) => lease.state === 'active' && lease.ownerSessionId !== sessionId,
    );
    if (otherActiveLease) {
      throw this.busyError(otherActiveLease, this.retryAfter(otherActiveLease));
    }
    const ownLease = resourceLeases.find((lease) => lease.ownerSessionId === sessionId);
    if (ownLease) {
      ownLease.state = 'quarantined';
      ownLease.expiresAt = iso(this.now() + ttl);
      return copyLease(ownLease);
    }
    const otherQuarantine = resourceLeases.find(
      (lease) => lease.state === 'quarantined' && lease.ownerSessionId !== sessionId,
    );
    if (otherQuarantine) throw this.quarantinedError(otherQuarantine);
    return copyLease(this.createLease(resource, sessionId, 'UNKNOWN_OUTCOME', ttl, 'quarantined'));
  }

  runTabWrite<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    validateTabId(tabId);
    if (typeof work !== 'function') {
      return Promise.reject(new CoordinatorError('INVALID_REQUEST', 'Write work must be a function', false));
    }
    const previous = this.queues.get(tabId)?.done ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(tabId, { done, release });
    return previous.then(async () => {
      try {
        return await work();
      } finally {
        release();
        if (this.queues.get(tabId)?.done === done) this.queues.delete(tabId);
      }
    });
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new CoordinatorError('INVALID_REQUEST', 'Unknown coordinator session', false, { sessionId });
    }
    return session;
  }

  private createLease(
    resource: LeaseResource,
    ownerSessionId: string,
    purpose: string,
    ttlMs: number,
    state: LeaseState,
  ): ResourceLease {
    const lease: ResourceLease = {
      id: `lease-${this.nextLeaseId++}`,
      resource,
      ownerSessionId,
      purpose,
      state,
      acquiredAt: iso(this.now()),
      expiresAt: iso(this.now() + ttlMs),
    };
    this.leases.set(lease.id, lease);
    let ids = this.leasesByResource.get(resource);
    if (!ids) {
      ids = new Set<string>();
      this.leasesByResource.set(resource, ids);
    }
    ids.add(lease.id);
    return lease;
  }

  private activeResourceLeases(resource: LeaseResource): ResourceLease[] {
    const ids = this.leasesByResource.get(resource);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.leases.get(id))
      .filter((lease): lease is ResourceLease => Boolean(lease));
  }

  private deleteLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    const ids = this.leasesByResource.get(lease.resource);
    ids?.delete(leaseId);
    if (ids?.size === 0) this.leasesByResource.delete(lease.resource);
  }

  private cleanupExpired(): void {
    const current = this.now();
    for (const lease of [...this.leases.values()]) {
      if (Date.parse(lease.expiresAt) <= current) this.deleteLease(lease.id);
    }
  }

  private recordConflict(sessionId: string, ownerLease: ResourceLease, retryAfterMs: number): CoordinationConflict {
    const owner = this.sessions.get(ownerLease.ownerSessionId)?.clientName ?? 'unknown-agent';
    return {
      sessionId,
      resource: ownerLease.resource,
      owner,
      purpose: ownerLease.purpose,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    };
  }

  private emitConflict(conflict: CoordinationConflict): void {
    this.conflictHistory.push({ ...conflict });
    if (this.conflictHistory.length > MAX_CONFLICT_HISTORY) this.conflictHistory.shift();
    this.onConflict?.({ ...conflict });
  }

  private retryAfter(lease: ResourceLease): number {
    return Math.max(0, Date.parse(lease.expiresAt) - this.now());
  }

  private busyError(lease: ResourceLease, retryAfterMs: number): CoordinatorError {
    const owner = this.sessions.get(lease.ownerSessionId)?.clientName ?? 'unknown-agent';
    return new CoordinatorError('RESOURCE_BUSY', 'Browser resource is owned by another Agent', true, {
      resource: lease.resource,
      owner,
      purpose: lease.purpose,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    });
  }

  private quarantinedError(lease: ResourceLease): CoordinatorError {
    const owner = this.sessions.get(lease.ownerSessionId)?.clientName ?? 'unknown-agent';
    return new CoordinatorError('RESOURCE_QUARANTINED', 'Browser tab requires outcome verification', true, {
      resource: lease.resource,
      owner,
      purpose: lease.purpose,
      retryAfterMs: this.retryAfter(lease),
    });
  }
}

function normalizeIdentity(identity: AgentIdentity): AgentIdentity {
  if (!identity || typeof identity !== 'object') {
    throw new CoordinatorError('INVALID_REQUEST', 'Agent identity is required', false);
  }
  const capabilities = identity.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some((value) => !isCapability(value))) {
    throw new CoordinatorError('INVALID_REQUEST', 'Agent capabilities are invalid', false);
  }
  const uniqueCapabilities = [...new Set(capabilities)];
  return {
    clientId: normalizeText(identity.clientId, 'clientId'),
    clientName: normalizeText(identity.clientName, 'clientName'),
    instanceId: normalizeText(identity.instanceId, 'instanceId'),
    capabilities: uniqueCapabilities,
  };
}

function isCapability(value: unknown): value is AgentCapability {
  return value === 'read' || value === 'write' || value === 'record';
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CoordinatorError('INVALID_REQUEST', `${field} must be a string`, false, { field });
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new CoordinatorError('INVALID_REQUEST', `${field} must be between 1 and 100 characters`, false, { field });
  }
  return normalized;
}

function validateTtl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new CoordinatorError('INVALID_REQUEST', `Lease TTL must be ${MIN_LEASE_TTL_MS}-${MAX_LEASE_TTL_MS} ms`, false, {
      ttlMs,
      minTtlMs: MIN_LEASE_TTL_MS,
      maxTtlMs: MAX_LEASE_TTL_MS,
    });
  }
  return ttlMs;
}

function validateTabId(tabId: number): void {
  if (!Number.isInteger(tabId) || tabId < 1) {
    throw new CoordinatorError('INVALID_REQUEST', 'tabId must be a positive integer', false, { tabId });
  }
}

function validateResource(resource: LeaseResource): LeaseResource {
  if (resource === 'global:recorder') return resource;
  if (typeof resource === 'string' && /^tab:[1-9]\d*$/.test(resource)) {
    return resource as LeaseResource;
  }
  throw new CoordinatorError('INVALID_REQUEST', 'Lease resource is invalid', false, { resource });
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function copySession(session: AgentSession): AgentSession {
  return { ...session, capabilities: [...session.capabilities] };
}

function copyLease(lease: ResourceLease): ResourceLease {
  return { ...lease };
}
