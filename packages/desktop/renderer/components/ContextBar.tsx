import React, { useEffect, useState, useCallback } from 'react';
import { useGitLore } from '../hooks/useElectronAPI';
import type { IndexStatus } from '@gitlore/core';

interface ContextBarProps {
  repoPath: string | null;
  onOpenFolder: () => void;
}

export const ContextBar: React.FC<ContextBarProps> = ({ repoPath, onOpenFolder }) => {
  const api = useGitLore();
  const [status, setStatus] = useState<IndexStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!repoPath) return;
    try {
      const s = await api.getStatus(repoPath);
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, [repoPath, api]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const repoName = repoPath ? repoPath.split(/[\\/]/).pop() : null;

  return (
    <div className="context-bar">
      <div className="context-bar__repo" onClick={onOpenFolder} title="Change repository">
        <span className="context-bar__repo-icon">
          {status?.indexed ? '🟢' : '⚪'}
        </span>
        <span className="context-bar__repo-name">
          {repoName ?? 'No repo selected'}
        </span>
      </div>
      {status && (
        <div className="context-bar__stats">
          {status.commitCount > 0 && (
            <span className="context-bar__badge">{status.commitCount} commits</span>
          )}
          {status.codeFileCount > 0 && (
            <span className="context-bar__badge">{status.codeFileCount} files</span>
          )}
          {status.prCount > 0 && (
            <span className="context-bar__badge">{status.prCount} PRs</span>
          )}
        </div>
      )}
    </div>
  );
};
