import React from 'react';
import type { IndexStatus } from '../../types/index';

interface StatusBarProps {
  status: IndexStatus;
  isIndexing: boolean;
  indexProgress: string;
  onIndex: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  status,
  isIndexing,
  indexProgress,
  onIndex,
}) => {
  return (
    <div className="status-bar">
      <div className="status-bar__info">
        <span className={`status-bar__dot ${status.indexed ? 'status-bar__dot--active' : ''}`} />
        {isIndexing ? (
          <span className="status-bar__text">{indexProgress}</span>
        ) : status.indexed ? (
          <span className="status-bar__text">
            {status.commitCount} commits indexed
          </span>
        ) : (
          <span className="status-bar__text">Not indexed</span>
        )}
      </div>
      <button
        className="status-bar__button"
        onClick={onIndex}
        disabled={isIndexing}
      >
        {isIndexing ? 'Indexing...' : status.indexed ? 'Re-index' : 'Index Repo'}
      </button>
    </div>
  );
};
