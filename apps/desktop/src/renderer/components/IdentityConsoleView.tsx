import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Loader2, Play, RefreshCw, Square, Trash2, Pencil } from 'lucide-react';
import type { IdentityConsoleItem } from '../../shared/identity-console';
import type { IdentityConsoleLog } from '../../shared/identity-console';
import type { IdentityManifest } from '../../../../chrome-bridge/src/identity/model';
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
  const [logs, setLogs] = useState<IdentityConsoleLog[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await window.identityConsole.list();
    if (result.ok) setIdentities(result.data ?? []);
    else setError(result.error?.message ?? 'Unable to load identities.');
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
      setError(result.error?.message ?? `${operation} failed.`);
      setBusyIdentity(undefined);
      return;
    }

    const identity = 'identity' in result.data ? result.data.identity : result.data;
    setIdentities((current) => current.map((item) => item.manifest.identityId === identityId ? identity : item));
    if ('error' in result.data && result.data.error) setError(result.data.error.message);
    setBusyIdentity(undefined);
  };
  const remove = async (identityId: string): Promise<void> => {
    if (!window.confirm(`Remove ${identityId}? Chrome profile data will be retained.`)) return;
    setBusyIdentity(identityId);
    try { const result = await window.identityConsole.delete(identityId); if (!result.ok) setError(`${result.error?.code ?? 'DELETE_FAILED'}: ${result.error?.message ?? ''}`); else setIdentities((current) => current.filter((item) => item.manifest.identityId !== identityId)); }
    finally { setBusyIdentity(undefined); void refreshLogs(); }
  };
  const validateAll = async (): Promise<void> => { setLoading(true); try { const result = await window.identityConsole.validateAll(); if (!result.ok) setError(`${result.error?.code ?? 'VALIDATE_FAILED'}: ${result.error?.message ?? ''}`); else setError(`Validated ${result.data?.length ?? 0} identities. See operations log for details.`); } finally { setLoading(false); } };
  const stopAll = async (): Promise<void> => { setLoading(true); try { const result = await window.identityConsole.stopAll(); if (!result.ok) setError(`${result.error?.code ?? 'STOP_ALL_FAILED'}: ${result.error?.message ?? ''}`); await refresh(); } finally { setLoading(false); } };

  return (
    <div className="identity-console">
      <div className="identity-console__header">
        <button className="identity-console__back" onClick={onBack} aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <div>
          <div className="home__label">KV BROWSER BRIDGE</div>
          <h1 className="identity-console__title">Identity Console</h1>
          <p className="identity-console__subtitle">Start, stop and inspect isolated Chrome identities.</p>
        </div>
        <button className="identity-console__refresh-all" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'identity-console__spin' : undefined} />
          Refresh all
        </button>
        <button className="identity-console__refresh-all" onClick={() => void validateAll()} disabled={loading}>Validate all</button>
        <button className="identity-console__refresh-all" onClick={() => void stopAll()} disabled={loading}>Stop all</button>
      </div>

      {error && (
        <div className="identity-console__error">
          <CircleAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="identity-console__empty"><Loader2 size={18} className="identity-console__spin" /> Loading identities…</div>
      ) : identities.length === 0 ? (
        <div className="identity-console__empty">
          <p>No identities yet. Create your first isolated browser identity.</p>
          <button className="identity-console__refresh-all" onClick={onCreate}>Create Identity</button>
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
                  <span className={`identity-card__status identity-card__status--${identity.status}`}>{identity.status}</span>
                </div>

                <dl className="identity-card__facts">
                  <div><dt>Proxy</dt><dd>{identity.manifest.proxy.protocol}://{identity.manifest.proxy.host}:{identity.manifest.proxy.port}</dd></div>
                  <div><dt>Profile</dt><dd title={identity.manifest.browser.userDataDir}>{identity.manifest.browser.userDataDir}</dd></div>
                  <div><dt>Public IP</dt><dd>{identity.publicIp ?? 'Not verified'}</dd></div>
                  <div><dt>PID</dt><dd>{identity.runtime.alive ? identity.runtime.pid ?? 'Unknown' : 'Not running'}</dd></div>
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
                    Start
                  </button>
                  <button onClick={() => void operate(id, 'stop')} disabled={busy || !running}>
                    <Square size={13} />
                    Stop
                  </button>
                  <button onClick={() => void operate(id, 'refresh')} disabled={busy}>
                    <RefreshCw size={14} />
                    Refresh
                  </button>
                  <button onClick={() => void remove(id)} disabled={busy || running} title="Remove configuration; profile is retained">
                    <Trash2 size={14} />
                    Delete
                  </button>
                  <button onClick={() => onEdit(identity.manifest as IdentityManifest)} disabled={busy}><Pencil size={14} /> Edit</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <section className="identity-console__logs">
        <div className="identity-console__logs-heading"><h2>Operations</h2><button className="identity-console__refresh-all" onClick={() => void refreshLogs()}>Refresh logs</button></div>
        {logs.slice(0, 20).map((entry) => <div className={`identity-console__log ${entry.ok ? 'is-ok' : 'is-failed'}`} key={`${entry.operation}:${entry.completedAt}:${entry.identityId ?? ''}`}><strong>{entry.operation}</strong><span>{entry.identityId ?? 'system'}</span><span>{new Date(entry.completedAt).toLocaleString()}</span><span>{entry.ok ? 'Success' : `${entry.errorCode ?? 'FAILED'} ${entry.errorMessage ?? ''}`}</span></div>)}
      </section>
    </div>
  );
}
