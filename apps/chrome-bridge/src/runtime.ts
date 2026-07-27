import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OperationClass } from '@kv-browser-bridge/browser-protocol';

export type RuntimeMode = 'legacy' | 'shadow' | 'proxy';
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface RuntimeOptions { root?: string; mode?: RuntimeMode; now?: () => string; }
export interface RunPackage { runId: string; directory: string; files: string[]; }

const SENSITIVE_KEY = /token|cookie|authorization|password|secret|localstorage|indexeddb/i;
const SENSITIVE_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b/i;

export class KvRuntime {
  readonly mode: RuntimeMode;
  readonly root: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly hadDatabase: boolean;
  private activeRunId: string | undefined;
  private sequence = 0;

  constructor(options: RuntimeOptions = {}) {
    this.mode = options.mode ?? runtimeMode();
    this.root = resolve(options.root ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'runtime'));
    this.databasePath = join(this.root, 'runtime.sqlite');
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.hadDatabase = existsSync(this.databasePath);
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.backupBeforeMigration();
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.migrate();
    if (this.mode === 'shadow') this.startRun('shadow');
  }

  startRun(kind: 'shadow' | 'replay' = 'shadow', metadata: Record<string, unknown> = {}): string {
    const id = `run-${randomUUID()}`;
    this.db.prepare('INSERT INTO runs (id, kind, mode, status, started_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, this.mode, 'running', this.now(), stringify(scrub(metadata)));
    this.activeRunId = id;
    this.sequence = 0;
    return id;
  }

  finishRun(status: 'completed' | 'failed' | 'paused' = 'completed'): void {
    if (!this.activeRunId) return;
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, this.now(), this.activeRunId);
    this.activeRunId = undefined;
  }

  recordRequest(method: string, params: Record<string, unknown>, operationClass: OperationClass, tabId?: number): string | undefined {
    if (this.mode !== 'shadow' || !this.activeRunId) return undefined;
    const id = `event-${randomUUID()}`;
    this.db.prepare('INSERT INTO run_events (id, run_id, sequence, at, kind, method, operation_class, tab_id, params_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.activeRunId, ++this.sequence, this.now(), 'request', method, operationClass, tabId ?? null, stringify(scrub(params)));
    return id;
  }

  recordResult(eventId: string | undefined, result?: unknown, error?: unknown): void {
    if (!eventId) return;
    this.db.prepare('UPDATE run_events SET result_json = ?, error_json = ? WHERE id = ?')
      .run(result === undefined ? null : stringify(scrub(result)), error === undefined ? null : stringify(scrub(error)), eventId);
  }

  saveRecipeDraft(draft: unknown): string | undefined {
    if (this.mode !== 'shadow' || !this.activeRunId || !isRecord(draft)) return undefined;
    const id = typeof draft.id === 'string' ? draft.id : `recipe-${randomUUID()}`;
    this.db.prepare('INSERT OR REPLACE INTO recipe_drafts (id, run_id, version, revision, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, this.activeRunId, Number(draft.version ?? 1), 1, stringify(scrub(draft)), this.now());
    return id;
  }

  addArtifact(eventId: string | undefined, kind: string, path: unknown): string | undefined {
    if (this.mode !== 'shadow' || !this.activeRunId || typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) return undefined;
    const id = `artifact-${randomUUID()}`;
    const info = statSync(path);
    this.db.prepare('INSERT INTO artifacts (id, run_id, event_id, kind, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.activeRunId, eventId ?? null, kind, path, sha256(path), info.size, this.now());
    return id;
  }

  latestRunId(): string | undefined {
    if (this.activeRunId) return this.activeRunId;
    return (this.db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get() as { id?: string } | undefined)?.id;
  }

  exportRunPackage(runId: string, directory: string): RunPackage {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const output = resolve(directory);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const artifactsDir = join(output, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    const events = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence').all(runId) as Record<string, unknown>[];
    const draft = this.db.prepare('SELECT body_json FROM recipe_drafts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as { body_json?: string } | undefined;
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at').all(runId) as Record<string, unknown>[];
    const exportedArtifacts = artifacts.map((artifact) => {
      const source = String(artifact.path);
      const name = `${String(artifact.id)}-${source.split(/[\\/]/).pop()}`;
      const destination = join(artifactsDir, name);
      if (existsSync(source)) copyFileSync(source, destination);
      return { id: String(artifact.id), kind: String(artifact.kind), path: join('artifacts', name).replace(/\\/g, '/'), sha256: String(artifact.sha256), size: Number(artifact.size) };
    });
    writeJson(join(output, 'manifest.json'), { version: 1, run: decodeRow(run), artifacts: exportedArtifacts });
    writeFileSync(join(output, 'events.jsonl'), events.map((event) => JSON.stringify(decodeRow(event))).join('\n') + (events.length ? '\n' : ''), 'utf8');
    writeJson(join(output, 'recipe-draft.json'), draft?.body_json ? JSON.parse(draft.body_json) : null);
    writeJson(join(output, 'result.json'), { run_id: runId, status: run.status, event_count: events.length, artifact_count: exportedArtifacts.length });
    return { runId, directory: output, files: ['manifest.json', 'events.jsonl', 'recipe-draft.json', 'result.json', ...readdirSync(artifactsDir).map((name) => join('artifacts', name).replace(/\\/g, '/'))] };
  }

  close(): void { this.finishRun(); this.db.close(); }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, method TEXT, operation_class TEXT, tab_id INTEGER, params_json TEXT, result_json TEXT, error_json TEXT);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT REFERENCES run_events(id), kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recipe_drafts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), version INTEGER NOT NULL, revision INTEGER NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));`);
  }

  private backupBeforeMigration(): void {
    if (!this.hadDatabase) return;
    try {
      this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
    } catch {
      const backup = join(this.root, 'runtime.sqlite.before-v1.bak');
      if (!existsSync(backup)) copyFileSync(this.databasePath, backup);
    }
  }
}

export function runtimeMode(value = process.env.KBB_RUNTIME_MODE): RuntimeMode {
  return value === 'shadow' || value === 'proxy' ? value : 'legacy';
}

function scrub(value: unknown): Json {
  if (typeof value === 'string') return SENSITIVE_TEXT.test(value) || value.startsWith('data:') ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(scrub);
  if (!isRecord(value)) return value == null ? null : typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) || key === 'text' ? '[redacted]' : scrub(item)]));
}

function stringify(value: Json): string { return JSON.stringify(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function writeJson(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function decodeRow(row: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(row).map(([key, value]) => key.endsWith('_json') && typeof value === 'string' ? [key.slice(0, -5), JSON.parse(value)] : [key, value])); }
