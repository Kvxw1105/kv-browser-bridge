import { getSelectedTabId, handleBrowserRequest, setSelectedTab, type BrowserResponse } from './browser-executor';

const HOST_NAME = 'com.claude_code_browser';
const MAX_NATIVE_MESSAGE_BYTES = 480 * 1024;

let nativePort: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const panelPorts = new Set<chrome.runtime.Port>();

function log(event: string, details: Record<string, unknown> = {}): void {
  console.info('[local-chrome-extension]', JSON.stringify({ event, at: new Date().toISOString(), ...details }));
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

    port.onMessage.addListener((message: { type?: string; requestId?: string; action?: string; params?: Record<string, unknown>; domain?: string; paths?: string[] }) => {
      if (message.type === 'browser:request' && typeof message.requestId === 'string' && typeof message.action === 'string') {
        void handleBrowserRequest({ requestId: message.requestId, action: message.action, params: message.params }, connectionStatus)
          .then(postBrowserResponse)
          .catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            try { postNative({ type: 'browser:response', requestId: message.requestId, error: { code: 'EXTENSION_INTERNAL_ERROR', message: text, retryable: true } }); } catch { /* reconnect handles it */ }
          });
        return;
      }
      if (message.type === 'sources:set' && message.domain && message.paths) {
        chrome.storage.local.set({ [`ccb-sources-${message.domain}`]: message.paths });
      }
      broadcastToPanels(message);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const error = chrome.runtime.lastError?.message ?? 'Chrome Bridge disconnected';
      nativePort = null;
      log('bridge_disconnected', { error });
      broadcastToPanels({ type: '_native_status', connected: false, error });
      scheduleReconnect();
    });
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

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  setSelectedTab(tab.id);
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tab=${tab.id}`, enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    // The Side Panel is optional for the Bridge; a UI failure must not disrupt
    // Native Messaging or background browser control.
    log('sidepanel_open_failed', {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (getSelectedTabId() === tabId) {
    // The executor will fall back to the active tab for a later request.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab?.id != null) setSelectedTab(tab.id);
    }).catch(() => undefined);
  }
});
