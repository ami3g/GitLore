// ─── Commit & Indexing ───

export interface CommitChunk {
  hash: string;
  author: string;
  date: string;
  message: string;
  filePath: string;        // the specific file this chunk describes
  condensedDiff: string;   // diff for just this file
  filesChanged: string[];  // all files in the parent commit (context)
}

// ─── Code File Indexing ───

export interface CodeChunk {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  /** True for file-level summary chunks (hierarchical indexing for large repos) */
  isSummary?: boolean;
  /** Function/method names defined in this chunk's line range */
  functions?: string[];
  /** Class names defined in this chunk's line range */
  classes?: string[];
  /** Import sources referenced in this chunk's line range */
  imports?: string[];
  /** Export names in this chunk's line range */
  exports?: string[];
}

// ─── PR/Issue Context ───

export interface PRChunk {
  prNumber: number;
  title: string;
  description: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  mergedBy: string;
  createdAt: string;
  mergedAt: string;
  linkedIssues: string;     // comma-separated "Title (#N)" entries
  resolvedBy: string;       // merge commit SHA or empty
}

// ─── AST / Call Graph ───

export interface SymbolInfo {
  name: string;
  startLine: number;
  endLine: number;
  /** For functions: parameter names (e.g. ["req", "res"]) */
  params?: string[];
  /** For classes: method names */
  methods?: string[];
}

export interface ImportInfo {
  /** The module/file being imported (e.g. "./utils", "express") */
  source: string;
  /** Named imports (e.g. ["Router", "Request"]) */
  names: string[];
  /** Line number of the import statement */
  line: number;
}

export interface ExportInfo {
  /** Exported symbol name */
  name: string;
  /** Line number */
  line: number;
}

export interface CallSite {
  /** Name of the calling function (or "<module>" for top-level) */
  caller: string;
  /** Name of the called function/method */
  callee: string;
  /** Line number of the call */
  line: number;
}

export interface FileSymbols {
  filePath: string;
  language: string;
  functions: SymbolInfo[];
  classes: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  callSites: CallSite[];
}

export interface CallEdge {
  callerFile: string;
  callerName: string;
  calleeFile: string;
  calleeName: string;
  line: number;
  /** 'call' for static call graph edges, 'co-change' for evolutionary coupling */
  edgeType?: 'call' | 'co-change';
  /** For co-change edges: recency-decayed coupling score (higher = stronger + more recent) */
  weight?: number;
  /** For co-change edges: raw number of co-occurring commits (before decay) */
  rawCount?: number;
  /** For co-change edges: hash of the most recent commit that co-changed these files */
  latestCommitHash?: string;
  /** For co-change edges: ISO date of the most recent co-change commit */
  latestCommitDate?: string;
  /** For co-change edges: hash of the earliest commit that co-changed these files */
  earliestCommitHash?: string;
  /** For co-change edges: ISO date of the earliest co-change commit */
  earliestCommitDate?: string;
}

export interface IndexStatus {
  indexed: boolean;
  commitCount: number;
  codeFileCount: number;
  prCount: number;
  lastIndexedAt: string | null;
  lastIndexedHash: string | null;
}

// ─── Search ───

export interface CommitSearchResult {
  type: 'commit';
  chunk: CommitChunk;
  score: number;
}

export interface CodeSearchResult {
  type: 'code';
  chunk: CodeChunk;
  score: number;
}

export interface PRSearchResult {
  type: 'pr';
  chunk: PRChunk;
  score: number;
}

export type SearchResult = CommitSearchResult | CodeSearchResult | PRSearchResult;

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
  | { command: 'summarize' }
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
