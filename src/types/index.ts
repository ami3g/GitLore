// ─── Commit & Indexing ───

export interface CommitChunk {
  hash: string;
  author: string;
  date: string;
  message: string;
  condensedDiff: string;
  filesChanged: string[];
}

export interface IndexStatus {
  indexed: boolean;
  commitCount: number;
  lastIndexedAt: string | null;
}

// ─── Search ───

export interface SearchResult {
  chunk: CommitChunk;
  score: number;
}

// ─── LLM ───

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

// ─── Chat UI ───

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
}

// ─── Webview ↔ Extension Message Protocol ───

export type WebviewToExtensionMessage =
  | { command: 'query'; payload: { text: string } }
  | { command: 'index' }
  | { command: 'getStatus' }
  | { command: 'setApiKey'; payload: { key: string } };

export type ExtensionToWebviewMessage =
  | { command: 'response'; payload: { id: string; content: string } }
  | { command: 'streamChunk'; payload: { id: string; content: string } }
  | { command: 'streamEnd'; payload: { id: string } }
  | { command: 'indexProgress'; payload: { phase: string; current: number; total: number } }
  | { command: 'indexComplete'; payload: IndexStatus }
  | { command: 'status'; payload: IndexStatus }
  | { command: 'error'; payload: { message: string } };
