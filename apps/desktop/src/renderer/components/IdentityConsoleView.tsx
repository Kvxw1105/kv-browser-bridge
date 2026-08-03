import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Loader2, Play, RefreshCw, Square, Trash2, Pencil } from 'lucide-react';
import type { IdentityConsoleItem } from '../../shared/identity-console';
import type { IdentityConsoleLog } from '../../shared/identity-console';
import type { IdentityManifest } from '../../shared/identity-manifest';
import '../identity-console.css';

interface IdentityConsoleViewProps {
  onBack(): void;
  onEdit(manifest: IdentityManifest): void;
  onCreate(): void;
}

export function IdentityConsoleView({ onBack, onEdit, onCreate }: IdentityConsoleViewProps) {
  const [identities, setIdentities] = useState<IdentityConsoleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIdentity, setBusyIdentity] = useState<string>();
  const [error, setError] = useState<string>();
  const [bridgeNotice, setBridgeNotice] = useState<string>();
  const [logs, setLogs] = useState<IdentityConsoleLog[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await window.identityConsole.list();
    if (result.ok) setIdentities(result.data ?? []);
    else setError(result.error?.message ?? '无法加载身份列表。');
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const refreshLogs = async (): Promise<void> => { const result = await window.identityConsole.logs(); if (result.ok) setLogs(result.data ?? []); };
  useEffect(() => { void refreshLogs(); }, []);

  const operate = async (identityId: string, operation: 'start' | 'stop' | 'refresh'): Promise<void> => {
    setBusyIdentity(identityId);
    setError(undefined);
    const result = operation === 'start'
      ? await window.identityConsole.start(identityId)
      : operation === 'stop'
        ? await window.identityConsole.stop(identityId)
        : await window.identityConsole.status(identityId);

    if (!result.ok || !result.data) {
      setError(result.error?.message ?? `${operation} 失败。`);
      setBusyIdentity(undefined);
      return;
    }

    const identity = 'identity' in result.data ? result.data.identity : result.data;
    setIdentities((current) => current.map((item) => item.manifest.identityId === identityId ? identity : item));
    if ('error' in result.data && result.data.error) setError(result.data.error.message);
    setBusyIdentity(undefined);
  };
  const remove = async (identityId: string): Promise<void> => {
    if (!window.confirm(`确认删除 ${identityId}？Chrome 配置文件将保留。`)) return;
    setBusyIdentity(identityId);
    try { const result = await window.identityConsole.delete(identityId); if (!result.ok) setError(`${result.error?.code ?? 'DELETE_FAILED'}: ${result.error?.message ?? ''}`); else setIdentities((current) => current.filter((item) => item.manifest.identityId !== identityId)); }
    finally { setBusyIdentity(undefined); void refreshLogs(); }
  };
  const validateAll = async (): Promise<void> => { setLoading(true); try { const result = await window.identityConsole.validateAll(); if (!result.ok) setError(`${result.error?.code ?? 'VALIDATE_FAILED'}: ${result.error?.message ?? ''}`); else setError(`已验证 ${result.data?.length ?? 0} 个身份，详见操作记录。`); } finally { setLoading(false); } };
  const stopAll = async (): Promise<void> => { setLoading(true); try { const result = await window.identityConsole.stopAll(); if (!result.ok) setError(`${result.error?.code ?? 'STOP_ALL_FAILED'}: ${result.error?.message ?? ''}`); await refresh(); } finally { setLoading(false); } };
  const installBridge = async (): Promise<void> => {
    setBridgeNotice(undefined);
    const result = await window.identityConsole.installBridge();
    if (!result.ok) setBridgeNotice(`${result.error?.code ?? 'INSTALL_BRIDGE_FAILED'}: ${result.error?.message ?? ''}`);
    else setBridgeNotice('原生宿主注册成功。若浏览器已打开，请刷新扩展。');
  };

  return (
    <div className="identity-console">
      <div className="identity-console__header">
        <button className="identity-console__back" onClick={onBack} aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <div>
          <div className="home__label">KV BROWSER BRIDGE</div>
          <h1 className="identity-console__title">身份控制台</h1>
          <p className="identity-console__subtitle">启动、停止并查看相互隔离的 Chrome 身份。</p>
        </div>
        <button className="identity-console__refresh-all" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'identity-console__spin' : undefined} />
          刷新全部
        </button>
        <button className="identity-console__refresh-all" onClick={() => void validateAll()} disabled={loading}>全部验证</button>
        <button className="identity-console__refresh-all" onClick={() => void stopAll()} disabled={loading}>全部停止</button>
        <button className="identity-console__refresh-all" onClick={() => void installBridge()} disabled={loading}>安装桥接</button>
      </div>

      {error && (
        <div className="identity-console__error">
          <CircleAlert size={15} />
          <span>{error}</span>
        </div>
      )}
      {bridgeNotice && (
        <div className="identity-console__error">
          <CircleAlert size={15} />
          <span>{bridgeNotice}</span>
        </div>
      )}

      {loading ? (
        <div className="identity-console__empty"><Loader2 size={18} className="identity-console__spin" /> 正在加载身份…</div>
      ) : identities.length === 0 ? (
        <div className="identity-console__empty">
          <p>还没有身份，先创建第一个隔离浏览器身份。</p>
          <button className="identity-console__refresh-all" onClick={onCreate}>创建身份</button>
        </div>
      ) : (
        <div className="identity-console__list">
          {identities.map((identity) => {
            const id = identity.manifest.identityId;
            const busy = busyIdentity === id;
            const running = identity.status === 'running';
            return (
              <article className="identity-card" key={id}>
                <div className="identity-card__top">
                  <div>
                    <div className="identity-card__label">{identity.manifest.accountLabel}</div>
                    <div className="identity-card__id">{id}</div>
                  </div>
                  <span className={`identity-card__status identity-card__status--${identity.status}`}>{({ 'not-started': '未启动', starting: '启动中', running: '运行中', stopped: '已停止', failed: '失败', frozen: '已冻结', unverified: '未验证', warning: '警告' } as Record<string, string>)[identity.status] ?? identity.status}</span>
                </div>

                <dl className="identity-card__facts">
                  <div><dt>代理</dt><dd>{identity.manifest.proxy.protocol}://{identity.manifest.proxy.host}:{identity.manifest.proxy.port}</dd></div>
                  <div><dt>配置文件</dt><dd title={identity.manifest.browser.userDataDir}>{identity.manifest.browser.userDataDir}</dd></div>
                  <div><dt>公网 IP</dt><dd>{identity.publicIp ?? '未验证'}</dd></div>
                  <div><dt>进程</dt><dd>{identity.session?.process.state ?? identity.runtime.state}</dd></div>
                  <div><dt>桥接</dt><dd>{identity.session?.bridge.extensionHandshake ? '握手就绪' : identity.session?.bridge.privateDiscoveryPresent ? '仅发现' : '未就绪'}</dd></div>
                  <div><dt>网络</dt><dd>{identity.session?.effectiveState === 'warning' ? '警告' : identity.frozen ? '已冻结' : identity.publicIp ? '已观测' : '未验证'}</dd></div>
                  <div><dt>PID</dt><dd>{identity.runtime.alive ? identity.runtime.pid ?? '未知' : '未运行'}</dd></div>
                </dl>

                {identity.lastError && (
                  <div className="identity-card__last-error">
                    <strong>{identity.lastError.code}</strong>
                    <span>{identity.lastError.message}</span>
                  </div>
                )}

                <div className="identity-card__actions">
                  <button onClick={() => void operate(id, 'start')} disabled={busy || running || identity.frozen}>
                    {busy ? <Loader2 size={14} className="identity-console__spin" /> : <Play size={14} />}
                    启动
                  </button>
                  <button onClick={() => void operate(id, 'stop')} disabled={busy || !running}>
                    <Square size={13} />
                    停止
                  </button>
                  <button onClick={() => void operate(id, 'refresh')} disabled={busy}>
                    <RefreshCw size={14} />
                    刷新
                  </button>
                  <button onClick={() => void remove(id)} disabled={busy || running} title="删除配置；配置文件保留">
                    <Trash2 size={14} />
                    删除
                  </button>
                  <button onClick={() => onEdit(identity.manifest as IdentityManifest)} disabled={busy}><Pencil size={14} /> 编辑</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <section className="identity-console__logs">
        <div className="identity-console__logs-heading"><h2>操作记录</h2><button className="identity-console__refresh-all" onClick={() => void refreshLogs()}>刷新记录</button></div>
        {logs.slice(0, 20).map((entry) => <div className={`identity-console__log ${entry.ok ? 'is-ok' : 'is-failed'}`} key={`${entry.operation}:${entry.completedAt}:${entry.identityId ?? ''}`}><strong>{entry.operation}</strong><span>{entry.identityId ?? '系统'}</span><span>{new Date(entry.completedAt).toLocaleString()}</span><span>{entry.ok ? '成功' : `${entry.errorCode ?? '失败'} ${entry.errorMessage ?? ''}`}</span></div>)}
      </section>
    </div>
  );
}
