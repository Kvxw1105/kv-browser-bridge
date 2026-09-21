import React, { useCallback, useState } from 'react';
import { useConnectionStore, type ManualUpdateInfo } from '../stores/connection-store';

const AGENT_INSTALL_URL = 'https://raw.githubusercontent.com/Kvxw1105/kv-browser-bridge/main/AGENT_INSTALL.md';

const AGENT_SETUP_PROMPT = `请在这台机器配置 Kv Browser Bridge。

先阅读并遵循：
${AGENT_INSTALL_URL}

完成标准：
1. 安装或更新 kv-browser-bridge Skill；
2. 配置本地 stdio MCP；
3. 运行 doctor；
4. 验证 browser_capabilities、browser_connection_status 和 browser_get_tabs；
5. 按 EDITED、LOCALLY_VERIFIED、LIVE_VERIFIED、NOT_VERIFIED、NEXT 报告结果。

安全边界：不要读取、导出或展示 Cookie、Token、密码、验证码、代理凭据或 Named Pipe bearer token；未经明确确认，不得发布、删除、付款或执行账号安全操作。`;

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);
  return (
    <div className="setup-screen__cmd-row">
      <pre className="setup-screen__code">{command}</pre>
      <button className="setup-screen__copy-btn" onClick={copy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function AgentSetupCard() {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(() => {
    void navigator.clipboard.writeText(AGENT_SETUP_PROMPT).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    }).catch(() => setCopied(false));
  }, []);

  return (
    <section className={`setup-screen__agent-card ${expanded ? 'setup-screen__agent-card--open' : ''}`}>
      <button
        type="button"
        className="setup-screen__agent-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="setup-screen__agent-toggle-copy">
          <span className="setup-screen__agent-kicker">QUICK HANDOFF</span>
          <strong>让 Agent 自动配置</strong>
          <small>复制一段提示词，交给 Codex、Claude Code 或其他 MCP Agent</small>
        </span>
        <span className="setup-screen__agent-toggle-icon" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>

      {expanded ? (
        <div className="setup-screen__agent-body">
          <p>Agent 会按安装指南完成 Skill、MCP、doctor 和首次只读验收。提示词不包含账号、Cookie 或本机凭据。</p>
          <pre className="setup-screen__agent-prompt">{AGENT_SETUP_PROMPT}</pre>
          <div className="setup-screen__agent-actions">
            <button type="button" className="setup-screen__agent-copy" onClick={copyPrompt}>
              {copied ? '已复制提示词' : '复制给 Agent'}
            </button>
            <a className="setup-screen__agent-link" href={AGENT_INSTALL_URL} target="_blank" rel="noreferrer">
              查看安装指南 ↗
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function KvFooter() {
  return <div className="setup-screen__footer"><div className="setup-screen__footer-label">Kv Browser Bridge</div></div>;
}

function UpdatingScreen() {
  return (
    <div className="setup-screen"><div className="setup-screen__content">
      <div className="setup-screen__header"><span className="setup-screen__status-dot" /><h2 className="setup-screen__title">Updating the bridge</h2></div>
      <p className="setup-screen__subtitle">A compatible local bridge is being prepared. Chrome reconnects automatically when it is ready.</p>
      <KvFooter />
    </div></div>
  );
}

function ManualUpdateScreen({ info }: { info: ManualUpdateInfo }) {
  return (
    <div className="setup-screen"><div className="setup-screen__content">
      <div className="setup-screen__header"><span className="setup-screen__status-dot" /><h2 className="setup-screen__title">Update Required</h2></div>
      <p className="setup-screen__subtitle">This extension needs local bridge version <strong>{info.target}</strong>{info.current ? <>; installed version: <strong>{info.current}</strong></> : null}.</p>
      {info.reason ? <p className="setup-screen__subtitle"><strong>Update note:</strong> {info.reason}</p> : null}
      <div className="setup-screen__steps"><div className="setup-screen__step"><div className="setup-screen__step-num">1</div><div className="setup-screen__step-body"><strong>Build the Kv path again</strong><div className="setup-screen__step-desc">Build the extension and local bridge, then register the bridge with your extension ID.</div><CopyableCommand command="npm run build:local-chrome" /></div></div></div>
      <KvFooter />
    </div></div>
  );
}

function GenericSetupScreen() {
  const installCmd = 'node apps/chrome-bridge/dist/install.js install <extension-id>';
  return (
    <div className="setup-screen"><div className="setup-screen__content">
      <div className="setup-screen__header"><span className="setup-screen__status-dot" /><h2 className="setup-screen__title">Setup Required</h2></div>
      <p className="setup-screen__subtitle">Kv Browser Bridge connects this Chrome extension to a local bridge on your computer. It does not require a separate product account.</p>
      <p className="setup-screen__subtitle">Build the project, load <code>apps/extension/dist</code> as an unpacked extension, copy its ID from <code>chrome://extensions</code>, then register the Kv host with that exact ID.</p>
      <div className="setup-screen__steps"><div className="setup-screen__step"><div className="setup-screen__step-num">1</div><div className="setup-screen__step-body"><strong>Run this in your terminal</strong><div className="setup-screen__step-desc">Registers the local bridge for this exact extension ID.</div><CopyableCommand command={installCmd} /></div></div><div className="setup-screen__step"><div className="setup-screen__step-num">2</div><div className="setup-screen__step-body"><strong>Reload the extension</strong><div className="setup-screen__step-desc">Reload the unpacked extension after registration.</div></div></div></div>
      <AgentSetupCard />
      <KvFooter />
    </div></div>
  );
}

export function SetupScreen() {
  const needsManualUpdate = useConnectionStore((s) => s.needsManualUpdate);
  const hostUpdating = useConnectionStore((s) => s.hostUpdating);
  if (needsManualUpdate) return <ManualUpdateScreen info={needsManualUpdate} />;
  if (hostUpdating) return <UpdatingScreen />;
  return <GenericSetupScreen />;
}
