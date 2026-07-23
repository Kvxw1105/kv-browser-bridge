import React, { useEffect, useState } from 'react';
import { MY_TAB_ID } from '../tab';

type BridgeState = 'connecting' | 'connected' | 'disconnected';

export function LocalBridgePanel() {
  const [state, setState] = useState<BridgeState>('connecting');
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (MY_TAB_ID != null) {
      chrome.tabs.get(MY_TAB_ID, (tab) => {
        if (!chrome.runtime.lastError) setTarget(tab.title || tab.url || `Tab ${MY_TAB_ID}`);
      });
    }

    const port = chrome.runtime.connect({ name: 'sidepanel' });
    if (MY_TAB_ID != null) port.postMessage({ type: '_panel_init', tabId: MY_TAB_ID });
    port.onMessage.addListener((message: { type?: string; connected?: boolean }) => {
      if (message.type === '_native_status') {
        setState(message.connected ? 'connected' : 'disconnected');
      }
    });
    port.onDisconnect.addListener(() => setState('disconnected'));
    return () => port.disconnect();
  }, []);

  const label = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Disconnected';

  return (
    <main className="local-bridge-panel">
      <header className="local-bridge-panel__header">
        <h1>Local Chrome</h1>
        <span className={`local-bridge-panel__state local-bridge-panel__state--${state}`}>{label}</span>
      </header>
      <dl className="local-bridge-panel__details">
        <div><dt>Bridge</dt><dd>Native Messaging</dd></div>
        <div><dt>MCP</dt><dd>local-chrome</dd></div>
        <div><dt>Target</dt><dd>{target || (MY_TAB_ID == null ? 'No target tab' : `Tab ${MY_TAB_ID}`)}</dd></div>
      </dl>
    </main>
  );
}
