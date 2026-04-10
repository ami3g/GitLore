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

const SYSTEM_PROMPT = `You are GitLore, a specialized Repository Historian. Your goal is to provide technical, high-density insights based on indexed git commits.

STRICT FORMATTING RULES:
1. Use ### for Date headers (e.g., ### March 10, 2026).
2. Use **Bold Title** for the main change in a commit.
3. Include the short hash as a clickable link: [hash](https://github.com).
4. Use Bullet points for technical "Why" and "How" details.
5. Group multiple commits from the same day under one date header.
6. Identify authors clearly.

CONVERSATION CONTEXT: Use the provided conversation history for continuity, but always prioritize the "Retrieved Snippets" for technical accuracy on the current question. If the snippets contradict previous discussion, trust the snippets.

TONE: Professional, concise, and developer-centric. Avoid "fluff" phrases like "The repository appears to be..." or "In summary..."`;

// Rough character budget — ~4 chars per token, leave room for the response
const MAX_PROMPT_CHARS = 24000; // ~6K tokens, safe for gpt-4o (128K) and smaller Ollama models (8K)

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

    const gitProcessor = new GitProcessor(repoPath);
    const store = this.getVectorStore(storePath);
    const embedding = this.getEmbeddingService(storePath);

    // Check if we can do an incremental index
    const meta = store.loadMeta();
    const isAlreadyIndexed = await store.isIndexed();
    let doFullIndex = true;

    if (meta?.lastIndexedHash && isAlreadyIndexed) {
      // Safety check: verify the hash still exists (survives rebase/reset)
      const hashValid = await gitProcessor.hashExists(meta.lastIndexedHash);

      if (!hashValid) {
        // History was rewritten — force a full rebuild
        onProgress?.('History rewritten (rebase/reset detected) — rebuilding', 0, 0);
        await store.clear();
        // doFullIndex stays true
      } else {
        // ─── Incremental: only new commits ───
        doFullIndex = false;
        onProgress?.('Checking for new commits', 0, 0);
        const newChunks = await gitProcessor.extractNewCommits(
          meta.lastIndexedHash,
          commitDepth,
          onProgress
        );

        if (newChunks.length === 0) {
          onProgress?.('Already up to date', 1, 1);
          return;
        }

        // Embed only the new chunks
        const texts = newChunks.map((c) => gitProcessor.toEmbeddingText(c));
        const embeddings = await embedding.embedBatch(texts, onProgress);

        // Append to existing table
        onProgress?.('Appending to vector database', 0, 1);
        await store.addRecords(newChunks, embeddings);

        // Update metadata with latest hash
        const latestHash = await gitProcessor.getLatestHash();
        if (latestHash) {
          store.saveMeta(latestHash);
        }
        onProgress?.(`Incremental index complete — ${newChunks.length} new chunks`, 1, 1);
      }
    }

    if (doFullIndex) {
      // ─── Full index (truly streaming: page → embed → write → discard) ───
      onProgress?.('Initializing Git processor', 0, commitDepth);

      const PAGE_SIZE = 200;   // commits per git-log page
      const WINDOW = 100;      // chunks per embed+write cycle
      let totalWritten = 0;
      let isFirstWrite = true;

      for await (const pageChunks of gitProcessor.extractPaged(commitDepth, PAGE_SIZE, onProgress)) {
        // Process each page in WINDOW-sized sub-batches
        for (let i = 0; i < pageChunks.length; i += WINDOW) {
          const window = pageChunks.slice(i, i + WINDOW);
          const texts = window.map((c) => gitProcessor.toEmbeddingText(c));
          const embeddings = await embedding.embedBatch(texts, (phase, cur, _tot) => {
            onProgress?.(phase, totalWritten + i + cur, commitDepth);
          });

          if (isFirstWrite) {
            onProgress?.('Storing in vector database', 0, commitDepth);
            await store.createTable(window, embeddings);
            isFirstWrite = false;
          } else {
            await store.addRecords(window, embeddings);
          }
          totalWritten += window.length;
        }
        // pageChunks is now eligible for GC — no accumulation
      }

      if (totalWritten === 0) {
        throw new Error('No commits found in this repository.');
      }

      // Save metadata for future incremental runs
      const latestHash = await gitProcessor.getLatestHash();
      if (latestHash) {
        store.saveMeta(latestHash);
      }
      onProgress?.('Indexing complete', totalWritten, totalWritten);
    }
  }

  // ─── Querying ───

  async query(
    question: string,
    onChunk?: StreamCallback,
    conversationHistory?: LLMMessage[]
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
    const messages = this.buildPrompt(question, results, conversationHistory);

    // Step 4: Send to LLM
    const provider = this.getLLMProvider();
    return provider.sendMessage(messages, onChunk);
  }

  // ─── Status & Cleanup ───

  async getStatus(): Promise<IndexStatus> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { indexed: false, commitCount: 0, lastIndexedAt: null, lastIndexedHash: null };
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

  /**
   * Summarize all commits between lastIndexedHash and HEAD.
   * "What's changed since I last looked?"
   */
  async summarizeRecent(onChunk?: StreamCallback): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder open.');
    }

    const repoPath = workspaceFolder.uri.fsPath;
    const storePath = this.getStorePath(repoPath);
    const store = this.getVectorStore(storePath);
    const meta = store.loadMeta();

    const gitProcessor = new GitProcessor(repoPath);
    const latestHash = await gitProcessor.getLatestHash();

    if (!latestHash) {
      throw new Error('No commits found in this repository.');
    }

    // Phase 1: Get lightweight TOC (commit messages + file stats)
    const sinceHash = (meta?.lastIndexedHash && meta.lastIndexedHash !== latestHash)
      ? meta.lastIndexedHash
      : null;
    const maxCommits = sinceHash ? 100 : 20;

    const toc = await gitProcessor.getCommitTOC(sinceHash, maxCommits);

    if (toc.length === 0) {
      throw new Error('No new commits to summarize.');
    }

    // Phase 2: Rank commits by complexity (lines changed — ignores noisy merges)
    const ranked = [...toc].sort((a, b) => b.linesChanged - a.linesChanged);

    // Pull full diffs only for the top 4 most complex commits
    const DETAIL_LIMIT = 4;
    const detailedHashes = new Set(ranked.slice(0, DETAIL_LIMIT).map((e) => e.hash));
    const detailedDiffs: Map<string, string> = new Map();

    for (const hash of detailedHashes) {
      try {
        const diff = await gitProcessor.getFullDiffForCommit(hash);
        // Trim individual diffs to keep total size manageable
        detailedDiffs.set(hash, diff.length > 4000 ? diff.slice(0, 4000) + '\n... [diff truncated]' : diff);
      } catch {
        // skip if diff fails
      }
    }

    // Phase 3: Build context — TOC for all, full diffs for complex ones
    const tocSection = toc
      .map((entry) => {
        const lines = [
          `[COMMIT: ${entry.hash.substring(0, 8)}] ${entry.author} | ${entry.date}`,
          `[MESSAGE]: ${entry.message}`,
          `[STAT]: ${entry.stat}`,
        ];
        return lines.join('\n');
      })
      .join('\n\n');

    const diffSection = Array.from(detailedDiffs.entries())
      .map(([hash, diff]) => `--- Detailed diff for ${hash.substring(0, 8)} ---\n${diff}`)
      .join('\n\n');

    const combined = `## Commit Table of Contents\n\n${tocSection}\n\n## Detailed Diffs (most complex changes)\n\n${diffSection}`;

    // Trim if too long for the LLM
    const trimmed = combined.length > MAX_PROMPT_CHARS
      ? combined.slice(0, MAX_PROMPT_CHARS) + '\n\n... [additional content truncated]'
      : combined;

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize the following recent commits for a standup update. Focus on what changed, why, and any patterns or themes across the changes:\n\n${trimmed}`,
      },
    ];

    const provider = this.getLLMProvider();
    return provider.sendMessage(messages, onChunk);
  }

  onConfigChanged(): void {
    // Reset LLM provider so it picks up new settings
    this.llmProvider = null;
  }

  // ─── Private Helpers ───

  private buildPrompt(question: string, results: SearchResult[], conversationHistory?: LLMMessage[]): LLMMessage[] {
    const contextSnippets = results
      .map((r, i) => {
        const c = r.chunk;
        const lines = [
          `--- Retrieved Snippet ${i + 1} (score: ${r.score.toFixed(4)}) ---`,
          `[COMMIT: ${c.hash.substring(0, 8)}] Author: ${c.author} | Date: ${c.date}`,
          `[MESSAGE]: ${c.message}`,
        ];
        if (c.filePath) {
          lines.push(`[FILE]: ${c.filePath}`);
        }
        if (c.filesChanged.length > 0) {
          lines.push(`[OTHER FILES]: ${c.filesChanged.join(', ')}`);
        }
        if (c.condensedDiff) {
          lines.push(`[DIFF]:\n${c.condensedDiff}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');

    const userMessage = `Here are the most relevant commits from the repository history:\n\n${contextSnippets}\n\n---\n\nQuestion: ${question}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Include conversation history, trimmed to fit token budget
    if (conversationHistory && conversationHistory.length > 0) {
      let recent = conversationHistory.slice(-10); // 5 exchanges = 10 messages

      // Calculate fixed cost: system prompt + current user message with snippets
      const fixedCost = SYSTEM_PROMPT.length + userMessage.length;
      let historyCost = recent.reduce((sum, m) => sum + m.content.length, 0);

      // Drop oldest messages until we fit the budget
      while (recent.length > 0 && fixedCost + historyCost > MAX_PROMPT_CHARS) {
        historyCost -= recent[0].content.length;
        recent = recent.slice(1);
      }

      messages.push(...recent);
    }

    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  private getLLMProvider(): LLMProvider {
    if (this.llmProvider) return this.llmProvider;

    const config = vscode.workspace.getConfiguration('gitlore');
    const providerType = config.get<string>('llmProvider', 'ollama');

    if (providerType === 'openai') {
      const model = config.get<string>('openaiModel', 'gpt-4o');
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
