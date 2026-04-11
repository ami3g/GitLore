# Git-Lore

**Chat with your repository's entire history, codebase, and PRs.** Privacy-first, RAG-powered project intelligence — as a VS Code extension or CLI tool.

Git-Lore indexes your commit history, current source files, GitHub PRs, and the static call graph into a local vector database, then answers natural-language questions backed by real evidence from your repo. Embeddings and vector search run entirely on your machine — only the final top-K snippets are sent to the LLM.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [VS Code Extension](#vs-code-extension)
- [Configuration](#configuration)
- [Query Pipeline Deep Dive](#query-pipeline-deep-dive)
- [Indexing Pipeline](#indexing-pipeline)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Battle-Tested: Express.js Stress Tests](#battle-tested-expressjs-stress-tests)
- [Privacy & Security](#privacy--security)
- [Development](#development)
- [License](#license)

---

## How It Works

```
 ┌────────────┐   ┌────────────┐   ┌────────────┐
 │  Git Log   │   │ Source Files│   │ GitHub PRs │
 │  (commits) │   │ (code)     │   │ (issues)   │
 └─────┬──────┘   └─────┬──────┘   └─────┬──────┘
       │                 │                 │
       ▼                 ▼                 ▼
 ┌──────────────────────────────────────────────┐
 │       Extraction & Chunking Layer            │
 │                                              │
 │  GitProcessor    CodeIndexer    GitHubService │
 │  • file-level    • 256-line     • PR desc    │
 │    diff chunks     windows      • linked     │
 │  • smart          + 50-line       issues     │
 │    truncation      overlap      • resolution │
 │  • 57-rule       • AST-tagged     metadata   │
 │    exclusions      chunks       • merged-by  │
 │                  • hierarchical              │
 │                    summaries                 │
 │                    (large repos)             │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │          ASTService (web-tree-sitter)        │
 │  9 languages · WASM grammars (lazy-loaded)   │
 │  Functions, classes, imports, exports, calls  │
 │  → FileSymbols per file                      │
 │  → CallGraphService: static + co-change edges│
 │  → Chunk-level metadata tagging              │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │         EmbeddingService (local)             │
 │  all-MiniLM-L6-v2 · 384-dim · q8 quantized  │
 │  Batch 32 · Runs entirely in Node.js         │
 │  AST metadata prepended: [DEFINES]/[IMPORTS] │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │           VectorStore (LanceDB)              │
 │                                              │
 │  ┌────────┐ ┌─────────┐ ┌───────┐ ┌───────┐ │
 │  │commits │ │code_files│ │pr_data│ │call_  │ │
 │  │        │ │+AST meta │ │       │ │graph  │ │
 │  └────────┘ └─────────┘ └───────┘ └───────┘ │
 │                                              │
 │  • HNSW-SQ indices for large repos (10K+)    │
 │  • Directory-scoped search with bubble-up    │
 │  • Call graph: relational edges (no vectors) │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │             Query Pipeline                   │
 │                                              │
 │  Question → IntentRouter (5 intents)         │
 │    → Vector search (3 tables, weighted)      │
 │    → Symbol discovery + file mention boost   │
 │    → Smart file expansion (Small-to-Big)     │
 │    → Cross-symbol contextual expansion       │
 │    → Elastic dual-stream budget filling      │
 │    → Structural context (call graph + age)   │
 │    → LLM → Streamed answer with citations    │
 └──────────────────────────────────────────────┘
```

### The Four Data Streams

| Stream | Source | What's Indexed | Best For |
|--------|--------|----------------|----------|
| **[COMMIT]** | `git log` + diffs | Per-file diff chunks with author, date, message | "When was X changed?", "Who added this?" |
| **[CODE]** | `git ls-files` | 256-line chunks with AST metadata (functions, classes, imports, exports) | "How does auth work?", "Where is X defined?" |
| **[PR]** | GitHub API | PR descriptions, linked issues, merge status, merged-by author | "What was the goal of this feature?" |
| **[STRUCTURE]** | tree-sitter AST + call graph | Static call edges, co-change coupling, freshness labels | "What calls this function?", "Show the architecture" |

---

## Quick Start

### VS Code Extension

```bash
git clone https://github.com/ami3g/GitLore.git
cd GitLore
npm install
npm run compile
# Press F5 in VS Code → Extension Development Host
```

1. Open any project with Git history
2. Click the **Git-Lore** icon in the activity bar
3. Click **"Index Repo"** — indexes commits + code + PRs + call graph
4. Ask questions in the chat sidebar

### CLI Tool

```bash
cd packages/cli
npm run build

# Navigate to any repo
cd ~/my-project

# Full index (commits + code + PRs + call graph)
gitlore index --depth 1000

# Ask questions
gitlore query "how does the auth middleware work?"
gitlore query "what security fixes were made recently?" --top-k 20

# Check what's indexed
gitlore status
```

---

## CLI Reference

| Command | Description | Options |
|---------|-------------|---------|
| `gitlore index` | Full pipeline: commits + code + PRs + call graph | `--depth <n>` (default: 1000, 0 = unlimited) |
| `gitlore index-code` | Re-index only source files (fast, incremental) | — |
| `gitlore index-prs` | Re-index only PRs from GitHub | — |
| `gitlore query <question>` | Ask about the repository | `--top-k <n>` (default: 10) |
| `gitlore standup` | Summarize recent changes | — |
| `gitlore status` | Show index statistics | — |
| `gitlore clear` | Delete the local index | — |
| `gitlore diagram architecture` | Mermaid file/module structure diagram | — |
| `gitlore diagram callgraph` | Mermaid call graph | `--entry <function>` |
| `gitlore diagram commits` | Mermaid commit timeline | `--limit <n>` (default: 30) |
| `gitlore diagram prs` | Mermaid PR/issue flow | — |

All diagram commands output Mermaid syntax to stdout — pipe to a file or clipboard.

---

## VS Code Extension

### Commands

| Command | Description |
|---------|-------------|
| **Git-Lore: Index Repository** | Full pipeline: commits + code + PRs + call graph |
| **Git-Lore: Index Code Files** | Re-index only source files (fast) |
| **Git-Lore: Clear Index** | Delete the local vector database |
| **Git-Lore: Set OpenAI API Key** | Store key in VS Code SecretStorage |
| **Git-Lore: What's Changed?** | Standup summary of recent commits |
| **Git-Lore: Explain This Change** | Right-click a line → blame → RAG query |

### Live Commit Detection

The extension watches `.git/refs/` for changes (push, pull, fetch, local commits). When new commits are detected, it prompts: "New commits detected. Update the index?" — keeping your index fresh without manual re-runs.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gitlore.llmProvider` | `"ollama"` | `"ollama"` (fully local) or `"openai"` (cloud) |
| `gitlore.ollamaEndpoint` | `http://localhost:11434` | Ollama server URL |
| `gitlore.ollamaModel` | `llama3.2` | Ollama model name |
| `gitlore.openaiModel` | `gpt-4o` | OpenAI model name |
| `gitlore.commitDepth` | `1000` | Max commits to index (0 = unlimited) |
| `gitlore.topK` | `5` | Results per query (small repos) |
| `gitlore.githubRepo` | *(auto-detected)* | Override `owner/repo` for PR indexing |

**CLI:** reads from `.gitlore.json` in the project root or environment variables (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `GITLORE_LLM_PROVIDER`, `GITLORE_OLLAMA_MODEL`, etc.).

### LLM Providers

**Ollama (default — fully local & private):**
```bash
ollama pull llama3.2
# Git-Lore connects to http://localhost:11434 by default
```

**OpenAI:**
```bash
# VS Code: run "Git-Lore: Set OpenAI API Key"
# CLI: export OPENAI_API_KEY=sk-...
```

**GitHub Token (for PR indexing):**
```bash
# VS Code: stored in SecretStorage
# CLI: export GITHUB_TOKEN=ghp_...
```
PR indexing works without a token on public repos (60 req/hr). For private repos or higher limits, provide a token. Commits + code always work without any token.

---

## Query Pipeline Deep Dive

Every question goes through a multi-stage retrieval pipeline designed to maximize the relevance and completeness of context sent to the LLM.

### 1. Intent Classification

The `IntentRouter` classifies each question into one of 5 intents using keyword analysis with soft-max blending:

| Intent | Example Queries | Code Budget | Commit Budget |
|--------|----------------|-------------|---------------|
| **Implementation** | "how does login work?", "trace the request flow" | 80% | 20% |
| **Overview** | "what is this project?", "describe the tech stack" | 70% | 30% |
| **General** | "explain this module" | 50% | 50% |
| **Historical** | "why was auth rewritten?", "who changed this?" | 20% | 80% |
| **Debugging** | "what broke the tests?", "find the regression" | 20% | 80% |

Each intent also controls per-source-type boost weights for reranking:

| Intent | Commit Boost | Code Boost | PR Boost |
|--------|-------------|------------|----------|
| Overview | 0.6× | 1.8× | 0.7× |
| Historical | 1.2× | 0.8× | 1.5× |
| Implementation | 0.8× | 1.5× | 0.9× |
| Debugging | 1.5× | 1.2× | 0.7× |
| General | 1.0× | 1.0× | 1.0× |

Each intent also controls **recency decay** — how aggressively stale commits and PRs are penalized during reranking:

| Intent | Recency Decay | Rationale |
|--------|--------------|-----------|
| Implementation | 0.40 (strong) | Old commits about replaced code are hallucination fuel |
| Overview | 0.30 (moderate) | Prefer the current state of the project |
| General | 0.20 (light) | Mild preference for recent context |
| Debugging | 0.15 (mild) | Recent regressions matter, but old root causes too |
| Historical | 0.00 (none) | Old PRs and commits are exactly what was asked for |

Decay formula: `distance × (1 + decayRate × min(ageYears / 2, 3))`. A 4-year-old commit with decayRate 0.40 gets a 0.80× distance penalty — pushed down but not eliminated. Historical queries bypass decay entirely.

### 2. Vector Search (commits, code_files, pr_data) simultaneously. For large repos, code search is 60% directory-scoped (near the active file) + 40% global.

### 3. Symbol Discovery & File Mention Extraction

Before reranking, the pipeline extracts:
- **Query symbols**: function names from `func()` syntax in the question (e.g. "res.json()" → `json`, `send`)
- **Mentioned files**: file paths from the question (e.g. "lib/response.js")

Chunks containing queried symbols get a 60% score boost. Chunks from mentioned files get a 70% boost. Mentioned files are force-expanded regardless of their vector rank.

### 4. Smart File Expansion (Small-to-Big)

Vector search finds the best 256-line chunk, then Git-Lore fetches **all chunks** for that file and reconstructs full context:
- Implementation/overview/general: top **5 files** expanded
- Historical/debugging: top **3 files** expanded
- Each expanded file capped at **18,000 chars**

Non-hit chunks are collapsed into one-line skeletons showing just their symbols:
```
// --- Lines 1-256: fn createApp() | fn lazyRouter() | imports: http, path ---
```

### 5. Cross-Symbol Contextual Expansion

When the query mentions multiple related symbols (e.g. "trace res.json() through res.send()"), the pipeline force-expands **every chunk** that defines a queried symbol — even if they're in different 256-line windows of the same file. This ensures the LLM sees complete implementations, not just the chunk that scored highest.

For nested closures (e.g. `next()` defined inside `handle()`), the pipeline detects parent-child function relationships using both AST metadata and content scanning, then expands all chunks belonging to the parent function.

### 6. Structural Context (Call Graph + Freshness)

For each expanded file, the pipeline injects a `[STRUCTURE]` block showing:
- **Static call edges**: who this file calls, who calls it (up to 15 each)
- **Co-change coupling**: files that historically change together (evolutionary coupling with recency decay, half-life = 365 days)
- **Freshness labels**: last modified date + classification (Modern < 6mo, Recent 6-18mo, Stale > 18mo)

### 7. Elastic Dual-Stream Budget

Total prompt budget: **120,000 chars** (110K for snippets, 10K reserved for system prompt + history).

The budget splits between code and commit streams based on intent:
- Implementation query → 80% code / 20% commits
- Historical query → 20% code / 80% commits

Greedy filling: the primary stream fills first, then overflow spills into the secondary stream. No context is wasted.

### 8. Anchor File Persistence

For implementation/trace queries, the top 3 most-connected files in the call graph (highest degree centrality) are always included in the expansion set — even if their vector rank is low. This ensures "hub" files like `app.ts` or `index.js` are always visible to the LLM.

---

## Indexing Pipeline

### Code Indexing

1. **File discovery**: `git ls-files` respects `.gitignore`, plus 57 exclusion rules (binaries, lockfiles, secrets, build outputs, `node_modules/`, `.git/`, etc.)
2. **Chunking**: 256-line windows with 50-line overlap. Documentation files (README, CONTRIBUTING, etc.) use 1024-line windows.
3. **AST parsing**: Each file is parsed with tree-sitter (9 languages). Functions, classes, imports, and exports are tagged onto each chunk with line-range intersection.
4. **Hierarchical summaries** (large repos only): Files > 256 lines also get a summary chunk (head 80 + tail 40 lines + stats).
5. **Embedding**: `[DEFINES] fn1, fn2 [IMPORTS] mod1, mod2 [EXPORTS] exp1` prepended to chunk text before embedding.
6. **Incremental**: SHA-256 content hashes per file — only re-chunks/re-embeds changed files.

### Commit Indexing

1. **Extraction**: `git log` with file-level diffs (one chunk per file changed per commit).
2. **Smart truncation**: Code files get 3,000 chars, medium files 1,500, config/docs 600.
3. **Paged processing**: Async generator yields 200-commit pages — embed + write + discard per page (constant memory).
4. **Incremental**: Tracks last indexed commit hash; new indexes start from where the previous one left off.
5. **Rebase safety**: Verifies stored hash exists via `git cat-file`; auto-rebuilds if history was rewritten.

### Call Graph

1. **Static edges**: Tree-sitter AST → function definitions + call sites → 3-level resolution (same-file → import tracing → fuzzy method match).
2. **Co-change edges**: Commit history → files that are often modified together → evolutionary coupling with exponential decay (half-life = 365 days).
3. **Stored relationally**: The `call_graph` table has no vector column — just caller/callee file+name pairs.

### PR/Issue Indexing

1. **GitHub API**: Fetches all PRs (no page caps), descriptions, linked issues, merge metadata.
2. **Small repos**: Concurrent page fetches (3 pages in parallel), eager issue title resolution.
3. **Large repos**: Sequential fetches (rate-limit safe), issue numbers only.
4. **Incremental**: Tracks last fetch timestamp; only fetches PRs merged after that date.

---

## Architecture

```
gitlore/
├── packages/
│   ├── core/                 @gitlore/core — framework-agnostic engine
│   │   └── src/
│   │       ├── services/
│   │       │   ├── RAGEngine.ts         Orchestrator: index + query + summarize
│   │       │   ├── IntentRouter.ts      5-intent classifier + elastic budgets
│   │       │   ├── GitProcessor.ts      Git log extraction, file-level chunking
│   │       │   ├── CodeIndexer.ts       Source file chunking + AST tagging
│   │       │   ├── ASTService.ts        Tree-sitter parsing (9 languages)
│   │       │   ├── CallGraphService.ts  Static + co-change call graph
│   │       │   ├── MermaidService.ts    4 Mermaid diagram generators
│   │       │   ├── GitHubService.ts     PR/issue fetching via Octokit
│   │       │   ├── EmbeddingService.ts  all-MiniLM-L6-v2 (transformers.js)
│   │       │   ├── VectorStore.ts       LanceDB (4 tables + SQ indices)
│   │       │   └── llm/
│   │       │       ├── OpenAIProvider.ts
│   │       │       └── OllamaProvider.ts
│   │       ├── types/index.ts
│   │       └── config.ts
│   │
│   ├── vscode/               VS Code extension — thin config/UI layer
│   │   ├── src/
│   │   │   ├── extension.ts             Activation, commands, file watcher
│   │   │   └── providers/
│   │   │       └── ChatViewProvider.ts  Webview bridge, config injection
│   │   └── webview/                     React 18 sidebar (Chat UI)
│   │
│   └── cli/                  Terminal tool
│       └── src/index.ts                 Commander entry point
│
├── package.json              npm workspaces root
└── tsconfig.base.json
```

### Data Flow

**Indexing** (one-time, then incremental):

```
git log ──→ GitProcessor ──→ CommitChunks ────┐
                                               │
git ls-files ──→ CodeIndexer ──┐               ├─→ EmbeddingService ──→ VectorStore
                               │               │         (LanceDB)
            ASTService ────────┤               │
            (tree-sitter)      │               │
                               ▼               │
                          CodeChunks ──────────┘
                          (AST-tagged)         │
                                               │
GitHub API ──→ GitHubService ──→ PRChunks ─────┘
                                               │
ASTService ──→ CallGraphService ──→ CallEdges ─┘
                (static + co-change)
```

**Querying** (every question):

```
Question
  │
  ├── embed(question)
  │     ├── search(commits)
  │     ├── searchCode(code_files)  ← directory-scoped for large repos
  │     └── searchPR(pr_data)
  │
  ├── IntentRouter.classify(question) → weights + codeBudgetRatio
  │
  ├── Symbol discovery: extract function names + file paths from question
  │     └── Boost matching chunks (60% symbol, 70% file mention)
  │
  ├── Rerank all results by intent-weighted distance
  │
  ├── Smart expansion: top N files → all chunks → full context
  │     ├── Cross-symbol expansion (json → send in same file)
  │     ├── Parent-function expansion (next inside handle)
  │     └── Anchor files: top 3 hub files by call-graph degree
  │
  ├── Structural context: call edges + co-change + freshness per file
  │
  ├── Elastic budget: code + commit streams filled per intent ratio
  │
  └── buildPrompt() → LLM → streamed answer with citations
```

### Local Storage

```
.vscode/git-lore/
├── db/                LanceDB vector database (4 tables)
├── grammars/          Cached tree-sitter WASM grammars (~1MB each)
├── models/            Cached embedding model (~80MB, downloaded once)
├── index-meta.json    Last indexed commit hash
├── code-meta.json     File content hashes (incremental code)
├── pr-meta.json       Last PR fetch timestamp
└── sq-enabled         Marker file when SQ indices are active
```

Add `.vscode/git-lore/` to your `.gitignore`.

---

## Tech Stack

| Component | Library | Role |
|-----------|---------|------|
| Git extraction | `simple-git` | Commit log, diffs, blame, ls-files |
| AST parsing | `web-tree-sitter` | 9 languages: TS, TSX, JS, Python, Go, Rust, Java, C, C++ |
| Embeddings | `@huggingface/transformers` | all-MiniLM-L6-v2, 384-dim, q8 quantized, runs in Node.js |
| Vector DB | `@lancedb/lancedb` | 4 tables, HNSW-SQ indexing, in-process (no server) |
| GitHub API | `@octokit/rest` | PR descriptions, linked issues, merge metadata |
| LLM (local) | Ollama REST API | NDJSON streaming, any local model |
| LLM (cloud) | `openai` SDK | Streaming chat completions |
| CLI | `commander` | Terminal commands |
| UI | React 18 + Vite | VS Code sidebar chat interface |
| Bundler | esbuild | Node CJS bundle, LanceDB external |

### Large Repo Scaling

Repos with 5,000+ commits are automatically handled differently:

| Feature | Small Repos | Large Repos (5K+ commits) |
|---------|------------|--------------------------|
| Code chunks | 256-line windows | + file-level summary chunks |
| Vector index | Brute-force search | HNSW-SQ (scalar quantization) on 10K+ row tables |
| Search scope | Global top-K | 60% directory-scoped + 40% global |
| PR fetching | 3 pages concurrent, eager issue titles | Sequential, issue numbers only |
| Query breadth | `topK` from config | Fixed 10 — focused + aggressive reranking |

**No data truncation at any scale.** All commits, all code, all PRs are indexed. The scaling strategy is smarter search, not less data.

---

## Battle-Tested: Express.js Stress Tests

Git-Lore was validated against the **Express.js repository** (12,889 commits, 116 source files, 2,443 PRs, 11,404 call graph edges) — one of the most architecturally complex Node.js projects. Each test targets a known failure mode of standard RAG systems.

### 1. The "Ghost in the Machine" Test — Closure Identification

**Challenge:** Trace the `next()` iterator inside `lib/router/index.js`.

In Express, `next` isn't a top-level function — it's a closure buried deep inside `proto.handle`. Most RAG systems grab a random 20-line snippet and lose the surrounding loop context entirely.

**Result:** Contextual Expansion (Step 4) detected that `next()` is defined inside `proto.handle`, walked up to the parent function, and expanded the entire `while` loop plus the recursive dispatch logic. The LLM correctly identified that Express 4.x routing is entirely synchronous.

### 2. The "Architecture Trace" Test — Cross-File Dependency

**Challenge:** Trace a request from `express.js` → `application.js` → `response.js`.

This requires the engine to understand **prototype injection** — `res.send()` is defined in `response.js` but "magically" attached to the app object in `application.js` via `Object.setPrototypeOf`.

**Result:** Anchor File Persistence (Step 4b) forced expansion of the top hub files by call-graph degree centrality. The LLM saw the `Object.setPrototypeOf` calls that wire the three files together, and correctly explained the prototype chain.

### 3. The "Historical Narrative" Test — The Budget Flip

**Challenge:** Identify security changes and the reverted CVE-2024-51999 patch.

Standard RAG only looks at the current code. It has no awareness that a security patch was added and then *removed* because it was erroneous.

**Result:** The Elastic Budget (Step 7) flipped to 80% commits / 20% code for this historical query. The engine surfaced the PR discussions and commit messages that explained *why* the patch was reverted — the narrative behind the code, not just the code itself.

### 4. The "Logical Handoff" Test — Symbol Discovery

**Challenge:** Trace `res.json()` through `res.send()`.

These functions live in the same file but hundreds of lines apart. Standard 256-line chunking provides one or the other, but rarely both in a way that shows the handoff.

**Result:** Symbol Discovery (Step 3) identified both `json` and `send` as queried symbols. Cross-Symbol Expansion (Step 5) force-expanded both chunks regardless of their vector rank. The LLM explained how `res.json()` pre-sets the `Content-Type` header before `res.send()` begins serialization.

---

## Privacy & Security

- **Embeddings are 100% local** — transformers.js runs all-MiniLM-L6-v2 in Node.js. No data leaves your machine during indexing.
- **Vector search is 100% local** — LanceDB runs in-process with no server.
- **Only top-K snippets go to the LLM** — typically 20-30 snippets plus your question. Raw diffs, full source files, and the vector database never leave your machine.
- **API keys stored securely** — VS Code SecretStorage for the extension, environment variables for CLI.
- **No telemetry, no analytics, no cloud services** — everything runs on your hardware (except the LLM API call if using OpenAI).

---

## Development

```bash
# Install all dependencies (npm workspaces)
npm install

# Build everything (core → extension → webview)
npm run compile

# Watch extension (Node side)
npm run watch:extension

# Watch webview (React side)
npm run dev:webview

# Type-check core
cd packages/core && npx tsc --noEmit

# Launch extension: press F5 in VS Code
```

---

## License

MIT
