import React, { useEffect, useState } from 'react';
import { MY_TAB_ID } from '../tab';

type BridgeState = 'connecting' | 'connected' | 'disconnected';

export function LocalBridgePanel() {
  const [state, setState] = useState<BridgeState>('connecting');
  const [target, setTarget] = useState('');
  const [grantedPermissions, setGrantedPermissions] = useState<string[]>([]);

  useEffect(() => {
    if (MY_TAB_ID != null) {
      chrome.tabs.get(MY_TAB_ID, (tab) => {
        if (!chrome.runtime.lastError) setTarget(tab.title || tab.url || `Tab ${MY_TAB_ID}`);
      });
    }

    const port = chrome.runtime.connect({ name: 'sidepanel' });
    void chrome.permissions.getAll().then((permissions) => setGrantedPermissions(permissions.permissions ?? []));
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
  const connected = state === 'connected';
  const requestPermission = async (permission: string) => {
    const granted = await chrome.permissions.request({ permissions: [permission] });
    if (granted) setGrantedPermissions((current) => [...new Set([...current, permission])]);
  };

  return (
    <main className="local-bridge-panel">
      <header className="local-bridge-panel__header" aria-label="Kv Browser Bridge status">
        <div className="local-bridge-panel__brand">
          <img className="local-bridge-panel__mark" src={chrome.runtime.getURL('icon-48.png')} alt="Kv" />
          <div>
            <p className="local-bridge-panel__eyebrow">LOCAL BROWSER CONTROL</p>
            <h1>Kv Bridge</h1>
          </div>
        </div>
        <span className={`local-bridge-panel__state local-bridge-panel__state--${state}`}>
          <i aria-hidden="true" />{label}
        </span>
      </header>

      <section className={`local-bridge-panel__hero local-bridge-panel__hero--${state}`}>
        <div className="local-bridge-panel__signal" aria-hidden="true"><span /><span /><span /></div>
        <div className="local-bridge-panel__hero-copy">
          <p>{connected ? 'Browser ready' : state === 'connecting' ? 'Connecting to Chrome' : 'Bridge unavailable'}</p>
          <strong>{connected ? 'Your existing Chrome session is available.' : 'Keep Chrome open and the extension enabled.'}</strong>
        </div>
      </section>

      <section className="local-bridge-panel__section" aria-labelledby="target-heading">
        <div className="local-bridge-panel__section-header">
          <p id="target-heading">Current target</p>
          <span>{MY_TAB_ID == null ? 'No tab selected' : `Tab ${MY_TAB_ID}`}</span>
        </div>
        <div className="local-bridge-panel__target">
          <span className="local-bridge-panel__target-icon" aria-hidden="true">K</span>
          <strong title={target}>{target || (MY_TAB_ID == null ? 'Open a page, then open Kv Bridge.' : `Chrome tab ${MY_TAB_ID}`)}</strong>
        </div>
      </section>

      <section className="local-bridge-panel__section" aria-labelledby="access-heading">
        <div className="local-bridge-panel__section-header">
          <p id="access-heading">Browser access</p>
          <span>{grantedPermissions.length} enabled</span>
        </div>
        <div className="local-bridge-panel__access-list">
          {[
            ['bookmarks', 'Bookmarks', 'Open saved destinations'],
            ['downloads', 'Downloads', 'Read recent download status'],
            ['management', 'Extensions', 'Inspect installed extensions'],
          ].map(([permission, name, description]) => (
            <div key={permission} className="local-bridge-panel__permission">
              <div>
                <strong>{name}</strong>
                <span>{description}</span>
              </div>
              {grantedPermissions.includes(permission)
                ? <span className="local-bridge-panel__granted"><i aria-hidden="true">OK</i> Enabled</span>
                : <button onClick={() => void requestPermission(permission)}>Enable</button>}
            </div>
          ))}
        </div>
      </section>

      <footer className="local-bridge-panel__footer">
        <span>Native Messaging</span><b aria-hidden="true" /> <span>kv-browser-bridge MCP</span>
      </footer>
    </main>
  );
}
