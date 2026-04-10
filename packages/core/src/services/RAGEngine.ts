import * as path from 'path';
import * as fs from 'fs';
import { GitProcessor, type ProgressCallback } from './GitProcessor';
import { CodeIndexer } from './CodeIndexer';
import { GitHubService, type RepoScale } from './GitHubService';
import { classifyIntent, rerank } from './IntentRouter';
import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';
import { OpenAIProvider } from './llm/OpenAIProvider';
import { OllamaProvider } from './llm/OllamaProvider';
import type { LLMProvider, StreamCallback } from './llm/LLMProvider';
import type { IndexStatus, LLMMessage, SearchResult } from '../types';
import type { GitLoreConfig } from '../config';

const SYSTEM_PROMPT = `You are GitLore, a specialized Repository Historian with access to the current codebase, the full git commit history, and pull request / issue context.

DATA TYPES YOU RECEIVE:
• [COMMIT] — Historical git commits with diffs, authors, dates. Use for “when”, “why”, and “who” questions.
• [CODE] — Current source file snippets with file paths, languages, and line numbers. Use for “what does this code do”, “where is X defined”, and architecture questions.
• [PR] — Pull requests and linked issues. Use for feature context, review decisions, and linking changes to higher-level goals.

STRICT FORMATTING RULES:
1. Use ### for Date headers (e.g., ### March 10, 2026) when discussing commits.
2. Use **Bold Title** for the main change in a commit.
3. Include the short hash as a clickable link: [hash](https://github.com).
4. Use Bullet points for technical "Why" and "How" details.
5. Group multiple commits from the same day under one date header.
6. When referencing code, include the file path and line range.
7. Identify authors clearly.

CONVERSATION CONTEXT: Use the provided conversation history for continuity, but always prioritize the "Retrieved Snippets" for technical accuracy on the current question. If the snippets contradict previous discussion, trust the snippets.

TONE: Professional, concise, and developer-centric. Avoid "fluff" phrases like "The repository appears to be..." or "In summary..."`;

// Rough character budget — ~4 chars per token, leave room for the response
const MAX_PROMPT_CHARS = 24000;

export class RAGEngine {
  private config: GitLoreConfig;
  private vectorStore: VectorStore | null = null;
  private embeddingService: EmbeddingService | null = null;
  private llmProvider: LLMProvider | null = null;

  constructor(config: GitLoreConfig) {
    this.config = config;
  }

  /** Update config at runtime (e.g. when VS Code settings change) */
  updateConfig(config: Partial<GitLoreConfig>): void {
    this.config = { ...this.config, ...config };
    this.llmProvider = null;
  }

  // ─── Indexing ───

  async indexRepository(
    repoPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const commitDepth = this.config.commitDepth;

    const storePath = this.getStorePath(repoPath);
    this.ensureDir(storePath);

    const gitProcessor = new GitProcessor(repoPath);
    const store = this.getVectorStore(storePath);
    const embedding = this.getEmbeddingService(storePath);

    const meta = store.loadMeta();
    const isAlreadyIndexed = await store.isIndexed();
    let doFullIndex = true;

    if (meta?.lastIndexedHash && isAlreadyIndexed) {
      const hashValid = await gitProcessor.hashExists(meta.lastIndexedHash);

      if (!hashValid) {
        onProgress?.('History rewritten (rebase/reset detected) — rebuilding', 0, 0);
        await store.clear();
      } else {
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

        const texts = newChunks.map((c) => gitProcessor.toEmbeddingText(c));
        const embeddings = await embedding.embedBatch(texts, onProgress);

        onProgress?.('Appending to vector database', 0, 1);
        await store.addRecords(newChunks, embeddings);

        const latestHash = await gitProcessor.getLatestHash();
        if (latestHash) {
          store.saveMeta(latestHash);
        }
        onProgress?.(`Incremental index complete — ${newChunks.length} new chunks`, 1, 1);
      }
    }

    if (doFullIndex) {
      onProgress?.('Initializing Git processor', 0, commitDepth);

      const PAGE_SIZE = 200;
      const WINDOW = 100;
      let totalWritten = 0;
      let isFirstWrite = true;

      for await (const pageChunks of gitProcessor.extractPaged(commitDepth, PAGE_SIZE, onProgress)) {
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
      }

      if (totalWritten === 0) {
        throw new Error('No commits found in this repository.');
      }

      const latestHash = await gitProcessor.getLatestHash();
      if (latestHash) {
        store.saveMeta(latestHash);
      }
      onProgress?.('Indexing complete', totalWritten, totalWritten);
    }
  }

  // ─── Code File Indexing ───

  async indexCode(
    repoPath: string,
    onProgress?: ProgressCallback,
    scale: RepoScale = 'small'
  ): Promise<{ changedFiles: number; totalChunks: number }> {
    const storePath = this.getStorePath(repoPath);
    this.ensureDir(storePath);

    const codeIndexer = new CodeIndexer(repoPath);
    const store = this.getVectorStore(storePath);
    const embedding = this.getEmbeddingService(storePath);

    const hierarchical = scale === 'large';

    onProgress?.('Scanning code files', 0, 0);

    // Find deleted files and remove their records
    const deletedFiles = await codeIndexer.getDeletedFiles(storePath);
    if (deletedFiles.length > 0) {
      onProgress?.('Removing deleted files', 0, deletedFiles.length);
      await store.removeCodeFiles(deletedFiles);
    }

    // Index changed/new files — hierarchical mode adds file summaries for large repos
    const { chunks, meta, changedFiles } = await codeIndexer.indexAll(storePath, onProgress, hierarchical);

    if (chunks.length === 0) {
      // No changes — just save updated meta
      codeIndexer.saveMeta(storePath, meta);
      onProgress?.('Code index up to date', 1, 1);
      return { changedFiles: 0, totalChunks: 0 };
    }

    onProgress?.('Embedding code chunks', 0, chunks.length);
    const texts = chunks.map((c) => codeIndexer.toEmbeddingText(c));

    // Embed in 100-chunk windows
    const WINDOW = 100;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += WINDOW) {
      const windowTexts = texts.slice(i, i + WINDOW);
      const windowEmbeddings = await embedding.embedBatch(windowTexts, (phase, cur, _tot) => {
        onProgress?.('Embedding code', i + cur, texts.length);
      });
      allEmbeddings.push(...windowEmbeddings);
    }

    // Upsert: delete old records for changed files, insert new ones
    onProgress?.('Updating code vector database', 0, 1);
    await store.upsertCodeFiles(changedFiles, chunks, allEmbeddings);

    // For large repos, create HNSW-SQ indices to compress vectors and speed up search.
    // createIndex runs on LanceDB's native thread pool (via NAPI), so the JS event
    // loop stays free. We yield between tables as an extra safety measure.
    if (scale === 'large') {
      const { indexed } = await store.ensureSQIndices((message) => {
        onProgress?.(message, 0, 1);
      });
      if (indexed.length > 0) {
        onProgress?.(`Optimized SQ indices: ${indexed.join(', ')}`, 1, 1);
      }
    }

    codeIndexer.saveMeta(storePath, meta);
    const summaryCount = chunks.filter((c) => c.isSummary).length;
    const label = hierarchical
      ? `Code index complete — ${changedFiles.length} files, ${chunks.length} chunks (${summaryCount} summaries)`
      : `Code index complete — ${changedFiles.length} files, ${chunks.length} chunks`;
    onProgress?.(label, 1, 1);

    return { changedFiles: changedFiles.length, totalChunks: chunks.length };
  }

  // ─── PR/Issue Indexing ───

  async indexPRs(
    repoPath: string,
    onProgress?: ProgressCallback
  ): Promise<{ prCount: number }> {
    const storePath = this.getStorePath(repoPath);
    this.ensureDir(storePath);

    const token = this.config.getGitHubToken
      ? await this.config.getGitHubToken()
      : undefined;

    const ghService = new GitHubService();
    await ghService.init(token);

    // Detect or use configured repo
    let parsed = this.config.githubRepo
      ? ghService.parseRepoString(this.config.githubRepo)
      : null;

    if (!parsed) {
      parsed = await ghService.detectRepo(repoPath);
    }

    if (!parsed) {
      onProgress?.('No GitHub remote detected — skipping PR indexing', 0, 0);
      return { prCount: 0 };
    }

    // Graceful no-token: warn but still try (works for public repos)
    if (!ghService.hasToken) {
      onProgress?.('No GitHub token set — using unauthenticated access (60 req/hr limit)', 0, 0);
    }

    // Detect repo scale and adapt strategy
    const scale = await ghService.detectScale(repoPath);
    if (scale === 'large') {
      onProgress?.('Large repository detected — sequential PR fetching, full coverage', 0, 0);
    }

    const store = this.getVectorStore(storePath);
    const embedding = this.getEmbeddingService(storePath);

    // Incremental: only fetch PRs updated after last fetch
    const prMeta = ghService.loadMeta(storePath);
    const since = prMeta?.lastFetchedAt;

    onProgress?.('Fetching PRs from GitHub', 0, 0);
    const chunks = await ghService.fetchPRs(parsed.owner, parsed.repo, since, onProgress, scale);

    if (chunks.length === 0) {
      onProgress?.('PR index up to date', 1, 1);
      ghService.saveMeta(storePath);
      return { prCount: await store.getPRCount() };
    }

    onProgress?.('Embedding PR data', 0, chunks.length);
    const texts = chunks.map((c) => ghService.toEmbeddingText(c));
    const embeddings = await embedding.embedBatch(texts, onProgress);

    const prTableExists = (await store.getPRCount()) > 0;
    if (prTableExists && since) {
      // Incremental: append new/updated PRs
      await store.addPRRecords(chunks, embeddings);
    } else {
      // Full: create fresh table
      await store.createPRTable(chunks, embeddings);
    }

    ghService.saveMeta(storePath);
    onProgress?.(`Indexed ${chunks.length} PRs`, chunks.length, chunks.length);
    return { prCount: chunks.length };
  }

  // ─── Querying ───

  async query(
    repoPath: string,
    question: string,
    onChunk?: StreamCallback,
    conversationHistory?: LLMMessage[],
    /** Optional: directory prefix of the active file (for large-repo scoping) */
    activeDirectory?: string
  ): Promise<string> {
    const storePath = this.getStorePath(repoPath);
    const store = this.getVectorStore(storePath);

    const isIndexed = await store.isIndexed();
    if (!isIndexed) {
      throw new Error('Repository not indexed. Run "Index Repository" to get started.');
    }

    // Detect scale for query strategy
    const ghService = new GitHubService();
    const scale = await ghService.detectScale(repoPath);

    const embedding = this.getEmbeddingService(storePath);
    const queryVector = await embedding.embed(question);

    // ─── 1. Classify intent ───
    const weights = classifyIntent(question);

    // ─── 2. Search all 3 tables with intent-aware breadth ───
    // Search broadly, but the greedy filler limits what actually enters the prompt
    const baseTopK = scale === 'large' ? 10 : this.config.topK;

    // Code always searches wide (many more chunks than commits)
    const codeTopK = Math.max(baseTopK * 4, 20);
    // Commits/PRs scale up for historical/debugging intents
    const histBoost = (weights.intent === 'historical' || weights.intent === 'debugging') ? 2 : 1;
    const commitTopK = Math.max(baseTopK * histBoost * 2, 10);
    const prTopK = Math.max(baseTopK * histBoost, 5);

    const commitResults = await store.search(queryVector, commitTopK);
    const prResults = await store.searchPR(queryVector, prTopK);

    let codeResults: SearchResult[];
    if (scale === 'large' && activeDirectory) {
      const scopedTopK = Math.ceil(codeTopK * 0.6);
      const globalTopK = codeTopK - scopedTopK;
      let scoped = await store.searchCodeScoped(queryVector, scopedTopK, activeDirectory);

      if (scoped.length === 0 && activeDirectory.includes('/')) {
        const parent = activeDirectory.substring(0, activeDirectory.lastIndexOf('/'));
        if (parent) {
          scoped = await store.searchCodeScoped(queryVector, scopedTopK, parent);
        }
      }

      if (scoped.length === 0) {
        codeResults = await store.searchCode(queryVector, codeTopK);
      } else {
        const global = await store.searchCode(queryVector, globalTopK);
        codeResults = [...scoped, ...global];
      }
    } else {
      codeResults = await store.searchCode(queryVector, codeTopK);
    }

    // ─── 3. Rerank with intent weights ───
    const allCandidates = rerank(
      [...commitResults, ...codeResults, ...prResults],
      weights
    );

    // For overview intent, boost README/docs/config files
    if (weights.intent === 'overview') {
      const DOC_FILES = /readme|package\.json|index\.[tj]sx?$|app\.[tj]sx?$|main\.[tj]sx?$|\.md$/i;
      for (const r of allCandidates) {
        if (r.type === 'code' && DOC_FILES.test(r.chunk.filePath)) {
          r.score *= 0.5;
        }
      }
      allCandidates.sort((a, b) => a.score - b.score);
    }

    // ─── 4. Small-to-Big expansion ───
    // For the top N unique code files, fetch ALL their chunks to give the LLM
    // full file context instead of isolated 256-line windows.
    // How many files to expand depends on intent:
    //   overview → expand top 3 files (README, main entry, etc.)
    //   implementation/general → expand top 3 files (see the whole module)
    //   historical/debugging → expand top 1 file (focus on the specific area)
    const EXPAND_FILES = (weights.intent === 'historical' || weights.intent === 'debugging') ? 1 : 3;
    const MAX_EXPAND_CHARS = 3000; // cap per expanded file

    // Find unique file paths from top code results
    const topCodeFiles: string[] = [];
    const seenFiles = new Set<string>();
    for (const r of allCandidates) {
      if (r.type === 'code' && !seenFiles.has(r.chunk.filePath)) {
        seenFiles.add(r.chunk.filePath);
        topCodeFiles.push(r.chunk.filePath);
        if (topCodeFiles.length >= EXPAND_FILES) break;
      }
    }

    // Fetch all chunks for those files and build expanded content
    const expandedFiles = new Map<string, string>();
    if (topCodeFiles.length > 0) {
      const allFileChunks = await store.getCodeChunksForFiles(topCodeFiles);
      for (const fp of topCodeFiles) {
        const fileChunks = allFileChunks
          .filter((c) => c.filePath === fp && !c.isSummary)
          .sort((a, b) => a.startLine - b.startLine);
        if (fileChunks.length === 0) continue;

        // Reconstruct file content from ordered chunks (deduplicate overlapping lines)
        let combined = fileChunks[0].content;
        for (let i = 1; i < fileChunks.length; i++) {
          const prev = fileChunks[i - 1];
          const curr = fileChunks[i];
          // If chunks overlap, skip the overlapping portion
          if (curr.startLine <= prev.endLine) {
            const overlapLines = prev.endLine - curr.startLine + 1;
            const lines = curr.content.split('\n');
            combined += '\n' + lines.slice(overlapLines).join('\n');
          } else {
            combined += '\n' + curr.content;
          }
        }

        // Truncate if too long
        if (combined.length > MAX_EXPAND_CHARS) {
          combined = combined.slice(0, MAX_EXPAND_CHARS) + '\n... [file truncated]';
        }
        expandedFiles.set(fp, combined);
      }
    }

    // ─── 5. Greedy token filling with diversity ───
    const snippetBudget = MAX_PROMPT_CHARS * 0.6;
    let usedChars = 0;
    const merged: SearchResult[] = [];
    const usedIndices = new Set<number>();
    const expandedFilesUsed = new Set<string>();

    // Intent-aware seed: code first for overview/impl/general, commits first for hist/debug
    const commitFirst = weights.intent === 'historical' || weights.intent === 'debugging';
    const seedOrder = commitFirst
      ? [allCandidates.findIndex((r) => r.type === 'commit'), allCandidates.findIndex((r) => r.type === 'code')]
      : [allCandidates.findIndex((r) => r.type === 'code'), allCandidates.findIndex((r) => r.type === 'commit')];

    for (const seedIdx of seedOrder) {
      if (seedIdx >= 0) {
        const result = allCandidates[seedIdx];
        const charCost = this.estimateSnippetChars(result);
        merged.push(result);
        usedChars += charCost;
        usedIndices.add(seedIdx);
        if (result.type === 'code') expandedFilesUsed.add(result.chunk.filePath);
      }
    }

    // Fill greedily; skip duplicate file chunks if we already have the expanded version
    for (let i = 0; i < allCandidates.length; i++) {
      if (usedIndices.has(i)) continue;
      const result = allCandidates[i];

      // If this code chunk's file was expanded, skip individual chunks for it
      if (result.type === 'code' && expandedFilesUsed.has(result.chunk.filePath)) continue;

      const charCost = this.estimateSnippetChars(result);
      if (usedChars + charCost > snippetBudget && merged.length > 0) break;
      merged.push(result);
      usedChars += charCost;
      if (result.type === 'code') expandedFilesUsed.add(result.chunk.filePath);
    }

    // ─── 6. Project file tree for broad queries ───
    // For overview/general intent, include a compact file tree so the LLM
    // knows about ALL features, not just those that ranked high in vector search.
    let projectTree: string | undefined;
    if (weights.intent === 'overview' || weights.intent === 'general') {
      const allPaths = await store.getAllUniqueFilePaths();
      if (allPaths.length > 0) {
        projectTree = this.buildFileTree(allPaths);
      }
    }

    const messages = this.buildPrompt(question, merged, conversationHistory, expandedFiles, projectTree);

    const provider = this.getLLMProvider();
    return provider.sendMessage(messages, onChunk);
  }

  // ─── Status & Cleanup ───

  async getStatus(repoPath: string): Promise<IndexStatus> {
    const storePath = this.getStorePath(repoPath);
    const store = this.getVectorStore(storePath);
    return store.getStatus();
  }

  async clearIndex(repoPath: string): Promise<void> {
    const storePath = this.getStorePath(repoPath);
    const store = this.getVectorStore(storePath);
    await store.clear();
    // Also remove PR meta
    const prMetaPath = path.join(storePath, 'pr-meta.json');
    try { fs.unlinkSync(prMetaPath); } catch { /* OK */ }
    // Also remove code meta
    const codeMetaPath = path.join(storePath, 'code-meta.json');
    try { fs.unlinkSync(codeMetaPath); } catch { /* OK */ }
    this.vectorStore = null;
  }

  async summarizeRecent(repoPath: string, onChunk?: StreamCallback): Promise<string> {
    const storePath = this.getStorePath(repoPath);
    const store = this.getVectorStore(storePath);
    const meta = store.loadMeta();

    const gitProcessor = new GitProcessor(repoPath);
    const latestHash = await gitProcessor.getLatestHash();

    if (!latestHash) {
      throw new Error('No commits found in this repository.');
    }

    const sinceHash = (meta?.lastIndexedHash && meta.lastIndexedHash !== latestHash)
      ? meta.lastIndexedHash
      : null;
    const maxCommits = sinceHash ? 100 : 20;

    const toc = await gitProcessor.getCommitTOC(sinceHash, maxCommits);

    if (toc.length === 0) {
      throw new Error('No new commits to summarize.');
    }

    const ranked = [...toc].sort((a, b) => b.linesChanged - a.linesChanged);

    const DETAIL_LIMIT = 4;
    const detailedHashes = new Set(ranked.slice(0, DETAIL_LIMIT).map((e) => e.hash));
    const detailedDiffs: Map<string, string> = new Map();

    for (const hash of detailedHashes) {
      try {
        const diff = await gitProcessor.getFullDiffForCommit(hash);
        detailedDiffs.set(hash, diff.length > 4000 ? diff.slice(0, 4000) + '\n... [diff truncated]' : diff);
      } catch {
        // skip
      }
    }

    const tocSection = toc
      .map((entry) => [
        `[COMMIT: ${entry.hash.substring(0, 8)}] ${entry.author} | ${entry.date}`,
        `[MESSAGE]: ${entry.message}`,
        `[STAT]: ${entry.stat}`,
      ].join('\n'))
      .join('\n\n');

    const diffSection = Array.from(detailedDiffs.entries())
      .map(([hash, diff]) => `--- Detailed diff for ${hash.substring(0, 8)} ---\n${diff}`)
      .join('\n\n');

    const combined = `## Commit Table of Contents\n\n${tocSection}\n\n## Detailed Diffs (most complex changes)\n\n${diffSection}`;

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
    this.llmProvider = null;
  }

  // ─── Private Helpers ───

  private buildPrompt(
    question: string,
    results: SearchResult[],
    conversationHistory?: LLMMessage[],
    expandedFiles?: Map<string, string>,
    projectTree?: string
  ): LLMMessage[] {
    // Track which files have already been rendered via expanded content
    const renderedExpanded = new Set<string>();

    const contextSnippets = results
      .map((r, i) => {
        if (r.type === 'commit') {
          const c = r.chunk;
          const lines = [
            `--- Retrieved Snippet ${i + 1} (score: ${r.score.toFixed(4)}) [COMMIT] ---`,
            `[COMMIT: ${c.hash.substring(0, 8)}] Author: ${c.author} | Date: ${c.date}`,
            `[MESSAGE]: ${c.message}`,
          ];
          if (c.filePath) lines.push(`[FILE]: ${c.filePath}`);
          if (c.filesChanged.length > 0) lines.push(`[OTHER FILES]: ${c.filesChanged.join(', ')}`);
          if (c.condensedDiff) lines.push(`[DIFF]:\n${c.condensedDiff}`);
          return lines.join('\n');
        } else if (r.type === 'pr') {
          const c = r.chunk;
          const lines = [
            `--- Retrieved Snippet ${i + 1} (score: ${r.score.toFixed(4)}) [PR] ---`,
            `[PR #${c.prNumber}] ${c.title} | State: ${c.state} | Author: ${c.author}`,
          ];
          if (c.description) lines.push(`[DESCRIPTION]: ${c.description.slice(0, 500)}`);
          if (c.linkedIssues) lines.push(`[LINKED ISSUES]: ${c.linkedIssues}`);
          if (c.mergedAt) lines.push(`[MERGED]: ${c.mergedAt}`);
          if (c.resolvedBy) lines.push(`[MERGE COMMIT]: ${c.resolvedBy.substring(0, 8)}`);
          return lines.join('\n');
        } else {
          const c = r.chunk;

          // Small-to-Big: if we have expanded content for this file, render it once
          if (expandedFiles?.has(c.filePath) && !renderedExpanded.has(c.filePath)) {
            renderedExpanded.add(c.filePath);
            const expanded = expandedFiles.get(c.filePath)!;
            const lines = [
              `--- Retrieved Snippet ${i + 1} (score: ${r.score.toFixed(4)}) [CODE – FULL FILE] ---`,
              `[CODE] File: ${c.filePath} | Language: ${c.language}`,
              expanded,
            ];
            return lines.join('\n');
          }

          // Already rendered expanded version of this file — skip duplicate chunk
          if (renderedExpanded.has(c.filePath)) return null;

          const truncatedContent = c.content.length > 3000 ? c.content.slice(0, 3000) + '\n... [truncated]' : c.content;
          const lines = [
            `--- Retrieved Snippet ${i + 1} (score: ${r.score.toFixed(4)}) [CODE] ---`,
            `[CODE] File: ${c.filePath} | Language: ${c.language} | Lines ${c.startLine}-${c.endLine}`,
            truncatedContent,
          ];
          return lines.join('\n');
        }
      })
      .filter(Boolean)
      .join('\n\n');

    const treePreamble = projectTree
      ? `## Project File Structure\n\nThe following is a complete listing of source files in this repository. Use this to identify features, modules, and capabilities — even those not directly retrieved above:\n\n${projectTree}\n\n---\n\n`
      : '';

    const userMessage = `Here are the most relevant snippets from the repository:\n\n${contextSnippets}\n\n---\n\n${treePreamble}Question: ${question}`;

    // Hard safety cap: if the prompt is still too large, truncate the user message
    const maxUserChars = MAX_PROMPT_CHARS - SYSTEM_PROMPT.length - 200;
    const safeUserMessage = userMessage.length > maxUserChars
      ? userMessage.slice(0, maxUserChars) + '\n\n... [context truncated to fit token budget]'
      : userMessage;

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    if (conversationHistory && conversationHistory.length > 0) {
      let recent = conversationHistory.slice(-10);
      const fixedCost = SYSTEM_PROMPT.length + safeUserMessage.length;
      let historyCost = recent.reduce((sum, m) => sum + m.content.length, 0);

      while (recent.length > 0 && fixedCost + historyCost > MAX_PROMPT_CHARS) {
        historyCost -= recent[0].content.length;
        recent = recent.slice(1);
      }

      messages.push(...recent);
    }

    messages.push({ role: 'user', content: safeUserMessage });
    return messages;
  }

  private buildFileTree(paths: string[]): string {
    // Build a compact indented tree from flat file paths
    // Cap at 4000 chars to leave room for code context
    const MAX_TREE_CHARS = 4000;
    const tree: Record<string, unknown> = {};

    for (const p of paths) {
      const parts = p.split('/');
      let node = tree;
      for (const part of parts) {
        if (!node[part]) node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
    }

    const lines: string[] = [];
    const render = (node: Record<string, unknown>, indent: string) => {
      const entries = Object.keys(node).sort();
      for (const name of entries) {
        const children = node[name] as Record<string, unknown>;
        const isDir = Object.keys(children).length > 0;
        lines.push(`${indent}${isDir ? name + '/' : name}`);
        if (isDir) render(children, indent + '  ');
      }
    };

    render(tree, '');
    const result = lines.join('\n');
    return result.length > MAX_TREE_CHARS
      ? result.slice(0, MAX_TREE_CHARS) + '\n... [tree truncated]'
      : result;
  }

  private getLLMProvider(): LLMProvider {
    if (this.llmProvider) return this.llmProvider;

    if (this.config.llmProvider === 'openai') {
      this.llmProvider = new OpenAIProvider(this.config.openaiModel, this.config.getApiKey);
    } else {
      this.llmProvider = new OllamaProvider(this.config.ollamaEndpoint, this.config.ollamaModel);
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
      this.embeddingService = new EmbeddingService(path.join(storePath, 'models'));
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

  /** Estimate the character cost of a search result when rendered in the prompt. */
  private estimateSnippetChars(result: SearchResult): number {
    if (result.type === 'commit') {
      const c = result.chunk;
      return 80 + c.message.length + c.condensedDiff.length + c.filesChanged.join(', ').length;
    } else if (result.type === 'code') {
      return 80 + result.chunk.content.length;
    } else {
      const c = result.chunk;
      return 80 + c.title.length + Math.min(c.description.length, 500) + c.linkedIssues.length;
    }
  }
}
