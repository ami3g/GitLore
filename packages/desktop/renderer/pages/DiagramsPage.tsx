import React, { useState, useCallback, useEffect } from 'react';
import { DiagramViewer } from '../components/DiagramViewer';
import { useGitLore } from '../hooks/useElectronAPI';
import type { DiagramType, SavedDiagram } from '../../shared/ipc-types';

interface DiagramsPageProps {
  repoPath: string;
}

interface DiagramDef {
  type: DiagramType;
  label: string;
  icon: string;
  description: string;
  hasInput?: boolean;
}

const DIAGRAMS: DiagramDef[] = [
  {
    type: 'architecture',
    label: 'Architecture',
    icon: '🏗️',
    description: 'File-level dependency graph grouped by directory.',
  },
  {
    type: 'callgraph',
    label: 'Call Graph',
    icon: '🔗',
    description: 'Function-level call relationships. Optionally filter by entry point.',
    hasInput: true,
  },
  {
    type: 'commits',
    label: 'Commit Timeline',
    icon: '📅',
    description: 'Git history timeline of recent commits.',
  },
  {
    type: 'prs',
    label: 'PR / Issue Flow',
    icon: '🔀',
    description: 'Pull requests linked to issues and merge commits.',
  },
];

const ICON_MAP: Record<DiagramType, string> = {
  architecture: '🏗️',
  callgraph: '🔗',
  commits: '📅',
  prs: '🔀',
};

export const DiagramsPage: React.FC<DiagramsPageProps> = ({ repoPath }) => {
  const api = useGitLore();
  const [activeDiagram, setActiveDiagram] = useState<DiagramType | null>(null);
  const [mermaidCode, setMermaidCode] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [entryFile, setEntryFile] = useState('');
  const [entryFunction, setEntryFunction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedDiagrams, setSavedDiagrams] = useState<SavedDiagram[]>([]);
  const [viewingName, setViewingName] = useState<string | null>(null);

  // Load saved diagrams on mount
  const refreshList = useCallback(async () => {
    try {
      const list = await api.diagramList(repoPath);
      setSavedDiagrams(list);
    } catch { /* no diagrams dir yet */ }
  }, [api, repoPath]);

  useEffect(() => { refreshList(); }, [refreshList]);

  const handleGenerate = useCallback(async (type: DiagramType) => {
    setIsGenerating(true);
    setError(null);
    setActiveDiagram(type);
    setViewingName(null);
    try {
      const options: Record<string, unknown> = {};
      if (type === 'callgraph' && entryFile && entryFunction) {
        options.entryFile = entryFile;
        options.entryFunction = entryFunction;
      }
      const code = await api.diagram(repoPath, type, options);
      setMermaidCode(code);

      // Auto-save
      const label = DIAGRAMS.find(d => d.type === type)?.label ?? type;
      const ts = new Date().toLocaleString();
      await api.diagramSave(repoPath, `${label} – ${ts}`, type, code);
      await refreshList();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate diagram');
      setMermaidCode('');
    } finally {
      setIsGenerating(false);
    }
  }, [api, repoPath, entryFile, entryFunction, refreshList]);

  const handleLoadSaved = useCallback(async (d: SavedDiagram) => {
    try {
      const code = await api.diagramLoad(repoPath, d.filename);
      setMermaidCode(code);
      setActiveDiagram(d.type);
      setViewingName(d.name);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load diagram');
    }
  }, [api, repoPath]);

  const handleDeleteSaved = useCallback(async (d: SavedDiagram, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.diagramDelete(repoPath, d.filename);
    await refreshList();
    // Clear viewer if this was the active one
    if (viewingName === d.name) {
      setMermaidCode('');
      setViewingName(null);
    }
  }, [api, repoPath, refreshList, viewingName]);

  return (
    <div className="diagrams-page">
      <h2 className="page-title">Diagrams</h2>

      <div className="diagrams-page__grid">
        {DIAGRAMS.map((d) => (
          <div key={d.type} className="diagrams-page__card">
            <div className="diagrams-page__card-header">
              <span className="diagrams-page__card-icon">{d.icon}</span>
              <span className="diagrams-page__card-label">{d.label}</span>
            </div>
            <p className="diagrams-page__card-desc">{d.description}</p>

            {d.hasInput && (
              <div className="diagrams-page__card-inputs">
                <input
                  className="input"
                  placeholder="Entry file (e.g. src/server.ts)"
                  value={entryFile}
                  onChange={(e) => setEntryFile(e.target.value)}
                />
                <input
                  className="input"
                  placeholder="Entry function (e.g. handleRequest)"
                  value={entryFunction}
                  onChange={(e) => setEntryFunction(e.target.value)}
                />
              </div>
            )}

            <button
              className="btn btn--secondary"
              onClick={() => handleGenerate(d.type)}
              disabled={isGenerating}
            >
              {isGenerating && activeDiagram === d.type ? 'Generating...' : 'Generate'}
            </button>
          </div>
        ))}
      </div>

      {/* Saved diagrams list */}
      {savedDiagrams.length > 0 && (
        <div className="diagrams-page__saved">
          <h3 className="diagrams-page__saved-title">Saved Diagrams</h3>
          <div className="diagrams-page__saved-list">
            {savedDiagrams.map((d) => (
              <div
                key={d.filename}
                className={`diagrams-page__saved-item ${viewingName === d.name ? 'diagrams-page__saved-item--active' : ''}`}
                onClick={() => handleLoadSaved(d)}
              >
                <span className="diagrams-page__saved-icon">{ICON_MAP[d.type] ?? '📄'}</span>
                <div className="diagrams-page__saved-info">
                  <span className="diagrams-page__saved-name">{d.name}</span>
                  {d.createdAt && (
                    <span className="diagrams-page__saved-date">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <button
                  className="diagrams-page__saved-delete"
                  onClick={(e) => handleDeleteSaved(d, e)}
                  title="Delete diagram"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="diagrams-page__error">{error}</div>}

      {mermaidCode && (
        <div className="diagrams-page__viewer">
          <div className="diagrams-page__viewer-header">
            <span>{viewingName ?? `${activeDiagram} diagram`}</span>
          </div>
          <DiagramViewer code={mermaidCode} />
        </div>
      )}
    </div>
  );
};
