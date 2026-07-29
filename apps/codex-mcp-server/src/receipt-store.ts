import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ActionReceipt } from './computer-contracts.js';

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

  async recent(limit = 20): Promise<ActionReceipt[]> {
    const bounded = Math.max(1, Math.min(limit, 200));
    let content: string;
    try { content = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).slice(-bounded).reverse().flatMap((line) => {
      try { return [JSON.parse(line) as ActionReceipt]; }
      catch { return []; }
    });
  }

  async find(actionId: string): Promise<ActionReceipt | undefined> {
    return (await this.recent(200)).find((receipt) => receipt.actionId === actionId);
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

function defaultReceiptPath(): string {
  const explicit = process.env.KV_COMPUTER_RECEIPT_LOG;
  if (explicit) return resolve(explicit);
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? join(process.cwd(), '.kv-browser-bridge');
  return join(base, 'KvBrowserBridge', 'computer-use', 'receipts.jsonl');
}
