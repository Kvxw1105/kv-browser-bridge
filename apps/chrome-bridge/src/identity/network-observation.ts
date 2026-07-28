import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export type NetworkIdentityState = 'verified' | 'frozen';

export interface BrowserNetworkObservation {
  publicIp: string;
  probeUrl: string;
  observedAt: string;
  runtimeSessionId?: string;
}

export interface NetworkIdentityRecord extends BrowserNetworkObservation {
  schemaVersion: 1;
  identityId: string;
  baselinePublicIp: string;
  state: NetworkIdentityState;
  reasons: string[];
  collisionWith: string[];
  updatedAt: string;
}

export interface RecordObservationOptions {
  expectedPublicIps?: string[];
  collisionWindowMs?: number;
  now?: () => Date;
}

const IDENTITY_SLUG = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DEFAULT_COLLISION_WINDOW_MS = 72 * 60 * 60 * 1000;

export function networkRecordPath(rootDir: string, identityId: string): string {
  assertIdentityId(identityId);
  return join(rootDir, identityId, 'network', 'network-identity.json');
}

export function readNetworkIdentityRecord(rootDir: string, identityId: string): NetworkIdentityRecord | undefined {
  const path = networkRecordPath(rootDir, identityId);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as NetworkIdentityRecord;
    if (value.schemaVersion !== 1 || value.identityId !== identityId || !isIP(value.publicIp) || !isIP(value.baselinePublicIp)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function listNetworkIdentityRecords(rootDir: string): NetworkIdentityRecord[] {
  if (!existsSync(rootDir)) return [];
  const records: NetworkIdentityRecord[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !IDENTITY_SLUG.test(entry.name)) continue;
    const record = readNetworkIdentityRecord(rootDir, entry.name);
    if (record) records.push(record);
  }
  return records;
}

export function recordNetworkObservation(
  rootDir: string,
  identityId: string,
  observation: BrowserNetworkObservation,
  options: RecordObservationOptions = {},
): NetworkIdentityRecord {
  assertIdentityId(identityId);
  const publicIp = normalizeIp(observation.publicIp);
  const now = options.now ?? (() => new Date());
  const observedAt = parseIso(observation.observedAt, 'observedAt');
  const updatedAt = now().toISOString();
  const expectedPublicIps = (options.expectedPublicIps ?? []).map(normalizeIp);
  const previous = readNetworkIdentityRecord(rootDir, identityId);
  const baselinePublicIp = previous?.baselinePublicIp ?? publicIp;
  const collisionWindowMs = options.collisionWindowMs ?? DEFAULT_COLLISION_WINDOW_MS;
  const reasons: string[] = [];

  if (expectedPublicIps.length > 0 && !expectedPublicIps.includes(publicIp)) {
    reasons.push('NETWORK_EGRESS_UNEXPECTED');
  } else if (baselinePublicIp !== publicIp) {
    reasons.push('NETWORK_EGRESS_DRIFT');
  }

  const cutoff = now().getTime() - collisionWindowMs;
  const collisions = listNetworkIdentityRecords(rootDir)
    .filter((record) => record.identityId !== identityId)
    .filter((record) => Date.parse(record.observedAt) >= cutoff)
    .filter((record) => record.publicIp === publicIp);

  if (collisions.length > 0) reasons.push('NETWORK_IDENTITY_COLLISION');
  const collisionWith = collisions.map((record) => record.identityId).sort();
  const record: NetworkIdentityRecord = {
    schemaVersion: 1,
    identityId,
    publicIp,
    baselinePublicIp,
    probeUrl: observation.probeUrl,
    observedAt,
    runtimeSessionId: observation.runtimeSessionId,
    state: reasons.length > 0 ? 'frozen' : 'verified',
    reasons: [...new Set(reasons)],
    collisionWith,
    updatedAt,
  };
  writeRecord(rootDir, record);

  for (const collision of collisions) {
    const updated: NetworkIdentityRecord = {
      ...collision,
      state: 'frozen',
      reasons: [...new Set([...collision.reasons, 'NETWORK_IDENTITY_COLLISION'])],
      collisionWith: [...new Set([...collision.collisionWith, identityId])].sort(),
      updatedAt,
    };
    writeRecord(rootDir, updated);
  }
  return record;
}

export function resetNetworkIdentityRecord(rootDir: string, identityId: string, now: () => Date = () => new Date()): { reset: boolean; archivedPath?: string } {
  const path = networkRecordPath(rootDir, identityId);
  if (!existsSync(path)) return { reset: false };
  const networkDir = join(rootDir, identityId, 'network');
  const archiveDir = join(networkDir, 'history');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archivedPath = join(archiveDir, `network-identity-${now().toISOString().replace(/[:.]/g, '-')}.json`);
  renameSync(path, archivedPath);
  return { reset: true, archivedPath };
}

function writeRecord(rootDir: string, record: NetworkIdentityRecord): void {
  const path = networkRecordPath(rootDir, record.identityId);
  const directory = join(rootDir, record.identityId, 'network');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}

function assertIdentityId(identityId: string): void {
  if (!IDENTITY_SLUG.test(identityId)) throw new Error('identityId must be a stable lowercase slug.');
}

function normalizeIp(value: string): string {
  const normalized = value.trim();
  if (!isIP(normalized)) throw new Error(`Invalid public IP address: ${value}`);
  return normalized;
}

function parseIso(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return new Date(timestamp).toISOString();
}
