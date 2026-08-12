import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { GoEngine } from '@kv-browser-bridge/go-agent/core';
import {
  DECISION_PROVIDER_PRESETS,
  LlmDecisionEngine,
  normalizeLlmOptions,
  type LlmDecisionEngineOptions,
} from '@kv-browser-bridge/go-agent/decision';
import { FileStorage } from '@kv-browser-bridge/go-agent/file-storage';
import { Ledger } from '@kv-browser-bridge/go-agent/ledger';
import type { GoHooks, GoStorage, PageAdapter, Platform } from '@kv-browser-bridge/go-agent/types';

export type BridgeInvoker = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
type LogFn = (event: string, fields?: Record<string, unknown>) => void;

function runsRoot(): string {
  const explicit = process.env.GO_RUNS_DIR;
  if (explicit) return explicit;
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'go-runs');
}

function conversationKeyFromUrl(url: string): string {
  if (url.includes('chatgpt.com')) {
    const m = url.match(/\/c\/([a-zA-Z0-9-]+)/);
    return m ? 'gpt-' + m[1] : 'gpt-tab';
  }
  const m = url.match(/\/a\/chat\/s\/([a-zA-Z0-9-]+)/);
  return m ? 'ds-' + m[1] : 'ds-tab';
}

interface DecisionConfigFile {
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 读取本地决策配置：%LOCALAPPDATA%\KvBrowserBridge\go-agent-decision.json
 * （或 GO_AGENT_DECISION_CONFIG 指定路径）。环境变量可覆盖 apiKey。
 */
async function loadDecisionConfig(): Promise<LlmDecisionEngineOptions | null> {
  const explicit = process.env.GO_AGENT_DECISION_CONFIG;
  const path =
    explicit ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge', 'go-agent-decision.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DecisionConfigFile;
    const opts: LlmDecisionEngineOptions = {};
    if (parsed.preset) opts.preset = parsed.preset;
    if (parsed.baseUrl) opts.baseUrl = parsed.baseUrl;
    if (parsed.model) opts.model = parsed.model;
    opts.apiKey = parsed.apiKey || process.env.GO_AGENT_DECISION_API_KEY || process.env.DEEPSEEK_API_KEY || undefined;
    return normalizeLlmOptions(opts) ? opts : null;
  } catch {
    return null;
  }
}

export interface GoPlatformSelectors {
  input: string;
  /** Send control (clicked to submit a nudge; React handles synthetic clicks). */
  sendButton: string;
  busyExpr: string;
  lastExpr: string;
  riskTexts: string[];
}

/** Platform selectors are page-DOM specific and change when ChatGPT/DeepSeek
 *  ship UI updates. They are centralized here and overridable per GoEngine
 *  via config (see BridgePageAdapter constructor). */
export function defaultPlatformSelectors(): Record<Platform, GoPlatformSelectors> {
  return {
    chatgpt: {
      input: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      busyExpr: `(() => { const el = document.querySelector('button[data-testid="stop-button"]'); return !!el && el.offsetParent !== null; })()`,
      lastExpr: `(() => { const n = document.querySelectorAll('[data-message-author-role="assistant"]'); return n.length ? n[n.length - 1].innerText : ''; })()`,
      riskTexts: ['请完成验证', '安全验证', '验证码已发送', 'unusual activity', 'verify you are human', '确认您不是机器人', '检测到异常流量'],
    },
    deepseek: {
      input: 'textarea[placeholder*="给 DeepSeek 发送消息"]',
      sendButton: 'button[aria-label*="发送"], button[title*="发送"]',
      busyExpr: `(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '■' && b.offsetParent !== null))()`,
      lastExpr: `(() => { const list = document.querySelector('.ds-virtual-list-visible-items'); if (!list) return ''; const n = list.children; return n.length ? n[n.length - 1].innerText : ''; })()`,
      riskTexts: ['请完成验证', '安全验证', '验证码已发送', 'unusual activity', 'verify you are human', '确认您不是机器人', '检测到异常流量'],
    },
  };
}

const RISK_IFRAMES = ['iframe[src*="captcha"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]', 'iframe[src*="challenges.cloudflare"]'];

function riskExpr(texts: string[]): string {
  const list = JSON.stringify(texts);
  return `(() => {
    const iframes = ${JSON.stringify(RISK_IFRAMES)};
    for (const sel of iframes) { const el = document.querySelector(sel); if (el && el.offsetParent !== null) return JSON.stringify({ risk: '验证码框架:' + sel }); }
    const texts = ${list};
    const t = document.body ? document.body.innerText : '';
    for (const k of texts) { if (t.includes(k)) return JSON.stringify({ risk: k }); }
    return JSON.stringify({ risk: null });
  })()`;
}

class BridgePageAdapter implements PageAdapter {
  private _platform: Platform = 'deepseek';
  private failures = 0;
  private readonly selectors: Record<Platform, GoPlatformSelectors>;

  constructor(
    private readonly invoke: BridgeInvoker,
    private readonly tabId: number,
    overrides?: Partial<Record<Platform, GoPlatformSelectors>>,
  ) {
    this.selectors = { ...defaultPlatformSelectors(), ...(overrides ?? {}) };
  }

  recentFailureCount(): number {
    return this.failures;
  }

  private ok(): void {
    this.failures = 0;
  }

  private fail(): void {
    this.failures += 1;
  }

  get platform(): Platform {
    return this._platform;
  }

  async refreshPlatform(): Promise<Platform> {
    try {
      const r = (await this.invoke('browser_get_url', { tabId: this.tabId })) as { url?: string };
      if (r && typeof r.url === 'string') {
        this._platform = r.url.includes('chatgpt.com') ? 'chatgpt' : 'deepseek';
      }
    } catch {
      /* keep last known */
    }
    return this._platform;
  }

  private async evaluate(expression: string): Promise<unknown> {
    try {
      const r = (await this.invoke('browser_evaluate', { tabId: this.tabId, expression })) as {
        result?: { value?: unknown };
      };
      const value = r?.result?.value;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      this.ok();
      return value;
    } catch {
      this.fail();
      throw new Error('bridge evaluate failed');
    }
  }

  async isBusy(): Promise<boolean> {
    try {
      const v = await this.evaluate(this.selectors[this._platform].busyExpr);
      return v === true;
    } catch {
      return false;
    }
  }

  async lastText(): Promise<string> {
    try {
      const v = await this.evaluate(this.selectors[this._platform].lastExpr);
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  }

  async detectRisk(): Promise<string | null> {
    try {
      const v = (await this.evaluate(riskExpr(this.selectors[this._platform].riskTexts))) as { risk?: string | null } | null;
      return v && typeof v.risk === 'string' ? v.risk : null;
    } catch {
      return null;
    }
  }

  async typeText(text: string): Promise<boolean> {
    try {
      await this.invoke('browser_type', {
        tabId: this.tabId,
        selector: this.selectors[this._platform].input,
        text,
        clear: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async send(): Promise<boolean> {
    // Prefer the platform send button: synthetic clicks are handled by React
    // event delegation, while CDP keyboard injection is dropped by Chrome
    // when the window has no OS focus (background/unattended runs).
    try {
      await this.invoke('browser_click', { tabId: this.tabId, selector: this.selectors[this._platform].sendButton, allowChatSend: true });
      return true;
    } catch {
      /* fall through to Enter */
    }
    try {
      await this.invoke('browser_press', { tabId: this.tabId, key: 'Enter' });
      return true;
    } catch {
      return false;
    }
  }
}

interface Entry {
  tabId: number;
  adapter: BridgePageAdapter;
  hooks: GoHooks;
  storage: GoStorage;
  decision: LlmDecisionEngine | null;
  engine: GoEngine;
  conversationKey: string;
  ledger: Ledger;
}

export class GoController {
  private readonly entries = new Map<number, Entry>();
  private defaultDecision: LlmDecisionEngineOptions | null | undefined;

  constructor(
    private readonly invoke: BridgeInvoker,
    private readonly log: LogFn,
  ) {}

  private async entryFor(tabId: number): Promise<Entry> {
    let entry = this.entries.get(tabId);
    if (!entry) {
      const adapter = new BridgePageAdapter(this.invoke, tabId);
      await adapter.refreshPlatform();
      // 后台标签页的虚拟列表可能停止渲染，启动前确保标签页激活
      await this.invoke('browser_switch_tab', { tabId, activate: true }).catch(() => undefined);
      const url = await this.tabUrl(tabId);
      const conversationKey = conversationKeyFromUrl(url);
      const root = runsRoot();
      const ledger = new Ledger(root, conversationKey);
      const storage = new FileStorage(join(root, conversationKey, 'engine'));
      let entryRef: Entry | null = null;
      const hooks: GoHooks = {
        status: (text) => {
          this.log('go_status', { tabId, text });
          ledger.append({ at: new Date().toISOString(), type: 'status', tabId, text, state: entryRef?.engine.getState() });
        },
        notify: (text) => this.log('go_notify', { tabId, text }),
      };
      entry = {
        tabId,
        adapter,
        hooks,
        storage,
        decision: null,
        engine: this.buildEngine(adapter, hooks, storage, null, tabId),
        conversationKey,
        ledger,
      };
      entryRef = entry;
      this.entries.set(tabId, entry);
    }
    return entry;
  }

  private async tabUrl(tabId: number): Promise<string> {
    try {
      const r = (await this.invoke('browser_get_url', { tabId })) as { url?: string };
      return typeof r?.url === 'string' ? r.url : '';
    } catch {
      return '';
    }
  }

  private buildEngine(
    adapter: BridgePageAdapter,
    hooks: GoHooks,
    storage: GoStorage,
    decision: LlmDecisionEngine | null,
    tabId: number,
  ): GoEngine {
    return new GoEngine(adapter, hooks, storage, {
      riskDetector: { detect: () => adapter.detectRisk() },
      decisionEngine: decision,
    });
  }

  private buildDecision(options: LlmDecisionEngineOptions | undefined, tabId: number): LlmDecisionEngine | null {
    if (!options) return null;
    return new LlmDecisionEngine(options, async (name) => {
      const entry = this.entries.get(tabId);
      if (!entry) return { error: 'no active GO entry' };
      if (name === 'go_status') return this.status(tabId);
      if (name === 'go_stop') return this.stop(tabId);
      if (name === 'go_continue') return this.continue(tabId, {});
      return { error: `unknown tool ${name}` };
    });
  }

  private async defaultDecisionConfig(): Promise<LlmDecisionEngineOptions | null> {
    if (this.defaultDecision === undefined) {
      this.defaultDecision = await loadDecisionConfig();
    }
    return this.defaultDecision;
  }

  async start(
    tabId: number,
    params: {
      goal?: string;
      keyword?: string;
      maxRounds?: number;
      nudgePool?: string[];
      injectProtocol?: boolean;
      decision?: LlmDecisionEngineOptions;
    },
  ): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      await entry.adapter.refreshPlatform();
      const url = await this.tabUrl(tabId);
      entry.conversationKey = conversationKeyFromUrl(url);
      if (params.decision) {
        entry.decision = this.buildDecision(params.decision, tabId);
        entry.engine = this.buildEngine(entry.adapter, entry.hooks, entry.storage, entry.decision, tabId);
      } else if (entry.decision === null) {
        const fileDecision = await this.defaultDecisionConfig();
        if (fileDecision) {
          entry.decision = this.buildDecision(fileDecision, tabId);
          entry.engine = this.buildEngine(entry.adapter, entry.hooks, entry.storage, entry.decision, tabId);
        }
      }
      await entry.engine.start({
        goal: params.goal,
        keyword: params.keyword,
        maxRounds: params.maxRounds,
        nudgePool: params.nudgePool,
        injectProtocol: params.injectProtocol,
        protocolUrl: `tab:${tabId}`,
      });
      entry.ledger.append({
        at: new Date().toISOString(),
        type: 'started',
        tabId,
        goal: params.goal ?? '',
        keyword: params.keyword ?? '',
        maxRounds: params.maxRounds ?? 10,
        conversationKey: entry.conversationKey,
        state: entry.engine.getState(),
      });
      return this.status(tabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(tabId: number): Promise<unknown> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: 'no active GO entry for tab' };
    entry.engine.stop('MCP 停止');
    entry.ledger.append({ at: new Date().toISOString(), type: 'stop', tabId, state: entry.engine.getState() });
    return this.status(tabId);
  }

  async continue(tabId: number, params: { goal?: string }): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      await entry.engine.resume({ goal: params.goal });
      entry.ledger.append({ at: new Date().toISOString(), type: 'continue', tabId, state: entry.engine.getState() });
      return this.status(tabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(tabId: number): Promise<unknown> {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return { ok: false, tabId, error: 'no active GO entry for tab (call go_start first)' };
    }
    return {
      ok: true,
      tabId,
      platform: entry.adapter.platform,
      running: entry.engine.getState().running,
      state: entry.engine.getState(),
      maxRounds: entry.engine.getConfig().maxRounds,
      decision: entry.decision?.configSummary ?? null,
      defaultDecisionConfigured: (await this.defaultDecisionConfig()) !== null,
      conversationKey: entry.conversationKey,
      ledgerPath: entry.ledger.path,
      lastLedgerEvents: entry.ledger.readAll().slice(-6),
    };
  }

  async resolve(tabId: number): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      await entry.adapter.refreshPlatform();
      const url = await this.tabUrl(tabId);
      entry.conversationKey = conversationKeyFromUrl(url);
      return {
        ok: true,
        tabId,
        platform: entry.adapter.platform,
        url,
        conversationKey: entry.conversationKey,
        ledgerPath: entry.ledger.path,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async wait(
    tabId: number,
    options: { until?: 'change' | 'checkpoint'; timeoutMs?: number; pollMs?: number },
  ): Promise<unknown> {
    const entry = await this.entryFor(tabId);
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120000, 1000), 300000);
    const pollMs = Math.min(Math.max(options.pollMs ?? 2000, 500), 10000);
    const deadline = Date.now() + timeoutMs;
    const baseline = JSON.stringify(entry.engine.getState());
    while (Date.now() < deadline) {
      const state = entry.engine.getState();
      if (options.until === 'checkpoint' && !state.running) {
        return { ...((await this.status(tabId)) as Record<string, unknown>), waited: true, timeout: false };
      }
      if (options.until === 'change' && JSON.stringify(state) !== baseline) {
        return { ...((await this.status(tabId)) as Record<string, unknown>), waited: true, timeout: false };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ...((await this.status(tabId)) as Record<string, unknown>), waited: true, timeout: true };
  }

  async configureDecision(tabId: number, options: LlmDecisionEngineOptions): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      entry.decision = this.buildDecision(options, tabId);
      entry.engine = this.buildEngine(entry.adapter, entry.hooks, entry.storage, entry.decision, tabId);
      return this.status(tabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function registerGoTools(
  server: McpServer,
  invoke: BridgeInvoker,
  log: LogFn,
  goEvents?: { drain(clear: boolean): unknown[] },
): void {
  const controller = new GoController(invoke, log);
  const tabId = z.number().int().positive().describe('Target Chrome tab ID.');
  const presetNames = Object.keys(DECISION_PROVIDER_PRESETS) as [string, ...string[]];
  const decisionFields = {
    preset: z.enum(presetNames).optional().describe('Preset provider; custom keeps your own baseUrl.'),
    baseUrl: z.string().url().optional().describe('OpenAI-compatible base URL (custom entry).'),
    apiKey: z.string().optional().describe('API key; leave empty for local Ollama.'),
    model: z.string().optional().describe('Model name; defaults to preset model.'),
  };
  const decisionSchema = z.object(decisionFields).optional();

  const json = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] });

  server.tool(
    'go_start',
    'Start GO Agent on a ChatGPT/DeepSeek tab: inject work protocol, then auto-nudge until a user-defined checkpoint.',
    {
      tabId,
      goal: z.string().max(2000).optional().describe('User goal used by the decision engine.'),
      keyword: z.string().max(200).optional().describe('Checkpoint keyword; empty uses defaults.'),
      maxRounds: z.number().int().min(1).max(200).optional().describe('Maximum nudge rounds before stopping.'),
      nudgePool: z.array(z.string().min(1).max(500)).max(50).optional().describe('Custom nudge lines (one per item).'),
      injectProtocol: z.boolean().optional().describe('Inject the progress-summary protocol on start (default true).'),
      decision: decisionSchema,
    },
    async (params) => {
      const { tabId: tab, decision, ...rest } = params;
      log('go_start', { tabId: tab });
      return json(await controller.start(tab, { ...rest, decision }));
    },
  );

  server.tool('go_stop', 'Stop GO Agent on a tab and wait for the user to verify.', { tabId }, async (params) => {
    log('go_stop', { tabId: params.tabId });
    return json(await controller.stop(params.tabId));
  });

  server.tool('go_status', 'Read GO Agent state for a tab (round, summary, running, decision config).', { tabId }, async (params) => {
    log('go_status', { tabId: params.tabId });
    return json(await controller.status(params.tabId));
  });

  server.tool('go_continue', 'Resume GO Agent on a tab, keeping rounds and summary.', { tabId, goal: z.string().max(2000).optional() }, async (params) => {
    log('go_continue', { tabId: params.tabId });
    return json(await controller.continue(params.tabId, { goal: params.goal }));
  });

  server.tool(
    'go_configure_decision',
    'Configure the LLM decision engine for a tab (preset providers prefilled; custom baseUrl allowed; API key only).',
    { tabId, ...decisionFields },
    async (params) => {
      const { tabId: tab, ...decision } = params;
      log('go_configure_decision', { tabId: tab });
      return json(await controller.configureDecision(tab, decision));
    },
  );

  server.tool('go_resolve_conversation', 'Resolve a tab to its stable conversation key and ledger path (agent-friendly handle).', { tabId }, async (params) => {
    log('go_resolve_conversation', { tabId: params.tabId });
    return json(await controller.resolve(params.tabId));
  });

  server.tool(
    'go_wait',
    'Block until the GO engine reaches a checkpoint (running=false) or its state changes; returns latest status. Lets agents subscribe without polling.',
    {
      tabId,
      until: z.enum(['change', 'checkpoint']).optional().describe('Wait condition; default checkpoint.'),
      timeoutMs: z.number().int().min(1000).max(300000).optional().describe('Max wait in milliseconds (default 120000).'),
      pollMs: z.number().int().min(500).max(10000).optional().describe('Internal poll interval (default 2000).'),
    },
    async (params) => {
      const { tabId: tab, ...rest } = params;
      log('go_wait', { tabId: tab, until: rest.until ?? 'checkpoint' });
      return json(await controller.wait(tab, rest));
    },
  );

  server.tool(
    'go_events',
    'Read (and optionally clear) buffered GO events pushed from the extension through the bridge (round status, checkpoint, risk, ledger).',
    {
      tabId,
      clear: z.boolean().optional().describe('Clear the buffer after reading (default false).'),
    },
    async (params) => {
      log('go_events', { tabId: params.tabId, clear: params.clear === true });
      return json(goEvents?.drain(params.clear === true) ?? []);
    },
  );
}
