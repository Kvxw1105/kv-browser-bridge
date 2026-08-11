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
    if (!window.confirm(`确认删除 ${item.manifest.identityId}？Chrome 配置文件将保留。`)) return;
    setBusy(item.manifest.identityId); setError(undefined);
    try { const result = await window.identityConsole.delete(item.manifest.identityId); if (result.ok) setItems((all) => all.filter((entry) => entry.manifest.identityId !== item.manifest.identityId)); else setError(`${result.error?.code ?? 'DELETE_FAILED'}: ${result.error?.message ?? ''}`); }
    finally { setBusy(undefined); }
  };

  const scan = async (): Promise<void> => {
    setLoading(true); setError(undefined);
    try { const result = await window.identityConsole.discover(); if (result.ok) setDiscovery(result.data as typeof discovery); else setError(`${result.error?.code}: ${result.error?.message}`); }
    finally { setLoading(false); }
  };
  const [runtime, setRuntime] = useState<{ doctor?: { ok?: boolean; checks?: Array<{ name: string; required?: boolean; ok?: boolean; message?: string }> }; bridge?: { present?: boolean; protocolVersion?: number; pid?: number; pipeName?: string; extensionPresent?: boolean; extensionPath?: string }; computerUseDir?: string; running?: boolean; error?: string }>();
  const runDiagnostics = async (): Promise<void> => {
    setRuntime((current) => ({ ...current, running: true })); setError(undefined);
    try {
      const result = await window.computerStatus.bridge();
      if (result.ok) {
        setRuntime({
          doctor: result.data.doctor as { ok?: boolean; checks?: Array<{ name: string; required?: boolean; ok?: boolean; message?: string }> } | undefined,
          bridge: result.data.bridge,
          computerUseDir: result.data.computerUseDir,
        });
      } else {
        setRuntime({ error: `${result.error.code}: ${result.error.message}` });
      }
    } finally { setRuntime((current) => ({ ...current, running: false })); }
  };
  const doctorChecks = runtime?.doctor?.checks ?? [];
  const doctorOk = runtime?.doctor?.ok ?? (doctorChecks.length > 0 ? doctorChecks.every((check) => check.ok) : undefined);
  const receiptPath = doctorChecks.find((check) => check.name === 'receipt-directory')?.message ?? '';
  const count = (state: string) => items.filter((item) => item.status === state).length;
  const stats = [['身份总数', items.length, Shield], ['运行中', count('running'), Activity], ['已冻结', count('frozen'), MonitorCog], ['未验证', count('unverified'), Gauge], ['发现代理', discovery?.proxies?.length ?? 0, Wifi]] as const;
  const statusLabel: Record<string, string> = { 'not-started': '未启动', starting: '启动中', running: '运行中', stopped: '已停止', failed: '失败', frozen: '已冻结', unverified: '未验证', warning: '警告' };

  return <div className="kv-shell"><aside className="kv-nav"><div className="kv-mark">KV</div><div className="kv-brand">KV Browser<br /><span>Bridge</span></div>{['首页', '身份管理', '代理', '环境', '日志', '设置'].map((label, index) => <button key={label} className={index === 0 ? 'is-active' : ''}>{label}</button>)}</aside><main className="kv-main"><header><div><p>KV BROWSER BRIDGE</p><h1>多身份浏览器控制中心</h1><span>管理互相隔离的浏览器身份与本地网络路由。</span></div><button className="kv-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> 刷新全部</button></header>{error && <div className="identity-console__error">{error}</div>}<section className="kv-stats">{stats.map(([label, value, Icon]) => <article key={label}><Icon size={17}/><strong>{value}</strong><span>{label}</span></article>)}</section><section className="kv-grid"><div className="kv-content"><h2>快捷操作</h2><div className="kv-actions"><button onClick={openConsole}><Shield />身份控制台</button><button onClick={openNewIdentity}><CirclePlus />新建身份</button><button onClick={() => void scan()}><Wifi />扫描环境</button><button onClick={() => void refresh()}><RefreshCw />刷新全部</button></div><h2>最近身份</h2><div className="kv-identities">{items.length ? items.slice(0, 4).map((item) => <div className="kv-recent" key={item.manifest.identityId}><span><strong>{item.manifest.accountLabel}</strong><small>{item.manifest.identityId} · {item.manifest.proxy.host}:{item.manifest.proxy.port}{item.runtime.alive ? ` · PID ${item.runtime.pid}` : ''}</small></span><em className={`kv-state ${item.status}`}>{statusLabel[item.status] ?? item.status}</em><div><button title={item.status === 'running' ? '停止' : '启动'} disabled={busy === item.manifest.identityId} onClick={() => void operate(item, item.status === 'running' ? 'stop' : 'start')}>{item.status === 'running' ? <Square size={12}/> : <Play size={12}/>}</button><button title="刷新状态" disabled={busy === item.manifest.identityId} onClick={() => void operate(item, 'refresh')}><RefreshCw size={12}/></button><button disabled={busy === item.manifest.identityId} onClick={() => openEditIdentity(item.manifest)}>编辑</button><button title="删除配置；配置文件保留" disabled={busy === item.manifest.identityId || item.runtime.alive} onClick={() => void remove(item)}><Trash2 size={12}/></button></div></div>) : <div className="kv-empty">还没有身份。<button onClick={openNewIdentity}>创建身份</button></div>}</div><h2>开发者工具</h2><div className="kv-tools"><button onClick={openFolder}><FolderOpen size={16}/> 打开文件夹</button><button><Plus size={16}/> 新建项目</button><button><Terminal size={16}/> 高级工具</button></div></div><aside className="kv-side"><section><h3>环境概览</h3><dl><div><dt>Chrome</dt><dd>{discovery?.chrome?.recommended ?? '点击"扫描环境"检测'}</dd></div><div><dt>身份目录</dt><dd>{discovery?.identityRoot ?? '未扫描'}</dd></div><div><dt>扫描时间</dt><dd>{discovery?.scannedAt ? new Date(discovery.scannedAt).toLocaleTimeString() : '未扫描'}</dd></div></dl></section><section><h3>检测到的代理端口</h3>{discovery?.proxies?.length ? discovery.proxies.map((proxy) => <div className="kv-proxy" key={`${proxy.host}:${proxy.port}`}><Wifi size={14}/><span>{proxy.protocol}://{proxy.host}:{proxy.port} {proxy.processName ? `(${proxy.processName})` : ''}</span></div>) : <p>尚未发现代理路由</p>}</section><section><h3>运行状态</h3><button className="kv-refresh" onClick={() => void runDiagnostics()} disabled={runtime?.running}><RefreshCw size={14} className={runtime?.running ? 'spin' : ''} /> 运行诊断</button>{runtime?.error && <p className="identity-console__error">{runtime.error}</p>}{runtime?.bridge && <dl><div><dt>扩展</dt><dd>{runtime.bridge.extensionPresent ? '已就绪' : '未找到（安装引导见身份控制台）'}</dd></div><div><dt>Bridge</dt><dd>{runtime.bridge.present ? `运行中 · PID ${runtime.bridge.pid}` : '未运行'}</dd></div>{runtime.bridge.pipeName ? <div><dt>管道</dt><dd title={runtime.bridge.pipeName}>{runtime.bridge.pipeName.slice(0, 40)}…</dd></div> : null}</dl>}{doctorOk !== undefined && <div className="kv-proxy"><span>Computer Use 诊断：{doctorOk ? '全部通过' : '存在异常'}</span></div>}{doctorChecks.length > 0 && <ul className="kv-doctor">{doctorChecks.map((check) => <li key={check.name} className={check.ok ? 'kv-ok' : 'kv-bad'}>{check.ok ? '✓' : '✗'} {check.name}</li>)}</ul>}{runtime?.computerUseDir ? <div className="kv-proxy"><span title={runtime.computerUseDir}>运行时：{runtime.computerUseDir.slice(-48)}</span></div> : null}{receiptPath ? <div className="kv-proxy"><span title={receiptPath}>回执：{receiptPath.slice(-40)}</span></div> : null}</section></aside></section></main></div>;
}
