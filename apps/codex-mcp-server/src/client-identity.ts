import { randomUUID } from 'node:crypto';

export type ClientCapability = 'read' | 'write' | 'record';

export interface ClientIdentity {
  clientId: string;
  clientName: string;
  instanceId: string;
  capabilities: ClientCapability[];
}

const MAX_IDENTIFIER_LENGTH = 100;
const INVALID_IDENTIFIER_CHARS = /[^A-Za-z0-9._-]+/g;

/** Normalize a client identifier without allowing whitespace, secrets, or path-like values. */
export function normalizeClientIdentifier(raw: string | undefined, fallback: string, field = 'client identifier'): string {
  const source = raw === undefined ? fallback : raw;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  const normalized = source.trim().replace(INVALID_IDENTIFIER_CHARS, '-').replace(/^[._-]+|[._-]+$/g, '');
  if (normalized.length === 0) throw new Error(`${field} must contain an alphanumeric character.`);
  if (normalized.length > MAX_IDENTIFIER_LENGTH) throw new Error(`${field} must be at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  return normalized;
}

export function normalizeClientName(raw: string | undefined, fallback = 'Codex'): string {
  const source = raw === undefined ? fallback : raw;
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('KBB_CLIENT_NAME must not be empty.');
  const normalized = source.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (normalized.length === 0) throw new Error('KBB_CLIENT_NAME must not be empty.');
  if (normalized.length > MAX_IDENTIFIER_LENGTH) throw new Error(`KBB_CLIENT_NAME must be at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  return normalized;
}

export function createClientIdentity(env: NodeJS.ProcessEnv = process.env): ClientIdentity {
  const clientId = normalizeClientIdentifier(env.KBB_CLIENT_ID, 'codex', 'KBB_CLIENT_ID');
  const clientName = normalizeClientName(env.KBB_CLIENT_NAME);
  const instanceId = normalizeClientIdentifier(env.KBB_CLIENT_INSTANCE, randomUUID(), 'KBB_CLIENT_INSTANCE');
  return { clientId, clientName, instanceId, capabilities: ['read', 'write', 'record'] };
}
