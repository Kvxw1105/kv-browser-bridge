import React, { useEffect, useRef, useState } from 'react';

type GoState = {
  phase?: string;
  round?: number;
  nextActionAt?: number;
  lastSummary?: string;
  lastStopReason?: string;
};

type GoStatus = {
  ok?: boolean;
  running?: boolean;
  maxRounds?: number;
  conversationKey?: string;
  decision?: { preset?: string; model?: string; apiKeySet?: boolean } | null;
  state?: GoState;
  error?: string;
};

export function KvGoPanel({ targetTabId, chinese }: { targetTabId: number | null; chinese: boolean }) {
  const [enabled, setEnabled] = useState(true);
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<GoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const t = {
    section: chinese ? 'KvGo 功能' : 'KvGo feature',
    hint: chinese ? '在聊天页面显示 GO 面板，并允许从这里控制无人值守推进。' : 'Shows the GO panel on chat pages and enables unattended progression control from here.',
    on: chinese ? '已启用' : 'Enabled',
    off: chinese ? '已停用' : 'Disabled',
    target: chinese ? '目标标签页' : 'Target tab',
    noTarget: chinese ? '未选择标签页' : 'No tab selected',
    goal: chinese ? '目标（可选）' : 'Goal (optional)',
    goalPh: chinese ? '例如：完成 5 个阶段并输出【任务完成】' : 'e.g. finish 5 stages and emit [DONE]',
    start: chinese ? '开始推进' : 'Start',
    stop: chinese ? '停止' : 'Stop',
    cont: chinese ? '继续' : 'Resume',
    idle: chinese ? '空闲' : 'Idle',
    running: chinese ? '运行中' : 'Running',
    stopped: chinese ? '已停止' : 'Stopped',
    generating: chinese ? '模型生成中…' : 'Generating…',
    waiting: chinese ? '等待回复' : 'Waiting',
    cooldown: chinese ? '后推进' : 'until next push',
    checkpoint: chinese ? '已到节点，请验收' : 'At checkpoint',
    risk: chinese ? '风控/异常' : 'Risk/error',
    decision: chinese ? '决策引擎' : 'Decision engine',
    decisionNone: chinese ? '未配置（模板池）' : 'Not configured (template pool)',
    keySet: chinese ? 'key 已设置' : 'key set',
    keyMissing: chinese ? '缺 key' : 'key missing',
    ledger: chinese ? '账本' : 'Ledger',
    error: chinese ? '操作失败' : 'Action failed',
  };

  const send = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, tabId: targetTabId, ...extra }, (r) => { void chrome.runtime.lastError; resolve(r); });
      } catch {
        resolve({ ok: false, error: 'background unreachable' });
      }
    });

  const refresh = () => {
    if (targetTabId == null) return;
    void send('go:status').then((r) => setStatus(r as GoStatus));
  };

  useEffect(() => {
    chrome.storage.local.get('goFeatureEnabled', (s) => setEnabled(s.goFeatureEnabled !== false));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.goFeatureEnabled) setEnabled(changes.goFeatureEnabled.newValue !== false);
    });
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (enabled && targetTabId != null) {
      refresh();
      timer.current = setInterval(refresh, 2000);
    }
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [enabled, targetTabId]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    void chrome.storage.local.set({ goFeatureEnabled: next });
    if (!next) setStatus(null);
  };

  const run = async (action: 'start' | 'stop' | 'continue') => {
    if (targetTabId == null) return;
    setBusy(true);
    setMessage('');
    const r = (await send(
      action === 'start' ? 'go:start' : action === 'stop' ? 'go:stop' : 'go:continue',
      action === 'start' ? { goal } : {},
    )) as GoStatus;
    setBusy(false);
    if (r && r.ok === false) setMessage(t.error + (r.error ? ': ' + r.error : ''));
    refresh();
  };

  const s = status?.state ?? {};
  const secs = s.nextActionAt ? Math.max(0, Math.ceil((s.nextActionAt - Date.now()) / 1000)) : 0;
  const phaseText =
    s.phase === 'generating' ? t.generating
      : s.phase === 'waiting' ? t.waiting
        : s.phase === 'cooldown' ? `${secs}s ${t.cooldown}`
          : s.phase === 'stopped' ? (s.lastStopReason?.includes('风控') ? t.risk : t.checkpoint)
            : t.idle;
  const decision = status?.decision;

  return (
    <section className="local-bridge-panel__section local-bridge-panel__kvgo" aria-labelledby="kvgo-heading">
      <div className="local-bridge-panel__section-header">
        <div className="local-bridge-panel__kvgo-title">
          <p id="kvgo-heading">KvGo</p>
          <span className={`local-bridge-panel__kvgo-badge${enabled ? ' is-on' : ''}`}>{enabled ? t.on : t.off}</span>
        </div>
        <button className="local-bridge-panel__kvgo-switch" onClick={toggle} aria-pressed={enabled}>
          {enabled ? (chinese ? '停用' : 'Disable') : (chinese ? '启用' : 'Enable')}
        </button>
      </div>
      <p className="local-bridge-panel__kvgo-hint">{t.hint}</p>

      {enabled && (
        <div className="local-bridge-panel__kvgo-body">
          <div className="local-bridge-panel__kvgo-row">
            <span>{t.target}:</span>
            <strong>{targetTabId == null ? t.noTarget : `Tab ${targetTabId}`}</strong>
          </div>
          <div className="local-bridge-panel__kvgo-row">
            <span>{t.goal}:</span>
            <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t.goalPh} disabled={targetTabId == null} />
          </div>
          <div className="local-bridge-panel__kvgo-status">
            <span className={`local-bridge-panel__kvgo-led${status?.running ? ' is-running' : ''}`} aria-hidden="true" />
            <strong>{status?.running ? t.running : status?.state?.phase === 'stopped' ? t.stopped : t.idle}</strong>
            <em>{phaseText}</em>
          </div>
          {status?.running && status.maxRounds != null && (
            <div className="local-bridge-panel__kvgo-row">
              <span>{chinese ? '轮次' : 'Round'}:</span>
              <strong>{s.round ?? 0}/{status.maxRounds}</strong>
            </div>
          )}
          {s.lastSummary ? (
            <div className="local-bridge-panel__kvgo-summary" title={s.lastSummary}>
              {(s.lastSummary || '').slice(0, 140)}{(s.lastSummary || '').length > 140 ? '…' : ''}
            </div>
          ) : null}
          {status?.conversationKey ? (
            <div className="local-bridge-panel__kvgo-row">
              <span>{t.ledger}:</span>
              <strong>{status.conversationKey}</strong>
            </div>
          ) : null}
          <div className="local-bridge-panel__kvgo-row">
            <span>{t.decision}:</span>
            <strong>{decision ? `${decision.preset || 'custom'}${decision.model ? ' / ' + decision.model : ''} · ${decision.apiKeySet ? t.keySet : t.keyMissing}` : t.decisionNone}</strong>
          </div>
          <div className="local-bridge-panel__kvgo-actions">
            {!status?.running ? (
              <button className="local-bridge-panel__kvgo-start" onClick={() => void run('start')} disabled={targetTabId == null || busy}>{t.start}</button>
            ) : (
              <button className="local-bridge-panel__kvgo-stop" onClick={() => void run('stop')} disabled={busy}>{t.stop}</button>
            )}
            {!status?.running && (s.round ?? 0) > 0 && (
              <button className="local-bridge-panel__kvgo-resume" onClick={() => void run('continue')} disabled={targetTabId == null || busy}>{t.cont}</button>
            )}
          </div>
          {message && <small className="local-bridge-panel__kvgo-error">{message}</small>}
        </div>
      )}
    </section>
  );
}
