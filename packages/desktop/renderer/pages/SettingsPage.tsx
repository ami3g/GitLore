import React, { useState, useEffect, useCallback } from 'react';
import { useGitLore } from '../hooks/useElectronAPI';
import type { DesktopConfig } from '../../shared/ipc-types';

export const SettingsPage: React.FC = () => {
  const api = useGitLore();
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, [api]);

  const update = useCallback(async (key: string, value: string | number) => {
    await api.setConfig(key, value);
    setConfig((prev) => prev ? { ...prev, [key]: value } : prev);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [api]);

  if (!config) return <div className="settings-page">Loading...</div>;

  return (
    <div className="settings-page">
      <h2 className="page-title">Settings</h2>

      {saved && <div className="settings-page__toast">Saved</div>}

      {/* LLM Provider */}
      <section className="settings-section">
        <h3 className="settings-section__title">LLM Provider</h3>
        <div className="settings-section__radios">
          {(['ollama', 'openai'] as const).map((p) => (
            <label key={p} className="radio-label">
              <input
                type="radio"
                name="provider"
                checked={config.llmProvider === p}
                onChange={() => update('llmProvider', p)}
              />
              <span>{p === 'ollama' ? 'Ollama (local)' : 'OpenAI'}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Ollama settings */}
      {config.llmProvider === 'ollama' && (
        <section className="settings-section">
          <h3 className="settings-section__title">Ollama</h3>
          <div className="settings-field">
            <label className="settings-field__label">Endpoint</label>
            <input
              className="input"
              value={config.ollamaEndpoint}
              onChange={(e) => update('ollamaEndpoint', e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-field__label">Model</label>
            <input
              className="input"
              value={config.ollamaModel}
              onChange={(e) => update('ollamaModel', e.target.value)}
            />
          </div>
        </section>
      )}

      {/* OpenAI settings */}
      {config.llmProvider === 'openai' && (
        <section className="settings-section">
          <h3 className="settings-section__title">OpenAI</h3>
          <div className="settings-field">
            <label className="settings-field__label">Model</label>
            <input
              className="input"
              value={config.openaiModel}
              onChange={(e) => update('openaiModel', e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-field__label">API Key</label>
            <input
              className="input"
              type="password"
              placeholder="sk-..."
              value={config.openaiApiKey ?? ''}
              onChange={(e) => update('openaiApiKey', e.target.value)}
            />
            <span className="settings-field__hint">
              Or set OPENAI_API_KEY environment variable
            </span>
          </div>
        </section>
      )}

      {/* Query defaults */}
      <section className="settings-section">
        <h3 className="settings-section__title">Query</h3>
        <div className="settings-field">
          <label className="settings-field__label">Default Top-K</label>
          <input
            className="input input--small"
            type="number"
            min={1}
            max={20}
            value={config.topK}
            onChange={(e) => update('topK', Number(e.target.value))}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field__label">Default Commit Depth</label>
          <input
            className="input input--small"
            type="number"
            min={10}
            max={100000}
            step={10}
            value={config.commitDepth}
            onChange={(e) => update('commitDepth', Number(e.target.value))}
          />
        </div>
      </section>

      {/* GitHub */}
      <section className="settings-section">
        <h3 className="settings-section__title">GitHub</h3>
        <div className="settings-field">
          <label className="settings-field__label">Personal Access Token</label>
          <input
            className="input"
            type="password"
            placeholder="ghp_..."
            value={config.githubToken ?? ''}
            onChange={(e) => update('githubToken', e.target.value)}
          />
          <span className="settings-field__hint">
            Required for PR indexing. Or set GITHUB_TOKEN env var.
          </span>
        </div>
        <div className="settings-field">
          <label className="settings-field__label">Repository (owner/repo)</label>
          <input
            className="input"
            placeholder="Auto-detected from git remote"
            value={config.githubRepo ?? ''}
            onChange={(e) => update('githubRepo', e.target.value)}
          />
        </div>
      </section>
    </div>
  );
};
