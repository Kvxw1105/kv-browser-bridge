import React, { useEffect, useState } from 'react';
import { MY_TAB_ID, sendToTab } from '../tab';

type BridgeState = 'connecting' | 'connected' | 'disconnected';
type BrowserTab = { id: number; title: string; url: string; active: boolean; favicon: string };
type RecordingState = { active: boolean; id?: string; tabId?: number; intent?: string; events?: number };
type WorkflowSummary = { id: string; steps: unknown[]; checkpoints: unknown[] };
type CoordinationStatus = {
  mode: 'off' | 'observe' | 'enforce';
  clients: Array<{ clientId: string; clientName: string; defaultTabId?: number }>;
  leases: Array<{ resource: string; purpose: string; state: 'active' | 'quarantined'; expiresAt: string }>;
};
type Locale = 'zh' | 'en';
type Theme = 'light' | 'dark';

export function LocalBridgePanel() {
  const [state, setState] = useState<BridgeState>('connecting');
  const [target, setTarget] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [targetTabId, setTargetTabId] = useState<number | null>(MY_TAB_ID);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [recording, setRecording] = useState<RecordingState>({ active: false });
  const [recordIntent, setRecordIntent] = useState('');
  const [recordError, setRecordError] = useState('');
  const [nativeError, setNativeError] = useState('');
  const [lastWorkflow, setLastWorkflow] = useState<WorkflowSummary | null>(null);
  const [grantedPermissions, setGrantedPermissions] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState('');
  const [locale, setLocale] = useState<Locale>('zh');
  const [theme, setTheme] = useState<Theme>('dark');
  const [coordination, setCoordination] = useState<CoordinationStatus | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [repairRequired, setRepairRequired] = useState(false);
  const [repairPromptOpen, setRepairPromptOpen] = useState(false);
  const [repairPromptCopied, setRepairPromptCopied] = useState(false);
  const [extensionVersion, setExtensionVersion] = useState('');
  const chinese = locale === 'zh';
  const text = chinese ? {
    eyebrow: '本地浏览器控制', connected: '已连接', connecting: '正在连接', disconnected: '未连接', ready: '浏览器已就绪', connectingTitle: '正在连接 Chrome', unavailable: '桥接不可用', readyBody: '当前 Chrome 登录态已可供使用。', unavailableBody: '请保持 Chrome 打开并启用扩展。', target: '当前目标', noTarget: '未选择标签页', refresh: '刷新', openPage: '打开一个页面后再打开 Kv Bridge。', noUrl: '没有可用的页面 URL', updated: '已更新', waiting: '等待页面详情', pick: '选择元素', copy: '复制标签页 ID', access: '浏览器访问', enabled: '已启用', bookmarks: '书签', bookmarksDesc: '打开已保存的目的地', downloads: '下载', downloadsDesc: '读取最近下载状态', extensions: '扩展程序', extensionsDesc: '检查已安装扩展', enable: '启用', tabs: '打开的标签页', tabsHint: '选择 Agent 工具的默认目标页。', refreshList: '刷新列表', targetTag: '目标', active: '当前', noTabs: '当前窗口没有可浏览的标签页。', recorder: '任务录制', recording: '已在标签页', events: '记录事件', recorderHint: '记录浏览器动作、目标、人工检查点和备注；当前不是视频录屏。', intentPlaceholder: '这条流程要完成什么？', start: '开始录制', stop: '停止并生成草稿', saved: '已生成草稿', steps: '个步骤', checkpoints: '个检查点', native: '本地消息', error: '录制请求失败。', dark: '深色模式', light: '浅色模式', agents: '连接中的 Agent', mode: '协调模式', leases: '资源占用', noAgents: '暂无其他 Agent 连接', noLeases: '暂无标签页占用'
  } : {
    eyebrow: 'LOCAL BROWSER CONTROL', connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', ready: 'Browser ready', connectingTitle: 'Connecting to Chrome', unavailable: 'Bridge unavailable', readyBody: 'Your existing Chrome session is available.', unavailableBody: 'Keep Chrome open and the extension enabled.', target: 'Current target', noUrl: 'No page URL available', noTarget: 'No tab selected', refresh: 'Refresh', openPage: 'Open a page, then open Kv Bridge.', updated: 'Updated', waiting: 'Waiting for page details', pick: 'Pick element', copy: 'Copy tab ID', access: 'Browser access', enabled: 'enabled', bookmarks: 'Bookmarks', bookmarksDesc: 'Open saved destinations', downloads: 'Downloads', downloadsDesc: 'Read recent download status', extensions: 'Extensions', extensionsDesc: 'Inspect installed extensions', enable: 'Enable', tabs: 'Open tabs', tabsHint: 'Select the default target for Agent tools.', refreshList: 'Refresh list', targetTag: 'Target', active: 'Active', noTabs: 'No browsable tabs found in this window.', recorder: 'Task recorder', recording: 'captured events on tab', events: '', recorderHint: 'Records browser actions, targets, checkpoints, and notes. It does not record screen video.', intentPlaceholder: 'What should this workflow accomplish?', start: 'Start recording', stop: 'Stop and create draft', saved: 'Draft created', steps: 'steps', checkpoints: 'checkpoints', native: 'Native Messaging', error: 'Recording request failed.', dark: 'Dark mode', light: 'Light mode', agents: 'Connected agents', mode: 'Coordination mode', leases: 'Resource leases', noAgents: 'No other agents connected', noLeases: 'No active leases'
  };

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
          .map((tab) => ({ id: tab.id, title: tab.title || tab.url || `Tab ${tab.id}`, url: tab.url || '', active: Boolean(tab.active), favicon: tab.favIconUrl || '' })));
      });
    });
  };
  const refreshRecording = () => {
    chrome.runtime.sendMessage({ type: 'KV_FLOW_CONTROL', action: 'status' }, (response?: { ok?: boolean; status?: RecordingState }) => {
      if (response?.ok && response.status) setRecording(response.status);
    });
  };

  useEffect(() => {
    chrome.storage.local.get(['kv-panel-locale', 'kv-panel-theme'], (settings) => {
      if (settings['kv-panel-locale'] === 'en' || settings['kv-panel-locale'] === 'zh') setLocale(settings['kv-panel-locale']);
      if (settings['kv-panel-theme'] === 'dark' || settings['kv-panel-theme'] === 'light') setTheme(settings['kv-panel-theme']);
    });
    setExtensionVersion(chrome.runtime.getManifest().version);
    if (MY_TAB_ID != null) {
      refreshTarget();
    }
    refreshTabs();
    refreshRecording();

    const port = chrome.runtime.connect({ name: 'sidepanel' });
    void chrome.permissions.getAll().then((permissions) => setGrantedPermissions(permissions.permissions ?? []));
    if (MY_TAB_ID != null) port.postMessage({ type: '_panel_init', tabId: MY_TAB_ID });
    port.onMessage.addListener((message: { type?: string; connected?: boolean; nativeReady?: boolean; error?: string; repairRequired?: boolean; status?: CoordinationStatus | null }) => {
      if (message.type === '_native_status') {
        const ready = message.connected === true && message.nativeReady === true;
        setState(ready ? 'connected' : message.connected ? 'connecting' : 'disconnected');
        if (ready) {
          setReconnecting(false);
          setRepairRequired(false);
          setRepairPromptOpen(false);
        }
        setNativeError(message.connected ? '' : message.error ?? '');
        if (message.repairRequired) {
          setRepairRequired(true);
          setRepairPromptOpen(true);
        }
        if (!message.connected) setCoordination(null);
      }
      if (message.type === 'bridge:coordination_status') setCoordination(message.status ?? null);
    });
    port.onDisconnect.addListener(() => setState('disconnected'));
    return () => port.disconnect();
  }, []);

  const label = state === 'connected' ? text.connected : state === 'connecting' ? text.connecting : text.disconnected;
  const connected = state === 'connected';
  const coordinationClients = coordination?.clients ?? [];
  const coordinationLeases = coordination?.leases ?? [];
  const requestPermission = async (permission: string) => {
    const granted = await chrome.permissions.request({ permissions: [permission] });
    if (granted) setGrantedPermissions((current) => [...new Set([...current, permission])]);
  };
  const copyTarget = () => {
    if (targetTabId != null) void navigator.clipboard.writeText(String(targetTabId));
  };

  const repairPrompt = [
    '\u4f60\u662f\u672c\u673a\u7ec8\u7aef Agent\uff0c\u4e0d\u8981\u4f9d\u8d56\u4e4b\u524d\u7684\u5bf9\u8bdd\u4e0a\u4e0b\u6587\u3002',
    '\u76ee\u6807\uff1a\u4fee\u590d Kv Browser Bridge \u7684 Chrome Native Messaging \u8fde\u63a5\u3002',
    `\u5f53\u524d\u6269\u5c55 ID\uff1a${chrome.runtime.id}`,
    `\u6700\u8fd1\u9519\u8bef\uff1a${nativeError || '\u672a\u63d0\u4f9b'}`,
    '\u53ea\u4fee\u6539 Kv Browser Bridge \u7684\u672c\u5730 Native Messaging \u914d\u7f6e\uff1b\u4e0d\u8981\u5220\u9664\u6216\u4fee\u6539 Chrome Profile\u3001Cookie\u3001LocalStorage\u3001IndexedDB\u3001\u7f13\u5b58\u6216\u767b\u5f55\u6001\u3002',
    '',
    '\u5728 Windows PowerShell \u6309\u4ee5\u4e0b\u987a\u5e8f\u6267\u884c\uff1a',
    '$extensionId = \'' + chrome.runtime.id + '\'',
    '$helper = Join-Path $env:LOCALAPPDATA \'KvBrowserBridge\\bin\\kv-browser-bridge-repair.cmd\'',
    'if (Test-Path $helper) {',
    '  & $helper repair $extensionId',
    '  & $helper doctor --json',
    '} else {',
    '  $installer = Get-ChildItem -Path (Get-Location).Path -Filter install.js -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match \'\\\\apps\\\\chrome-bridge\\\\dist\\\\install\\.js$\' } | Select-Object -First 1',
    '  if (-not $installer) { throw \'Kv Browser Bridge repair helper and source installer were not found.\' }',
    '  & node $installer.FullName repair $extensionId',
    '  & node $installer.FullName doctor --json',
    '}',
    '',
    '\u9a8c\u8bc1 doctor \u4e2d\u7684 manifest\u3001registry-hkcu\u3001bridge-path\u3001repair-helper \u548c log-directory \u5747\u4e3a ok\u3002',
    '\u6700\u540e\u63d0\u9192\u7528\u6237\u5728 chrome://extensions \u91cd\u65b0\u52a0\u8f7d\u8be5\u6269\u5c55\uff0c\u4e0d\u8981\u81ea\u52a8\u542f\u52a8\u65b0 Chrome\u3002',
    '\u5982\u679c\u5931\u8d25\uff0c\u8fd4\u56de\u5931\u8d25\u5c42\u3001\u5b9e\u9645\u547d\u4ee4\u3001\u9000\u51fa\u7801\u3001\u539f\u59cb\u9519\u8bef\u3001\u65e5\u5fd7\u8def\u5f84\u548c\u6700\u5c0f\u4fee\u590d\u52a8\u4f5c\u3002',
  ].join('\n');
  const requestReconnect = () => {
    if (reconnecting) return;
    setReconnecting(true);
    setState('connecting');
    setNativeError('');
    setRepairRequired(false);
    chrome.runtime.sendMessage({ type: 'KV_BRIDGE_RECONNECT' }, () => { void chrome.runtime.lastError; });
    window.setTimeout(() => setReconnecting(false), 8_000);
  };
  const copyRepairPrompt = () => {
    void navigator.clipboard.writeText(repairPrompt).then(() => {
      setRepairPromptCopied(true);
      window.setTimeout(() => setRepairPromptCopied(false), 2_000);
    });
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
      if (!response?.ok) { setRecordError(response?.error || text.error); return; }
      if (response.status) setRecording(response.status);
      if (action === 'stop') { setRecordIntent(''); setLastWorkflow(response.result ?? null); }
    });
  };

  return (
    <main className="local-bridge-panel" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <header className="local-bridge-panel__header" aria-label="Kv Browser Bridge status">
        <div className="local-bridge-panel__brand">
          <img className="local-bridge-panel__mark" src={chrome.runtime.getURL('icon-48.png')} alt="Kv" />
          <div>
            <p className="local-bridge-panel__eyebrow">{text.eyebrow}</p>
            <h1>Kv Bridge</h1>
          </div>
        </div>
        <div className="local-bridge-panel__header-actions">
          <div className="local-bridge-panel__toggle" aria-label="Panel language">
            <button className={locale === 'zh' ? 'is-active' : ''} onClick={() => { setLocale('zh'); chrome.storage.local.set({ 'kv-panel-locale': 'zh' }); }}>中文</button>
            <button className={locale === 'en' ? 'is-active' : ''} onClick={() => { setLocale('en'); chrome.storage.local.set({ 'kv-panel-locale': 'en' }); }}>EN</button>
          </div>
          <button className="local-bridge-panel__theme" onClick={() => { const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); chrome.storage.local.set({ 'kv-panel-theme': next }); }} aria-label={theme === 'light' ? text.dark : text.light}>{theme === 'light' ? 'Dark' : 'Light'}</button>
          <span className={`local-bridge-panel__state local-bridge-panel__state--${state}`}><i aria-hidden="true" />{label}</span>
        </div>
      </header>

      <section className={`local-bridge-panel__hero local-bridge-panel__hero--${state}`}>
        <div className="local-bridge-panel__signal" aria-hidden="true"><span /><span /><span /></div>
        <div className="local-bridge-panel__hero-copy">
          <p>{connected ? text.ready : state === 'connecting' ? text.connectingTitle : text.unavailable}</p>
          <strong>{connected ? text.readyBody : text.unavailableBody}</strong>
          {!connected && nativeError && <small>{text.native}: {nativeError}</small>}
        </div>
        <button className="local-bridge-panel__reconnect" onClick={requestReconnect} disabled={reconnecting}>
          {reconnecting ? (chinese ? '正在重连…' : 'Reconnecting…') : (chinese ? '立即重连' : 'Reconnect now')}
        </button>
      </section>

      {repairRequired && (
        <section className="local-bridge-panel__repair" aria-labelledby="repair-heading">
          <div className="local-bridge-panel__repair-header">
            <div>
              <p id="repair-heading">{chinese ? '\u8fde\u63a5\u914d\u7f6e\u9700\u8981\u4fee\u590d' : 'Connection setup needs repair'}</p>
              <span>{chinese ? '\u5f53\u524d\u6269\u5c55\u65e0\u6743\u542f\u52a8 Native Host\uff0c\u53ef\u5c06\u4ee5\u4e0b\u6307\u5f15\u4ea4\u7ed9\u4efb\u610f\u672c\u5730 Agent\u3002' : 'The extension cannot start its Native Host. Copy these steps to any local Agent.'}</span>
            </div>
            <button onClick={() => setRepairPromptOpen((open) => !open)}>{repairPromptOpen ? (chinese ? '\u6536\u8d77' : 'Collapse') : (chinese ? '\u663e\u793a\u4fee\u590d\u6307\u5f15' : 'Show repair steps')}</button>
          </div>
          {repairPromptOpen && (
            <div className="local-bridge-panel__repair-body">
              <pre>{repairPrompt}</pre>
              <button onClick={copyRepairPrompt}>{repairPromptCopied ? (chinese ? '\u5df2\u590d\u5236' : 'Copied') : (chinese ? '\u590d\u5236\u63d0\u793a\u8bcd' : 'Copy prompt')}</button>
            </div>
          )}
        </section>
      )}

      <div className="local-bridge-panel__workspace">
        <section className="local-bridge-panel__section local-bridge-panel__section--target" aria-labelledby="target-heading">
          <div className="local-bridge-panel__section-header">
            <p id="target-heading">{text.target}</p>
            <div className="local-bridge-panel__section-actions">
              <span>{targetTabId == null ? text.noTarget : `Tab ${targetTabId}`}</span>
              <button onClick={refreshTarget} disabled={targetTabId == null}>{text.refresh}</button>
            </div>
          </div>
          <div className="local-bridge-panel__target">
            <span className="local-bridge-panel__target-icon" aria-hidden="true">K</span>
            <div className="local-bridge-panel__target-copy">
              <strong title={target}>{target || (targetTabId == null ? text.openPage : `Chrome tab ${targetTabId}`)}</strong>
              <span title={targetUrl}>{targetUrl || text.noUrl}</span>
            </div>
          </div>
          <div className="local-bridge-panel__target-footer">
            <span>{updatedAt ? `${text.updated} ${updatedAt}` : text.waiting}</span>
            <div className="local-bridge-panel__target-actions">
              <button onClick={activatePicker} disabled={targetTabId == null}>{text.pick}</button>
              <button onClick={copyTarget} disabled={targetTabId == null}>{text.copy}</button>
            </div>
          </div>
        </section>

        <section className="local-bridge-panel__section local-bridge-panel__section--access" aria-labelledby="access-heading">
          <div className="local-bridge-panel__section-header">
            <p id="access-heading">{text.access}</p>
            <span>{grantedPermissions.length} {text.enabled}</span>
          </div>
          <div className="local-bridge-panel__access-list">
            {[
              ['bookmarks', text.bookmarks, text.bookmarksDesc],
              ['downloads', text.downloads, text.downloadsDesc],
              ['management', text.extensions, text.extensionsDesc],
            ].map(([permission, name, description]) => (
              <div key={permission} className="local-bridge-panel__permission">
                <div>
                  <strong>{name}</strong>
                  <span>{description}</span>
                </div>
                {grantedPermissions.includes(permission)
                  ? <span className="local-bridge-panel__granted"><i aria-hidden="true">OK</i> {text.enabled}</span>
                  : <button onClick={() => void requestPermission(permission)}>{text.enable}</button>}
              </div>
            ))}
          </div>
        </section>
      </div>


      <section className="local-bridge-panel__tabs" aria-labelledby="tabs-heading">
        <div className="local-bridge-panel__tabs-header">
          <div><p id="tabs-heading">{text.tabs}</p><span>{text.tabsHint}</span></div>
          <button onClick={refreshTabs}>{text.refreshList}</button>
        </div>
        <div className="local-bridge-panel__tab-list">
          {tabs.map((tab) => (
            <button key={tab.id} className={`local-bridge-panel__tab${tab.id === targetTabId ? ' local-bridge-panel__tab--selected' : ''}`} onClick={() => selectTarget(tab.id)}>
              {tab.favicon ? <img src={tab.favicon} alt="" /> : <i aria-hidden="true" />}
              <span>{tab.title}</span>
              <em>{tab.id === targetTabId ? text.targetTag : tab.active ? text.active : ''}</em>
            </button>
          ))}
          {tabs.length === 0 && <p className="local-bridge-panel__tabs-empty">{text.noTabs}</p>}
        </div>
      </section>

      <section className="local-bridge-panel__coordination" aria-labelledby="coordination-heading">
        <div className="local-bridge-panel__coordination-header">
          <div><p id="coordination-heading">{text.agents}</p><span>{text.mode}: {coordination?.mode ?? '—'}</span></div>
          <span className="local-bridge-panel__coordination-count">{coordinationClients.length}</span>
        </div>
        <div className="local-bridge-panel__coordination-grid">
          <div className="local-bridge-panel__agent-list">
            {coordinationClients.length ? coordinationClients.map((client) => (
              <div className="local-bridge-panel__agent" key={`${client.clientId}-${client.defaultTabId ?? 'none'}`}>
                <i aria-hidden="true" />
                <strong>{client.clientName}</strong>
                <span>{client.clientId}{client.defaultTabId == null ? '' : ` · Tab ${client.defaultTabId}`}</span>
              </div>
            )) : <span className="local-bridge-panel__coordination-empty">{text.noAgents}</span>}
          </div>
          <div className="local-bridge-panel__lease-list">
            {coordinationLeases.length ? coordinationLeases.map((lease) => (
              <div className={`local-bridge-panel__lease local-bridge-panel__lease--${lease.state}`} key={`${lease.resource}-${lease.expiresAt}`}>
                <strong>{lease.resource}</strong><span>{lease.purpose}</span><em>{lease.state}</em>
              </div>
            )) : <span className="local-bridge-panel__coordination-empty">{text.noLeases}</span>}
          </div>
        </div>
      </section>

      <section className="local-bridge-panel__record" aria-labelledby="record-heading">
        <div>
          <p id="record-heading">{text.recorder}</p>
          <span>{recording.active ? `${recording.events ?? 0} ${text.recording} ${recording.tabId}` : text.recorderHint}</span>
        </div>
        {recording.active ? (
          <button className="local-bridge-panel__record-stop" onClick={() => controlRecording('stop')}>{text.stop}</button>
        ) : (
          <div className="local-bridge-panel__record-start">
            <input value={recordIntent} onChange={(event) => setRecordIntent(event.target.value)} placeholder={text.intentPlaceholder} aria-label={text.recorder} />
            <button onClick={() => controlRecording('start')} disabled={targetTabId == null || recordIntent.trim().length < 3}>{text.start}</button>
          </div>
        )}
        {recordError && <small>{recordError}</small>}
        {lastWorkflow && <small className="local-bridge-panel__record-result">{text.saved} {lastWorkflow.id}: {lastWorkflow.steps.length} {text.steps}, {lastWorkflow.checkpoints.length} {text.checkpoints}.</small>}
      </section>

      <footer className="local-bridge-panel__footer">
        <span>{text.native}</span><b aria-hidden="true" /> <span>kv-browser-bridge MCP</span><b aria-hidden="true" /><span>v{extensionVersion || '—'}</span>
      </footer>
    </main>
  );
}
