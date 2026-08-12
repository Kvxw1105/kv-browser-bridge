import { clearSelectedTab, getSelectedTabId, handleBrowserRequest, setSelectedTab, type BrowserResponse } from './browser-executor';
import { flowRecordingStatus, recordFlowUserEvent, startFlowRecording, stopFlowRecording } from './flow-recorder';


const HOST_NAME = 'io.kv.browser_bridge';
const MAX_NATIVE_MESSAGE_BYTES = 480 * 1024;

let nativePort: chrome.runtime.Port | null = null;
let nativeReady = false;
let lastNativeError = '';
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const panelPorts = new Set<chrome.runtime.Port>();

type CoordinationStatus = {
  mode: 'off' | 'observe' | 'enforce';
  clients: Array<{ clientId: string; clientName: string; defaultTabId?: number }>;
  leases: Array<{ resource: string; purpose: string; state: 'active' | 'quarantined'; expiresAt: string }>;
};

let latestCoordinationStatus: CoordinationStatus | null = null;

function sanitizeCoordinationStatus(value: unknown): CoordinationStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (mode !== 'off' && mode !== 'observe' && mode !== 'enforce') return null;
  const clients = Array.isArray(input.clients) ? input.clients.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const client = entry as Record<string, unknown>;
    if (typeof client.clientId !== 'string' || typeof client.clientName !== 'string') return [];
    const defaultTabId = client.defaultTabId;
    return [{
      clientId: client.clientId,
      clientName: client.clientName,
      ...(typeof defaultTabId === 'number' && Number.isFinite(defaultTabId) ? { defaultTabId } : {}),
    }];
  }) : [];
  const leases = Array.isArray(input.leases) ? input.leases.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const lease = entry as Record<string, unknown>;
    if (typeof lease.resource !== 'string' || typeof lease.purpose !== 'string' || typeof lease.expiresAt !== 'string') return [];
    if (lease.state !== 'active' && lease.state !== 'quarantined') return [];
    return [{ resource: lease.resource, purpose: lease.purpose, state: lease.state as 'active' | 'quarantined', expiresAt: lease.expiresAt }];
  }) : [];
  return { mode, clients, leases };
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.info('[kv-browser-bridge-extension]', JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function broadcastToPanels(message: unknown): void {
  for (const panel of panelPorts) {
    try { panel.postMessage(message); } catch { panelPorts.delete(panel); }
  }
}

function nativeStatusMessage(extra: Record<string, unknown> = {}) {
  return {
    type: '_native_status',
    connected: nativePort != null,
    nativeReady,
    reconnectAttempt,
    ...(lastNativeError ? { error: lastNativeError } : {}),
    ...extra,
  };
}

function connectionStatus() {
  return {
    extensionConnected: true,
    bridgeConnected: nativePort != null && nativeReady,
    nativeReady,
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

function forceReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  const current = nativePort;
  nativePort = null;
  nativeReady = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (current) {
    try { current.disconnect(); } catch { /* the new connection attempt is authoritative */ }
  }
  lastNativeError = 'Manual reconnect requested.';
  broadcastToPanels(nativeStatusMessage({ connected: false, nativeReady: false, reconnecting: true }));
  connectBridge();
}

function connectBridge(): void {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    nativeReady = false;
    lastNativeError = '';
    reconnectAttempt = 0;
    log('bridge_connected');
    broadcastToPanels(nativeStatusMessage());

    port.onMessage.addListener((message: { type?: string; requestId?: string; action?: string; params?: Record<string, unknown>; sessionId?: string; deadlineAt?: number; operationClass?: 'read' | 'non_idempotent_write'; domain?: string; paths?: string[]; status?: unknown }) => {
      if (message.type === 'bridge:ready') {
        nativeReady = true;
        log('bridge_ready');
        broadcastToPanels(nativeStatusMessage());
        return;
      }
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
      if (message.type === 'bridge:coordination_status') {
        const status = sanitizeCoordinationStatus(message.status);
        if (!status) return;
        latestCoordinationStatus = status;
        broadcastToPanels({ ...message, status });
        return;
      }
      broadcastToPanels(message);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const error = chrome.runtime.lastError?.message ?? 'Chrome Bridge disconnected';
      nativePort = null;
      nativeReady = false;
      lastNativeError = error;
      latestCoordinationStatus = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      log('bridge_disconnected', { error });
      const repairRequired = /forbidden|native messaging host|specified native messaging host|not found|cannot find|access/i.test(error);
      broadcastToPanels(nativeStatusMessage({ connected: false, nativeReady: false, repairRequired }));
      scheduleReconnect();
    });
    heartbeatTimer = setInterval(() => {
      if (nativePort === port) { try { port.postMessage({ type: 'ping' }); } catch { /* disconnect handler reconnects */ } }
    }, 15_000);
  } catch (error) {
    lastNativeError = error instanceof Error ? error.message : String(error);
    log('bridge_connect_failed', { error: lastNativeError });
    broadcastToPanels(nativeStatusMessage({ connected: false, nativeReady: false }));
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
  if (port.name !== 'sidepanel' && port.name !== 'popup') return;
  panelPorts.add(port);
  try { port.postMessage(nativeStatusMessage()); } catch { /* closed */ }
  port.onMessage.addListener((message: { type?: string; tabId?: number } & Record<string, unknown>) => {
    if (message.type === 'KV_BRIDGE_RECONNECT') {
      forceReconnect();
      try { port.postMessage({ type: '_native_status', connected: false, reconnecting: true }); } catch { /* closed */ }
      return;
    }
    if (message.type === '_panel_init' && typeof message.tabId === 'number') {
      // Retain selection for legacy callers that do not provide tabId. New MCP
      // requests should always select explicitly through browser_switch_tab.
      setSelectedTab(message.tabId);
      try { port.postMessage(nativeStatusMessage()); } catch { /* closed */ }
      if (latestCoordinationStatus) {
        try { port.postMessage({ type: 'bridge:coordination_status', status: latestCoordinationStatus }); } catch { /* closed */ }
      }
      return;
    }
    try { postNative(message); } catch (error) {
      try { port.postMessage({ type: '_native_status', connected: false, error: error instanceof Error ? error.message : String(error) }); } catch { /* closed */ }
    }
  });
  port.onDisconnect.addListener(() => panelPorts.delete(port));
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
