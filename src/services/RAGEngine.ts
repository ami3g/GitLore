import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitProcessor, type ProgressCallback } from './GitProcessor';
import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';
import { OpenAIProvider } from './llm/OpenAIProvider';
import { OllamaProvider } from './llm/OllamaProvider';
import type { LLMProvider, StreamCallback } from './llm/LLMProvider';
import type { IndexStatus, LLMMessage, SearchResult } from '../types';

const SYSTEM_PROMPT = `You are Git-Lore, a knowledgeable Git historian and code archaeologist. Your role is to help developers understand WHY code changed by analyzing commit history.

When answering:
- Reference specific commit hashes (shortened to 8 chars) when citing evidence.
- Mention the author and date when relevant.
- Explain the reasoning behind changes based on commit messages and diffs.
- If the retrieved commits don't fully answer the question, say so honestly.
- Keep answers focused and concise.`;

export class RAGEngine {
  private context: vscode.ExtensionContext;
  private vectorStore: VectorStore | null = null;
  private embeddingService: EmbeddingService | null = null;
  private llmProvider: LLMProvider | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  // ─── Indexing ───

  async indexRepository(
    repoPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitlore');
    const commitDepth = config.get<number>('commitDepth', 1000);

    const storePath = this.getStorePath(repoPath);
    this.ensureDir(storePath);

    // Step 1: Extract & chunk commits
    onProgress?.('Initializing Git processor', 0, commitDepth);
    const gitProcessor = new GitProcessor(repoPath);
    const chunks = await gitProcessor.extractAndChunk(commitDepth, onProgress);

    if (chunks.length === 0) {
      throw new Error('No commits found in this repository.');
    }

    // Step 2: Generate embeddings
    const embedding = this.getEmbeddingService(storePath);
    const texts = chunks.map((c) => gitProcessor.toEmbeddingText(c));
    const embeddings = await embedding.embedBatch(texts, onProgress);

    // Step 3: Store in vector DB
    onProgress?.('Storing in vector database', 0, 1);
    const store = this.getVectorStore(storePath);
    await store.createTable(chunks, embeddings);
    onProgress?.('Indexing complete', 1, 1);
  }

  // ─── Querying ───

  async query(
    question: string,
    onChunk?: StreamCallback
  ): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder open.');
    }

    const storePath = this.getStorePath(workspaceFolder.uri.fsPath);
    const store = this.getVectorStore(storePath);

    const isIndexed = await store.isIndexed();
    if (!isIndexed) {
      throw new Error('Repository not indexed. Click "Index Repo" to get started.');
    }

    // Step 1: Embed the question
    const embedding = this.getEmbeddingService(storePath);
    const queryVector = await embedding.embed(question);

    // Step 2: Search for relevant commits
    const config = vscode.workspace.getConfiguration('gitlore');
    const topK = config.get<number>('topK', 5);
    const results = await store.search(queryVector, topK);

    // Step 3: Build context-aware prompt
    const messages = this.buildPrompt(question, results);

    // Step 4: Send to LLM
    const provider = this.getLLMProvider();
    return provider.sendMessage(messages, onChunk);
  }

  // ─── Status & Cleanup ───

  async getStatus(): Promise<IndexStatus> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { indexed: false, commitCount: 0, lastIndexedAt: null };
    }

    const storePath = this.getStorePath(workspaceFolder.uri.fsPath);
    const store = this.getVectorStore(storePath);
    return store.getStatus();
  }

  async clearIndex(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const storePath = this.getStorePath(workspaceFolder.uri.fsPath);
    const store = this.getVectorStore(storePath);
    await store.clear();
    this.vectorStore = null;
  }

  onConfigChanged(): void {
    // Reset LLM provider so it picks up new settings
    this.llmProvider = null;
  }

  // ─── Private Helpers ───

  private buildPrompt(question: string, results: SearchResult[]): LLMMessage[] {
    const contextSnippets = results
      .map((r, i) => {
        const c = r.chunk;
        return [
          `--- Snippet ${i + 1} (relevance score: ${r.score.toFixed(4)}) ---`,
          `Commit: ${c.hash.substring(0, 8)}`,
          `Author: ${c.author} | Date: ${c.date}`,
          `Message: ${c.message}`,
          c.filesChanged.length > 0 ? `Files: ${c.filesChanged.join(', ')}` : '',
          c.condensedDiff ? `Diff:\n${c.condensedDiff}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Here are the most relevant commits from the repository history:\n\n${contextSnippets}\n\n---\n\nQuestion: ${question}`,
      },
    ];
  }

  private getLLMProvider(): LLMProvider {
    if (this.llmProvider) return this.llmProvider;

    const config = vscode.workspace.getConfiguration('gitlore');
    const providerType = config.get<string>('llmProvider', 'ollama');

    if (providerType === 'openai') {
      const model = config.get<string>('openaiModel', 'gpt-4o-mini');
      this.llmProvider = new OpenAIProvider(
        model,
        async () => {
          const key = await this.context.secrets.get('gitlore.openaiApiKey');
          return key;
        }
      );
    } else {
      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('ollamaModel', 'llama3.2');
      this.llmProvider = new OllamaProvider(endpoint, model);
    }

    return this.llmProvider;
  }

  private getVectorStore(storePath: string): VectorStore {
    if (!this.vectorStore) {
      this.vectorStore = new VectorStore(path.join(storePath, 'db'));
    }
    return this.vectorStore;
  }

  private getEmbeddingService(storePath: string): EmbeddingService {
    if (!this.embeddingService) {
      this.embeddingService = new EmbeddingService(
        path.join(storePath, 'models')
      );
    }
    return this.embeddingService;
  }

  private getStorePath(repoPath: string): string {
    return path.join(repoPath, '.vscode', 'git-lore');
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
