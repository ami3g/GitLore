# PLAN.md — Git-Lore Source of Truth

> Last updated: 2025-07-19

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
- **Token budget**: `MAX_PROMPT_CHARS = 120000` (110K snippets + 10K system/history); elastic dual-stream split by intent (e.g. 80% code / 20% commits for implementation queries)
- **Hierarchical code indexing**: large repos get 2-level embeddings — file summary (head+tail) for broad queries + 256-line detail chunks for specific queries
- **4 LanceDB tables**: commits (vector), code_files (vector), pr_data (vector), call_graph (relational — no vectors)
- **HNSW-SQ indices**: created on tables with 10K+ rows, compresses float32 → scalar quantized vectors for O(log n) search
- **AST-enriched embeddings**: code chunk embedding text prepended with `[DEFINES]`, `[IMPORTS]`, `[EXPORTS]` from tree-sitter analysis
- **Call graph resolution**: 3-level — same-file function lookup → import tracing → fuzzy method name match
- **Mermaid diagram generation**: 4 generators (architecture, callgraph, commits, PRs) with Mermaid syntax safety (reserved keyword handling, dangling edge guards)
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

### Rubric-Based Prompting ✅
- [x] 5-point ANSWER RUBRIC in system prompt: Evidence-Grounded, Cited, Complete, No Hallucination, Confidence Signal
- [x] Updated data type descriptions: `[CODE – FULL FILE]`, `Project File Structure`
- [x] Formatting rules: Markdown, code fences, short paragraphs, cite `[COMMIT:<hash>]` / `[FILE:<path>]` / `[PR:#<N>]`

---

## v3 — AST Analysis, Call Graphs & Mermaid Diagrams ✅

### Goal
Add a **tree-sitter-based static analysis layer** that extracts AST metadata (imports, exports, functions, classes, call sites) per file, builds a full transitive call graph, stores structural edges in a new LanceDB table, enriches code chunk embeddings, and powers new CLI commands that output **Mermaid diagrams** for codebase architecture, commit history, and PR/issue context.

### Phase 14: Tree-Sitter AST Extraction Service ✅
- [x] Add `web-tree-sitter` dependency to @gitlore/core
- [x] Grammar WASM files lazy-downloaded on first use and cached (CLI: `~/.gitlore/grammars/`, VS Code: `globalStorageUri`)
- [x] Supported grammars: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C, C++
- [x] Grammar WASMs fetched from official tree-sitter GitHub release URLs per language (verified versions)
- [x] Separate TS and JS queries — `type_identifier` for TS classes, `identifier` for JS classes
- [x] `failedLanguages` cache prevents error spam (logs once per language, not per file)
- [x] New `ASTService` class: `init()`, `parseFile(filePath, content, language) → FileSymbols`
- [x] S-expression queries: function/class declarations, call expressions, import/export statements
- [x] New types: `FileSymbols`, `SymbolInfo`, `CallSite`, `ImportInfo`, `ExportInfo`

### Phase 15: Call Graph Builder ✅
- [x] New `CallGraphService` class: `buildGraph(allSymbols) → CallEdge[]`
- [x] Resolution: same-file lookup → import tracing → fuzzy method name match
- [x] `getTransitiveClosure(entry) → BFS all reachable functions`
- [x] `getCallers(function) → reverse edges`
- [x] New `call_graph` LanceDB table (relational — no vector column): callerFile, callerName, calleeFile, calleeName, line
- [x] VectorStore: `createCallGraphTable()`, `upsertCallGraph()`, `queryCallGraph()`

### Phase 16: Enrich Code Chunks with AST Metadata ✅
- [x] Extend `CodeChunk` with optional: `functions?`, `classes?`, `imports?`, `exports?`
- [x] Update `CodeIndexer.chunkFile()` — parse full file via ASTService, tag each chunk with intersecting symbols
- [x] Update `CodeIndexer.toEmbeddingText()` — prepend `[DEFINES]`, `[IMPORTS]`, `[EXPORTS]` metadata
- [x] Extend `code_files` table schema with nullable metadata columns (backward-compatible)

### Phase 17: Mermaid Diagram CLI Commands ✅
- [x] New `MermaidService`: `generateCodeArchitecture()`, `generateCallGraph()`, `generateCommitTimeline()`, `generatePRIssueFlow()`
- [x] CLI commands: `gitlore diagram architecture`, `gitlore diagram callgraph [--entry <fn>]`, `gitlore diagram commits [--limit <n>]`, `gitlore diagram prs`
- [x] All output Mermaid syntax to stdout (pipeable)
- [x] Mermaid syntax fixes: root subgraph `.` → `root["root"]`, reserved keyword `external` → `ext_fns`, dangling edge guard (only emit edges where both endpoints declared)

### Phase 18: Structural Context in RAG Query ✅
- [x] Update `RAGEngine.query()` — fetch FileSymbols for expanded files, build structural context section
- [x] Update `buildPrompt()` — accept optional `structuralContext` parameter, insert between code and file tree
- [x] Update system prompt DATA TYPES — add `[STRUCTURE]` description

### Key Decisions (v3)
- **web-tree-sitter** over native tree-sitter: avoids node-gyp, works in VS Code WASM sandbox. Slower parsing acceptable for indexing.
- **Official tree-sitter GitHub releases** for grammar WASMs — per-language URLs verified against actual release pages (e.g., typescript v0.23.2, javascript v0.25.0, python v0.25.0)
- **Separate TS/JS queries**: TypeScript uses `type_identifier` for class names; JavaScript uses `identifier` (no `type_identifier` in JS grammar)
- **Call graph in separate table** (no vectors): edges are relational, not semantic.
- **Mermaid to stdout**: pipeable, no rendering dependency.
- **Full transitive closure at query time via BFS**: keeps storage small, always fresh.
- **AST metadata is additive**: nullable columns, no forced reindex of existing data.
- **`failedLanguages` caching**: download/query failures cached per language — logs once, then silently skips remaining files of that language

### Post-v3 Refinements ✅
- [x] `mergedBy` field added to PRChunk, GitHubService, and VectorStore — tracks who merged each PR
- [x] RAG budget tuned: `MAX_PROMPT_CHARS` 24K→60K, `EXPAND_FILES` 3→5, `MAX_EXPAND_CHARS` 3K→6K, default `topK`→10
- [x] Added `--top-k` flag to CLI `query` command (configurable retrieval depth)
- [x] LanceDB path mismatch fixed in diagram commits/prs commands (`lancedb` → `db`)
- [x] Tested live on Express repo: 12,889 commits, 275 code chunks, 2,443 PRs, 141 AST-parseable files, 11,404 call graph edges

---

## v4 — Elastic Budgets, Cross-Symbol Expansion & AST-Tagged Indexing ✅

### Goal
Transform the query pipeline from fixed-budget greedy filling into an **intent-driven elastic dual-stream** system. Populate **AST metadata directly during indexing** (not just at embedding enrichment time). Add **cross-symbol contextual expansion** so the LLM always sees complete implementations of every queried symbol — even when they span multiple chunks.

### Phase 19: Elastic Dual-Stream Budgets ✅
- [x] `MAX_PROMPT_CHARS` 60K → **120K** (110K snippets + 10K system/history reserve)
- [x] New `CODE_BUDGET_RATIOS` per intent: implementation=0.80, overview=0.70, general=0.50, historical=0.20, debugging=0.20
- [x] `codeBudget = snippetBudget × codeBudgetRatio`; `commitBudget = snippetBudget - codeBudget`
- [x] Greedy filling: primary stream fills first, overflow spills into secondary stream — no context wasted
- [x] `EXPAND_FILES` now intent-aware: 5 (overview/implementation/general), 3 (historical/debugging)
- [x] `MAX_EXPAND_CHARS` 6K → **18,000** per expanded file

### Phase 20: Content-Aware Symbol Discovery ✅
- [x] Extract `querySymbols[]` from function-call syntax in the question: `func()` → captures name
- [x] `CORE_LOOP_RE` keywords: `middleware`, `handler`, `route`, `controller`, `dispatch`, `render`, `serve`
- [x] Extract `mentionedFiles[]` via regex: recognizes `path/file.ext` patterns in the question
- [x] Symbol-matching chunks boosted 60% (multiply distance by 0.4)
- [x] File-mention chunks boosted 70% (multiply distance by 0.3)
- [x] Mentioned files force-expanded regardless of vector rank via `getAllUniqueFilePaths()` resolution

### Phase 21: Contextual File Expansion ✅
- [x] Parent function walk: for closures like `next()` inside `handle()`, detect parent-child via AST metadata + content scan
- [x] All chunks belonging to a parent function get expanded together
- [x] Non-hit chunks collapsed to one-line skeletons: `// --- Lines 1-256: fn createApp() | imports: http, path ---`
- [x] Skeleton lines show function/class/import names from AST metadata when available

### Phase 22: Cross-Symbol Expansion ✅
- [x] Force-expand ANY chunk defining a queried symbol — not just parent-child relationships
- [x] Example: query "trace res.json() through res.send()" → `json()` in chunk A (lines 200-456) and `send()` in chunk B (lines 1-256) both expanded
- [x] Works via `contextExpandedKeys.add()` for symbol-defining chunks regardless of search rank

### Phase 23: AST Metadata Population During Indexing ✅
- [x] `CodeIndexer.indexAll()` now accepts optional 4th parameter: `ASTService`
- [x] When provided, each file is parsed with `astService.parseFile()` before chunking
- [x] `FileSymbols` passed to `chunkFile()` → `tagChunkWithAST()` intersects symbol ranges with chunk line ranges
- [x] Metadata stored in LanceDB `code_files` table: `functions` (JSON), `classes` (JSON), `imports` (JSON), `exports` (JSON)
- [x] `RAGEngine.indexCode()` creates `ASTService` upfront, passes to `indexAll()`, then reuses for `buildCallGraph()`

### Phase 24: Anchor File Persistence ✅
- [x] For implementation queries, top 3 most-connected files by call-graph degree centrality always in expansion set
- [x] Hub files (e.g. `app.ts`, `index.js`) included even if their vector rank is low

### Phase 25: LanceDB Query Fix ✅
- [x] LanceDB DataFusion WHERE clause silently returns 0 rows for camelCase column names (e.g. `"filePath"`)
- [x] Replaced SQL WHERE filter in `getCodeChunksForFiles()` with JS-side `Set` filtering: load all rows, filter in memory
- [x] Reliable at all scales — no dependency on DataFusion's column name handling

### Phase 26: Intent-Aware Recency Decay + Temporal Anchoring ✅
- [x] New `RECENCY_DECAY_RATES` per intent: implementation=0.40, overview=0.30, general=0.20, debugging=0.15, historical=0.00
- [x] `DECAY_HALF_LIFE_YEARS = 2` — a 2-year-old result gets penalty = decayRate × 1.0; cap at 3× half-life (6 years)
- [x] `rerank()` applies `distance × (1 + decayRate × ageFraction)` to commit/PR results
- [x] Code results are immune (they represent current state, not historical)
- [x] Historical intent gets `decayRate = 0` — old PRs/commits are preserved because they're the answer
- [x] `IntentWeights.recencyDecay` blended via soft-max distribution, same as all other weights
- [x] `getResultDate()` extracts date from commit (`chunk.date`) or PR (`chunk.mergedAt || chunk.createdAt`)
- [x] Prevents "hallucination fuel" from stale commits about replaced frameworks ranking above current-era context
- [x] **Temporal anchor extraction**: `extractTemporalAnchor()` parses time references from query text
  - Bare years: "2022" → July 1, 2022
  - Month+year: "March 2022" → March 15, 2022
  - Relative: "3 months ago", "2 years ago", "last year", "last month"
  - Vague recency: "recently", "lately" → ~1 month ago
- [x] **Proximity-to-anchor scoring**: when temporal anchor is present, replaces recency-from-now decay
  - `distance × (1 + 0.50 × min(|distFromAnchor| / 1.5 years, 3))` — results near the referenced era rank highest
  - Both newer AND older results are penalized (bidirectional)
  - Works for ALL intents — "how did auth work in 2022?" prefers 2022 commits even for implementation intent
- [x] `IntentWeights.temporalAnchor: Date | null` field added to interface

### Key Decisions (v4)
- **JS-side filtering over SQL WHERE**: LanceDB's DataFusion backend can't handle camelCase column names reliably — double-quoted returns 0, unquoted lowercases. JS-side Set filtering is correct and fast enough for code tables (typically <10K rows).
- **120K prompt budget**: Modern LLMs handle long context well. More context = fewer hallucinations. 110K for snippets is generous enough to include multiple expanded files + dozens of commit chunks.
- **Intent-driven budget split**: An implementation question should be 80% code, not 50/50. Historical questions should be 80% commits. The intent router now controls this directly.
- **Cross-symbol expansion**: Essential for trace queries like "how does res.json() relate to res.send()". Without it, the LLM only sees the highest-ranked chunk and misses the second symbol's implementation.
- **AST metadata at index time**: Moving AST parsing into `indexAll()` means metadata is persisted in LanceDB, not just used for embedding enrichment. This enables downstream features (skeleton lines, symbol-based expansion) without re-parsing files at query time.
- **Intent-aware recency decay**: Blanket age penalties would sabotage historical queries. The decay rate is soft-max-blended from the intent distribution, so a 49% historical + 51% implementation query still respects old results while mildly preferring recent ones. The 2-year half-life with 3× cap ensures very old results are pushed down, not eliminated.
- **Temporal anchoring over blanket decay**: When a query says "in 2022", disabling decay isn't enough — we need to actively PREFER 2022-era results. Proximity-to-anchor scoring penalizes distance from the referenced era bidirectionally (both older and newer), so the right time period always wins regardless of intent.

### Commits
- `2f18783` — Content-aware symbol discovery
- `11e2b72` — File mention extraction and boosting
- `c4fa27b` — Elastic dual-stream budgets
- `0e48261` — Contextual expansion (parent function walk)
- `83725b4` — Anchor file persistence
- `01ed25e` — Non-hit chunk skeletons
- `43cf466` — Structural context (call graph + co-change + freshness)
- `d623b94` — JS-side filtering fix for LanceDB camelCase columns
- `b9e2c4a` — AST metadata population during indexing
- `46ccda9` — Cross-symbol expansion

### Verified On
- **Express.js repo** (Express 5): 12,889 commits, 116 code files, 2,443 PRs, 11,404 call edges
- Queries tested: implementation trace (`res.json()`), security history, cross-file symbol discovery
- All expanded files show AST metadata (functions, classes, imports) correctly
- Elastic budgets adapt: 80/20 code/commit for impl, 50/50 for general, 20/80 for historical
