import { useEffect, useState } from 'react';
import { Activity, CirclePlus, FolderOpen, Gauge, MonitorCog, Play, Plus, RefreshCw, Shield, Square, Terminal, Trash2, Wifi } from 'lucide-react';
import type { IdentityConsoleItem } from '../../shared/identity-console';
import '../kv-dashboard.css';

interface DashboardProps {
  openConsole(): void;
  openFolder(): void;
  openNewIdentity(): void;
  openEditIdentity(manifest: IdentityConsoleItem['manifest']): void;
}

export function KvDashboard({ openConsole, openFolder, openNewIdentity, openEditIdentity }: DashboardProps) {
  const [items, setItems] = useState<IdentityConsoleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [discovery, setDiscovery] = useState<{ chrome?: { recommended?: string }; proxies?: Array<{ protocol: string; host: string; port: number; processName?: string }>; identityRoot?: string; scannedAt?: string }>();

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try { const result = await window.identityConsole.refreshAll(); if (result.ok) setItems(result.data ?? []); else setError(`${result.error?.code}: ${result.error?.message}`); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const operate = async (item: IdentityConsoleItem, action: 'start' | 'stop' | 'refresh'): Promise<void> => {
    setBusy(item.manifest.identityId); setError(undefined);
    try {
      const result = action === 'start' ? await window.identityConsole.start(item.manifest.identityId) : action === 'stop' ? await window.identityConsole.stop(item.manifest.identityId) : await window.identityConsole.status(item.manifest.identityId);
      if (!result.ok || !result.data) { setError(`${result.error?.code ?? 'OPERATION_FAILED'}: ${result.error?.message ?? ''}`); return; }
      const next = 'identity' in result.data ? result.data.identity : result.data;
      setItems((all) => all.map((entry) => entry.manifest.identityId === item.manifest.identityId ? next : entry));
    } finally { setBusy(undefined); }
  };

  const remove = async (item: IdentityConsoleItem): Promise<void> => {
    if (!window.confirm(`Remove ${item.manifest.identityId}? Chrome profile data will be retained.`)) return;
    setBusy(item.manifest.identityId); setError(undefined);
    try { const result = await window.identityConsole.delete(item.manifest.identityId); if (result.ok) setItems((all) => all.filter((entry) => entry.manifest.identityId !== item.manifest.identityId)); else setError(`${result.error?.code ?? 'DELETE_FAILED'}: ${result.error?.message ?? ''}`); }
    finally { setBusy(undefined); }
  };

  const scan = async (): Promise<void> => {
    setLoading(true); setError(undefined);
    try { const result = await window.identityConsole.discover(); if (result.ok) setDiscovery(result.data as typeof discovery); else setError(`${result.error?.code}: ${result.error?.message}`); }
    finally { setLoading(false); }
  };
  const count = (state: string) => items.filter((item) => item.status === state).length;
  const stats = [['Total Identities', items.length, Shield], ['Running', count('running'), Activity], ['Frozen', count('frozen'), MonitorCog], ['Unverified', count('unverified'), Gauge], ['Proxies Found', discovery?.proxies?.length ?? 0, Wifi]] as const;

  return <div className="kv-shell"><aside className="kv-nav"><div className="kv-mark">KV</div><div className="kv-brand">KV Browser<br /><span>Bridge</span></div>{['Home', 'Identities', 'Proxies', 'Environment', 'Logs', 'Settings'].map((label, index) => <button key={label} className={index === 0 ? 'is-active' : ''}>{label}</button>)}</aside><main className="kv-main"><header><div><p>KV BROWSER BRIDGE</p><h1>多身份浏览器控制中心</h1><span>Manage isolated browser identities and local network routes.</span></div><button className="kv-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh all</button></header>{error && <div className="identity-console__error">{error}</div>}<section className="kv-stats">{stats.map(([label, value, Icon]) => <article key={label}><Icon size={17}/><strong>{value}</strong><span>{label}</span></article>)}</section><section className="kv-grid"><div className="kv-content"><h2>Quick actions</h2><div className="kv-actions"><button onClick={openConsole}><Shield />Identity Console</button><button onClick={openNewIdentity}><CirclePlus />New Identity</button><button onClick={() => void scan()}><Wifi />Scan Environment</button><button onClick={() => void refresh()}><RefreshCw />Refresh All</button></div><h2>Recent identities</h2><div className="kv-identities">{items.length ? items.slice(0, 4).map((item) => <div className="kv-recent" key={item.manifest.identityId}><span><strong>{item.manifest.accountLabel}</strong><small>{item.manifest.identityId} · {item.manifest.proxy.host}:{item.manifest.proxy.port}{item.runtime.alive ? ` · PID ${item.runtime.pid}` : ''}</small></span><em className={`kv-state ${item.status}`}>{item.status}</em><div><button disabled={busy === item.manifest.identityId} onClick={() => void operate(item, item.status === 'running' ? 'stop' : 'start')}>{item.status === 'running' ? <Square size={12}/> : <Play size={12}/>}</button><button disabled={busy === item.manifest.identityId} onClick={() => void operate(item, 'refresh')}><RefreshCw size={12}/></button><button disabled={busy === item.manifest.identityId} onClick={() => openEditIdentity(item.manifest)}>Edit</button><button disabled={busy === item.manifest.identityId || item.runtime.alive} onClick={() => void remove(item)} title="Remove configuration; profile is retained"><Trash2 size={12}/></button></div></div>) : <div className="kv-empty">No identities yet. <button onClick={openNewIdentity}>Create Identity</button></div>}</div><h2>Developer tools</h2><div className="kv-tools"><button onClick={openFolder}><FolderOpen size={16}/> Open Folder</button><button><Plus size={16}/> New Project</button><button><Terminal size={16}/> Advanced tools</button></div></div><aside className="kv-side"><section><h3>Environment overview</h3><dl><div><dt>Chrome</dt><dd>{discovery?.chrome?.recommended ?? 'Run Scan Environment'}</dd></div><div><dt>Identity root</dt><dd>{discovery?.identityRoot ?? 'Not scanned'}</dd></div><div><dt>Scanned</dt><dd>{discovery?.scannedAt ? new Date(discovery.scannedAt).toLocaleTimeString() : 'Not scanned'}</dd></div></dl></section><section><h3>Detected proxy ports</h3>{discovery?.proxies?.length ? discovery.proxies.map((proxy) => <div className="kv-proxy" key={`${proxy.host}:${proxy.port}`}><Wifi size={14}/><span>{proxy.protocol}://{proxy.host}:{proxy.port} {proxy.processName ? `(${proxy.processName})` : ''}</span></div>) : <p>No proxy routes discovered yet.</p>}</section></aside></section></main></div>;
}
