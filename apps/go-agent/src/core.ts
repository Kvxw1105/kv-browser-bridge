import { createDefaultConfig } from './config.js';
import type { DecisionEngine } from './decision.js';
import type { GoConfig, GoHooks, GoState, GoStorage, PageAdapter } from './types.js';

export interface StartOptions {
  goal?: string;
  keyword?: string;
  nudgePool?: string[];
  maxRounds?: number;
  injectProtocol?: boolean;
  protocolUrl?: string;
  settleProtocolMs?: number;
}

export interface RiskDetector {
  detect(): string | null | Promise<string | null>;
}

const DEFAULT_RISK_IFRAMES = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="challenges.cloudflare"]',
];

const DEFAULT_RISK_TEXTS = [
  '请完成验证',
  '安全验证',
  '验证码已发送',
  'unusual activity',
  'verify you are human',
  '确认您不是机器人',
  '检测到异常流量',
];

export class GoEngine {
  private readonly config: GoConfig;
  private readonly state: GoState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly adapter: PageAdapter;
  private readonly hooks: GoHooks;
  private readonly storage: GoStorage;
  private readonly riskDetector: RiskDetector;
  private readonly decisionEngine: DecisionEngine | null;

  constructor(
    adapter: PageAdapter,
    hooks: GoHooks,
    storage: GoStorage,
    options: { config?: Partial<GoConfig>; riskDetector?: RiskDetector; decisionEngine?: DecisionEngine | null } = {},
  ) {
    this.adapter = adapter;
    this.hooks = hooks;
    this.storage = storage;
    this.config = { ...createDefaultConfig(), ...options.config };
    this.riskDetector = options.riskDetector ?? { detect: () => detectRisk(this.config) };
    this.decisionEngine = options.decisionEngine ?? null;
    this.state = {
      running: false,
      startedAt: 0,
      round: 0,
      nudgeCount: 0,
      goal: '',
      lastLen: -1,
      lastStableAt: 0,
      lastNudgeAt: 0,
      lastNudgeText: '',
      lastBusy: false,
      lastSummary: '',
      protocolUrl: '',
      phase: 'idle',
      nextActionAt: 0,
      cooldownMs: 0,
      lastStopReason: '',
      generationSeen: false,
      busySince: 0,
    };
  }

  getState(): Readonly<GoState> {
    return this.state;
  }

  getConfig(): Readonly<GoConfig> {
    return this.config;
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.state.running = true;
    this.state.startedAt = Date.now();
    this.state.round = 0;
    this.state.nudgeCount = 0;
    const initialLen = (await this.adapter.lastText()).length;
    this.state.lastLen = initialLen > 0 ? initialLen : -1;
    this.state.lastStableAt = Date.now();
    this.state.lastNudgeAt = 0;
    this.state.lastSummary = '';
    if (options.goal !== undefined) this.state.goal = options.goal;
    this.state.phase = 'waiting';
    this.state.nextActionAt = Date.now() + this.config.idleThresholdMs;
    this.state.cooldownMs = 0;
    this.state.lastStopReason = '';
    this.state.generationSeen = false;
    this.state.busySince = 0;

    if (options.keyword !== undefined) this.config.keyword = options.keyword;
    if (options.nudgePool && options.nudgePool.length > 0) this.config.nudgePool = options.nudgePool;
    if (options.maxRounds && options.maxRounds > 0) this.config.maxRounds = options.maxRounds;
    if (options.injectProtocol !== undefined) this.config.injectProtocol = options.injectProtocol;

    await this.save();
    this.hooks.status(`运行中 · 轮次 ${this.state.round}/${this.config.maxRounds}`);
    this.resetTimer();

    const protocolKey = options.protocolUrl ?? currentPath();
    const inject = this.config.injectProtocol && this.state.protocolUrl !== protocolKey;
    if (inject) {
      this.hooks.status('正在注入工作协议…');
      const baseLen = (await this.adapter.lastText()).length;
      const okType = await this.adapter.typeText(this.config.protocolMessage);
      await sleep(300);
      const okSend = okType && await this.adapter.send();
      if (okSend) {
        this.state.protocolUrl = protocolKey;
        await this.storage.saveProtocolUrl(this.state.protocolUrl);
        const settleMs = options.settleProtocolMs ?? 0;
        if (settleMs > 0) await this.settleProtocol(baseLen, settleMs);
      }
    }

    if (!this.state.running) return;
    const postLen = (await this.adapter.lastText()).length;
    this.state.lastLen = postLen > 0 ? postLen : this.state.lastLen;
    this.state.lastStableAt = Date.now();
    await this.tick();
  }

  stop(reason = '已停止'): void {
    this.state.running = false;
    this.state.phase = 'stopped';
    this.state.nextActionAt = 0;
    this.state.lastStopReason = reason;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.save();
    this.hooks.notify(reason);
  }

  /** 从暂停/节点处继续：保留轮次与摘要，不重复注入工作协议。 */
  async resume(options: { goal?: string } = {}): Promise<void> {
    if (options.goal !== undefined) this.state.goal = options.goal;
    this.state.running = true;
    const resumeLen = (await this.adapter.lastText()).length;
    this.state.lastLen = resumeLen > 0 ? resumeLen : this.state.lastLen;
    this.state.lastStableAt = Date.now();
    this.state.phase = 'waiting';
    this.state.nextActionAt = Date.now() + this.config.idleThresholdMs;
    this.state.lastStopReason = '';
    this.state.generationSeen = false;
    this.state.busySince = 0;
    await this.save();
    this.hooks.status(`继续推进 · 轮次 ${this.state.round}/${this.config.maxRounds}`);
    this.resetTimer();
    await this.tick();
  }

  async restore(): Promise<void> {
    const persisted = await this.storage.loadState();
    const protocolUrl = await this.storage.loadProtocolUrl();
    if (protocolUrl) this.state.protocolUrl = protocolUrl;
    if (persisted && persisted.running) {
      this.state.running = true;
      this.state.round = persisted.round || 0;
      this.state.nudgeCount = persisted.nudgeCount || 0;
      this.state.startedAt = persisted.startedAt || Date.now();
      this.state.lastSummary = persisted.lastSummary || '';
      this.state.goal = persisted.goal || '';
      this.hooks.status(`刷新后继续 · 轮次 ${this.state.round}/${this.config.maxRounds}`);
      this.resetTimer();
      void this.tick();
    }
  }

  private resetTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), rand(this.config.pollMinMs, this.config.pollMaxMs));
  }

  private async tick(): Promise<void> {
    if (!this.state.running) return;
    if ((this.hooks.hidden ? this.hooks.hidden() : typeof document !== 'undefined' && document.hidden)) return;

    const risk = await this.riskDetector.detect();
    if (risk) {
      this.stop(`风控/验证码出现，已自动停止（${risk}）`);
      return;
    }

        const busy = await this.adapter.isBusy();
        const text = await this.adapter.lastText();
        const len = text.length;
        const now = Date.now();
        // 虚拟列表重渲染时可能短暂返回空文本：跳过本轮，不重置基准
        if (len === 0) return;

    if (busy) {
      if (!this.state.lastBusy) this.state.busySince = now;
      this.state.lastBusy = true;
      this.state.generationSeen = true;
      this.state.phase = 'generating';
      this.state.nextActionAt = 0;
      const stalled = len === this.state.lastLen && now - this.state.busySince > this.config.busyStallMs;
      if (!stalled) return;
      // 生成停滞：停止按钮可见但文本长时间不增长，视为停住
      this.state.lastBusy = false;
      this.state.lastStableAt = now;
    }

    if (len > this.state.lastLen) {
      this.state.lastLen = len;
      this.state.lastStableAt = now;
      this.state.lastBusy = false;
      this.state.lastSummary = extractSummary(text, this.config.summaryMarker);
      this.state.generationSeen = true;
      this.state.phase = 'generating';
      this.state.nextActionAt = 0;
      return;
    }

    // 识别"回复已结束"：看到生成结束（busy→idle 转换）立即确认；
    // 未观察到 busy 时用短确认窗；长时间无变化作为兜底。
    this.state.lastBusy = false;
    const stableMs = now - this.state.lastStableAt;
    const finished = this.state.generationSeen;
    const hasWork = len > 0 || this.state.round > 0 || this.state.lastNudgeAt > 0;
    if (!finished) {
      if (!hasWork) {
        this.state.phase = 'waiting';
        this.state.nextActionAt = now + this.config.idleThresholdMs;
        return;
      }
      const actionAt = Math.max(
        this.state.lastStableAt + this.config.idleThresholdMs,
        this.state.lastNudgeAt + (this.state.cooldownMs || 0),
      );
      this.state.nextActionAt = actionAt;
      this.state.phase = now < this.state.lastStableAt + this.config.idleThresholdMs ? 'waiting' : 'cooldown';
      if (now < actionAt) return;
      // 静默停滞：模型既无回复也长时间安静，不计数轮次，直接再催办
      if (this.state.round >= this.config.maxRounds) {
        this.stop(`已到轮次上限，请验收（轮次 ${this.state.round}）`);
        return;
      }
      await this.doNudge();
      return;
    }

    // 观察到真实生成结束：计数一轮
    this.state.round++;
    this.state.nudgeCount = 0;
    this.state.lastStableAt = now;
    this.state.generationSeen = false;
    await this.save();
    this.hooks.status(`运行中 · 轮次 ${this.state.round}/${this.config.maxRounds}`);

    if (atCheckpoint(text, this.config) || this.state.round >= this.config.maxRounds) {
      this.stop(`已到节点，请验收（轮次 ${this.state.round}）`);
      return;
    }

    if (now >= this.state.lastNudgeAt + (this.state.cooldownMs || 0)) {
      await this.doNudge();
    } else {
      this.state.phase = 'cooldown';
      this.state.nextActionAt = this.state.lastNudgeAt + this.state.cooldownMs;
    }
  }

  private async doNudge(): Promise<void> {
    let nudgeText: string | null = null;
    if (this.decisionEngine) {
      const decision = await this.decisionEngine.decide(
        {
          goal: this.state.goal,
          summary: this.state.lastSummary,
          previousQuestion: this.state.lastNudgeText,
          round: this.state.round,
        },
        { config: this.config, state: this.state },
      );
      if (decision) {
        if (decision.action === 'stop') {
          this.stop('决策引擎判定：已到节点');
          return;
        }
        nudgeText = decision.hint && decision.hint.trim() ? decision.hint : null;
      }
    }
    if (!nudgeText) nudgeText = pickNudge(this.config.nudgePool, this.state.lastNudgeText);
    // 先锁冷却，防止打字等待期间定时器重入造成连发
    this.state.lastNudgeAt = Date.now();
    this.state.cooldownMs = rand(this.config.cooldownMinMs, this.config.cooldownMaxMs);
    this.state.nudgeCount++;
    this.state.phase = 'cooldown';
    this.state.nextActionAt = this.state.lastNudgeAt + this.state.cooldownMs;
    this.state.generationSeen = false;
    this.state.lastStableAt = Date.now();
    const ok = await this.sendNudgeText(nudgeText);
    await this.save();
    this.hooks.status(`已发送推进 #${this.state.nudgeCount} · 轮次 ${this.state.round}/${this.config.maxRounds}`);
    if (!ok) this.hooks.status('推进失败：输入框未找到，请检查页面');
  }

  private async sendNudgeText(nudgeText: string): Promise<boolean> {
    this.state.lastNudgeText = nudgeText;
    const okSet = await this.adapter.typeText(nudgeText);
    await sleep(300);
    const okSend = okSet && await this.adapter.send();
    if (!okSet || !okSend) {
      this.hooks.status('推进失败：输入框未找到，请检查页面');
      return false;
    }
    const readLen = (await this.adapter.lastText()).length;
    if (readLen > 0) this.state.lastLen = readLen;
    this.state.lastStableAt = Date.now();
    return true;
  }

  private async settleProtocol(baseLen: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastLen = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      const busy = await this.adapter.isBusy();
      const len = (await this.adapter.lastText()).length;
      if (!busy && len > baseLen && len === lastLen) {
        stable++;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
      lastLen = len;
    }
  }

  private async save(): Promise<void> {
    await this.storage.saveState({
      running: this.state.running,
      round: this.state.round,
      nudgeCount: this.state.nudgeCount,
      startedAt: this.state.startedAt,
      lastSummary: this.state.lastSummary,
      goal: this.state.goal,
    });
  }
}

export function atCheckpoint(text: string, config: GoConfig): boolean {
  const kw = (config.keyword || '').trim() || config.defaultKeywords.join('|');
  const re = new RegExp(kw.split('|').map(escapeRegExp).join('|'));
  return re.test(text);
}

export function extractSummary(text: string, marker: string): string {
  const idx = text.lastIndexOf(marker);
  return idx >= 0 ? text.slice(idx).trim() : '';
}

export function pickNudge(pool: string[], lastNudgeText: string): string {
  const candidates = pool.filter((t) => t !== lastNudgeText);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)] || pool[0];
  return chosen;
}

export function detectRisk(config: GoConfig): string | null {
  if (typeof document === 'undefined') return null;
  try {
    for (const sel of DEFAULT_RISK_IFRAMES) {
      const el = document.querySelector(sel);
      if (el && (el as HTMLElement).offsetParent !== null) return `检测到验证码框架（${sel}）`;
    }
    const bodyText = document.body ? document.body.innerText : '';
    for (const t of DEFAULT_RISK_TEXTS) {
      if (bodyText.includes(t)) return `页面出现风控提示：${t}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a));

function currentPath(): string {
  try {
    return typeof location !== 'undefined' ? location.pathname : '';
  } catch {
    return '';
  }
}
