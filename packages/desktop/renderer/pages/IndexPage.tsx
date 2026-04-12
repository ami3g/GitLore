import React, { useState, useEffect, useCallback } from 'react';
import { useGitLore, useIPCEvent } from '../hooks/useElectronAPI';
import type { IndexStatus } from '@gitlore/core';

interface IndexPageProps {
  repoPath: string;
}

export const IndexPage: React.FC<IndexPageProps> = ({ repoPath }) => {
  const api = useGitLore();
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [totalCommits, setTotalCommits] = useState(1000);
  const [depth, setDepth] = useState(1000);
  const [isIndexing, setIsIndexing] = useState(false);
  const [progress, setProgress] = useState('');

  // Load status + total commits on mount
  useEffect(() => {
    api.getStatus(repoPath).then(setStatus).catch(() => {});
    api.getTotalCommits(repoPath).then((n) => {
      setTotalCommits(n);
      setDepth(Math.min(1000, n));
    }).catch(() => {});
  }, [repoPath, api]);

  // Progress events
  useIPCEvent('gitlore:index-progress', useCallback(({ phase, current, total }) => {
    setProgress(`${phase}: ${current}/${total}`);
  }, []));

  useIPCEvent('gitlore:index-complete', useCallback((newStatus: IndexStatus) => {
    setStatus(newStatus);
    setIsIndexing(false);
    setProgress('');
  }, []));

  const handleIndexCommits = useCallback(async () => {
    setIsIndexing(true);
    setProgress('Starting...');
    try {
      await api.index(repoPath, depth);
    } catch {
      setIsIndexing(false);
      setProgress('');
    }
  }, [api, repoPath, depth]);

  const handleIndexCode = useCallback(async () => {
    setIsIndexing(true);
    setProgress('Starting code indexing...');
    try {
      await api.indexCode(repoPath);
      const s = await api.getStatus(repoPath);
      setStatus(s);
    } finally {
      setIsIndexing(false);
      setProgress('');
    }
  }, [api, repoPath]);

  const handleIndexPRs = useCallback(async () => {
    setIsIndexing(true);
    setProgress('Starting PR indexing...');
    try {
      await api.indexPRs(repoPath);
      const s = await api.getStatus(repoPath);
      setStatus(s);
    } finally {
      setIsIndexing(false);
      setProgress('');
    }
  }, [api, repoPath]);

  const handleClear = useCallback(async () => {
    await api.clear(repoPath);
    const s = await api.getStatus(repoPath);
    setStatus(s);
  }, [api, repoPath]);

  const pct = totalCommits > 0 ? Math.round((depth / totalCommits) * 100) : 0;

  return (
    <div className="index-page">
      <h2 className="page-title">Index</h2>

      {/* Status panel */}
      <div className="index-page__status">
        <div className="index-page__status-row">
          <span className={`status-dot ${status?.indexed ? 'status-dot--active' : ''}`} />
          <span>{status?.indexed ? 'Indexed' : 'Not indexed'}</span>
        </div>
        {status?.indexed && (
          <>
            <div className="index-page__stat">{status.commitCount} commits</div>
            <div className="index-page__stat">{status.codeFileCount} code files</div>
            <div className="index-page__stat">{status.prCount} PRs</div>
            {status.lastIndexedAt && (
              <div className="index-page__stat">
                Last: {new Date(status.lastIndexedAt).toLocaleDateString()}
              </div>
            )}
          </>
        )}
      </div>

      {/* Depth slider */}
      <div className="index-page__slider-section">
        <label className="index-page__slider-label">
          Commit Depth: <strong>{depth.toLocaleString()}</strong>
          <span className="index-page__slider-pct"> ({pct}% of {totalCommits.toLocaleString()})</span>
        </label>
        <input
          type="range"
          className="index-page__slider"
          min={10}
          max={totalCommits}
          step={10}
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          disabled={isIndexing}
        />
        <div className="index-page__slider-ticks">
          <span>10</span>
          <span>{Math.round(totalCommits / 2).toLocaleString()}</span>
          <span>{totalCommits.toLocaleString()}</span>
        </div>
      </div>

      {/* Progress bar */}
      {isIndexing && (
        <div className="index-page__progress">
          <div className="index-page__progress-bar">
            <div className="index-page__progress-fill" />
          </div>
          <span className="index-page__progress-text">{progress}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="index-page__actions">
        <button
          className="btn btn--primary"
          onClick={handleIndexCommits}
          disabled={isIndexing}
        >
          {isIndexing ? 'Indexing...' : status?.indexed ? 'Re-index Commits' : 'Index Commits'}
        </button>
        <button
          className="btn btn--secondary"
          onClick={handleIndexCode}
          disabled={isIndexing}
        >
          Index Code
        </button>
        <button
          className="btn btn--secondary"
          onClick={handleIndexPRs}
          disabled={isIndexing}
        >
          Index PRs
        </button>
        {status?.indexed && (
          <button
            className="btn btn--danger"
            onClick={handleClear}
            disabled={isIndexing}
          >
            Clear Index
          </button>
        )}
      </div>
    </div>
  );
};
