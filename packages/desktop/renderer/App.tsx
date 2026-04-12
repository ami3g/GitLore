import React, { useState, useCallback } from 'react';
import { Sidebar, type Page } from './components/Sidebar';
import { ContextBar } from './components/ContextBar';
import { AskPage } from './pages/AskPage';
import { DiagramsPage } from './pages/DiagramsPage';
import { IndexPage } from './pages/IndexPage';
import { SettingsPage } from './pages/SettingsPage';
import { useGitLore } from './hooks/useElectronAPI';

export const App: React.FC = () => {
  const [page, setPage] = useState<Page>('ask');
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const api = useGitLore();

  const handleOpenFolder = useCallback(async () => {
    const folder = await api.openFolder();
    if (folder) setRepoPath(folder);
  }, [api]);

  const renderPage = () => {
    if (!repoPath) {
      return (
        <div className="empty-state">
          <div className="empty-state__icon">📂</div>
          <h2>Open a Repository</h2>
          <p>Select a Git repository to get started.</p>
          <button className="btn btn--primary" onClick={handleOpenFolder}>
            Open Folder
          </button>
        </div>
      );
    }

    switch (page) {
      case 'ask':
        return <AskPage repoPath={repoPath} />;
      case 'diagrams':
        return <DiagramsPage repoPath={repoPath} />;
      case 'index':
        return <IndexPage repoPath={repoPath} />;
      case 'settings':
        return <SettingsPage />;
    }
  };

  return (
    <div className="app">
      <Sidebar activePage={page} onNavigate={setPage} />
      <div className="app__main">
        <ContextBar repoPath={repoPath} onOpenFolder={handleOpenFolder} />
        <div className="app__content">
          {renderPage()}
        </div>
      </div>
    </div>
  );
};
