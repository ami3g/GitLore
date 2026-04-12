import { contextBridge, ipcRenderer } from 'electron';
import type { IPCEvents } from '../shared/ipc-types';

// ─── Typed API exposed to renderer via window.gitlore ───

const api = {
  // ─── Invoke (request/response) ───
  openFolder: () => ipcRenderer.invoke('gitlore:open-folder'),
  getStatus: (repoPath: string) => ipcRenderer.invoke('gitlore:status', repoPath),
  index: (repoPath: string, commitDepth?: number) =>
    ipcRenderer.invoke('gitlore:index', repoPath, commitDepth),
  indexCode: (repoPath: string) => ipcRenderer.invoke('gitlore:index-code', repoPath),
  indexPRs: (repoPath: string) => ipcRenderer.invoke('gitlore:index-prs', repoPath),
  query: (repoPath: string, question: string, topK?: number) =>
    ipcRenderer.invoke('gitlore:query', repoPath, question, topK),
  summarize: (repoPath: string) => ipcRenderer.invoke('gitlore:summarize', repoPath),
  clear: (repoPath: string) => ipcRenderer.invoke('gitlore:clear', repoPath),
  diagram: (repoPath: string, type: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('gitlore:diagram', repoPath, type, options),
  diagramSave: (repoPath: string, name: string, type: string, code: string) =>
    ipcRenderer.invoke('gitlore:diagram-save', repoPath, name, type, code),
  diagramList: (repoPath: string) =>
    ipcRenderer.invoke('gitlore:diagram-list', repoPath),
  diagramLoad: (repoPath: string, filename: string) =>
    ipcRenderer.invoke('gitlore:diagram-load', repoPath, filename),
  diagramDelete: (repoPath: string, filename: string) =>
    ipcRenderer.invoke('gitlore:diagram-delete', repoPath, filename),
  getConfig: () => ipcRenderer.invoke('gitlore:config-get'),
  setConfig: (key: string, value: string | number) =>
    ipcRenderer.invoke('gitlore:config-set', key, value),
  getTotalCommits: (repoPath: string) => ipcRenderer.invoke('gitlore:total-commits', repoPath),

  // ─── Events (main → renderer) ───
  on: <K extends keyof IPCEvents>(
    channel: K,
    callback: (data: IPCEvents[K]) => void,
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, data: IPCEvents[K]) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('gitlore', api);

export type GitLoreAPI = typeof api;
