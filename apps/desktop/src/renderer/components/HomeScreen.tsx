import { useState } from 'react';
import { useWorkspaceStore } from '../stores/workspace-store';
import { IdentityConsoleView } from './IdentityConsoleView';
import { IdentityForm } from './IdentityForm';
import { KvDashboard } from './KvDashboard';
import { NewProjectView } from './NewProjectView';
import type { IdentityManifest } from '../../../../chrome-bridge/src/identity/model';

type HomeView = 'dashboard' | 'new-project' | 'identity-console' | 'identity-form';

export function HomeScreen() {
  const openFolder = useWorkspaceStore((state) => state.openFolder);
  const [view, setView] = useState<HomeView>('dashboard');
  const [editing, setEditing] = useState<IdentityManifest>();
  const openForm = (manifest?: IdentityManifest): void => { setEditing(manifest); setView('identity-form'); };

  if (view === 'identity-console') return <IdentityConsoleView onBack={() => setView('dashboard')} onCreate={() => openForm()} onEdit={openForm} />;
  if (view === 'identity-form') return <IdentityForm initial={editing} onDone={() => { setEditing(undefined); setView('dashboard'); }} onCancel={() => { setEditing(undefined); setView('dashboard'); }} />;
  if (view === 'new-project') return <NewProjectView onBack={() => setView('dashboard')} />;

  return <div className="home"><div className="home__stage"><KvDashboard openConsole={() => setView('identity-console')} openFolder={() => void openFolder()} openNewIdentity={() => openForm()} openEditIdentity={(manifest) => openForm(manifest as IdentityManifest)} /></div><div className="home__footer">KV Browser Bridge</div></div>;
}
