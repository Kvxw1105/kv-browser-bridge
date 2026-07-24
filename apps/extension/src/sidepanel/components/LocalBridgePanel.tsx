import React, { useEffect, useState } from 'react';
import { MY_TAB_ID, sendToTab } from '../tab';

type BridgeState = 'connecting' | 'connected' | 'disconnected';
type BrowserTab = { id: number; title: string; url: string; active: boolean };
type RecordingState = { active: boolean; id?: string; tabId?: number; intent?: string; events?: number };
type WorkflowSummary = { id: string; steps: unknown[]; checkpoints: unknown[] };

export function LocalBridgePanel() {
  const [state, setState] = useState<BridgeState>('connecting');
  const [target, setTarget] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [targetTabId, setTargetTabId] = useState<number | null>(MY_TAB_ID);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [recording, setRecording] = useState<RecordingState>({ active: false });
  const [recordIntent, setRecordIntent] = useState('');
  const [recordError, setRecordError] = useState('');
  const [lastWorkflow, setLastWorkflow] = useState<WorkflowSummary | null>(null);
  const [grantedPermissions, setGrantedPermissions] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState('');

  const refreshTarget = () => {
    if (targetTabId == null) return;
    chrome.tabs.get(targetTabId, (tab) => {
      if (chrome.runtime.lastError) return;
      setTarget(tab.title || tab.url || `Tab ${targetTabId}`);
      setTargetUrl(tab.url || '');
      setUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    });
  };
  const refreshTabs = () => {
    chrome.windows.getCurrent((window) => {
      if (chrome.runtime.lastError || window.id == null) return;
      chrome.tabs.query({ windowId: window.id }, (currentTabs) => {
        setTabs(currentTabs
          .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null && !tab.url?.startsWith('chrome-extension://'))
          .map((tab) => ({ id: tab.id, title: tab.title || tab.url || `Tab ${tab.id}`, url: tab.url || '', active: Boolean(tab.active) })));
      });
    });
  };
  const refreshRecording = () => {
    chrome.runtime.sendMessage({ type: 'KV_FLOW_CONTROL', action: 'status' }, (response?: { ok?: boolean; status?: RecordingState }) => {
      if (response?.ok && response.status) setRecording(response.status);
    });
  };

  useEffect(() => {
    if (MY_TAB_ID != null) {
      refreshTarget();
    }
    refreshTabs();
    refreshRecording();

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
  const copyTarget = () => {
    if (targetTabId != null) void navigator.clipboard.writeText(String(targetTabId));
  };
  const selectTarget = (tabId: number) => {
    chrome.runtime.sendMessage({ type: 'KV_SET_TARGET_TAB', tabId }, (response?: { ok?: boolean }) => {
      if (!response?.ok) return;
      setTargetTabId(tabId);
      chrome.tabs.update(tabId, { active: true });
      requestAnimationFrame(refreshTarget);
      refreshTabs();
    });
  };
  const activatePicker = () => {
    if (targetTabId != null) sendToTab(targetTabId, { type: 'ACTIVATE_PICKER' });
  };
  const controlRecording = (action: 'start' | 'stop') => {
    setRecordError('');
    if (action === 'start') setLastWorkflow(null);
    chrome.runtime.sendMessage({ type: 'KV_FLOW_CONTROL', action, tabId: targetTabId, intent: recordIntent }, (response?: { ok?: boolean; error?: string; status?: RecordingState; result?: WorkflowSummary }) => {
      if (!response?.ok) { setRecordError(response?.error || 'Recording request failed.'); return; }
      if (response.status) setRecording(response.status);
      if (action === 'stop') { setRecordIntent(''); setLastWorkflow(response.result ?? null); }
    });
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

      <div className="local-bridge-panel__workspace">
        <section className="local-bridge-panel__section local-bridge-panel__section--target" aria-labelledby="target-heading">
          <div className="local-bridge-panel__section-header">
            <p id="target-heading">Current target</p>
            <div className="local-bridge-panel__section-actions">
              <span>{targetTabId == null ? 'No tab selected' : `Tab ${targetTabId}`}</span>
              <button onClick={refreshTarget} disabled={targetTabId == null}>Refresh</button>
            </div>
          </div>
          <div className="local-bridge-panel__target">
            <span className="local-bridge-panel__target-icon" aria-hidden="true">K</span>
            <div className="local-bridge-panel__target-copy">
              <strong title={target}>{target || (targetTabId == null ? 'Open a page, then open Kv Bridge.' : `Chrome tab ${targetTabId}`)}</strong>
              <span title={targetUrl}>{targetUrl || 'No page URL available'}</span>
            </div>
          </div>
          <div className="local-bridge-panel__target-footer">
            <span>{updatedAt ? `Updated ${updatedAt}` : 'Waiting for page details'}</span>
            <div className="local-bridge-panel__target-actions">
              <button onClick={activatePicker} disabled={targetTabId == null}>Pick element</button>
              <button onClick={copyTarget} disabled={targetTabId == null}>Copy tab ID</button>
            </div>
          </div>
        </section>

        <section className="local-bridge-panel__section local-bridge-panel__section--access" aria-labelledby="access-heading">
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
      </div>

      <section className="local-bridge-panel__tabs" aria-labelledby="tabs-heading">
        <div className="local-bridge-panel__tabs-header">
          <div><p id="tabs-heading">Open tabs</p><span>Select the default target for Agent tools.</span></div>
          <button onClick={refreshTabs}>Refresh list</button>
        </div>
        <div className="local-bridge-panel__tab-list">
          {tabs.map((tab) => (
            <button key={tab.id} className={`local-bridge-panel__tab${tab.id === targetTabId ? ' local-bridge-panel__tab--selected' : ''}`} onClick={() => selectTarget(tab.id)}>
              <i aria-hidden="true" />
              <span>{tab.title}</span>
              <em>{tab.id === targetTabId ? 'Target' : tab.active ? 'Active' : ''}</em>
            </button>
          ))}
          {tabs.length === 0 && <p className="local-bridge-panel__tabs-empty">No browsable tabs found in this window.</p>}
        </div>
      </section>

      <section className="local-bridge-panel__record" aria-labelledby="record-heading">
        <div>
          <p id="record-heading">Workflow recorder</p>
          <span>{recording.active ? `${recording.events ?? 0} captured events on tab ${recording.tabId}` : 'Capture an Agent task and your manual browser steps.'}</span>
        </div>
        {recording.active ? (
          <button className="local-bridge-panel__record-stop" onClick={() => controlRecording('stop')}>Stop recording</button>
        ) : (
          <div className="local-bridge-panel__record-start">
            <input value={recordIntent} onChange={(event) => setRecordIntent(event.target.value)} placeholder="What should this workflow accomplish?" aria-label="Workflow intent" />
            <button onClick={() => controlRecording('start')} disabled={targetTabId == null || recordIntent.trim().length < 3}>Start recording</button>
          </div>
        )}
        {recordError && <small>{recordError}</small>}
        {lastWorkflow && <small className="local-bridge-panel__record-result">Saved draft {lastWorkflow.id}: {lastWorkflow.steps.length} steps, {lastWorkflow.checkpoints.length} checkpoints.</small>}
      </section>

      <footer className="local-bridge-panel__footer">
        <span>Native Messaging</span><b aria-hidden="true" /> <span>kv-browser-bridge MCP</span>
      </footer>
    </main>
  );
}
