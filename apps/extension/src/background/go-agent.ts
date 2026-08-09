import { GoEngine } from '@kv-browser-bridge/go-agent/core';
import {
  DECISION_PROVIDER_PRESETS,
  LlmDecisionEngine,
  normalizeLlmOptions,
  type LlmDecisionEngineOptions,
} from '@kv-browser-bridge/go-agent/decision';
import { ChromeStorage } from '@kv-browser-bridge/go-agent/storage';
import type { PageAdapter, Platform } from '@kv-browser-bridge/go-agent/types';

const EXPR = {
  hostname: 'location.hostname',
  chatgptBusy: `(() => { const el = document.querySelector('button[data-testid="stop-button"]'); return !!el && el.offsetParent !== null; })()`,
  chatgptLast: `(() => { const n = document.querySelectorAll('[data-message-author-role="assistant"]'); return n.length ? n[n.length - 1].innerText : ''; })()`,
  deepseekBusy: `(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '■' && b.offsetParent !== null))()`,
  deepseekLast: `(() => { const list = document.querySelector('.ds-virtual-list-visible-items'); if (!list) return ''; const n = list.children; return n.length ? n[n.length - 1].innerText : ''; })()`,
  risk: `(() => {
    const iframes = ['iframe[src*="captcha"]','iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]','iframe[src*="turnstile"]','iframe[src*="challenges.cloudflare"]'];
    for (const sel of iframes) { const el = document.querySelector(sel); if (el && el.offsetParent !== null) return JSON.stringify({ risk: '验证码框架:' + sel }); }
    const texts = ['请完成验证','安全验证','验证码已发送','unusual activity','verify you are human','确认您不是机器人','检测到异常流量'];
    const t = document.body ? document.body.innerText : '';
    for (const k of texts) { if (t.includes(k)) return JSON.stringify({ risk: k }); }
    return JSON.stringify({ risk: null });
  })()`,
};

const attachedTabs = new Set<number>();

function ensureDebugger(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const error = chrome.runtime.lastError;
      if (error) {
        if (/another debugger|already attached/i.test(error.message ?? '')) {
          attachedTabs.add(tabId);
          resolve();
          return;
        }
        reject(new Error(error.message));
        return;
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

class CdpPageAdapter implements PageAdapter {
  private _platform: Platform = 'deepseek';
  private readonly inputSels: Record<Platform, string> = {
    chatgpt: '#prompt-textarea',
    deepseek: 'textarea[placeholder*="给 DeepSeek 发送消息"]',
  };

  constructor(private readonly tabId: number) {}

  get platform(): Platform {
    return this._platform;
  }

  async refreshPlatform(): Promise<Platform> {
    try {
      const host = String((await this.evaluate(EXPR.hostname)) ?? '');
      this._platform = host.includes('chatgpt.com') ? 'chatgpt' : 'deepseek';
    } catch {
      /* keep last known */
    }
    return this._platform;
  }

  private async cdp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await ensureDebugger(this.tabId);
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {}, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result as T);
      });
    });
  }

  private async evaluate(expression: string): Promise<unknown> {
    const r = await this.cdp<{ result?: { type?: string; value?: unknown } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    const value = r?.result?.value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  private async nodeId(selector: string): Promise<number> {
    const doc = await this.cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 1 });
    const query = await this.cdp<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!query.nodeId) throw new Error('element not found: ' + selector);
    return query.nodeId;
  }

  private async key(key: string, windowsVirtualKeyCode: number, modifiers: number, code: string): Promise<void> {
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
  }

  async isBusy(): Promise<boolean> {
    try {
      const v = await this.evaluate(this._platform === 'chatgpt' ? EXPR.chatgptBusy : EXPR.deepseekBusy);
      return v === true;
    } catch {
      return false;
    }
  }

  async lastText(): Promise<string> {
    try {
      const v = await this.evaluate(this._platform === 'chatgpt' ? EXPR.chatgptLast : EXPR.deepseekLast);
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  }

  async detectRisk(): Promise<string | null> {
    try {
      const v = (await this.evaluate(EXPR.risk)) as { risk?: string | null } | null;
      return v && typeof v.risk === 'string' ? v.risk : null;
    } catch {
      return null;
    }
  }

  async currentUrl(): Promise<string> {
    try {
      return String((await this.evaluate('location.href')) ?? '');
    } catch {
      return '';
    }
  }

  async typeText(text: string): Promise<boolean> {
    try {
      const nodeId = await this.nodeId(this.inputSels[this._platform]);
      await this.cdp('DOM.focus', { nodeId });
      await this.key('a', 65, 2, 'KeyA'); // Ctrl+A
      await this.key('Backspace', 8, 0, 'Backspace');
      await this.cdp('Input.insertText', { text });
      return true;
    } catch {
      return false;
    }
  }

  async send(): Promise<boolean> {
    try {
      await this.key('Enter', 13, 0, 'Enter');
      return true;
    } catch {
      return false;
    }
  }
}

interface Entry {
  tabId: number;
  adapter: CdpPageAdapter;
  decision: LlmDecisionEngine | null;
  engine: GoEngine;
  conversationKey: string;
}

function conversationKeyFromUrl(url: string): string {
  if (url.includes('chatgpt.com')) {
    const m = url.match(/\/c\/([a-zA-Z0-9-]+)/);
    return m ? 'gpt-' + m[1] : 'gpt-tab';
  }
  const m = url.match(/\/a\/chat\/s\/([a-zA-Z0-9-]+)/);
  return m ? 'ds-' + m[1] : 'ds-tab';
}

class GoAgentController {
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly emit: (type: string, data: unknown) => void) {}

  private buildEngine(adapter: CdpPageAdapter, decision: LlmDecisionEngine | null, tabId: number): GoEngine {
    return new GoEngine(
      adapter,
      {
        status: (text) => {
          console.info('[go-agent]', JSON.stringify({ event: 'status', tabId, text }));
          const entry = this.entries.get(tabId);
          const key = entry?.conversationKey ?? 'tab-' + tabId;
          this.emit('go_event', { tabId, text, state: entry?.engine.getState() });
          this.emit('go_ledger_append', {
            key,
            event: { type: 'status', tabId, text, state: entry?.engine.getState() },
          });
        },
        notify: (text) => {
          console.info('[go-agent]', JSON.stringify({ event: 'notify', tabId, text }));
          this.emit('go_event', { tabId, text });
        },
      },
      new ChromeStorage(chrome.storage.local),
      { riskDetector: { detect: () => adapter.detectRisk() }, decisionEngine: decision },
    );
  }

  private buildDecision(options: LlmDecisionEngineOptions | undefined, tabId: number): LlmDecisionEngine | null {
    if (!options || !normalizeLlmOptions(options)) return null;
    return new LlmDecisionEngine(options, async (name) => {
      if (name === 'go_status') return this.status(tabId);
      if (name === 'go_stop') return this.stop(tabId);
      if (name === 'go_continue') return this.continue(tabId, {});
      return { error: `unknown tool ${name}` };
    });
  }

  private async entryFor(tabId: number): Promise<Entry> {
    let entry = this.entries.get(tabId);
    if (!entry) {
      const adapter = new CdpPageAdapter(tabId);
      await adapter.refreshPlatform();
      const conversationKey = conversationKeyFromUrl(await adapter.currentUrl());
      const decision = await this.loadDecision();
      entry = {
        tabId,
        adapter,
        decision,
        engine: this.buildEngine(adapter, decision, tabId),
        conversationKey,
      };
      this.entries.set(tabId, entry);
    }
    return entry;
  }

  private async loadDecision(): Promise<LlmDecisionEngine | null> {
    try {
      const r = await chrome.storage.local.get('goDecisionConfig');
      const cfg = r.goDecisionConfig as LlmDecisionEngineOptions | undefined;
      return cfg ? this.buildDecision(cfg, 0) : null;
    } catch {
      return null;
    }
  }

  async start(
    tabId: number,
    params: {
      goal?: string;
      keyword?: string;
      maxRounds?: number;
      nudgePool?: string[];
      injectProtocol?: boolean;
    },
  ): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      await entry.adapter.refreshPlatform();
      entry.conversationKey = conversationKeyFromUrl(await entry.adapter.currentUrl());
      await entry.engine.start({
        goal: params.goal,
        keyword: params.keyword,
        maxRounds: params.maxRounds,
        nudgePool: params.nudgePool,
        injectProtocol: params.injectProtocol,
        protocolUrl: `tab:${tabId}`,
      });
      this.emit('go_ledger_append', {
        key: entry.conversationKey,
        event: { type: 'started', tabId, goal: params.goal ?? '', state: entry.engine.getState() },
      });
      return this.status(tabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(tabId: number): Promise<unknown> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: 'no active GO entry' };
    entry.engine.stop('手动停止');
    this.emit('go_ledger_append', {
      key: entry.conversationKey,
      event: { type: 'stop', tabId, state: entry.engine.getState() },
    });
    return this.status(tabId);
  }

  async continue(tabId: number, params: { goal?: string }): Promise<unknown> {
    try {
      const entry = await this.entryFor(tabId);
      await entry.engine.resume({ goal: params.goal });
      this.emit('go_ledger_append', {
        key: entry.conversationKey,
        event: { type: 'continue', tabId, state: entry.engine.getState() },
      });
      return this.status(tabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(tabId: number): Promise<unknown> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, tabId, error: 'no active GO entry' };
    return {
      ok: true,
      tabId,
      platform: entry.adapter.platform,
      running: entry.engine.getState().running,
      state: entry.engine.getState(),
      maxRounds: entry.engine.getConfig().maxRounds,
      decision: entry.decision?.configSummary ?? null,
    };
  }

  async saveDecision(tabId: number, options: LlmDecisionEngineOptions): Promise<unknown> {
    try {
      await chrome.storage.local.set({ goDecisionConfig: options });
      const entry = this.entries.get(tabId);
      if (entry) {
        entry.decision = this.buildDecision(options, tabId);
        entry.engine = this.buildEngine(entry.adapter, entry.decision, tabId);
      }
      return { ok: true, decision: this.buildDecision(options, tabId)?.configSummary ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

let postNativeToHost: ((message: unknown) => void) | null = null;
const controller = new GoAgentController((type, data) => postNativeToHost?.({ type, data }));

export function initGoAgent(postNative?: (message: unknown) => void): void {
  postNativeToHost = postNative ?? null;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = typeof message?.type === 'string' ? message.type : '';
    const tabId = typeof message?.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (!type.startsWith('go:')) return;
    const run = async (): Promise<unknown> => {
      if (tabId == null) return { ok: false, error: 'tabId required' };
      if (type === 'go:loadPrefs') {
        try {
          const r = await chrome.storage.local.get('goPanelPrefs');
          return r.goPanelPrefs ?? null;
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (type === 'go:start') {
        if (message.panelPrefs) {
          try { await chrome.storage.local.set({ goPanelPrefs: message.panelPrefs }); } catch { /* ignore */ }
        }
        return controller.start(tabId, message);
      }
      if (type === 'go:stop') return controller.stop(tabId);
      if (type === 'go:status') return controller.status(tabId);
      if (type === 'go:continue') return controller.continue(tabId, { goal: message.goal });
      if (type === 'go:saveDecision') return controller.saveDecision(tabId, {
        preset: message.preset,
        baseUrl: message.baseUrl,
        apiKey: message.apiKey,
        model: message.model,
      });
      return { ok: false, error: `unknown message ${type}` };
    };
    run().then(sendResponse, (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // async sendResponse
  });
  console.info('[go-agent] initialized; presets:', Object.keys(DECISION_PROVIDER_PRESETS).join(','));
}
