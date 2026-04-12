import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitProcessor, type ProgressCallback } from './GitProcessor';
import { CodeIndexer } from './CodeIndexer';
import { GitHubService, type RepoScale } from './GitHubService';
import { classifyIntent, rerank } from './IntentRouter';
import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';
import { ASTService } from './ASTService';
import { CallGraphService } from './CallGraphService';
import { OpenAIProvider } from './llm/OpenAIProvider';
import { OllamaProvider } from './llm/OllamaProvider';
import type { LLMProvider, StreamCallback } from './llm/LLMProvider';
import type { IndexStatus, LLMMessage, SearchResult, CallEdge } from '../types';
import type { GitLoreConfig } from '../config';

const SYSTEM_PROMPT = `You are GitLore, a specialized Repository Historian with access to the current codebase, the full git commit history, and pull request / issue context.

DATA TYPES YOU RECEIVE:
• [COMMIT] — Historical git commits with diffs, authors, dates. Use for “when”, “why”, and “who” questions.
• [CODE] — Current source file snippets with file paths, languages, and line numbers. Use for “what does this code do”, “where is X defined”, and architecture questions.
• [CODE – FULL FILE] — Expanded full-file context for top-ranked code results. Prefer these over individual chunks when available.
• [PR] — Pull requests and linked issues. Use for feature context, review decisions, and linking changes to higher-level goals.• [STRUCTURE] — Call graph, symbol information (defines, imports, callers, callees), and co-change coupling (files that frequently change together in commits) for top-ranked files. Use to explain how functions connect, how data flows through the codebase, and which files are evolutionarily coupled even without direct imports.• Project File Structure — A directory tree of all indexed source files. Use this to identify features, modules, and capabilities even if their code was not directly retrieved.

ANSWER RUBRIC — Evaluate your response against these criteria before finalizing:
1. **Evidence-grounded**: Every claim must trace to a specific retrieved snippet. If you cannot find evidence, state "The retrieved context does not cover X" instead of guessing.
2. **Cited**: Reference file paths, commit hashes, PR numbers, or line ranges for key points. Never say "in the codebase" — be specific.
3. **Complete**: Address all parts of the question. If context only partially answers it, answer what you can and explicitly note what is missing.
4. **No hallucination**: Do not invent file names, function names, commit hashes, or features not present in the retrieved snippets or file tree. If the file tree shows a path but no code was retrieved, you may mention its existence but not speculate on implementation.
5. **Confidence signal**: When context is limited, end with a brief italic note stating the actual snippet and commit counts provided (see the stats line at the end of the retrieved context). Example: *"Note: Based on 12 code snippets and 8 commits. Retrieved context may not cover all relevant files."*

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

const SYNTHESIS_ADDENDUM = `

MANDATORY — CODE FLOW TRACING (this overrides all other instructions when a "how" question is asked):
Your answer MUST contain a "## Code Flow" section that traces the actual function calls. This is non-negotiable.

FORMAT REQUIRED:
\`\`\`
res.json(obj)                          // lib/response.js:XXX
  → this.send(body)                    // lib/response.js:YYY  — body is JSON.stringify(obj)
    → this.set('Content-Type', ...)    // lib/response.js:ZZZ  — sets application/json
    → this.end(chunk, encoding)        // lib/response.js:AAA  — writes to socket
\`\`\`

RULES:
1. DO NOT just summarize commit messages. Read the [CODE] and [CODE – FULL FILE] snippets LINE BY LINE.
2. For every claim about behavior, QUOTE the actual line of code: e.g., "At line 178, \`this.set('Content-Type', type)\` is called..."
3. Show the CALL CHAIN: which function calls which, with file:line references.
4. Show DATA TRANSFORMATIONS: how does the input argument change at each step?
5. Your answer should have TWO parts:
   Part 1: "## Historical Change" — the commit/PR that made the change and why (keep concise)
   Part 2: "## Code Flow (Current)" — step-by-step trace through the CURRENT code showing mechanics
6. If the retrieved code is insufficient to trace a specific call, say: "To complete this trace, the file [X] at function [Y] is needed."
7. DO NOT write generic statements like "headers are managed efficiently" — that is useless. Show the EXACT code that manages them.`;

const TRIAGE_PROMPT = `You are a code context triage agent. A developer asked a question about their codebase. You have been given retrieved code snippets and commit history.

Your ONLY job: decide if the snippets contain enough ACTUAL SOURCE CODE to trace the code flow and answer the question mechanically (not just historically).

If the snippets are SUFFICIENT to trace the code path step-by-step, respond exactly:
VERDICT: SUFFICIENT

If you need to see more source files to explain HOW the code works, respond:
VERDICT: NEED_MORE
file: relative/path/to/file.ext
file: relative/path/to/other.ext
reason: One sentence explaining what code flow is missing

Rules:
- Request at most 5 files
- ONLY request files whose paths appear in the snippets, imports, require() calls, or call graph structure
- Focus on files needed to trace function-to-function call chains
- Do NOT request test files unless the question is specifically about tests`;

// Rough character budget — modern LLMs (GPT-4o, Claude 3.5) handle 128K+ tokens.
// We target ~30K tokens of context (~120K chars) leaving ample room for the response.
const MAX_PROMPT_CHARS = 120000;

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

    // Initialize AST service for symbol metadata tagging
    const grammarDir = path.join(os.homedir(), '.gitlore', 'grammars');
    const ast = new ASTService(grammarDir);
    await ast.init();

    // Find deleted files and remove their records
    const deletedFiles = await codeIndexer.getDeletedFiles(storePath);
    if (deletedFiles.length > 0) {
      onProgress?.('Removing deleted files', 0, deletedFiles.length);
      await store.removeCodeFiles(deletedFiles);
    }

    // Index changed/new files — hierarchical mode adds file summaries for large repos
    // AST service tags each chunk with functions/classes/imports/exports metadata
    const { chunks, meta, changedFiles } = await codeIndexer.indexAll(storePath, onProgress, hierarchical, ast);

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

    // ─── Build Call Graph (static + co-change edges) ───
    await this.buildCallGraph(repoPath, codeIndexer, store, onProgress, ast);

    ast.dispose();
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
    activeDirectory?: string,
    /** Override the base top-K retrieval count */
    topKOverride?: number
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
    const baseTopK = topKOverride ?? (scale === 'large' ? 10 : this.config.topK);

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

    // ─── 2b. AST metadata boosting for implementation intent ───
    // When the implementation distribution is high (>0.4), search specifically for
    // chunks tagged with [DEFINES]/[EXPORTS] so the LLM sees module interfaces first.
    if (weights.distribution.implementation > 0.4) {
      const astTopK = Math.ceil(codeTopK * 0.3);
      const astResults = await store.searchCodeWithAST(queryVector, astTopK);
      if (astResults.length > 0) {
        // Boost AST-tagged results by lowering their score (lower = better)
        for (const r of astResults) {
          r.score *= 0.7; // 30% boost for structural chunks
        }
        // Deduplicate: only add AST results not already in codeResults
        const existingKeys = new Set(
          codeResults.map((r) => r.type === 'code' ? `${r.chunk.filePath}:${r.chunk.startLine}` : '')
        );
        for (const r of astResults) {
          if (r.type !== 'code') continue;
          const key = `${r.chunk.filePath}:${r.chunk.startLine}`;
          if (!existingKeys.has(key)) {
            codeResults.push(r);
            existingKeys.add(key);
          }
        }
      }
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

    // ─── 3b. Historical temporal chain: PR → linked commits ───
    // When historical intent is significant, find PRs in results and pull their
    // merge commits from the commit table — regardless of vector score.
    if (weights.distribution.historical > 0.3) {
      const prCandidates = allCandidates.filter((r): r is import('../types').PRSearchResult => r.type === 'pr');
      const existingHashes = new Set(
        allCandidates
          .filter((r): r is import('../types').CommitSearchResult => r.type === 'commit')
          .map((r) => r.chunk.hash)
      );

      for (const prResult of prCandidates.slice(0, 3)) {
        const mergeHash = prResult.chunk.resolvedBy;
        if (!mergeHash || existingHashes.has(mergeHash)) continue;

        const linkedCommits = await store.searchCommitsByHash(mergeHash);
        for (const lc of linkedCommits) {
          if (lc.type !== 'commit') continue;
          if (!existingHashes.has(lc.chunk.hash)) {
            // Give linked commits a score just below the PR that found them
            lc.score = prResult.score * 1.05;
            allCandidates.push(lc);
            existingHashes.add(lc.chunk.hash);
          }
        }
      }
      // Re-sort after injecting temporal chain commits
      allCandidates.sort((a, b) => a.score - b.score);
    }

    // ─── 3c. Symbol discovery + explicit file mention ───
    // Extract queried symbols and explicitly mentioned file paths from the question.
    // Boost chunks that match symbols via AST metadata OR content scan (for closures
    // like `function next()` / `var next = function()` that AST metadata may miss).
    const querySymbols: string[] = [];
    const mentionedFiles: string[] = [];
    if (weights.distribution.implementation > 0.4) {
      // Extract symbol names from function-call syntax in the question
      const symbolPattern = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = symbolPattern.exec(question)) !== null) {
        querySymbols.push(m[1].toLowerCase());
      }
      // Also check for common core-loop keywords even without parens
      const CORE_LOOP_RE = /\b(next|handle|dispatch|process|route|iterate|middleware|resolver)\b/gi;
      for (const sym of (question.match(CORE_LOOP_RE) || [])) {
        if (!querySymbols.includes(sym.toLowerCase())) querySymbols.push(sym.toLowerCase());
      }
      if (querySymbols.length > 0) {
        // Build a regex to find symbols in chunk CONTENT (catches closures/nested fns
        // that AST metadata may miss, e.g. `var next = function(){}`)
        const symContentRe = new RegExp(
          `(?:function\\s+(?:${querySymbols.join('|')})\\b|(?:var|let|const)\\s+(?:${querySymbols.join('|')})\\s*=\\s*function)`,
          'i'
        );
        for (const r of allCandidates) {
          if (r.type !== 'code') continue;
          const fns = (r.chunk.functions || []).map(f => f.toLowerCase());
          let matched = false;
          for (const sym of querySymbols) {
            if (fns.some(f => f === sym || f.includes(sym))) {
              matched = true;
              break;
            }
          }
          // Fallback: scan chunk content for function declarations/expressions
          if (!matched && symContentRe.test(r.chunk.content)) {
            matched = true;
          }
          if (matched) {
            r.score *= 0.4; // 60% boost — these are the files we need
          }
        }
        allCandidates.sort((a, b) => a.score - b.score);
      }

      // Extract explicitly mentioned file paths from the question
      // Matches patterns like lib/router/index.js, src/app.ts, etc.
      const filePathRe = /(?:^|\s|['"`])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,4})\b/gi;
      let fp: RegExpExecArray | null;
      while ((fp = filePathRe.exec(question)) !== null) {
        mentionedFiles.push(fp[1]);
      }
      // Boost chunks from explicitly mentioned files
      if (mentionedFiles.length > 0) {
        for (const r of allCandidates) {
          if (r.type !== 'code') continue;
          if (mentionedFiles.some(mf => r.chunk.filePath === mf || r.chunk.filePath.endsWith('/' + mf) || r.chunk.filePath.endsWith('\\' + mf))) {
            r.score *= 0.3; // 70% boost for explicitly referenced files
          }
        }
        allCandidates.sort((a, b) => a.score - b.score);
      }
    }

    // ─── 4. Smart file expansion (AST-aware) ───
    // Instead of hard-truncating at N chars, we use chunk metadata:
    //   - Chunks that were direct vector search hits → include FULL content
    //   - Chunks that weren't hits → collapse to a 1-line skeleton with symbol names
    // This means the LLM sees the whole file structure but only the relevant details.
    const EXPAND_FILES = (weights.intent === 'historical' || weights.intent === 'debugging') ? 3 : 5;
    const MAX_EXPAND_CHARS = (weights.intent === 'historical' || weights.intent === 'debugging') ? 8000 : 18000;

    // Track which chunks were actually hit by vector search for each file
    const hitChunkKeys = new Set<string>();
    for (const r of allCandidates) {
      if (r.type === 'code') {
        hitChunkKeys.add(`${r.chunk.filePath}:${r.chunk.startLine}`);
      }
    }

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



    // ─── 4b. Anchor file persistence for trace / implementation queries ───
    // Central files (highest call-graph connectivity) should always have their
    // skeletons injected into the prompt for trace queries, even if their vector
    // rank is low. This ensures "hub" files like lib/application.js or
    // lib/router/index.js are always visible to the LLM.
    if (weights.distribution.implementation > 0.4) {
      const allEdges = await store.getAllCallGraphEdges();
      const fileDegree = new Map<string, number>();
      for (const e of allEdges) {
        fileDegree.set(e.callerFile, (fileDegree.get(e.callerFile) ?? 0) + 1);
        if (e.calleeFile !== e.callerFile) {
          fileDegree.set(e.calleeFile, (fileDegree.get(e.calleeFile) ?? 0) + 1);
        }
      }
      // Top 3 most-connected files = anchor files
      const anchorFiles = [...fileDegree.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([fp]) => fp);

      for (const af of anchorFiles) {
        if (!seenFiles.has(af)) {
          seenFiles.add(af);
          topCodeFiles.push(af);
        }
      }
    }

    // ─── 4c. Force-expand explicitly mentioned files ───
    // When the user names a file directly (e.g. "lib/router/index.js"),
    // always include it in the expansion set regardless of vector rank.
    // Resolve against the FULL file index, not just current candidates,
    // because the mentioned file may have zero chunks in vector results.
    if (mentionedFiles.length > 0) {
      const allIndexedPaths = await store.getAllUniqueFilePaths();
      for (const mf of mentionedFiles) {
        const match = allIndexedPaths.find(kp => kp === mf || kp.endsWith('/' + mf) || kp.endsWith('\\' + mf));
        if (match && !seenFiles.has(match)) {
          seenFiles.add(match);
          topCodeFiles.push(match);
        }
      }
    }

    // Fetch all chunks for those files and build smart-expanded content
    const expandedFiles = new Map<string, string>();
    if (topCodeFiles.length > 0) {
      try {
      const allFileChunks = await store.getCodeChunksForFiles(topCodeFiles);
      for (const fp of topCodeFiles) {
        const fileChunks = allFileChunks
          .filter((c) => c.filePath === fp && !c.isSummary)
          .sort((a, b) => a.startLine - b.startLine);
        if (fileChunks.length === 0) {
          continue;
        }


        // ─── Contextual Expansion ───
        // For trace queries: if a chunk contains a queried symbol (e.g. next) as a
        // nested function/closure, find the parent function that spans it and
        // force-expand ALL chunks belonging to the parent. This ensures the LLM
        // sees the loop + closure together.
        //
        // Detection uses BOTH AST metadata (chunk.functions) AND content scanning
        // (for closures like `var next = function(){}` that AST may not tag).
        const contextExpandedKeys = new Set<string>();
        if (querySymbols.length > 0) {
          // Build content-scan regex for symbol detection in chunk bodies
          const symDefRe = new RegExp(
            `(?:function\\s+(?:${querySymbols.join('|')})\\b|(?:var|let|const)\\s+(?:${querySymbols.join('|')})\\s*=\\s*function)`,
            'i'
          );
          // Helper: get all function names from a chunk (metadata + content scan)
          const getChunkFns = (c: import('../types').CodeChunk): string[] => {
            const fns = (c.functions || []).map(f => f.toLowerCase());
            // Also extract function declarations/expressions from content
            const contentFnRe = /(?:function\s+([a-zA-Z_$][\w$]*)|\b(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*function)\b/g;
            let match: RegExpExecArray | null;
            while ((match = contentFnRe.exec(c.content)) !== null) {
              const name = (match[1] || match[2]).toLowerCase();
              if (!fns.includes(name)) fns.push(name);
            }
            // Also extract proto.method / exports.method patterns
            const protoFnRe = /(?:proto|exports|module\.exports)\.\s*([a-zA-Z_$][\w$]*)\s*=\s*function\b/g;
            while ((match = protoFnRe.exec(c.content)) !== null) {
              const name = match[1].toLowerCase();
              if (!fns.includes(name)) fns.push(name);
            }
            return fns;
          };
          // Helper: does a chunk contain any queried symbol?
          const chunkHasSymbol = (c: import('../types').CodeChunk): boolean => {
            const fns = getChunkFns(c);
            if (querySymbols.some(sym => fns.some(f => f === sym || f.includes(sym)))) return true;
            // Fallback: content regex scan
            return symDefRe.test(c.content);
          };
          // Helper: does a chunk contain a specific parent function?
          const chunkHasParent = (c: import('../types').CodeChunk, parent: string): boolean => {
            const fns = getChunkFns(c);
            return fns.some(f => f === parent || f.includes(parent));
          };

          for (let ci = 0; ci < fileChunks.length; ci++) {
            const chunk = fileChunks[ci];
            if (!chunkHasSymbol(chunk)) continue;

            // Force-expand any chunk that defines a queried symbol
            // (e.g. res.send() lives in a different chunk than res.json())
            contextExpandedKeys.add(`${chunk.filePath}:${chunk.startLine}`);

            const fns = getChunkFns(chunk);
            // Find the parent function: the outermost function in this chunk that
            // isn't the symbol itself. For expressjs, next() is inside proto.handle —
            // so `fns` would be ['handle', 'next'] and parent = 'handle'.
            const parentFn = fns.find(f => !querySymbols.some(sym => f === sym || f.includes(sym))) || fns[0];
            if (!parentFn) continue;

            // Mark this chunk as force-expanded
            contextExpandedKeys.add(`${chunk.filePath}:${chunk.startLine}`);

            // Walk backward: expand preceding chunks that share the parent function
            for (let bi = ci - 1; bi >= 0; bi--) {
              if (chunkHasParent(fileChunks[bi], parentFn)) {
                contextExpandedKeys.add(`${fileChunks[bi].filePath}:${fileChunks[bi].startLine}`);
              } else {
                break;
              }
            }
            // Walk forward: expand following chunks that share the parent function
            for (let fi = ci + 1; fi < fileChunks.length; fi++) {
              if (chunkHasParent(fileChunks[fi], parentFn)) {
                contextExpandedKeys.add(`${fileChunks[fi].filePath}:${fileChunks[fi].startLine}`);
              } else {
                break;
              }
            }
          }
        }

        const parts: string[] = [];
        for (const chunk of fileChunks) {
          const key = `${chunk.filePath}:${chunk.startLine}`;
          const isHit = hitChunkKeys.has(key) || contextExpandedKeys.has(key);

          if (isHit) {
            // Hit chunk → full content
            parts.push(chunk.content);
          } else {
            // Non-hit chunk → collapsed skeleton with symbol names
            const symbols: string[] = [];
            if (chunk.functions?.length) symbols.push(...chunk.functions.map(f => `fn ${f}()`));
            if (chunk.classes?.length) symbols.push(...chunk.classes.map(c => `class ${c}`));
            if (chunk.imports?.length) symbols.push(`imports: ${chunk.imports.join(', ')}`);
            if (chunk.exports?.length) symbols.push(`exports: ${chunk.exports.join(', ')}`);

            if (symbols.length > 0) {
              parts.push(`// --- Lines ${chunk.startLine}-${chunk.endLine}: ${symbols.join(' | ')} ---`);
            } else {
              parts.push(`// --- Lines ${chunk.startLine}-${chunk.endLine} (${chunk.endLine - chunk.startLine + 1} lines) ---`);
            }
          }
        }

        let combined = parts.join('\n');
        // Safety cap (after collapsing, should rarely trigger)
        if (combined.length > MAX_EXPAND_CHARS) {
          combined = combined.slice(0, MAX_EXPAND_CHARS) + '\n... [file truncated]';
        }
        expandedFiles.set(fp, combined);

      }
      } catch (err) {

      }
    }

    // ─── 5. Greedy token filling with elastic budget ───
    // Split the snippet budget between code and commits/PRs based on intent.
    // Trace/Implementation: 80% code / 20% commits
    // Root Cause / Why:     20% code / 80% commits
    // General / Refactor:   50% / 50%
    const snippetBudget = MAX_PROMPT_CHARS - 10000;
    const codeBudget = Math.floor(snippetBudget * weights.codeBudgetRatio);
    const commitBudget = snippetBudget - codeBudget;
    let usedCodeChars = 0;
    let usedCommitChars = 0;
    const merged: SearchResult[] = [];
    const usedIndices = new Set<number>();

    // Track which files have expanded (full-file) content — only skip individual chunks for THOSE files
    const expandedFileSet = new Set(expandedFiles.keys());

    // Account for expanded files in the CODE budget (they use prompt space too)
    // Cap expanded file content to stay within code budget
    let expandedChars = 0;
    for (const [fp, content] of expandedFiles) {
      const cost = content.length + 100; // +100 for header formatting
      if (expandedChars + cost > codeBudget * 0.85) {
        // Drop this expansion to leave room for individual snippets
        expandedFiles.delete(fp);
        expandedFileSet.delete(fp);
        continue;
      }
      expandedChars += cost;
      usedCodeChars += cost;
    }

    // For each expanded file, add ONE representative code result to `merged` so the
    // expanded content gets rendered via buildPrompt(). Pick the highest-ranked chunk per file.
    const expandedFilesAdded = new Set<string>();
    for (let i = 0; i < allCandidates.length; i++) {
      const r = allCandidates[i];
      if (r.type === 'code' && expandedFileSet.has(r.chunk.filePath) && !expandedFilesAdded.has(r.chunk.filePath)) {
        merged.push(r);
        usedIndices.add(i);
        expandedFilesAdded.add(r.chunk.filePath);
      }
    }

    // Intent-aware seed: code first for overview/impl/general, commits first for hist/debug
    const commitFirst = weights.intent === 'historical' || weights.intent === 'debugging';
    const seedOrder = commitFirst
      ? [allCandidates.findIndex((r) => r.type === 'commit'), allCandidates.findIndex((r) => r.type === 'code' && !expandedFileSet.has(r.chunk.filePath))]
      : [allCandidates.findIndex((r) => r.type === 'code' && !expandedFileSet.has(r.chunk.filePath)), allCandidates.findIndex((r) => r.type === 'commit')];

    for (const seedIdx of seedOrder) {
      if (seedIdx >= 0 && !usedIndices.has(seedIdx)) {
        const result = allCandidates[seedIdx];
        const charCost = this.estimateSnippetChars(result);
        merged.push(result);
        if (result.type === 'code') usedCodeChars += charCost; else usedCommitChars += charCost;
        usedIndices.add(seedIdx);
      }
    }

    // Fill greedily respecting per-stream budgets.
    // Skip individual chunks ONLY for files that have expanded content.
    // When one stream is full, keep filling the other until total budget is exhausted.
    for (let i = 0; i < allCandidates.length; i++) {
      if (usedIndices.has(i)) continue;
      const result = allCandidates[i];

      // If this code chunk's file was expanded to full-file content, skip the duplicate chunk
      if (result.type === 'code' && expandedFileSet.has(result.chunk.filePath)) continue;

      const charCost = this.estimateSnippetChars(result);
      const totalUsed = usedCodeChars + usedCommitChars;

      if (result.type === 'code') {
        // For historical/debugging intent, strictly cap code budget — don't spill into commit space
        if (commitFirst) {
          if (usedCodeChars + charCost > codeBudget) continue;
        } else {
          if (usedCodeChars + charCost > codeBudget && totalUsed + charCost > snippetBudget) continue;
        }
        usedCodeChars += charCost;
      } else {
        if (commitFirst) {
          if (usedCommitChars + charCost > commitBudget && totalUsed + charCost > snippetBudget) continue;
        } else {
          if (usedCommitChars + charCost > commitBudget) continue;
        }
        usedCommitChars += charCost;
      }
      if (totalUsed + charCost > snippetBudget && merged.length > 0) break;
      merged.push(result);
    }

    const usedChars = usedCodeChars + usedCommitChars;

    console.error(
      `[RAGEngine] Pipeline: ${allCandidates.length} candidates → ` +
      `${expandedFiles.size} expanded files + ${merged.length - expandedFilesAdded.size} additional snippets = ` +
      `${merged.length} total in prompt ` +
      `(code: ${Math.round(usedCodeChars / 1000)}K/${Math.round(codeBudget / 1000)}K, ` +
      `commits: ${Math.round(usedCommitChars / 1000)}K/${Math.round(commitBudget / 1000)}K, ` +
      `ratio: ${Math.round(weights.codeBudgetRatio * 100)}% code [${weights.intent}])`
    );

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

    // ─── 7. Structural context from call graph ───
    // For expanded files, show what they define, import, connect to, and co-change with.
    let structuralContext: string | undefined;
    if (expandedFiles.size > 0) {
      const structParts: string[] = [];
      for (const fp of expandedFiles.keys()) {
        const callerEdges = await store.queryCallGraphByCaller(fp);
        const calleeEdges = await store.queryCallGraphByCallee(fp);
        const coChangeEdges = await store.queryCoChangeEdges(fp);

        // Separate static call edges from co-change in caller/callee results
        const staticCallerEdges = callerEdges.filter((e) => e.edgeType !== 'co-change');
        const staticCalleeEdges = calleeEdges.filter((e) => e.edgeType !== 'co-change');

        if (staticCallerEdges.length === 0 && staticCalleeEdges.length === 0 && coChangeEdges.length === 0) continue;

        const lines: string[] = [`[STRUCTURE] File: ${fp}`];
        if (staticCallerEdges.length > 0) {
          const callees = [...new Set(staticCallerEdges.map((e) => `${e.calleeName} (${e.calleeFile})`))];
          lines.push(`  Calls: ${callees.slice(0, 15).join(', ')}`);
        }
        if (staticCalleeEdges.length > 0) {
          const callers = [...new Set(staticCalleeEdges.map((e) => `${e.callerName} (${e.callerFile})`))];
          lines.push(`  Called by: ${callers.slice(0, 15).join(', ')}`);
        }
        if (coChangeEdges.length > 0) {
          // Dual-stream format: show raw count, latest commit (Modern/Stale), and earliest commit (Legacy Peak)
          const topEdges = coChangeEdges
            .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
            .slice(0, 5);
          for (const e of topEdges) {
            const otherFile = e.callerFile === fp ? e.calleeFile : e.callerFile;
            const count = e.rawCount ?? Math.round(e.weight ?? 0);
            lines.push(`  - Evolutionary: ${otherFile} — ${count} co-changes`);
            if (e.latestCommitDate) {
              const latestAge = this.relativeAge(e.latestCommitDate);
              const latestHash = e.latestCommitHash ? e.latestCommitHash.substring(0, 8) : '';
              const freshness = this.freshnessLabel(e.latestCommitDate);
              lines.push(`    LAST MODIFIED: ${latestAge} (${latestHash}) → "${freshness}"`);
            }
            if (e.earliestCommitDate) {
              const earliestAge = this.relativeAge(e.earliestCommitDate);
              const earliestHash = e.earliestCommitHash ? e.earliestCommitHash.substring(0, 8) : '';
              const legacyLabel = this.freshnessLabel(e.earliestCommitDate);
              lines.push(`    LEGACY PEAK: ${earliestAge} (${earliestHash}) → "${legacyLabel}"`);
            }
          }
        }
        structParts.push(lines.join('\n'));
      }
      if (structParts.length > 0) {
        structuralContext = structParts.join('\n\n');
      }
    }

    let messages = this.buildPrompt(question, merged, conversationHistory, expandedFiles, projectTree, structuralContext);

    const provider = this.getLLMProvider();

    // ─── Two-pass synthesis: let the LLM request more files if needed ───
    if (this.shouldSynthesize(question)) {
      const enriched = await this.synthesisPass(
        provider, store, repoPath, question, queryVector,
        messages, merged, expandedFiles, conversationHistory,
        projectTree, structuralContext,
      );
      if (enriched) {
        messages = enriched;
        console.error('[RAGEngine] Synthesis pass: enriched context with additional files');
      }
    }

    return provider.sendMessage(messages, onChunk);
  }

  // ─── Call Graph Building ───

  /**
   * Build static call graph (from AST analysis) + co-change edges (from commit history)
   * and persist them into the call_graph table.
   */
  private async buildCallGraph(
    repoPath: string,
    codeIndexer: CodeIndexer,
    store: VectorStore,
    onProgress?: ProgressCallback,
    existingAst?: ASTService
  ): Promise<void> {
    try {
      onProgress?.('Building call graph (AST analysis)', 0, 0);

      // 1. Initialize AST service (reuse if provided by caller)
      const ast = existingAst ?? new ASTService(path.join(os.homedir(), '.gitlore', 'grammars'));
      if (!existingAst) await ast.init();

      // 2. Read all code files for parsing
      const files = await codeIndexer.listFiles();
      const LANG_MAP: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
        '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      };

      const fileContents: { filePath: string; content: string; language: string }[] = [];
      for (const relPath of files) {
        const absPath = path.join(repoPath, relPath);
        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          const ext = path.extname(relPath).toLowerCase();
          const language = LANG_MAP[ext];
          if (language) {
            fileContents.push({ filePath: relPath, content, language });
          }
        } catch {
          // Skip unreadable files
        }
      }

      onProgress?.(`Parsing ${fileContents.length} files for AST`, 0, fileContents.length);
      const allSymbols = await ast.parseFiles(fileContents);
      if (!existingAst) ast.dispose();

      // 3. Build static call graph edges
      const cg = new CallGraphService();
      const staticEdges = cg.buildGraph(allSymbols);
      onProgress?.(`Static call graph: ${staticEdges.length} edges`, 0, 0);

      // 4. Compute co-change edges from commit history
      let coChangeEdges: CallEdge[] = [];
      try {
        const commitFileGroups = await store.getCommitFileGroups();
        if (commitFileGroups.size > 0) {
          coChangeEdges = cg.computeCoChangeEdges(commitFileGroups);
          onProgress?.(`Co-change edges: ${coChangeEdges.length} evolutionary couplings`, 0, 0);
        }
      } catch {
        // Co-change is optional — commit table might not exist yet
      }

      // 5. Merge and persist
      const allEdges = [...staticEdges, ...coChangeEdges];
      if (allEdges.length > 0) {
        await store.upsertCallGraph(allEdges);
        onProgress?.(`Call graph stored: ${staticEdges.length} static + ${coChangeEdges.length} co-change edges`, 1, 1);
      }
    } catch (err) {
      // Call graph building is supplementary — don't fail the indexing
      console.error('[RAGEngine] Call graph building failed:', err);
      onProgress?.('Call graph building skipped (non-fatal)', 0, 0);
    }
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
    projectTree?: string,
    structuralContext?: string,
  ): LLMMessage[] {
    // Track which files have already been rendered via expanded content
    const renderedExpanded = new Set<string>();
    const isSynthesis = this.shouldSynthesize(question);

    // Separate results by type for ordered rendering
    const codeResults: { result: SearchResult; index: number }[] = [];
    const commitResults: { result: SearchResult; index: number }[] = [];
    const prResults: { result: SearchResult; index: number }[] = [];
    results.forEach((r, i) => {
      if (r.type === 'code') codeResults.push({ result: r, index: i });
      else if (r.type === 'commit') commitResults.push({ result: r, index: i });
      else prResults.push({ result: r, index: i });
    });

    // For synthesis (how/flow questions): code first, then commits
    // For historical questions: keep interleaved score order
    const orderedResults = isSynthesis
      ? [...codeResults, ...prResults, ...commitResults]
      : results.map((r, i) => ({ result: r, index: i }));

    const renderSnippet = (r: SearchResult, displayIdx: number): string | null => {
      if (r.type === 'commit') {
        const c = r.chunk;
        const lines = [
          `--- Retrieved Snippet ${displayIdx} (score: ${r.score.toFixed(4)}) [COMMIT] ---`,
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
          `--- Retrieved Snippet ${displayIdx} (score: ${r.score.toFixed(4)}) [PR] ---`,
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
            `--- Retrieved Snippet ${displayIdx} (score: ${r.score.toFixed(4)}) [CODE – FULL FILE] ---`,
            `[CODE] File: ${c.filePath} | Language: ${c.language}`,
            expanded,
          ];
          return lines.join('\n');
        }

        // Already rendered expanded version of this file — skip duplicate chunk
        if (renderedExpanded.has(c.filePath)) return null;

        const truncatedContent = c.content.length > 3000 ? c.content.slice(0, 3000) + '\n... [truncated]' : c.content;
        const lines = [
          `--- Retrieved Snippet ${displayIdx} (score: ${r.score.toFixed(4)}) [CODE] ---`,
          `[CODE] File: ${c.filePath} | Language: ${c.language} | Lines ${c.startLine}-${c.endLine}`,
          truncatedContent,
        ];
        return lines.join('\n');
      }
    };

    let contextSnippets: string;
    if (isSynthesis) {
      // Render code section with a clear header, then history section
      const codeParts: string[] = [];
      const historyParts: string[] = [];
      let idx = 1;
      for (const { result } of orderedResults) {
        const rendered = renderSnippet(result, idx);
        if (rendered) {
          if (result.type === 'code') codeParts.push(rendered);
          else historyParts.push(rendered);
          idx++;
        }
      }
      const sections: string[] = [];
      if (codeParts.length > 0) {
        sections.push(`=== SOURCE CODE (read this FIRST to trace the code flow) ===\n\n${codeParts.join('\n\n')}`);
      }
      if (historyParts.length > 0) {
        sections.push(`=== COMMIT HISTORY & PRs (use for "why" and "when", NOT for "how") ===\n\n${historyParts.join('\n\n')}`);
      }
      contextSnippets = sections.join('\n\n---\n\n');
    } else {
      // Standard interleaved rendering
      let idx = 1;
      contextSnippets = orderedResults
        .map(({ result }) => {
          const rendered = renderSnippet(result, idx);
          if (rendered) idx++;
          return rendered;
        })
        .filter(Boolean)
        .join('\n\n');
    }

    const structurePreamble = structuralContext
      ? `## Code Structure (Call Graph)\n\nThe following shows how the top-ranked files connect to other code:\n\n${structuralContext}\n\n---\n\n`
      : '';

    const treePreamble = projectTree
      ? `## Project File Structure\n\nThe following is a complete listing of source files in this repository. Use this to identify features, modules, and capabilities — even those not directly retrieved above:\n\n${projectTree}\n\n---\n\n`
      : '';

    // Count actual snippets by type for the confidence signal
    const codeCount = results.filter(r => r.type === 'code').length;
    const commitCount = results.filter(r => r.type === 'commit').length;
    const prCount = results.filter(r => r.type === 'pr').length;
    const expandedCount = expandedFiles?.size ?? 0;
    const statsLine = `[CONTEXT STATS] ${codeCount} code snippets (${expandedCount} full-file expansions), ${commitCount} commit records, ${prCount} PR records.`;

    const userMessage = `Here are the most relevant snippets from the repository:\n\n${contextSnippets}\n\n---\n\n${statsLine}\n\n${structurePreamble}${treePreamble}Question: ${question}`;

    // Hard safety cap: if the prompt is still too large, truncate the user message
    const maxUserChars = MAX_PROMPT_CHARS - SYSTEM_PROMPT.length - 200;
    const safeUserMessage = userMessage.length > maxUserChars
      ? userMessage.slice(0, maxUserChars) + '\n\n... [context truncated to fit token budget]'
      : userMessage;

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + (this.shouldSynthesize(question) ? SYNTHESIS_ADDENDUM : '') },
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

  /** Classify an ISO date as Modern (<6 months), Recent (6–18 months), or Stale (>18 months). */
  private freshnessLabel(isoDate: string): string {
    const then = new Date(isoDate).getTime();
    if (isNaN(then)) return 'Unknown';
    const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
    if (days < 180) return 'Modern';
    if (days < 540) return 'Recent';
    return 'Stale';
  }

  /** Convert an ISO date string to a human-readable relative age. */
  private relativeAge(isoDate: string): string {
    const then = new Date(isoDate).getTime();
    if (isNaN(then)) return '';
    const diffMs = Date.now() - then;
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? '1 year ago' : `${years} years ago`;
  }

  // ─── Two-Pass File-System Agency ───

  /**
   * Detect questions that benefit from code-flow tracing (the synthesis addendum
   * and the two-pass triage). Matches "how", "affect", "flow", "trace",
   * "mechanism", "calls", "internally", etc.
   */
  private shouldSynthesize(question: string): boolean {
    const FLOW_RE = /\b(how\s+(does|do|did|is|are|will|would|could|can)|affects?|flow|trace|mechan|internal|under.?the.?hood|step.?by.?step|calls?\s+chain|propagat|data.?flow|code.?path|walks?.?through|end.?to.?end)\b/i;
    return FLOW_RE.test(question);
  }

  /**
   * Two-pass synthesis: send the initial prompt to the LLM as a triage request.
   * If the LLM identifies missing files, read them from disk and rebuild the prompt.
   */
  private async synthesisPass(
    provider: LLMProvider,
    store: VectorStore,
    repoPath: string,
    question: string,
    queryVector: number[],
    initialMessages: LLMMessage[],
    merged: SearchResult[],
    expandedFiles: Map<string, string>,
    conversationHistory?: LLMMessage[],
    projectTree?: string,
    structuralContext?: string,
  ): Promise<LLMMessage[] | null> {
    try {
      // Extract user message (always last in the array)
      const userMsg = initialMessages[initialMessages.length - 1];

      // Pass 1: lightweight triage — does the LLM think it has enough code?
      const triageMessages: LLMMessage[] = [
        { role: 'system', content: TRIAGE_PROMPT },
        { role: 'user', content: userMsg.content },
      ];

      const triageResponse = await provider.sendMessage(triageMessages); // no streaming

      if (triageResponse.includes('VERDICT: SUFFICIENT')) {
        console.error('[RAGEngine] Triage: context sufficient, skipping synthesis pass');
        return null;
      }

      // Parse requested files from triage response
      const requestedFiles = this.parseTriageFiles(triageResponse);
      if (requestedFiles.length === 0) {
        console.error('[RAGEngine] Triage: NEED_MORE but no parseable file requests');
        return null;
      }

      console.error(`[RAGEngine] Triage: LLM requested ${requestedFiles.length} additional files: ${requestedFiles.join(', ')}`);

      // Read the requested files from disk + store
      const additionalFiles = await this.readRequestedFiles(store, repoPath, requestedFiles);
      if (additionalFiles.size === 0) {
        console.error('[RAGEngine] Triage: could not read any of the requested files');
        return null;
      }

      console.error(`[RAGEngine] Triage: successfully read ${additionalFiles.size} files (${[...additionalFiles.values()].reduce((s, c) => s + c.length, 0)} chars)`);

      // Merge additional files into expanded files
      const enrichedExpanded = new Map(expandedFiles);
      for (const [fp, content] of additionalFiles) {
        if (!enrichedExpanded.has(fp)) {
          enrichedExpanded.set(fp, content);
        }
      }

      // Add synthetic search results for the new files so buildPrompt renders them
      const enrichedMerged = [...merged];
      for (const fp of additionalFiles.keys()) {
        if (!merged.some(r => r.type === 'code' && r.chunk.filePath === fp)) {
          enrichedMerged.push({
            type: 'code' as const,
            score: 999,
            chunk: { filePath: fp, content: '', language: path.extname(fp).slice(1), startLine: 0, endLine: 0, embedding: [] },
          } as SearchResult);
        }
      }

      // Rebuild prompt with enriched context
      return this.buildPrompt(
        question, enrichedMerged, conversationHistory,
        enrichedExpanded, projectTree, structuralContext,
      );
    } catch (err) {
      console.error('[RAGEngine] Synthesis pass failed (non-fatal):', err);
      return null;
    }
  }

  /**
   * Parse the triage LLM response for file path requests.
   * Expected format: "file: path/to/file.ext" lines.
   */
  private parseTriageFiles(response: string): string[] {
    const files: string[] = [];
    const fileRe = /^file:\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(response)) !== null) {
      const fp = m[1].trim();
      // Basic sanitization: no absolute paths, no path traversal
      if (fp && !path.isAbsolute(fp) && !fp.includes('..')) {
        files.push(fp);
      }
    }
    return files.slice(0, 5); // Cap at 5
  }

  /**
   * Read requested files — first try the VectorStore (already chunked),
   * then fall back to reading raw files from disk.
   */
  private async readRequestedFiles(
    store: VectorStore,
    repoPath: string,
    requestedFiles: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const MAX_FILE_CHARS = 12000;

    // Try store first (indexed files have better chunking)
    try {
      const storeChunks = await store.getCodeChunksForFiles(requestedFiles);
      const byFile = new Map<string, string[]>();
      for (const chunk of storeChunks) {
        if (!byFile.has(chunk.filePath)) byFile.set(chunk.filePath, []);
        byFile.get(chunk.filePath)!.push(chunk.content);
      }
      for (const [fp, parts] of byFile) {
        let combined = parts.join('\n');
        if (combined.length > MAX_FILE_CHARS) {
          combined = combined.slice(0, MAX_FILE_CHARS) + '\n... [truncated for synthesis]';
        }
        result.set(fp, combined);
      }
    } catch {
      // Store might not have these files
    }

    // Fall back to disk for files not found in store
    for (const reqFile of requestedFiles) {
      if (result.has(reqFile)) continue;

      // Resolve against repo root, then check it's still under repoPath
      const absPath = path.resolve(repoPath, reqFile);
      const normalizedRepo = path.resolve(repoPath);
      if (!absPath.startsWith(normalizedRepo)) continue; // path traversal guard

      try {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
          let content = fs.readFileSync(absPath, 'utf-8');
          if (content.length > MAX_FILE_CHARS) {
            content = content.slice(0, MAX_FILE_CHARS) + '\n... [truncated for synthesis]';
          }
          result.set(reqFile, content);
        }
      } catch {
        // Skip unreadable files
      }
    }

    return result;
  }
}
