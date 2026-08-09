import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LedgerEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

/**
 * 持久会话账本：每个会话一条 JSONL 文件，记录状态/轮次/摘要/洞见/检查点事件。
 * 人和 Agent（GUI/MCP/CLI/API）读写同一份账本。
 */
export class Ledger {
  private readonly file: string;

  constructor(runsDir: string, conversationKey: string) {
    const safe = conversationKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.file = join(runsDir, safe + '.jsonl');
    mkdirSync(runsDir, { recursive: true });
  }

  get path(): string {
    return this.file;
  }

  append(event: LedgerEvent): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(event) + '\n', { flag: 'a' });
    } catch {
      /* ledger 失败不阻断主流程 */
    }
  }

  readAll(): LedgerEvent[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEvent);
    } catch {
      return [];
    }
  }
}
