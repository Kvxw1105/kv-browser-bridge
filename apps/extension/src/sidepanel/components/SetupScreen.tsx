import React, { useCallback, useState } from 'react';
import { useConnectionStore, type ManualUpdateInfo } from '../stores/connection-store';

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
