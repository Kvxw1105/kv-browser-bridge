import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PublicIdentitySession {
  schemaVersion: 1;
  identity: {
    identityId: string;
    workspaceId?: string;
    platform?: string;
    runtimeSessionId?: string;
  };
  pid: number;
  startedAt: string;
  protocolVersion: number;
}

export interface IdentitySessionSummary extends PublicIdentitySession {
  registryPath: string;
  discoveryPath: string;
  discoveryPresent: boolean;
  processAlive: boolean;
}

export function identityRegistryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(appData, 'KvBrowserBridge');
}

export function privateDiscoveryPath(identityId: string, env: NodeJS.ProcessEnv = process.env): string {
  validateIdentityId(identityId);
  return join(identityRegistryRoot(env), 'identities', identityId, 'bridge.json');
}

export async function listIdentitySessions(env: NodeJS.ProcessEnv = process.env): Promise<IdentitySessionSummary[]> {
  const sessionsDir = join(identityRegistryRoot(env), 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sessions: IdentitySessionSummary[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const registryPath = join(sessionsDir, entry);
    try {
      const record = parsePublicIdentitySession(JSON.parse(await readFile(registryPath, 'utf8')));
      const discoveryPath = privateDiscoveryPath(record.identity.identityId, env);
      sessions.push({
        ...record,
        registryPath,
        discoveryPath,
        discoveryPresent: existsSync(discoveryPath),
        processAlive: processAlive(record.pid),
      });
    } catch {
      // One corrupt or partially written session must not hide healthy identities.
    }
  }
  return sessions;
}

export async function resolveIdentityDiscovery(identityId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  validateIdentityId(identityId);
  const sessions = await listIdentitySessions(env);
  const session = sessions.find((candidate) => candidate.identity.identityId === identityId);
  if (!session) throw new Error(`Identity session ${identityId} is not registered.`);
  if (!session.processAlive) throw new Error(`Identity session ${identityId} is not running.`);
  if (!session.discoveryPresent) throw new Error(`Identity session ${identityId} has no private Bridge discovery file.`);
  await stat(session.discoveryPath);
  return session.discoveryPath;
}

export function parsePublicIdentitySession(value: unknown): PublicIdentitySession {
  if (typeof value !== 'object' || value === null) throw new Error('Session record must be an object.');
  const record = value as Record<string, unknown>;
  const identity = record.identity as Record<string, unknown> | undefined;
  if (record.schemaVersion !== 1 || !identity || typeof identity.identityId !== 'string') throw new Error('Invalid identity session record.');
  validateIdentityId(identity.identityId);
  if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) throw new Error('Invalid identity session PID.');
  if (typeof record.startedAt !== 'string' || typeof record.protocolVersion !== 'number') throw new Error('Invalid identity session metadata.');
  return {
    schemaVersion: 1,
    identity: {
      identityId: identity.identityId,
      workspaceId: optionalString(identity.workspaceId),
      platform: optionalString(identity.platform),
      runtimeSessionId: optionalString(identity.runtimeSessionId),
    },
    pid: Number(record.pid),
    startedAt: record.startedAt,
    protocolVersion: record.protocolVersion,
  };
}

function validateIdentityId(identityId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(identityId)) throw new Error('identityId must be a stable lowercase slug.');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
