import { existsSync, readFileSync } from 'node:fs';
import type { RuntimeReceipt } from './model.js';
import { runtimePaths } from './paths.js';
import { writeJsonAtomic } from './atomic-json.js';

export class RuntimeReceiptStore {
  constructor(private readonly rootDir: string) {}

  load(identityId: string): RuntimeReceipt | undefined {
    const { receiptPath } = runtimePaths(this.rootDir, identityId);
    if (!existsSync(receiptPath)) return undefined;
    return JSON.parse(readFileSync(receiptPath, 'utf8')) as RuntimeReceipt;
  }

  save(receipt: RuntimeReceipt): void {
    writeJsonAtomic(runtimePaths(this.rootDir, receipt.identityId).receiptPath, receipt);
  }
}
