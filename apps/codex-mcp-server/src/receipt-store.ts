import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ActionReceipt, SequenceReceipt } from './computer-contracts.js';

type SequenceReceiptRecord = SequenceReceipt & { recordType: 'sequence' };

export class ReceiptStore {
  constructor(
    private readonly filePath = defaultReceiptPath(),
    private readonly detailMode = process.env.KV_COMPUTER_RECEIPT_DETAIL === 'full' ? 'full' : 'safe',
  ) {}

  path(): string { return this.filePath; }

  async append(receipt: ActionReceipt): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const persisted = this.detailMode === 'full' ? receipt : sanitizeReceipt(receipt);
    await appendFile(this.filePath, `${JSON.stringify(persisted)}\n`, { encoding: 'utf8' });
  }

  async appendSequence(receipt: SequenceReceipt): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const persisted = this.detailMode === 'full' ? receipt : sanitizeSequenceReceipt(receipt);
    const record: SequenceReceiptRecord = { recordType: 'sequence', ...persisted };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
  }

  async recent(limit = 20): Promise<ActionReceipt[]> {
    const bounded = Math.max(1, Math.min(limit, 200));
    return (await this.readRecords())
      .filter(isActionReceipt)
      .slice(-bounded)
      .reverse();
  }

  async find(actionId: string): Promise<ActionReceipt | undefined> {
    return (await this.recent(200)).find((receipt) => receipt.actionId === actionId);
  }

  async recentSequences(limit = 20): Promise<SequenceReceipt[]> {
    const bounded = Math.max(1, Math.min(limit, 100));
    return (await this.readRecords())
      .filter(isSequenceReceiptRecord)
      .slice(-bounded)
      .reverse()
      .map(withoutRecordType);
  }

  async findSequence(sequenceId: string): Promise<SequenceReceipt | undefined> {
    return (await this.recentSequences(100)).find((receipt) => receipt.sequenceId === sequenceId);
  }

  private async readRecords(): Promise<unknown[]> {
    let content: string;
    try { content = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; }
      catch { return []; }
    });
  }
}

function sanitizeReceipt(receipt: ActionReceipt): ActionReceipt {
  const result = summarizeResult(receipt.result);
  return {
    protocolVersion: receipt.protocolVersion,
    actionId: receipt.actionId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    driver: receipt.driver,
    status: receipt.status,
    ...(result === undefined ? {} : { result }),
    ...(receipt.error ? { error: receipt.error } : {}),
    verification: { status: receipt.verification.status },
  };
}

function sanitizeSequenceReceipt(receipt: SequenceReceipt): SequenceReceipt {
  return {
    protocolVersion: receipt.protocolVersion,
    sequenceId: receipt.sequenceId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    status: receipt.status,
    risk: receipt.risk,
    totalSteps: receipt.totalSteps,
    completedSteps: receipt.completedSteps,
    ...(receipt.stoppedAtStep ? { stoppedAtStep: receipt.stoppedAtStep } : {}),
    ...(receipt.skippedSteps ? { skippedSteps: receipt.skippedSteps } : {}),
    stepReceipts: receipt.stepReceipts.map(sanitizeReceipt),
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

function summarizeResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return undefined;
  const source = result as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of [
    'action',
    'windowHandle',
    'foregroundWindowHandle',
    'targetRef',
    'valueSet',
    'appId',
    'displayName',
    'pid',
    'executableName',
    'source',
  ]) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function isActionReceipt(value: unknown): value is ActionReceipt {
  return typeof value === 'object'
    && value !== null
    && (value as { recordType?: unknown }).recordType !== 'sequence'
    && typeof (value as { actionId?: unknown }).actionId === 'string';
}

function isSequenceReceiptRecord(value: unknown): value is SequenceReceiptRecord {
  return typeof value === 'object'
    && value !== null
    && (value as { recordType?: unknown }).recordType === 'sequence'
    && typeof (value as { sequenceId?: unknown }).sequenceId === 'string';
}

function withoutRecordType(record: SequenceReceiptRecord): SequenceReceipt {
  const { recordType: _recordType, ...receipt } = record;
  return receipt;
}

function defaultReceiptPath(): string {
  const explicit = process.env.KV_COMPUTER_RECEIPT_LOG;
  if (explicit) return resolve(explicit);
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? join(process.cwd(), '.kv-browser-bridge');
  return join(base, 'KvBrowserBridge', 'computer-use', 'receipts.jsonl');
}
