import type { PageAdapter, Platform } from './types.js';

export function detectPlatform(hostname: string): Platform {
  return hostname.includes('chatgpt.com') ? 'chatgpt' : 'deepseek';
}

async function typeIntoTextarea(ta: HTMLTextAreaElement, text: string, charMinMs: number, charMaxMs: number): Promise<boolean> {
  ta.focus();
  document.execCommand('selectAll');
  let execOk = true;
  for (const ch of text) {
    if (!document.execCommand('insertText', false, ch)) {
      execOk = false;
      break;
    }
    await sleep(rand(charMinMs, charMaxMs));
  }
  if (execOk && ta.value === text) return true;
  try {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    const apply = setter as (this: HTMLTextAreaElement, v: string) => void;
    apply.call(ta, '');
    for (const ch of text) {
      apply.call(ta, ta.value + ch);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(rand(charMinMs, charMaxMs));
    }
    return ta.value === text;
  } catch {
    return false;
  }
}

export function createChatGptAdapter(charMinMs: number, charMaxMs: number): PageAdapter {
  const inputSel = '#prompt-textarea';
  return {
    platform: 'chatgpt',
    isBusy() {
      const el = document.querySelector('button[data-testid="stop-button"]');
      return !!el && (el as HTMLElement).offsetParent !== null;
    },
    lastText() {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      return nodes.length ? (nodes[nodes.length - 1] as HTMLElement).innerText : '';
    },
    async typeText(text) {
      const el = document.querySelector<HTMLElement>(inputSel);
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll');
      for (const ch of text) {
        if (!document.execCommand('insertText', false, ch)) return false;
        await sleep(rand(charMinMs, charMaxMs));
      }
      return true;
    },
    async send() {
      const el = document.querySelector<HTMLElement>(inputSel);
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return true;
    },
  };
}

export function createDeepSeekAdapter(charMinMs: number, charMaxMs: number): PageAdapter {
  const inputSel = 'textarea[placeholder*="给 DeepSeek 发送消息"]';
  return {
    platform: 'deepseek',
    isBusy() {
      return [...document.querySelectorAll('button')].some(
        (b) => b.textContent.trim() === '■' && b.offsetParent !== null
      );
    },
    lastText() {
      const list = document.querySelector('.ds-virtual-list-visible-items');
      if (!list) return '';
      const nodes = list.children;
      return nodes.length ? (nodes[nodes.length - 1] as HTMLElement).innerText : '';
    },
    async typeText(text) {
      const ta = document.querySelector<HTMLTextAreaElement>(inputSel);
      if (!ta) return false;
      return typeIntoTextarea(ta, text, charMinMs, charMaxMs);
    },
    async send() {
      const ta = document.querySelector<HTMLTextAreaElement>(inputSel);
      if (!ta) return false;
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return true;
    },
  };
}

export function createAdapter(platform: Platform, charMinMs = 40, charMaxMs = 180): PageAdapter {
  return platform === 'chatgpt'
    ? createChatGptAdapter(charMinMs, charMaxMs)
    : createDeepSeekAdapter(charMinMs, charMaxMs);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a));
