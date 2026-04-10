// ─── Core Config (replaces vscode.ExtensionContext coupling) ───

export interface GitLoreConfig {
  /** Number of commits to index from history */
  commitDepth: number;
  /** Number of top-K results to retrieve per query */
  topK: number;
  /** LLM provider to use */
  llmProvider: 'openai' | 'ollama';
  /** Ollama server endpoint URL */
  ollamaEndpoint: string;
  /** Ollama model name */
  ollamaModel: string;
  /** OpenAI model name */
  openaiModel: string;
  /** Callback to retrieve the OpenAI API key (from SecretStorage, env var, etc.) */
  getApiKey: () => Promise<string | undefined>;
  /** Callback to retrieve a GitHub personal access token (optional — for PR/issue indexing) */
  getGitHubToken?: () => Promise<string | undefined>;
  /** GitHub owner/repo override (auto-detected from git remote if not set) */
  githubRepo?: string;
}

export const DEFAULT_CONFIG: GitLoreConfig = {
  commitDepth: 1000,
  topK: 5,
  llmProvider: 'ollama',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openaiModel: 'gpt-4o',
  getApiKey: async () => undefined,
};
