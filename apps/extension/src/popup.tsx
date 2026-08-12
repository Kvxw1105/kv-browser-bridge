import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel/styles.css';
import './popup.css';

function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [zh, setZh] = useState(true);
  const [bridgeState, setBridgeState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [bridgeError, setBridgeError] = useState('');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const popupPort = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => setTabId(tabs?.[0]?.id ?? null));
    chrome.storage.local.get(['kv-panel-theme', 'kv-panel-locale'], (settings) => {
      if (settings['kv-panel-theme'] === 'light') setTheme('light');
      if (settings['kv-panel-locale'] === 'en') setZh(false);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes['kv-panel-theme']) setTheme(changes['kv-panel-theme'].newValue === 'light' ? 'light' : 'dark');
      if (changes['kv-panel-locale']) setZh(changes['kv-panel-locale'].newValue !== 'en');
    });

    const port = chrome.runtime.connect({ name: 'popup' });
    popupPort.current = port;
    const onMessage = (message: { type?: string; connected?: boolean; nativeReady?: boolean; reconnecting?: boolean; reconnectAttempt?: number; error?: string }) => {
      if (message.type !== '_native_status') return;
      const nextState = message.reconnecting
        ? 'connecting'
        : message.connected === true && message.nativeReady === true
          ? 'connected'
          : message.connected === true
            ? 'connecting'
            : 'disconnected';
      setBridgeState(nextState);
      setReconnectAttempt(message.reconnectAttempt ?? 0);
      setBridgeError(message.connected ? '' : message.error ?? '');
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      popupPort.current = null;
      setBridgeState('disconnected');
      setBridgeError('\u6269\u5c55\u540e\u53f0\u8fde\u63a5\u5df2\u65ad\u5f00');
    });

    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      popupPort.current = null;
    };
  }, []);

  const requestReconnect = () => {
    setBridgeState('connecting');
    setBridgeError('');
    popupPort.current?.postMessage({ type: 'KV_BRIDGE_RECONNECT' });
  };

  const openFullPanel = () => {
    if (tabId == null) return;
    chrome.runtime.sendMessage({ type: 'KV_SET_TARGET_TAB', tabId }, () => {
      void chrome.runtime.lastError;
      void chrome.tabs.create({ url: chrome.runtime.getURL(`sidepanel.html?tab=${tabId}`), active: true });
    });
  };

  return (
    <main className="local-bridge-panel kvgo-popup" data-theme={theme}>
      <div className="kvgo-popup__head">
        <strong>KvGo</strong>
        <button onClick={openFullPanel}>{zh ? '打开完整面板' : 'Open full panel'}</button>
      </div>
      <section className={`kvgo-popup__connection kvgo-popup__connection--${bridgeState}`} aria-live="polite">
        <div className="kvgo-popup__connection-head">
          <div className="kvgo-popup__connection-label">
            <span className="kvgo-popup__connection-dot" aria-hidden="true" />
            <div>
              <span>{zh ? '\u6d4f\u89c8\u5668\u6865\u63a5' : 'Browser bridge'}</span>
              <strong>
                {bridgeState === 'connected'
                  ? (zh ? '\u5df2\u8fde\u63a5' : 'Connected')
                  : bridgeState === 'connecting'
                    ? (zh ? '\u6b63\u5728\u8fde\u63a5' : 'Connecting')
                    : (zh ? '\u672a\u8fde\u63a5' : 'Disconnected')}
              </strong>
            </div>
          </div>
          <span className="kvgo-popup__connection-channel">Native Messaging</span>
        </div>
        <p>
          {bridgeState === 'connected'
            ? (zh ? '\u672c\u5730 Chrome Bridge \u5df2\u5c31\u7eea\uff0c\u53ef\u4ee5\u63a7\u5236\u5f53\u524d\u6d4f\u89c8\u5668\u3002' : 'The local Chrome Bridge is ready.')
            : bridgeState === 'connecting'
              ? (zh ? '\u6b63\u5728\u68c0\u67e5 Native Host \u548c\u672c\u5730\u8fde\u63a5\u3002' : 'Checking the Native Host and local connection.')
              : (bridgeError || (zh ? '\u8bf7\u786e\u8ba4 Native Host \u5df2\u5b89\u88c5\u5e76\u4e14 Chrome \u4ecd\u5728\u8fd0\u884c\u3002' : 'Check that the Native Host is installed and Chrome is running.'))}
        </p>
        {bridgeState !== 'connected' && (
          <button className="kvgo-popup__connection-reconnect" onClick={requestReconnect}>
            {bridgeState === 'connecting'
              ? (zh ? '\u91cd\u65b0\u68c0\u67e5' : 'Check again')
              : (zh ? '\u91cd\u65b0\u8fde\u63a5' : 'Reconnect')}
          </button>
        )}
        {bridgeState === 'connecting' && reconnectAttempt > 0 && (
          <small>{zh ? `\u6b63\u5728\u7b2c ${reconnectAttempt} \u6b21\u91cd\u8fde` : `Reconnect attempt ${reconnectAttempt}`}</small>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
