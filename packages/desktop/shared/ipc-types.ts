// ─── IPC Channel Definitions ───
// Shared between main, preload, and renderer.
// This file lives in shared/ so both tsconfigs can access it.

import type { IndexStatus } from '@gitlore/core';

// ─── Renderer → Main (invoke) ───

export interface IPCChannels {
  'gitlore:open-folder': () => Promise<string | null>;
  'gitlore:status': (repoPath: string) => Promise<IndexStatus>;
  'gitlore:index': (repoPath: string, commitDepth?: number) => Promise<void>;
  'gitlore:index-code': (repoPath: string) => Promise<{ changedFiles: number; totalChunks: number }>;
  'gitlore:index-prs': (repoPath: string) => Promise<{ prCount: number }>;
  'gitlore:query': (repoPath: string, question: string, topK?: number) => Promise<string>;
  'gitlore:summarize': (repoPath: string) => Promise<string>;
  'gitlore:clear': (repoPath: string) => Promise<void>;
  'gitlore:diagram': (repoPath: string, type: DiagramType, options?: DiagramOptions) => Promise<string>;
  'gitlore:diagram-save': (repoPath: string, name: string, type: DiagramType, code: string) => Promise<void>;
  'gitlore:diagram-list': (repoPath: string) => Promise<SavedDiagram[]>;
  'gitlore:diagram-load': (repoPath: string, filename: string) => Promise<string>;
  'gitlore:diagram-delete': (repoPath: string, filename: string) => Promise<void>;
  'gitlore:config-get': () => Promise<DesktopConfig>;
  'gitlore:config-set': (key: string, value: string | number) => Promise<void>;
  'gitlore:total-commits': (repoPath: string) => Promise<number>;
}

// ─── Main → Renderer (events) ───

export interface IPCEvents {
  'gitlore:stream-chunk': { id: string; content: string };
  'gitlore:stream-end': { id: string };
  'gitlore:index-progress': { phase: string; current: number; total: number };
  'gitlore:index-complete': IndexStatus;
  'gitlore:search-hits': { chunkIds: string[] };
  'gitlore:answer-used': { chunkIds: string[] };
  'gitlore:error': { message: string };
}

// ─── Supporting Types ───

export type DiagramType = 'architecture' | 'callgraph' | 'commits' | 'prs';

export interface DiagramOptions {
  entryFile?: string;
  entryFunction?: string;
  limit?: number;
}

export interface SavedDiagram {
  filename: string;
  name: string;
  type: DiagramType;
  createdAt: string;
}

export interface DesktopConfig {
  llmProvider: 'openai' | 'ollama';
  ollamaEndpoint: string;
  ollamaModel: string;
  openaiModel: string;
  commitDepth: number;
  topK: number;
  openaiApiKey?: string;
  githubToken?: string;
  githubRepo?: string;
}
