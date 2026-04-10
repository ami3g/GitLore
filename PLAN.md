# PLAN.md — Git-Lore Source of Truth

> Last updated: 2026-04-09

---

## v1 — Completed Features

<details>
<summary>Click to expand v1 phases (all complete)</summary>

### Phase 1: Scaffolding & Build System
- [x] `package.json` with manifest, deps, contributes (views, config, commands)
- [x] `esbuild.js` for extension host (Node/CJS, LanceDB external)
- [x] Vite config for React webview (`src/webview/vite.config.ts`)
- [x] TypeScript configs (extension + webview)
- [x] `.gitignore` / `.vscodeignore`
- [x] Activity bar icon SVG
- [x] `extension.ts` entry point with activation, command registration
- [x] `ChatViewProvider` with CSP, nonce, message passing
- [x] React webview shell (App, ChatMessage, ChatInput, StatusBar)
- [x] CSS with VS Code theme variable integration

### Phase 2: Git Data Extraction
- [x] Shared types (`CommitChunk` with `filePath` field for file-level granularity)
- [x] `GitProcessor` — extract commits via `simple-git`, **file-level chunking** (one embedding per file changed)
- [x] Smart truncation: code files (`.ts`, `.py`, `.go`) get 3,000 chars; medium (`.sql`, `.sh`) get 1,500; config/docs get 600
- [x] Progress reporting callback
- [x] **57-rule exclusion filter** — skip binaries, lockfiles, secrets (.env, .pem, .key, id_rsa)
- [x] **Paged async-generator extraction** — `extractPaged()` yields 200-commit pages, never holds all commits in memory

### Phase 3: Embedding & Vector Storage
- [x] `EmbeddingService` — `@huggingface/transformers` pipeline, lazy init, 384-dim vectors
- [x] `VectorStore` — LanceDB wrapper (connect, createTable, addRecords, search, clear, getStatus)
- [x] **True batch embedding** — sends 32 strings at once to the model (not sequential)
- [x] **Streaming DB writes** — 100-chunk windows: embed → write → discard → repeat
- [x] Metadata persistence (`index-meta.json`) tracking last indexed commit hash

### Phase 4: LLM Provider Layer
- [x] `LLMProvider` interface (sendMessage with streaming, testConnection)
- [x] `OpenAIProvider` — OpenAI SDK, streaming, SecretStorage for API key
- [x] `OllamaProvider` — fetch + NDJSON streaming, configurable endpoint

### Phase 5: RAG Engine
- [x] `RAGEngine` orchestrator — indexRepository (full or incremental), query (embed→search→prompt→stream)
- [x] Incremental indexing: detects existing index + metadata, only processes commits since `lastIndexedHash`
- [x] Rebase safety: verifies `lastIndexedHash` exists via `git cat-file`; auto-rebuilds if missing
- [x] Conversation history: last 5 exchanges (10 messages) passed to LLM for follow-up context
- [x] Token budget: trims oldest history to stay under 24K chars; snippets never trimmed
- [x] "What's Changed?" summarization — smart standup: `--stat` TOC + full diffs for top 4 by lines changed, skips merges
- [x] Structured snippet labels: `[COMMIT:]` `[FILE:]` `[DIFF:]` format
- [x] Provider selection from VS Code settings

### Phase 6: Wire UI ↔ Backend
- [x] Typed message protocol (WebviewToExtensionMessage / ExtensionToWebviewMessage)
- [x] ChatViewProvider dispatches to RAGEngine, streams chunks back
- [x] React UI handles streaming, progress, errors, status

### Phase 7: Polish
- [x] SecretStorage for OpenAI API key (`gitlore.setApiKey` command)
- [x] Right-click "Explain This Change" — `git blame` → sidebar RAG query
- [x] README.md, PLAN.md, LICENSE (MIT)

</details>

---

## v2 — Monorepo + Full Codebase + PR/Issue Indexing

### Goal
Restructure into a **monorepo** with a framework-agnostic core library + VS Code extension + CLI tool. Index **current source files** alongside git history. Add **PR/issue context** from GitHub API (descriptions, linked issues, resolutions only). Live incremental updates on file save/commit.

### Target Architecture

```
gitlore/
├── packages/
│   ├── core/              ← Framework-agnostic engine (pure Node.js)
│   │   ├── src/
│   │   │   ├── services/  ← GitProcessor, EmbeddingService, VectorStore,
│   │   │   │                 RAGEngine, CodeIndexer, GitHubService
│   │   │   ├── llm/       ← LLMProvider, OpenAI, Ollama
│   │   │   └── types/     ← All shared types
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── vscode/            ← Thin UI layer (injects config into core)
│   │   ├── src/
│   │   │   ├── extension.ts
│   │   │   └── providers/ChatViewProvider.ts
│   │   ├── webview/       ← React sidebar (unchanged)
│   │   ├── esbuild.js
│   │   └── package.json
│   └── cli/               ← Standalone tool (Claude Code, terminal, etc.)
│       ├── src/index.ts   ← commander entry point
│       └── package.json
├── package.json           ← npm workspaces root
└── tsconfig.base.json
```

### Phase 8: Monorepo Restructure ✅
- [x] Init npm workspaces: `"workspaces": ["packages/*"]`
- [x] Create `packages/core/` — move framework-agnostic services (GitProcessor, EmbeddingService, VectorStore, LLM providers, types)
- [x] **Refactor RAGEngine** — replace `vscode.ExtensionContext` with a plain `GitLoreConfig` interface + callbacks
- [x] Create `packages/vscode/` — thin wrapper: injects VS Code config/secrets into core
- [x] Move webview into `packages/vscode/webview/`
- [x] Create `packages/cli/` — `commander` entry, reads `.gitlore.json` or env vars
- [x] Update esbuild configs per package
- [x] Verify: `npm run compile` from root builds all 3 packages

### Phase 9: Code File Indexing ✅
- [x] New `CodeIndexer` service in core: `git ls-files` → reuse `isExcluded()` → **256-line chunks with 50-line overlap**
- [x] New `code_files` LanceDB table: `vector`, `filePath`, `language`, `startLine`, `endLine`, `content`
- [x] VectorStore: `upsertCodeFiles(paths, chunks, embeddings)` (delete old → insert new) and `removeCodeFiles(paths)`
- [x] Metadata: `code-meta.json` with `{ [filePath]: contentHash }` for incremental updates
- [x] RAGEngine: `indexCode()` method; `query()` searches **both** `commits` + `code_files`, merge + re-rank by distance
- [x] Unified search results: `CommitSearchResult` and `CodeSearchResult` discriminated union
- [x] System prompt updated to explain `[COMMIT]` and `[CODE]` data types
- [x] `buildPrompt()` renders both result types with proper labels

### Phase 10: Live Commit Detection ✅
> **Design choice**: Only detect *committed* changes — not editor saves. Indexes committed code, not work-in-progress.
- [x] `fs.watch` on `.git/refs/` (recursive) to detect new commits from push, pull, fetch, or local commits
- [x] 3-second debounce — git operations write multiple ref files quickly
- [x] Compares current HEAD hash against last-known hash; prompts user: "New commits detected. Update the index?"
- [x] "Update Index" re-runs full `indexRepository()` + `indexCode()` for both commit and code tables
- [ ] CLI: `gitlore watch` command — poll `.git/refs/` and auto-reindex on change

### Phase 11: PR/Issue Context (GitHub API) ✅
- [x] Add `@octokit/rest` to core
- [x] New `GitHubService`: `fetchPRs()`, parse linked issues from body (`Closes/Fixes/Resolves #N`), `fetchIssue()` title+body
- [x] **Only index**: PR description, linked issue titles, final resolution — no review comments, no full diffs
- [x] New `pr_data` LanceDB table; `PRChunk` type: prNumber, title, description, state, linkedIssues, resolvedBy
- [x] RAGEngine: `indexPRs()` incremental via date; `query()` searches all 3 tables
- [x] **Repo-scale detection**: `git rev-list --count` → small vs large strategy
  - Small repos: eagerly fetch linked issue titles (up to 5 per PR)
  - Large repos: cap at 500 PRs (5 pages), skip issue title resolution
- [x] **Graceful no-token**: CLI warns about unauthenticated rate limits, Extension skips PR phase silently on failure — `[CODE]` + `[COMMIT]` always work

### Phase 12: Dynamic Intent-Based Search & Prompt ✅
- [x] New `IntentRouter` service — lightweight keyword classifier
  - Detects 4 intents: `historical` (PR-heavy), `implementation` (code-heavy), `debugging` (commit-heavy), `general` (balanced)
  - Returns per-source-type weight multipliers: `{ commit, code, pr }`
  - Keyword dictionaries with word-boundary regex matching
- [x] **Weighted reranking**: divide raw distance by intent weight (higher weight → lower effective distance → ranked higher)
- [x] **Greedy token filling**: walk reranked results, accumulate char cost until snippet budget (60% of 24K) is full — no hard slot limits per source
- [x] `estimateSnippetChars()` per result type for accurate budget tracking
- [x] Label results in prompt: `[CODE]`, `[COMMIT]`, `[PR]`
- [x] System prompt updated to explain the 3 data types and when to use each

### Phase 13: Large Repo Full-Coverage Strategy ✅
> **Philosophy**: No page caps, no metadata-only fallbacks. Embeddings exist to handle scale — use them. Truncation causes hallucination.

- [x] **Removed PR page caps** — `LARGE_REPO_MAX_PAGES` eliminated. ALL PRs fetched regardless of repo size.
  - Small repos: concurrent page fetches (3 pages in parallel), eager issue title resolution
  - Large repos: sequential page fetches (rate-limit safe), issue numbers only
  - `since` filter for incremental fetching is the real scaling strategy
- [x] **Hierarchical chunking** for code files (large repos only)
  - File-level summary chunk: head 80 lines + tail 40 lines + metadata → one embedding per file
  - Detail chunks: standard 256-line/50-line-overlap windows (unchanged)
  - `isSummary` flag on `CodeChunk` type for distinguishing in search results
  - Broad queries surface summaries; specific queries surface detail chunks
- [x] **HNSW Scalar Quantization** for large repos
  - `VectorStore.ensureSQIndices()` creates `Index.hnswSq()` on all 3 tables
  - Only triggered when table row count exceeds 10,000 rows
  - Compresses 384-dim float32 vectors in-place — faster search, lower RAM
- [x] **Directory-scoped search** for large repos
  - `VectorStore.searchCodeScoped(embedding, topK, directoryPrefix)` — `.where("filePath LIKE 'dir/%'")`
  - VS Code passes active editor's directory; CLI uses cwd-relative paths
  - 60/40 split: 60% scoped results, 40% global results for context breadth
- [x] **Scale-aware query breadth**
  - Small repos: `topK = config.topK` (default 5) — broad search, more diverse results
  - Large repos: `topK = 10` — focused search + aggressive intent reranking to cut noise

---

## Key Decisions (v2)

- **Separate LanceDB tables** per record type — cleaner schemas, can rebuild one type independently
- **npm workspaces** (not turborepo/nx) — zero extra tooling for 3 packages
- **`git ls-files`** for code file discovery — respects .gitignore automatically
- **256-line chunks with 50-line overlap** for code — standard RAG practice
- **Octokit REST** (not GraphQL) — simpler, 3 endpoints is all we need
- **PR descriptions only** — high signal, low noise per design choice
- **Dynamic intent-based budget** — no static slot splits; IntentRouter classifies query → weighted reranking → greedy token fill
- **Repo-scale adaptation** — small repos get concurrent fetching + eager issue resolution; large repos get sequential fetching, hierarchical chunking, HNSW-SQ indices, and directory-scoped search. NO data truncation at any scale.
- **No-token graceful degradation** — PR indexing is additive; `[CODE]` + `[COMMIT]` always work, even without GitHub token

## Architecture Notes

- **Build split**: esbuild for Node host, Vite for React webview
- **LanceDB is native**: marked `external` in esbuild — ships via `node_modules`
- **Embeddings are local**: transformers.js runs all-MiniLM-L6-v2 in Node.js, no external API needed
- **Privacy**: vector search is 100% local. Only top-K snippets + user question go to LLM
- **API keys**: VS Code SecretStorage (extension) or env vars (CLI)
- **Incremental indexing**: `index-meta.json` stores `lastIndexedHash` for commits; `code-meta.json` stores file content hashes for code
- **Rebase safety**: `git cat-file -t <hash>` verifies hash exists before incremental
- **Paged extraction**: async generator yields 200-commit pages; embedding + DB writes happen per page then discard
- **Token budget**: `MAX_PROMPT_CHARS = 24000`; system + snippets are fixed cost; oldest history dropped first
- **Hierarchical code indexing**: large repos get 2-level embeddings — file summary (head+tail) for broad queries + 256-line detail chunks for specific queries
- **HNSW-SQ indices**: created on tables with 10K+ rows, compresses float32 → scalar quantized vectors for O(log n) search
- **Directory scoping**: large repo queries prioritize results near the active editor file; prevents irrelevant far-away code from dominating results

---

## Post-v2 Refinements ✅

> Iterative quality improvements discovered during live testing on a real project (Florafy — flower ecommerce SaaS, 347 commits, 1554 code chunks).

### Code Indexer Exclusions ✅
- [x] Added `EXCLUDED_DIRS` array to CodeIndexer: `.vscode/git-lore/`, `.git/`, `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `.output/`, `__pycache__/`, `.pytest_cache/`, `coverage/`, `.nyc_output/`, `.turbo/`, `.cache/`
- [x] Directory prefix check at top of `isExcluded()` — prevents embedding model cache, build outputs, etc. from being indexed

### Prompt Overflow & Rate Limit Handling ✅
- [x] Code snippets truncated to 3,000 chars in `buildPrompt()`
- [x] Hard safety cap on user message: `maxUserChars = MAX_PROMPT_CHARS - SYSTEM_PROMPT.length - 200`
- [x] OpenAI 429 rate limit: clean error message instead of raw stack trace

### Overview Intent ✅
- [x] Added 5th intent: `overview` — triggered by: about, overview, purpose, project, feature, summary, describe, tech stack, etc.
- [x] Overview weights: commit=0.6, code=1.8, pr=0.7 (heavily favors current code over old commits)
- [x] Removed generic words (`how`, `what`, `where`, `feature`) from implementation/historical signals to prevent misclassification
- [x] Doc file boosting for overview intent: README, package.json, index/app/main entry files ranked higher

### Intent-Aware Search Breadth ✅
- [x] Code always searches wide (topK × 4, minimum 20) — many more chunks than commits
- [x] Commits/PRs scale up (×2) for historical/debugging intents
- [x] Intent-aware diversity seeding: code first for overview/impl, commits first for hist/debug

### Small-to-Big Retrieval (Parent-Document Retrieval) ✅
- [x] `VectorStore.getCodeChunksForFiles()` — fetches all chunks for specific files via table filter
- [x] RAGEngine query step 4: top N unique code files get reconstructed from ordered chunks with overlap dedup
  - Overview/implementation/general: expand top 3 files
  - Historical/debugging: expand top 1 file
  - Each expanded file capped at 3,000 chars
- [x] `buildPrompt()` renders `[CODE – FULL FILE]` for expanded files, skips duplicate individual chunks
- [x] Greedy filler skips individual chunks for files that have expanded versions

### Project File Tree Injection ✅
- [x] `VectorStore.getAllUniqueFilePaths()` — fetches all unique file paths from code_files table
- [x] `RAGEngine.buildFileTree()` — converts flat paths into compact indented directory tree (capped at 4,000 chars)
- [x] Injected into prompt for `overview` and `general` intent queries
- [x] Gives LLM structural awareness of ALL features/modules, not just those that ranked high in vector search
