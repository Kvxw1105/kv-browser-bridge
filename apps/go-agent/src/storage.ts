import type { GoStorage, PersistedState } from './types.js';

export class MemoryStorage implements GoStorage {
  private state: PersistedState | null = null;
  private pool: string | null = null;
  private protocolUrl: string | null = null;

  async saveState(state: PersistedState): Promise<void> {
    this.state = { ...state };
  }
  async loadState(): Promise<PersistedState | null> {
    return this.state ? { ...this.state } : null;
  }
  async savePool(poolText: string): Promise<void> {
    this.pool = poolText;
  }
  async loadPool(): Promise<string | null> {
    return this.pool;
  }
  async saveProtocolUrl(url: string): Promise<void> {
    this.protocolUrl = url;
  }
  async loadProtocolUrl(): Promise<string | null> {
    return this.protocolUrl;
  }
}

interface ChromeStorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ChromeStorage implements GoStorage {
  constructor(private readonly area: ChromeStorageAreaLike) {}

  async saveState(state: PersistedState): Promise<void> {
    await this.area.set({ goAgentState: state });
  }
  async loadState(): Promise<PersistedState | null> {
    const r = await this.area.get('goAgentState');
    return (r.goAgentState as PersistedState | undefined) ?? null;
  }
  async savePool(poolText: string): Promise<void> {
    await this.area.set({ goAgentPool: poolText });
  }
  async loadPool(): Promise<string | null> {
    const r = await this.area.get('goAgentPool');
    return (r.goAgentPool as string | undefined) ?? null;
  }
  async saveProtocolUrl(url: string): Promise<void> {
    await this.area.set({ goAgentProtocolUrl: url });
  }
  async loadProtocolUrl(): Promise<string | null> {
    const r = await this.area.get('goAgentProtocolUrl');
    return (r.goAgentProtocolUrl as string | undefined) ?? null;
  }
}
