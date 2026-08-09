export type Platform = 'chatgpt' | 'deepseek';

export interface GoConfig {
  keyword: string;
  defaultKeywords: string[];
  maxRounds: number;
  pollMinMs: number;
  pollMaxMs: number;
  finishConfirmMs: number;
  idleThresholdMs: number;
  busyStallMs: number;
  cooldownMinMs: number;
  cooldownMaxMs: number;
  charMinMs: number;
  charMaxMs: number;
  nudgePool: string[];
  protocolMessage: string;
  injectProtocol: boolean;
  summaryMarker: string;
  doneMarker: string;
}

export interface PersistedState {
  running: boolean;
  round: number;
  nudgeCount: number;
  startedAt: number;
  lastSummary: string;
  goal: string;
}

export interface GoState extends PersistedState {
  goal: string;
  lastLen: number;
  lastStableAt: number;
  lastNudgeAt: number;
  lastNudgeText: string;
  lastBusy: boolean;
  protocolUrl: string;
  phase: 'idle' | 'generating' | 'waiting' | 'cooldown' | 'stopped';
  nextActionAt: number;
  cooldownMs: number;
  lastStopReason: string;
  generationSeen: boolean;
  busySince: number;
}

export interface PageAdapter {
  platform: Platform;
  isBusy(): boolean | Promise<boolean>;
  lastText(): string | Promise<string>;
  typeText(text: string): Promise<boolean>;
  send(): Promise<boolean>;
  detectRisk?(): string | null | Promise<string | null>;
}

export interface GoHooks {
  status(text: string): void;
  notify(text: string): void;
  hidden?(): boolean;
}

export interface GoStorage {
  saveState(state: PersistedState): void | Promise<void>;
  loadState(): Promise<PersistedState | null>;
  savePool(poolText: string): void | Promise<void>;
  loadPool(): Promise<string | null>;
  saveProtocolUrl(url: string): void | Promise<void>;
  loadProtocolUrl(): Promise<string | null>;
}
