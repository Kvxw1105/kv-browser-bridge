import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import type { IdentityConsoleItem } from '../../shared/identity-console';
import '../identity-console.css';

interface IdentityConsoleViewProps {
  onBack(): void;
}

export function IdentityConsoleView({ onBack }: IdentityConsoleViewProps) {
  const [identities, setIdentities] = useState<IdentityConsoleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIdentity, setBusyIdentity] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await window.identityConsole.list();
    if (result.ok) setIdentities(result.data ?? []);
    else setError(result.error?.message ?? 'Unable to load identities.');
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
          No generated identity manifests were found. Run the Windows preparation and manifest generation commands first.
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
                  <div><dt>PID</dt><dd>{identity.runtime.pid ?? '—'}</dd></div>
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
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
