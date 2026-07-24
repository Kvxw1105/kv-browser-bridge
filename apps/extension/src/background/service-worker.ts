import { clearSelectedTab, getSelectedTabId, handleBrowserRequest, setSelectedTab, type BrowserResponse } from './browser-executor';
import { flowRecordingStatus, recordFlowUserEvent, startFlowRecording, stopFlowRecording } from './flow-recorder';

const HOST_NAME = 'io.kv.browser_bridge';
const MAX_NATIVE_MESSAGE_BYTES = 480 * 1024;

let nativePort: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const panelPorts = new Set<chrome.runtime.Port>();

function log(event: string, details: Record<string, unknown> = {}): void {
  console.info('[kv-browser-bridge-extension]', JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function broadcastToPanels(message: unknown): void {
  for (const panel of panelPorts) {
    try { panel.postMessage(message); } catch { panelPorts.delete(panel); }
  }
}

function connectionStatus() {
  return {
    extensionConnected: true,
    bridgeConnected: nativePort != null,
    selectedTabId: getSelectedTabId(),
    reconnectAttempt,
    panelCount: panelPorts.size,
  };
}

function postNative(message: unknown): void {
  if (!nativePort) throw new Error('Chrome Bridge is disconnected');
  nativePort.postMessage(message);
}

/** Native Messaging has a one-megabyte payload limit.  Large screenshots are
 * transferred as a UTF-8 JSON stream so the Bridge can safely reconstruct the
 * original browser:response without sharing this process's stdin/stdout. */
function postBrowserResponse(response: BrowserResponse): void {
  const encoded = JSON.stringify(response);
  if (new TextEncoder().encode(encoded).byteLength <= MAX_NATIVE_MESSAGE_BYTES) {
    postNative(response);
    return;
  }
  const encodedBase64 = bytesToBase64(new TextEncoder().encode(encoded));
  const chunkSize = 320 * 1024;
  const totalChunks = Math.ceil(encodedBase64.length / chunkSize);
  for (let index = 0; index < totalChunks; index += 1) {
    postNative({
      type: 'bridge:chunk',
      transferId: response.requestId,
      index,
      total: totalChunks,
      encoding: 'base64-json',
      data: encodedBase64.slice(index * chunkSize, (index + 1) * chunkSize),
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, delay);
  log('bridge_reconnect_scheduled', { delay, reconnectAttempt });
}

function connectBridge(): void {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    reconnectAttempt = 0;
    log('bridge_connected');
    broadcastToPanels({ type: '_native_status', connected: true });

    port.onMessage.addListener((message: { type?: string; requestId?: string; action?: string; params?: Record<string, unknown>; sessionId?: string; deadlineAt?: number; operationClass?: 'read' | 'non_idempotent_write'; domain?: string; paths?: string[] }) => {
      if (message.type === 'browser:request' && typeof message.requestId === 'string' && typeof message.action === 'string') {
        void handleBrowserRequest({ requestId: message.requestId, action: message.action, params: message.params, sessionId: message.sessionId, deadlineAt: message.deadlineAt, operationClass: message.operationClass }, connectionStatus)
          .then(postBrowserResponse)
          .catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            try { postNative({ type: 'browser:response', requestId: message.requestId, error: { code: 'EXTENSION_INTERNAL_ERROR', message: text, retryable: true } }); } catch { /* reconnect handles it */ }
          });
        return;
      }
      if (message.type === 'ping') { try { postNative({ type: 'pong' }); } catch { /* reconnect handles it */ } return; }
      if (message.type === 'sources:set' && message.domain && message.paths) {
        chrome.storage.local.set({ [`ccb-sources-${message.domain}`]: message.paths });
      }
      broadcastToPanels(message);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const error = chrome.runtime.lastError?.message ?? 'Chrome Bridge disconnected';
      nativePort = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      log('bridge_disconnected', { error });
      broadcastToPanels({ type: '_native_status', connected: false, error });
      scheduleReconnect();
    });
    heartbeatTimer = setInterval(() => {
      if (nativePort === port) { try { port.postMessage({ type: 'ping' }); } catch { /* disconnect handler reconnects */ } }
    }, 15_000);
  } catch (error) {
    log('bridge_connect_failed', { error: error instanceof Error ? error.message : String(error) });
    scheduleReconnect();
  }
}

// Start a single bridge connection independently of side-panel lifetime.
connectBridge();
chrome.runtime.onStartup.addListener(connectBridge);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    chrome.storage.local.get('ccb-stats', (res) => {
      if (!res['ccb-stats']) chrome.storage.local.set({ 'ccb-stats': { installedAt: Date.now(), messageCount: 0, sessionCount: 0 } });
    });
  }
  connectBridge();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);
  port.onMessage.addListener((message: { type?: string; tabId?: number } & Record<string, unknown>) => {
    if (message.type === '_panel_init' && typeof message.tabId === 'number') {
      // Retain selection for legacy callers that do not provide tabId. New MCP
      // requests should always select explicitly through browser_switch_tab.
      setSelectedTab(message.tabId);
      try { port.postMessage({ type: '_native_status', connected: nativePort != null }); } catch { /* closed */ }
      return;
    }
    try { postNative(message); } catch (error) {
      try { port.postMessage({ type: '_native_status', connected: false, error: error instanceof Error ? error.message : String(error) }); } catch { /* closed */ }
    }
  });
  port.onDisconnect.addListener(() => panelPorts.delete(port));
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  setSelectedTab(tab.id);
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`sidepanel.html?tab=${tab.id}`),
    active: true,
  }).catch((error) => {
    log('tool_tab_open_failed', {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSelectedTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'KV_FLOW_USER_EVENT' && sender.tab?.id != null && typeof message.event === 'object' && message.event != null) {
    recordFlowUserEvent(sender.tab.id, message.event);
    return;
  }
  if (message?.type === 'KV_FLOW_CONTROL') {
    const tabId = typeof message.tabId === 'number' ? message.tabId : null;
    const intent = typeof message.intent === 'string' ? message.intent.trim() : '';
    if (message.action === 'status') {
      sendResponse({ ok: true, status: flowRecordingStatus() });
      return;
    }
    if (tabId == null) {
      sendResponse({ ok: false, error: 'A target tab is required.' });
      return;
    }
    if (message.action === 'start' && intent.length < 3) {
      sendResponse({ ok: false, error: 'Describe the workflow in at least 3 characters.' });
      return;
    }
    const operation = message.action === 'start'
      ? startFlowRecording(tabId, intent, false)
      : message.action === 'stop'
        ? stopFlowRecording(tabId)
        : Promise.reject(new Error('Unknown recording operation.'));
    void operation.then((result) => sendResponse({ ok: true, result, status: flowRecordingStatus() }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error), status: flowRecordingStatus() }));
    return true;
  }
  if (message?.type !== 'KV_SET_TARGET_TAB' || typeof message.tabId !== 'number') return;
  void chrome.tabs.get(message.tabId).then((tab) => {
    setSelectedTab(message.tabId);
    sendResponse({ ok: true, tabId: message.tabId, title: tab.title ?? '', url: tab.url ?? '' });
  }).catch(() => sendResponse({ ok: false }));
  return true;
});
