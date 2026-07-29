import { useEffect, useState } from 'react';
import { Activity, CirclePlus, FolderOpen, Gauge, MonitorCog, Plus, RefreshCw, Shield, Terminal, Wifi } from 'lucide-react';
import type { IdentityConsoleItem } from '../../shared/identity-console';
import '../kv-dashboard.css';

export function KvDashboard({ openConsole, openFolder, newProject }: { openConsole(): void; openFolder(): void; newProject(): void }) {
  const [items, setItems] = useState<IdentityConsoleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const refresh = async (): Promise<void> => {
    setLoading(true);
    try { const result = await window.identityConsole.list(); if (result.ok) setItems(result.data ?? []); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const count = (state: string) => items.filter((item) => item.status === state).length;
  const stats = [['Total Identities', items.length, Shield], ['Running', count('running'), Activity], ['Frozen', count('frozen'), MonitorCog], ['Unverified', count('unverified'), Gauge], ['Proxies Found', new Set(items.map((item) => `${item.manifest.proxy.host}:${item.manifest.proxy.port}`)).size, Wifi]] as const;
  return <div className="kv-shell">
    <aside className="kv-nav"><div className="kv-mark">KV</div><div className="kv-brand">KV Browser<br /><span>Bridge</span></div>{['Home','Identities','Proxies','Environment','Logs','Settings'].map((label, index) => <button key={label} className={index === 0 ? 'is-active' : ''}>{label}</button>)}</aside>
    <main className="kv-main"><header><div><p>KV BROWSER BRIDGE</p><h1>多身份浏览器控制中心</h1><span>Manage isolated browser identities and local network routes.</span></div><button className="kv-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh all</button></header>
    <section className="kv-stats">{stats.map(([label, value, Icon]) => <article key={label}><Icon size={17}/><strong>{value}</strong><span>{label}</span></article>)}</section>
    <section className="kv-grid"><div className="kv-content"><h2>Quick actions</h2><div className="kv-actions"><button onClick={openConsole}><Shield />Identity Console</button><button onClick={openConsole}><CirclePlus />New Identity</button><button onClick={() => void refresh()}><Wifi />Scan Environment</button><button onClick={() => void refresh()}><RefreshCw />Refresh All</button></div><h2>Recent identities</h2><div className="kv-identities">{items.length ? items.slice(0, 4).map((item) => <button key={item.manifest.identityId} onClick={openConsole}><span><strong>{item.manifest.accountLabel}</strong><small>{item.manifest.identityId}</small></span><em className={`kv-state ${item.status}`}>{item.status}</em></button>) : <div className="kv-empty">No identities yet. Create your first isolated browser identity.</div>}</div><h2>Developer tools</h2><div className="kv-tools"><button onClick={openFolder}><FolderOpen size={16}/> Open Folder</button><button onClick={newProject}><Plus size={16}/> New Project</button><button><Terminal size={16}/> Advanced tools</button></div></div>
    <aside className="kv-side"><section><h3>Environment overview</h3><dl><div><dt>Chrome</dt><dd>{items[0]?.manifest.browser.executablePath ?? 'Not configured'}</dd></div><div><dt>Identity root</dt><dd>{items[0]?.manifest.browser.userDataDir ?? 'No profiles yet'}</dd></div><div><dt>Last refresh</dt><dd>{new Date().toLocaleTimeString()}</dd></div></dl></section><section><h3>Detected proxy ports</h3>{items.length ? items.map((item) => <div className="kv-proxy" key={item.manifest.identityId}><Wifi size={14}/><span>{item.manifest.proxy.protocol}://{item.manifest.proxy.host}:{item.manifest.proxy.port}</span></div>) : <p>No proxy routes discovered yet.</p>}</section></aside></section></main></div>;
}
