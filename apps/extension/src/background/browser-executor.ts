/**
 * Browser operations executed by the extension service worker.  Keeping this
 * here means a native-messaging client can use the already-running Chrome
 * even when no side panel document exists.
 */

import { executeWebMcpToolInPage, listWebMcpToolsInPage } from '@kv-browser-bridge/browser-protocol';

export type BrowserRequest = {
  requestId: string;
  action: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  deadlineAt?: number;
  operationClass?: 'read' | 'non_idempotent_write';
};

export type BrowserError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type BrowserResponse = {
  type: 'browser:response';
  requestId: string;
  result?: unknown;
  error?: BrowserError;
};

const selectedTabs = new Map<string, number>();
const PANEL_SESSION_ID = 'extension-sidepanel';
const debuggerTabs = new Set<number>();
const observedTabs = new Set<number>();
const consoleEntries = new Map<number, Array<Record<string, unknown>>>();
const networkEntries = new Map<number, Array<Record<string, unknown>>>();
const MAX_DEVTOOLS_ENTRIES = 200;

class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function asError(error: unknown): BrowserError {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'BROWSER_OPERATION_FAILED', message, retryable: false };
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function setSelectedTab(tabId: number, sessionId = PANEL_SESSION_ID): void {
  selectedTabs.set(sessionId, tabId);
}

export function getSelectedTabId(sessionId = PANEL_SESSION_ID): number | null {
  return selectedTabs.get(sessionId) ?? null;
}

export function clearSelectedTab(tabId?: number, sessionId?: string): void {
  for (const [session, selected] of selectedTabs) {
    if ((sessionId == null || session === sessionId) && (tabId == null || selected === tabId)) selectedTabs.delete(session);
  }
}

function sessionFor(params: Record<string, unknown>): string { return typeof params.__sessionId === 'string' ? params.__sessionId : PANEL_SESSION_ID; }
function selectFor(params: Record<string, unknown>, tabId: number): void { setSelectedTab(tabId, sessionFor(params)); }

async function resolveTabId(params: Record<string, unknown>): Promise<number> {
  const requested = numberParam(params.tabId);
  if (requested != null) {
    await chrome.tabs.get(requested).catch(() => {
      throw new ToolError('TAB_NOT_FOUND', `Tab ${requested} no longer exists`, false, { tabId: requested });
    });
    return requested;
  }
  const selectedTabId = getSelectedTabId(sessionFor(params));
  if (selectedTabId != null) {
    const tab = await chrome.tabs.get(selectedTabId).catch(() => undefined);
    if (tab) return selectedTabId;
    clearSelectedTab(selectedTabId, sessionFor(params));
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id == null) throw new ToolError('NO_TARGET_TAB', 'No browser tab is selected');
  selectFor(params, active.id);
  return active.id;
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (debuggerTabs.has(tabId)) return;
  const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve) => chrome.debugger.getTargets(resolve));
  if (targets.some((target) => target.tabId === tabId && target.attached)) {
    throw new ToolError('DEBUGGER_IN_USE', 'Another debugger is already attached to this tab', false, { tabId });
  }
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const error = chrome.runtime.lastError?.message;
      if (error) reject(new ToolError(/another debugger|already attached/i.test(error) ? 'DEBUGGER_IN_USE' : 'DEBUGGER_DETACHED', error, true, { tabId }));
      else { debuggerTabs.add(tabId); resolve(); }
    });
  });
}

function sendDebuggerCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError?.message;
      if (error) {
        debuggerTabs.delete(tabId);
        reject(new ToolError('DEBUGGER_DETACHED', error, true, { tabId, method }));
      }
      else resolve(result as T);
    });
  });
}

/** A detached debugger may be reattached once for observational CDP work.
 * Input/CDP writes deliberately call ensure/send directly and are never replayed. */
async function withSafeDebuggerRead<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureDebuggerAttached(tabId);
      return await work();
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'DEBUGGER_DETACHED' || attempt === 1) throw error;
    }
  }
  throw new ToolError('DEBUGGER_DETACHED', 'Debugger detached while reading page state', true, { tabId });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) { debuggerTabs.delete(source.tabId); observedTabs.delete(source.tabId); }
});
chrome.tabs.onRemoved.addListener((tabId) => { debuggerTabs.delete(tabId); observedTabs.delete(tabId); consoleEntries.delete(tabId); networkEntries.delete(tabId); });

function appendDevtoolsEntry(store: Map<number, Array<Record<string, unknown>>>, tabId: number, entry: Record<string, unknown>): void {
  const entries = store.get(tabId) ?? [];
  entries.push({ at: new Date().toISOString(), ...entry });
  if (entries.length > MAX_DEVTOOLS_ENTRIES) entries.splice(0, entries.length - MAX_DEVTOOLS_ENTRIES);
  store.set(tabId, entries);
}

function remoteValue(value: unknown): unknown {
  if (typeof value !== 'object' || value == null) return value;
  const remote = value as { value?: unknown; description?: string; type?: string };
  return remote.value ?? remote.description ?? remote.type ?? '[unavailable]';
}

chrome.debugger.onEvent.addListener((source, method, params: unknown) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const data = (params ?? {}) as Record<string, any>;
  if (method === 'Runtime.consoleAPICalled') {
    appendDevtoolsEntry(consoleEntries, tabId, { level: data.type ?? 'log', text: Array.isArray(data.args) ? data.args.map(remoteValue).map(String).join(' ') : '', stack: data.stackTrace?.callFrames?.slice(0, 5) });
  } else if (method === 'Runtime.exceptionThrown') {
    appendDevtoolsEntry(consoleEntries, tabId, { level: 'error', text: data.exceptionDetails?.exception?.description ?? data.exceptionDetails?.text ?? 'Uncaught exception', stack: data.exceptionDetails?.stackTrace?.callFrames?.slice(0, 5) });
  } else if (method === 'Network.responseReceived') {
    const response = data.response ?? {};
    appendDevtoolsEntry(networkEntries, tabId, { requestId: data.requestId, url: response.url, status: response.status, mimeType: response.mimeType, type: data.type, failed: Number(response.status) >= 400 });
  } else if (method === 'Network.loadingFailed') {
    appendDevtoolsEntry(networkEntries, tabId, { requestId: data.requestId, errorText: data.errorText, canceled: data.canceled === true, failed: true });
  }
});

async function enableDevtoolsObservation(tabId: number): Promise<void> {
  await ensureDebuggerAttached(tabId);
  if (observedTabs.has(tabId)) return;
  await sendDebuggerCommand(tabId, 'Runtime.enable');
  await sendDebuggerCommand(tabId, 'Network.enable');
  await sendDebuggerCommand(tabId, 'Performance.enable').catch(() => undefined);
  observedTabs.add(tabId);
}

function locator(params: Record<string, unknown>): { selector: string; xpath: string } {
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const xpath = typeof params.xpath === 'string' ? params.xpath : '';
  if (!selector && !xpath) throw new ToolError('INVALID_LOCATOR', 'selector or xpath is required');
  return { selector, xpath };
}

async function executeInPage<T>(tabId: number, func: (...args: any[]) => T, args: unknown[] = []): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (!results.length) throw new ToolError('SCRIPT_EXECUTION_FAILED', 'The page did not return a result', true);
  return results[0].result as T;
}

/** Execute in the page MAIN world: WebMCP's navigator.modelContextTesting is
 *  defined by page scripts in the main world and is not visible from the
 *  isolated world that executeScript uses by default. */
async function executeInPageMain<T>(tabId: number, func: (...args: any[]) => T, args: unknown[] = []): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'MAIN',
  });
  if (!results.length) throw new ToolError('SCRIPT_EXECUTION_FAILED', 'The page did not return a result', true);
  return results[0].result as T;
}

function findElement(selector: string, xpath: string): Element | null {
  if (selector) {
    try {
      const element = document.querySelector(selector);
      if (element) return element;
    } catch { /* return the XPath result below */ }
  }
  if (xpath) {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
    } catch { /* invalid XPath */ }
  }
  return null;
}

function looksLikeFinalPublishControl(element: Element): boolean {
  const text = [
    element.textContent,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('value'),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const explicitSafe = /\b(save draft|draft|preview|cancel|back)\b|草稿|预览|取消|返回/i.test(text);
  const finalPublish = /\b(publish|post|submit|release|send)\b|发布|提交|上线|发送/.test(text);
  return finalPublish && !explicitSafe;
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getTabs(params: Record<string, unknown>): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id != null).map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: Boolean(tab.active),
    selected: tab.id === getSelectedTabId(sessionFor(params)),
  }));
}

async function newTab(params: Record<string, unknown>): Promise<unknown> {
  const url = typeof params.url === 'string' && params.url ? params.url : 'chrome://newtab/';
  const requestedWindowId = numberParam(params.windowId);
  let windowId = requestedWindowId;
  if (windowId == null) {
    const focused = await chrome.windows.getLastFocused();
    windowId = focused.id;
  }
  if (windowId == null) throw new ToolError('NO_TARGET_WINDOW', 'No existing Chrome window is available');

  const tab = await chrome.tabs.create({ windowId, url, active: params.activate !== false });
  if (tab.id == null) throw new ToolError('TAB_CREATE_FAILED', 'Chrome did not return a tab ID', true, { windowId, url });
  selectFor(params, tab.id);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? url,
    active: params.activate !== false,
  };
}

async function switchTab(params: Record<string, unknown>): Promise<unknown> {
  const tabId = numberParam(params.tabId);
  if (tabId == null) throw new ToolError('INVALID_TAB_ID', 'tabId is required');
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new ToolError('TAB_NOT_FOUND', `Tab ${tabId} no longer exists`, false, { tabId });
  });
  if (params.activate !== false) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  }
  selectFor(params, tabId);
  return { tabId, title: tab.title ?? '', url: tab.url ?? '', active: params.activate !== false };
}

async function closeTab(params: Record<string, unknown>): Promise<unknown> {
  // Closing a tab is irreversible.  Do not infer the target from the currently
  // selected tab: callers must name it and opt in explicitly.
  const tabId = numberParam(params.tabId);
  if (tabId == null) throw new ToolError('INVALID_TAB_ID', 'tabId is required to close a tab');
  if (params.confirm !== true) throw new ToolError('CLOSE_CONFIRMATION_REQUIRED', 'confirm must be true to close a tab');
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new ToolError('TAB_NOT_FOUND', `Tab ${tabId} no longer exists`, false, { tabId });
  });
  if (tab.pinned && params.allowPinned !== true) {
    throw new ToolError('PINNED_TAB_CLOSE_BLOCKED', 'Refusing to close a pinned tab without allowPinned: true', false, { tabId });
  }
  const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
  if (windowTabs.length <= 1) {
    throw new ToolError('LAST_TAB_CLOSE_BLOCKED', 'Refusing to close the last tab in a Chrome window', false, { tabId, windowId: tab.windowId });
  }
  await chrome.tabs.remove(tabId).catch((error: unknown) => {
    throw new ToolError('TAB_CLOSE_FAILED', error instanceof Error ? error.message : String(error), true, { tabId });
  });
  clearSelectedTab(tabId);
  return { closed: true, tabId, windowId: tab.windowId };
}

async function navigate(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const url = typeof params.url === 'string' ? params.url : '';
  if (!url) throw new ToolError('INVALID_URL', 'url is required');
  // Subscribe before navigation so an immediately-completing navigation cannot
  // race past the listener and consume the full request timeout.
  const loaded = waitForTabComplete(tabId, numberParam(params.timeoutMs) ?? 30_000);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  const tab = await chrome.tabs.get(tabId);
  return { tabId, title: tab.title ?? '', url: tab.url ?? '' };
}

async function scroll(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const xpath = typeof params.xpath === 'string' ? params.xpath : '';
  const direction = typeof params.direction === 'string' ? params.direction : 'down';
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new ToolError('INVALID_SCROLL_DIRECTION', 'direction must be up, down, left, or right');
  }
  const amount = Math.max(1, Math.min(numberParam(params.amount) ?? numberParam(params.pixels) ?? 600, 10_000));
  const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';
  const result = await executeInPage<{ error?: string; target?: string; before?: { x: number; y: number }; after?: { x: number; y: number } }>(tabId, (css: string, path: string, requestedDirection: string, pixels: number, requestedBehavior: ScrollBehavior) => {
    let element: Element | null = null;
    if (css) { try { element = document.querySelector(css); } catch { return { error: 'Invalid CSS selector' }; } }
    if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { return { error: 'Invalid XPath' }; } }
    if ((css || path) && !element) return { error: 'Element not found' };
    const horizontal = requestedDirection === 'left' || requestedDirection === 'right';
    const signedAmount = (requestedDirection === 'up' || requestedDirection === 'left') ? -pixels : pixels;
    if (element instanceof HTMLElement) {
      const before = { x: element.scrollLeft, y: element.scrollTop };
      element.scrollBy(horizontal ? { left: signedAmount, behavior: requestedBehavior } : { top: signedAmount, behavior: requestedBehavior });
      return { target: 'element', before, after: { x: element.scrollLeft, y: element.scrollTop } };
    }
    const before = { x: window.scrollX, y: window.scrollY };
    window.scrollBy(horizontal ? { left: signedAmount, behavior: requestedBehavior } : { top: signedAmount, behavior: requestedBehavior });
    return { target: 'window', before, after: { x: window.scrollX, y: window.scrollY } };
  }, [selector, xpath, direction, amount, behavior]);
  if (result.error) throw new ToolError('SCROLL_FAILED', result.error, false, { selector, xpath });
  return { scrolled: true, direction, amount, behavior, ...result };
}

async function find(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const xpath = typeof params.xpath === 'string' ? params.xpath : '';
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  const role = typeof params.role === 'string' ? params.role.trim() : '';
  if (!selector && !xpath && !text && !role) {
    throw new ToolError('INVALID_FIND_QUERY', 'text, role, selector, or xpath is required');
  }
  const maxResults = Math.max(1, Math.min(numberParam(params.maxResults) ?? 20, 100));
  const result = await executeInPage<{ error?: string; matches?: Array<Record<string, unknown>>; scanned?: number; truncated?: boolean }>(tabId, (css: string, path: string, containsText: string, requestedRole: string, max: number) => {
    let candidates: Element[] = [];
    if (css) {
      try { candidates = Array.from(document.querySelectorAll(css)); } catch { return { error: 'Invalid CSS selector' }; }
    } else if (path) {
      try {
        const snapshot = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        candidates = Array.from({ length: snapshot.snapshotLength }, (_, index) => snapshot.snapshotItem(index)).filter((element): element is Element => element instanceof Element);
      } catch { return { error: 'Invalid XPath' }; }
    } else {
      candidates = Array.from(document.querySelectorAll('body *'));
    }
    const limited = candidates.slice(0, 5_000);
    const wantedText = containsText.toLocaleLowerCase();
    const wantedRole = requestedRole.toLocaleLowerCase();
    const matches: Array<Record<string, unknown>> = [];
    for (const element of limited) {
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = computed.display !== 'none' && computed.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      const accessibleRole = (element.getAttribute('role') ?? '').toLocaleLowerCase();
      const elementText = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        ? '' : ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (wantedText && !elementText.toLocaleLowerCase().includes(wantedText)) continue;
      if (wantedRole && accessibleRole !== wantedRole) continue;
      matches.push({
        tag: element.tagName.toLocaleLowerCase(),
        id: element.id || undefined,
        role: element.getAttribute('role') || undefined,
        ariaLabel: element.getAttribute('aria-label') || undefined,
        text: elementText.slice(0, 200),
        visible,
      });
      if (matches.length >= max) break;
    }
    return { matches, scanned: limited.length, truncated: candidates.length > limited.length || matches.length >= max };
  }, [selector, xpath, text, role, maxResults]);
  if (result.error) throw new ToolError('FIND_FAILED', result.error, false, { selector, xpath });
  return { tabId, matches: result.matches ?? [], scanned: result.scanned ?? 0, truncated: Boolean(result.truncated) };
}

async function requireOptionalPermission(permission: string, action: string): Promise<void> {
  const granted = await chrome.permissions.contains({ permissions: [permission] });
  if (!granted) {
    throw new ToolError('PERMISSION_REQUIRED', `${action} requires the optional Chrome permission: ${permission}`, false, { permission, action });
  }
}

function filenameBasename(filename: string): string {
  return filename.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

async function downloadStatus(params: Record<string, unknown>): Promise<unknown> {
  await requireOptionalPermission('downloads', 'browser_download_status');
  const id = numberParam(params.downloadId);
  const limit = Math.max(1, Math.min(numberParam(params.limit) ?? 10, 20));
  const startedAfter = typeof params.startedAfter === 'string' ? params.startedAfter : undefined;
  if (startedAfter && Number.isNaN(Date.parse(startedAfter))) {
    throw new ToolError('INVALID_STARTED_AFTER', 'startedAfter must be an ISO-8601 timestamp');
  }
  const query: chrome.downloads.DownloadQuery = {
    orderBy: ['-startTime'],
    id,
    state: typeof params.state === 'string' ? params.state : undefined,
    startedAfter: startedAfter ?? (id == null ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() : undefined),
  };
  const downloads = await chrome.downloads.search(query).catch((error: unknown) => {
    throw new ToolError('DOWNLOAD_QUERY_FAILED', error instanceof Error ? error.message : String(error), true);
  });
  const items = downloads.slice(0, limit).map((item) => ({
    id: item.id,
    state: item.state,
    paused: item.paused,
    canResume: item.canResume,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    percentComplete: item.totalBytes > 0 ? Math.min(100, Math.floor((item.bytesReceived / item.totalBytes) * 100)) : null,
    startTime: item.startTime,
    endTime: item.endTime,
    estimatedEndTime: item.estimatedEndTime,
    danger: item.danger,
    interruptReason: item.error ?? null,
    exists: item.exists,
    mime: item.mime,
    fileSize: item.fileSize,
    filename: filenameBasename(item.filename),
  }));
  if (id != null && !items.length) throw new ToolError('DOWNLOAD_NOT_FOUND', `Download ${id} was not found`, false, { downloadId: id });
  return { downloads: items, limitedTo: limit, historyWindow: id == null ? { startedAfter: query.startedAfter } : undefined };
}

type BookmarkResult = {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  folder: boolean;
  unmodifiable?: string;
};

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], depth: number, maxDepth: number, output: BookmarkResult[]): void {
  for (const node of nodes) {
    output.push({
      id: node.id,
      parentId: node.parentId,
      index: node.index,
      title: node.title,
      url: node.url,
      folder: !node.url,
      unmodifiable: node.unmodifiable,
    });
    if (node.children && depth < maxDepth) flattenBookmarks(node.children, depth + 1, maxDepth, output);
  }
}

async function listBookmarks(params: Record<string, unknown>): Promise<unknown> {
  await requireOptionalPermission('bookmarks', 'browser_list_bookmarks');
  const maxResults = Math.max(1, Math.min(numberParam(params.maxResults) ?? 100, 500));
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (query) {
    const matches = await chrome.bookmarks.search(query);
    return { bookmarks: matches.slice(0, maxResults).map((node) => ({ id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url, folder: !node.url, unmodifiable: node.unmodifiable })), truncated: matches.length > maxResults };
  }
  const folderId = typeof params.folderId === 'string' ? params.folderId : '';
  const maxDepth = Math.max(1, Math.min(numberParam(params.maxDepth) ?? 3, 8));
  const roots = folderId ? await chrome.bookmarks.getSubTree(folderId) : await chrome.bookmarks.getTree();
  if (folderId && !roots.length) throw new ToolError('BOOKMARK_FOLDER_NOT_FOUND', `Bookmark folder ${folderId} was not found`, false, { folderId });
  const bookmarks: BookmarkResult[] = [];
  flattenBookmarks(roots, 0, maxDepth, bookmarks);
  return { bookmarks: bookmarks.slice(0, maxResults), truncated: bookmarks.length > maxResults, maxDepth };
}

async function openBookmark(params: Record<string, unknown>): Promise<unknown> {
  await requireOptionalPermission('bookmarks', 'browser_open_bookmark');
  const bookmarkId = typeof params.bookmarkId === 'string' ? params.bookmarkId : '';
  if (!bookmarkId) throw new ToolError('INVALID_BOOKMARK_ID', 'bookmarkId is required');
  const [bookmark] = await chrome.bookmarks.get(bookmarkId);
  if (!bookmark?.url) throw new ToolError('BOOKMARK_NOT_OPENABLE', 'The selected bookmark is a folder or has no URL', false, { bookmarkId });
  let parsed: URL;
  try { parsed = new URL(bookmark.url); } catch { throw new ToolError('INVALID_BOOKMARK_URL', 'Bookmark URL is invalid', false, { bookmarkId }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError('BOOKMARK_SCHEME_BLOCKED', 'Only HTTP(S) bookmarks may be opened through this tool', false, { bookmarkId, protocol: parsed.protocol });
  }
  const requestedWindowId = numberParam(params.windowId);
  const windowId = requestedWindowId ?? (await chrome.windows.getLastFocused()).id;
  if (windowId == null) throw new ToolError('NO_TARGET_WINDOW', 'No existing Chrome window is available');
  const tab = await chrome.tabs.create({ windowId, url: bookmark.url, active: params.activate !== false });
  if (tab.id == null) throw new ToolError('TAB_CREATE_FAILED', 'Chrome did not return a tab ID', true, { windowId, bookmarkId });
  selectFor(params, tab.id);
  return { bookmarkId, tabId: tab.id, windowId: tab.windowId, title: tab.title ?? bookmark.title, url: tab.url ?? bookmark.url, active: params.activate !== false };
}

async function listExtensions(params: Record<string, unknown>): Promise<unknown> {
  await requireOptionalPermission('management', 'browser_list_extensions');
  const includeDisabled = params.includeDisabled !== false;
  const includePermissions = params.includePermissions === true;
  const extensions = await chrome.management.getAll();
  return {
    extensions: extensions
      .filter((extension) => includeDisabled || extension.enabled)
      .map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        type: extension.type,
        enabled: extension.enabled,
        installType: extension.installType,
        mayDisable: extension.mayDisable,
        disabledReason: extension.disabledReason,
        ...(includePermissions ? { permissions: extension.permissions, hostPermissions: extension.hostPermissions } : {}),
      })),
    extensionStateChanges: 'not_automated_requires_user_gesture',
  };
}

async function snapshot(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  const maxChars = Math.max(500, Math.min(numberParam(params.maxChars) ?? 12_000, 100_000));
  try {
    const tree = await withSafeDebuggerRead(tabId, () => sendDebuggerCommand<{ nodes?: Array<{ nodeId?: string; role?: { value?: string }; name?: { value?: string }; childIds?: string[] }> }>(tabId, 'Accessibility.getFullAXTree'));
    if (tree.nodes?.length) {
      const byId = new Map(tree.nodes.filter((node): node is Required<Pick<typeof node, 'nodeId'>> & typeof node => Boolean(node.nodeId)).map((node) => [node.nodeId, node]));
      const lines: string[] = [];
      const maxDepth = Math.max(1, Math.min(numberParam(params.maxDepth) ?? 12, 50));
      const walk = (nodeId: string, depth: number) => {
        if (depth > maxDepth) return;
        const node = byId.get(nodeId);
        if (!node) return;
        const role = node.role?.value ?? '';
        const name = node.name?.value ?? '';
        const visible = role && role !== 'none' && role !== 'generic';
        if (visible) lines.push(`${'  '.repeat(depth)}${role}${name ? ` \"${name}\"` : ''}`);
        for (const childId of node.childIds ?? []) walk(childId, depth + (visible ? 1 : 0));
      };
      if (tree.nodes[0].nodeId) walk(tree.nodes[0].nodeId, 0);
      const snapshot = lines.join('\n');
      return { tabId, title: tab.title ?? '', url: tab.url ?? '', snapshot: snapshot.slice(0, maxChars), format: 'accessibility', truncated: snapshot.length > maxChars };
    }
  } catch { /* Fall back to a DOM-only structural view. */ }

  const maxDepth = Math.max(1, Math.min(numberParam(params.maxDepth) ?? 6, 30));
  const dom = await executeInPage<string>(tabId, (depth: number) => {
    const render = (element: Element, level: number): string => {
      if (level > depth) return '';
      const tag = element.tagName.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) return '';
      const id = element.id ? `#${element.id}` : '';
      const role = element.getAttribute('role');
      const label = element.getAttribute('aria-label');
      const directText = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent?.trim()).filter(Boolean).join(' ').slice(0, 80);
      let output = `${'  '.repeat(level)}<${tag}${id}${role ? ` role=\"${role}\"` : ''}${label ? ` aria-label=\"${label}\"` : ''}>${directText ? ` \"${directText}\"` : ''}\n`;
      for (const child of Array.from(element.children)) output += render(child, level + 1);
      return output;
    };
    return document.body ? render(document.body, 0) : '';
  }, [maxDepth]);
  return { tabId, title: tab.title ?? '', url: tab.url ?? '', snapshot: dom.slice(0, maxChars), format: 'dom', truncated: dom.length > maxChars };
}

async function screenshot(tabId: number): Promise<unknown> {
  try {
    const captured = await withSafeDebuggerRead(tabId, () => withTimeout(
      sendDebuggerCommand<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png' }),
      10_000,
      'Screenshot CDP request timed out',
    ));
    return { tabId, mimeType: 'image/png', captureMethod: 'cdp', dataUrl: `data:image/png;base64,${captured.data}` };
  } catch (cdpError) {
    const tab = await chrome.tabs.get(tabId);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { tabId, mimeType: 'image/png', captureMethod: 'captureVisibleTab', dataUrl };
    } catch (fallbackError) {
      throw new ToolError(
        'SCREENSHOT_FAILED',
        `CDP capture failed (${cdpError instanceof Error ? cdpError.message : String(cdpError)}); visible-tab fallback failed (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`,
        true,
        { tabId },
      );
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError('SCREENSHOT_TIMEOUT', message, true)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function click(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const { selector, xpath } = locator(params);
  const allowCommentSend = params.allowCommentSend === true;
  const result = await executeInPage<{ error?: string; blocked?: boolean; tag?: string; text?: string }>(tabId, (css: string, path: string, allowCommentSendControl: boolean) => {
    let element: Element | null = null;
    if (css) { try { element = document.querySelector(css); } catch { /* try XPath */ } }
    if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { /* invalid XPath */ } }
    if (!element) return { error: 'Element not found' };
    const text = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('value')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const explicitSafe = /\b(save draft|draft|preview|cancel|back)\b|草稿|预览|取消|返回/i.test(text);
    const finalPublish = /\b(publish|post|submit|release|send)\b|发布|提交|上线|发送/i.test(text);
    const commentComposerContainsButton = Array.from(document.querySelectorAll('[contenteditable="true"]')).some((editor) => {
      let ancestor: Element | null = editor.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
        if (ancestor.contains(element)) return true;
      }
      return false;
    });
    const approvedCommentSend = allowCommentSendControl && text === '发送' && commentComposerContainsButton;
    if (finalPublish && !explicitSafe && !approvedCommentSend) return { blocked: true, text: text.slice(0, 160) };
    (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
    (element as HTMLElement).click();
    return { tag: element.tagName.toLowerCase(), text: (element.textContent ?? '').trim().slice(0, 160) };
  }, [selector, xpath, allowCommentSend]);
  if (result.blocked) throw new ToolError('PREPUBLISH_BLOCKED', 'Clicking a final publish or submit control is disabled', false, { text: result.text });
  if (result.error) throw new ToolError('ELEMENT_NOT_FOUND', result.error, false, { selector, xpath });
  return { clicked: true, ...result };
}

async function typeText(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const { selector, xpath } = locator(params);
  const text = typeof params.text === 'string' ? params.text : '';
  if (typeof params.text !== 'string') throw new ToolError('INVALID_TEXT', 'text is required');
  const clear = params.clear !== false;
  const result = await executeInPage<{ error?: string; tag?: string }>(tabId, (css: string, path: string, value: string, shouldClear: boolean) => {
    let element: Element | null = null;
    if (css) { try { element = document.querySelector(css); } catch { /* try XPath */ } }
    if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { /* invalid XPath */ } }
    const editable = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
    if (!editable) return { error: 'Element not found' };
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      const prototype = editable instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(editable, shouldClear ? value : `${editable.value}${value}`);
    } else if (editable.isContentEditable) {
      editable.textContent = shouldClear ? value : `${editable.textContent ?? ''}${value}`;
    } else return { error: 'Element is not editable' };
    editable.focus();
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
    return { tag: editable.tagName.toLowerCase() };
  }, [selector, xpath, text, clear]);
  if (result.error) throw new ToolError('TYPE_FAILED', result.error, false, { selector, xpath });
  return { typed: true, characters: text.length, ...result };
}

async function press(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const key = typeof params.key === 'string' ? params.key : '';
  if (!key) throw new ToolError('INVALID_KEY', 'key is required');
  const parsedShortcut = key.split('+').map((part) => part.trim()).filter(Boolean);
  const shortcutKey = parsedShortcut.pop() ?? key;
  const suppliedModifiers = Array.isArray(params.modifiers) ? params.modifiers.filter((value): value is string => typeof value === 'string') : [];
  const modifierNames = [...new Set([...suppliedModifiers, ...parsedShortcut.map((part) => part === 'Ctrl' ? 'Control' : part)])];
  const modifierBits = modifierNames.reduce((bits, modifier) => bits | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier] ?? 0), 0);
  await ensureDebuggerAttached(tabId);
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: shortcutKey, modifiers: modifierBits });
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: shortcutKey, modifiers: modifierBits });
  return { pressed: shortcutKey, modifiers: modifierNames };
}

async function select(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const { selector, xpath } = locator(params);
  const value = typeof params.value === 'string' ? params.value : undefined;
  const label = typeof params.label === 'string' ? params.label : undefined;
  if (value == null && label == null) throw new ToolError('INVALID_SELECT_VALUE', 'value or label is required');
  const result = await executeInPage<{ error?: string; value?: string }>(tabId, (css: string, path: string, wantedValue?: string, wantedLabel?: string) => {
    let element: Element | null = null;
    if (css) { try { element = document.querySelector(css); } catch { /* try XPath */ } }
    if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { /* invalid XPath */ } }
    if (!(element instanceof HTMLSelectElement)) return { error: 'Element is not a select control' };
    const option = Array.from(element.options).find((candidate) => candidate.value === wantedValue || candidate.label === wantedLabel || candidate.text === wantedLabel);
    if (!option) return { error: 'Matching option not found' };
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: element.value };
  }, [selector, xpath, value, label]);
  if (result.error) throw new ToolError('SELECT_FAILED', result.error, false, { selector, xpath, value, label });
  return { selected: true, value: result.value };
}

async function nodeIdForLocator(tabId: number, selector: string, xpath: string): Promise<number> {
  const documentNode = await sendDebuggerCommand<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 1 });
  if (selector) {
    const query = await sendDebuggerCommand<{ nodeId: number }>(tabId, 'DOM.querySelector', { nodeId: documentNode.root.nodeId, selector });
    if (query.nodeId) return query.nodeId;
  }
  if (xpath) {
    const search = await sendDebuggerCommand<{ searchId: string; resultCount: number }>(tabId, 'DOM.performSearch', { query: xpath, includeUserAgentShadowDOM: true });
    try {
      if (search.resultCount) {
        const results = await sendDebuggerCommand<{ nodeIds: number[] }>(tabId, 'DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: 1 });
        if (results.nodeIds[0]) return results.nodeIds[0];
      }
    } finally {
      await sendDebuggerCommand(tabId, 'DOM.discardSearchResults', { searchId: search.searchId }).catch(() => undefined);
    }
  }
  throw new ToolError('ELEMENT_NOT_FOUND', 'File input was not found', false, { selector, xpath });
}

async function setFiles(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const { selector, xpath } = locator(params);
  const files = Array.isArray(params.files) ? params.files : [];
  if (!files.length || files.some((file) => typeof file !== 'string' || file.length < 4 || !/^[a-zA-Z]:$/.test(file.slice(0, 2)) || (file[2] !== '\\' && file[2] !== '/'))) {
    throw new ToolError('INVALID_FILE_PATH', 'files must contain local Windows absolute paths');
  }
  await ensureDebuggerAttached(tabId);
  const nodeId = await nodeIdForLocator(tabId, selector, xpath);
  const description = await sendDebuggerCommand<{ node: { nodeName?: string; attributes?: string[] } }>(tabId, 'DOM.describeNode', { nodeId });
  const attributes = description.node.attributes ?? [];
  const typeIndex = attributes.findIndex((value) => value.toLowerCase() === 'type');
  if (description.node.nodeName?.toLowerCase() !== 'input' || typeIndex < 0 || attributes[typeIndex + 1]?.toLowerCase() !== 'file') {
    throw new ToolError('NOT_FILE_INPUT', 'The selected element is not an input[type=file]');
  }
  await sendDebuggerCommand(tabId, 'DOM.setFileInputFiles', { nodeId, files });
  return { files: files.map((file) => file.split(/[\\/]/).pop()), count: files.length };
}

async function waitFor(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const timeoutMs = Math.max(100, Math.min(numberParam(params.timeoutMs) ?? 30_000, 120_000));
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const xpath = typeof params.xpath === 'string' ? params.xpath : '';
  const text = typeof params.text === 'string' ? params.text : '';
  const urlIncludes = typeof params.urlIncludes === 'string'
    ? params.urlIncludes
    : typeof params.url === 'string' ? params.url : '';
  if (!selector && !xpath && !text && !urlIncludes) throw new ToolError('INVALID_WAIT_CONDITION', 'selector, xpath, text, or urlIncludes is required');
  const deadline = Date.now() + timeoutMs;
  const state = typeof params.state === 'string' ? params.state : 'attached';
  if (state === 'load') {
    await waitForTabComplete(tabId, timeoutMs);
    return { matched: true, state: 'load', waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
  }
  while (Date.now() < deadline) {
    const matched = await executeInPage<boolean>(tabId, (css: string, path: string, containsText: string, includesUrl: string, requestedState: string) => {
      if (includesUrl && !location.href.includes(includesUrl)) return false;
      if (containsText && !(document.body?.innerText ?? '').includes(containsText)) return false;
      let element: Element | null = null;
      if (css) { try { element = document.querySelector(css); } catch { /* try XPath */ } }
      if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { /* invalid XPath */ } }
      if (!css && !path) return true;
      if (requestedState === 'detached') return !element;
      if (requestedState === 'hidden') {
        if (!element) return true;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0;
      }
      if (requestedState === 'visible') {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      return Boolean(element);
    }, [selector, xpath, text, urlIncludes, state]);
    if (matched) return { matched: true, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ToolError('WAIT_TIMEOUT', 'Timed out waiting for page condition', true, { selector, xpath, text, urlIncludes, timeoutMs });
}

async function getText(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const { selector, xpath } = locator(params);
  const maxLength = Math.max(1, Math.min(numberParam(params.maxLength) ?? numberParam(params.maxChars) ?? 20_000, 200_000));
  const result = await executeInPage<{ error?: string; text?: string }>(tabId, (css: string, path: string, max: number) => {
    let element: Element | null = null;
    if (css) { try { element = document.querySelector(css); } catch { /* try XPath */ } }
    if (!element && path) { try { element = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null; } catch { /* invalid XPath */ } }
    return element ? { text: ((element as HTMLElement).innerText || element.textContent || '').trim().slice(0, max) } : { error: 'Element not found' };
  }, [selector, xpath, maxLength]);
  if (!result) throw new ToolError('SCRIPT_EXECUTION_FAILED', 'The page did not return text', true);
  if (result.error) throw new ToolError('ELEMENT_NOT_FOUND', result.error, false, { selector, xpath });
  return { text: result.text ?? '' };
}

async function getUrl(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, title: tab.title ?? '', url: tab.url ?? '' };
}

function boundedEntries(entries: Array<Record<string, unknown>>, params: Record<string, unknown>): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(numberParam(params.limit) ?? 50, MAX_DEVTOOLS_ENTRIES));
  return entries.slice(-limit);
}

async function consoleLogs(tabId: number, params: Record<string, unknown>, errorsOnly = false): Promise<unknown> {
  await withSafeDebuggerRead(tabId, () => enableDevtoolsObservation(tabId));
  const entries = boundedEntries(consoleEntries.get(tabId) ?? [], params);
  return { tabId, entries: errorsOnly ? entries.filter((entry) => entry.level === 'error' || entry.level === 'warning' || entry.level === 'warn') : entries, buffered: consoleEntries.get(tabId)?.length ?? 0 };
}

async function networkRequests(tabId: number, params: Record<string, unknown>, failuresOnly = false): Promise<unknown> {
  await withSafeDebuggerRead(tabId, () => enableDevtoolsObservation(tabId));
  const entries = boundedEntries(networkEntries.get(tabId) ?? [], params);
  return { tabId, entries: failuresOnly ? entries.filter((entry) => entry.failed === true) : entries, buffered: networkEntries.get(tabId)?.length ?? 0 };
}

async function responseBody(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  const requestId = typeof params.requestId === 'string' ? params.requestId : '';
  if (!requestId) throw new ToolError('INVALID_REQUEST', 'requestId is required');
  const maxChars = Math.max(1, Math.min(numberParam(params.maxChars) ?? 20_000, 100_000));
  return withSafeDebuggerRead(tabId, async () => {
    await enableDevtoolsObservation(tabId);
    const body = await sendDebuggerCommand<{ body: string; base64Encoded: boolean }>(tabId, 'Network.getResponseBody', { requestId });
    const text = body.body.slice(0, maxChars);
    return { tabId, requestId, body: text, base64Encoded: body.base64Encoded === true, truncated: body.body.length > text.length, totalChars: body.body.length };
  });
}

async function inspectElement(tabId: number, params: Record<string, unknown>, includeStyles = false): Promise<unknown> {
  const { selector, xpath } = locator(params);
  return withSafeDebuggerRead(tabId, async () => {
    await ensureDebuggerAttached(tabId);
    const nodeId = await nodeIdForLocator(tabId, selector, xpath);
    const description = await sendDebuggerCommand<{ node: { nodeName?: string; localName?: string; nodeValue?: string; attributes?: string[]; backendNodeId?: number } }>(tabId, 'DOM.describeNode', { nodeId });
    const box = await sendDebuggerCommand<{ model?: { content?: number[]; width?: number; height?: number } }>(tabId, 'DOM.getBoxModel', { nodeId }).catch((): { model?: { content?: number[]; width?: number; height?: number } } => ({}));
    const base = { tabId, nodeId, node: description.node, box: box.model ? { content: box.model.content, width: box.model.width, height: box.model.height } : undefined };
    if (!includeStyles) return base;
    const styles = await sendDebuggerCommand<{ computedStyle: Array<{ name: string; value: string }> }>(tabId, 'CSS.getComputedStyleForNode', { nodeId }).catch(() => ({ computedStyle: [] }));
    return { ...base, styles: styles.computedStyle };
  });
}

async function pageMetrics(tabId: number): Promise<unknown> {
  return withSafeDebuggerRead(tabId, async () => {
    await enableDevtoolsObservation(tabId);
    const [metrics, layout] = await Promise.all([
      sendDebuggerCommand<{ metrics: Array<{ name: string; value: number }> }>(tabId, 'Performance.getMetrics'),
      sendDebuggerCommand<Record<string, unknown>>(tabId, 'Page.getLayoutMetrics').catch(() => ({})),
    ]);
    const selected = Object.fromEntries(metrics.metrics.filter((metric) => ['Timestamp', 'Documents', 'Frames', 'Nodes', 'JSHeapUsedSize', 'JSHeapTotalSize', 'LayoutCount', 'RecalcStyleCount'].includes(metric.name)).map((metric) => [metric.name, metric.value]));
    return { tabId, metrics: selected, layout };
  });
}

export async function handleBrowserRequest(request: BrowserRequest, connectionStatus: () => unknown): Promise<BrowserResponse> {
  const params: Record<string, unknown> = { ...(request.params ?? {}), __sessionId: request.sessionId ?? PANEL_SESSION_ID };
  // Bridge implementations may forward either the compact protocol operation
  // name or the public MCP tool name. Keep the extension protocol tolerant of
  // both while preserving one internal dispatch table.
  const action = request.action.replace(/^browser_/, '');
  try {
    let result: unknown;
    if (typeof request.deadlineAt === 'number' && request.deadlineAt <= Date.now()) {
      throw new ToolError(request.operationClass === 'non_idempotent_write' ? 'UNKNOWN_OUTCOME' : 'REQUEST_TIMEOUT', 'Request deadline expired before execution', request.operationClass === 'read', { deadlineAt: request.deadlineAt });
    }
    if (action === 'get_tabs') result = await getTabs(params);
    else if (action === 'new_tab') result = await newTab(params);
    else if (action === 'switch_tab') result = await switchTab(params);
    else if (action === 'close_tab') result = await closeTab(params);
    else if (action === 'download_status') result = await downloadStatus(params);
    else if (action === 'list_bookmarks') result = await listBookmarks(params);
    else if (action === 'open_bookmark') result = await openBookmark(params);
    else if (action === 'list_extensions') result = await listExtensions(params);
    else if (action === 'list_webmcp_tools') {
      const tabId = await resolveTabId(params);
      result = await executeInPageMain(tabId, listWebMcpToolsInPage);
    }
    else if (action === 'connection_status') result = connectionStatus();
    else {
      const requiresExplicitTab = new Set(['navigate', 'scroll', 'click', 'type', 'press', 'select', 'evaluate', 'set_files', 'list_webmcp_tools', 'execute_webmcp_tool']);
      if (requiresExplicitTab.has(action) && numberParam(params.tabId) == null) throw new ToolError('EXPLICIT_TAB_ID_REQUIRED', `${action} requires an explicit tabId`, false);
      const tabId = await resolveTabId(params);
      switch (action) {
        case 'navigate': result = await navigate(tabId, params); break;
        case 'scroll': result = await scroll(tabId, params); break;
        case 'find': result = await find(tabId, params); break;
        case 'snapshot': result = await snapshot(tabId, params); break;
        case 'screenshot': result = await screenshot(tabId); break;
        case 'click': result = await click(tabId, params); break;
        case 'type': result = await typeText(tabId, params); break;
        case 'press': result = await press(tabId, params); break;
        case 'select': result = await select(tabId, params); break;
        case 'evaluate': {
          const expression = typeof params.expression === 'string' ? params.expression : '';
          if (!expression) throw new ToolError('INVALID_EXPRESSION', 'expression is required');
          await ensureDebuggerAttached(tabId);
          result = await sendDebuggerCommand(tabId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, throwOnSideEffect: true, userGesture: false });
          break;
        }
        case 'execute_webmcp_tool': {
          const name = typeof params.name === 'string' && params.name ? params.name : '';
          if (!name) throw new ToolError('INVALID_PARAMS', 'execute_webmcp_tool requires a non-empty tool name', false);
          const rawInput = params.input;
          const input = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput) ? rawInput : {};
          result = await executeInPageMain(tabId, executeWebMcpToolInPage, [name, input]);
          break;
        }
        case 'set_files': result = await setFiles(tabId, params); break;
        case 'wait_for': result = await waitFor(tabId, params); break;
        case 'get_text': result = await getText(tabId, params); break;
        case 'get_url': result = await getUrl(tabId); break;
        case 'console_logs': result = await consoleLogs(tabId, params); break;
        case 'console_errors': result = await consoleLogs(tabId, params, true); break;
        case 'network_requests': result = await networkRequests(tabId, params); break;
        case 'network_failures': result = await networkRequests(tabId, params, true); break;
        case 'get_response_body': result = await responseBody(tabId, params); break;
        case 'inspect_element': result = await inspectElement(tabId, params, false); break;
        case 'get_element_styles': result = await inspectElement(tabId, params, true); break;
        case 'page_metrics': result = await pageMetrics(tabId); break;
        default: throw new ToolError('UNKNOWN_ACTION', `Unknown browser action: ${request.action}`);
      }
    }
    return { type: 'browser:response', requestId: request.requestId, result };
  } catch (error) {
    return { type: 'browser:response', requestId: request.requestId, error: asError(error) };
  }
}
