import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GoStorage, PersistedState } from './types.js';

/**
 * 文件存储（Node 环境）：每个控制器实例（按会话/标签）一个目录，状态、推进语池、协议记录落盘。
 * 仅用于 MCP/CLI/API 等 Node 侧；浏览器扩展请用 ChromeStorage。
 */
export class FileStorage implements GoStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.dir, key + '.json');
  }

  private async read<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(readFileSync(this.pathFor(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      mkdirSync(dirname(this.pathFor(key)), { recursive: true });
      writeFileSync(this.pathFor(key), JSON.stringify(value, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  async saveState(state: PersistedState): Promise<void> {
    await this.write('state', state);
  }
  async loadState(): Promise<PersistedState | null> {
    return this.read<PersistedState>('state');
  }
  async savePool(poolText: string): Promise<void> {
    await this.write('pool', poolText);
  }
  async loadPool(): Promise<string | null> {
    return this.read<string>('pool');
  }
  async saveProtocolUrl(url: string): Promise<void> {
    await this.write('protocolUrl', url);
  }
  async loadProtocolUrl(): Promise<string | null> {
    return this.read<string>('protocolUrl');
  }
}
