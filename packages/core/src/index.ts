// ─── Core Engine ───
export { RAGEngine } from './services/RAGEngine';
export { GitProcessor, type ProgressCallback } from './services/GitProcessor';
export { CodeIndexer } from './services/CodeIndexer';
export { GitHubService, type RepoScale } from './services/GitHubService';
export { classifyIntent, rerank, type QueryIntent, type IntentWeights } from './services/IntentRouter';
export { EmbeddingService } from './services/EmbeddingService';
export { VectorStore } from './services/VectorStore';
export { ASTService } from './services/ASTService';
export { CallGraphService } from './services/CallGraphService';
export { MermaidService } from './services/MermaidService';

// ─── LLM Providers ───
export { OpenAIProvider } from './services/llm/OpenAIProvider';
export { OllamaProvider } from './services/llm/OllamaProvider';
export type { LLMProvider, StreamCallback } from './services/llm/LLMProvider';

// ─── Config ───
export { DEFAULT_CONFIG, type GitLoreConfig } from './config';

// ─── Types ───
export type {
  CommitChunk,
  CodeChunk,
  PRChunk,
  IndexStatus,
  SearchResult,
  CommitSearchResult,
  CodeSearchResult,
  PRSearchResult,
  LLMRole,
  LLMMessage,
  ChatMessageRole,
  ChatMessage,
  SymbolInfo,
  ImportInfo,
  ExportInfo,
  CallSite,
  FileSymbols,
  CallEdge,
} from './types';

// Re-export webview message types (used by vscode package)
export type {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
} from './types';
