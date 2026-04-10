# Git-Lore

**Chat with your repository's entire history, codebase, and PRs.** Privacy-first, RAG-powered project intelligence — as a VS Code extension or CLI tool.

Git-Lore indexes your commit history, current source files, and GitHub PRs/issues into a local vector database, then lets you ask natural-language questions backed by real evidence from your repo.

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
 │  • 57-rule       • hierarchical   metadata   │
 │    exclusions      summaries                 │
 │                    (large repos)             │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │         EmbeddingService (local)             │
 │  all-MiniLM-L6-v2 · 384-dim · q8 quantized  │
 │  Batch 32 · Runs entirely in Node.js         │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │           VectorStore (LanceDB)              │
 │                                              │
 │  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
 │  │ commits  │ │code_files│ │ pr_data  │     │
 │  └──────────┘ └──────────┘ └──────────┘     │
 │                                              │
 │  • HNSW-SQ indices for large repos (10K+)    │
 │  • refineFactor(3) for SQ rescoring          │
 │  • Directory-scoped search with bubble-up    │
 └────────────────────┬─────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────┐
 │                Query Flow                    │
 │                                              │
 │  User Question                               │
 │       │                                      │
 │       ▼                                      │
 │  IntentRouter (classify → weight)            │
 │  "why was auth changed?" → historical        │
 │  "how does login work?" → implementation     │
 │  "what broke the tests?" → debugging         │
 │  "what is this project?" → overview          │
 │       │                                      │
 │       ▼                                      │
 │  Vector search all 3 tables                  │
 │  (directory-scoped for large repos)          │
 │       │                                      │
 │       ▼                                      │
 │  Weighted reranking by intent                │
 │       │                                      │
 │       ▼                                      │
 │  Small-to-Big file expansion                 │
 │  (top N files → full context)                │
 │       │                                      │
 │       ▼                                      │
 │  Greedy token filling (60% of 24K budget)    │
 │       │                                      │
 │       ▼                                      │
 │  File tree injection (overview/general)      │
 │       │                                      │
 │       ▼                                      │
 │  LLM (Ollama local / OpenAI cloud)           │
 │       │                                      │
 │       ▼                                      │
 │  Streamed answer with citations              │
 └──────────────────────────────────────────────┘
```

### The Three Data Types

| Type | Source | What's Indexed | Best For |
|------|--------|----------------|----------|
| **[COMMIT]** | `git log` + diffs | Per-file diff chunks with author, date, message | "When was X changed?", "Who added this?", "Why was this rewritten?" |
| **[CODE]** | `git ls-files` | 256-line chunks of current source code | "How does the auth module work?", "Where is X defined?" |
| **[PR]** | GitHub API | PR descriptions, linked issues, merge status | "What was the goal of this feature?", "Which issue did this fix?" |

### Intent-Based Routing

When you ask a question, the `IntentRouter` classifies it into one of 5 intents and boosts the relevant data type:

| Intent | Trigger Words | Boost |
|--------|--------------|-------|
| **Overview** | about, overview, purpose, project, summary, describe, tech stack | Code × 1.8, Commit × 0.6 |
| **Historical** | why, when, who, history, decision, rationale | PR × 1.5, Commit × 1.2 |
| **Implementation** | function, class, architecture, module, component | Code × 1.5 |
| **Debugging** | bug, fix, error, broken, regression, revert | Commit × 1.5, Code × 1.2 |
| **General** | (no strong signal) | All × 1.0 (balanced) |

Results are reranked by intent weights, then greedily packed into the prompt until the token budget is full — no hard limits per data type.

### Smart Retrieval

**Small-to-Big Expansion:** Vector search finds the best 256-line chunk, then Git-Lore fetches ALL chunks for that file and reconstructs the full context. The LLM sees complete modules, not isolated fragments.
- Overview/implementation queries: top 3 files expanded
- Historical/debugging queries: top 1 file expanded
- Each expanded file capped at 3,000 chars

**Project File Tree:** For overview and general queries, a compact directory tree of all indexed source files is injected into the prompt. This gives the LLM structural awareness of features and modules even if their code didn't rank in the top vector search results.

**Doc File Boosting:** For overview queries, README, package.json, and entry point files (index.ts, app.ts, main.ts) are boosted in ranking.

### Large Repo Scaling

Repos with 5,000+ commits are automatically detected and handled differently:

| Feature | Small Repos | Large Repos (5K+ commits) |
|---------|------------|--------------------------|
| **PR fetching** | 3 pages concurrent, eager issue titles | Sequential, issue numbers only |
| **Code chunks** | 256-line windows | + file-level summary chunks (head 80 + tail 40 lines) |
| **Vector index** | Brute-force search | HNSW-SQ (scalar quantization) on tables with 10K+ rows |
| **Search scope** | Global top-K | 60% directory-scoped + 40% global (with bubble-up fallback) |
| **Query breadth** | `topK` from config | Fixed 10 — focused + aggressive reranking |

**No data truncation at any scale.** All commits, all code, all PRs are indexed. The scaling strategy is smarter search, not less data.

---

## Quick Start

### VS Code Extension

```bash
# Clone and install
git clone https://github.com/your-username/gitlore.git
cd gitlore
npm install

# Build everything (core lib → extension → webview)
npm run compile

# Launch: press F5 in VS Code for Extension Development Host
```

1. Open any project with Git history
2. Click the **Git-Lore** icon in the activity bar
3. Click **"Index Repo"** — indexes commits + code files + PRs
4. Ask questions!

### CLI Tool

```bash
cd packages/cli
npm run build

# Index current repo
npx gitlore index --depth 2000

# Ask a question
npx gitlore query "why was the auth middleware rewritten?"

# Quick standup summary
npx gitlore standup

# Check status
npx gitlore status
```

CLI Commands:

| Command | Description |
|---------|-------------|
| `gitlore index` | Index commits + code + PRs (full pipeline) |
| `gitlore index-code` | Re-index only source files (fast, incremental) |
| `gitlore index-prs` | Re-index only PRs from GitHub |
| `gitlore query <question>` | Ask about the repository |
| `gitlore standup` | Summarize recent changes |
| `gitlore status` | Show index stats |
| `gitlore clear` | Delete the local index |

---

## LLM Providers

### Ollama (Default — Fully Local & Private)

```bash
# 1. Install Ollama: https://ollama.ai
# 2. Pull a model
ollama pull llama3.2

# Git-Lore connects to http://localhost:11434 by default
```

### OpenAI

```
# VS Code: run command "Git-Lore: Set OpenAI API Key"
# CLI: export OPENAI_API_KEY=sk-...
```

Then set `gitlore.llmProvider` → `"openai"` in VS Code settings.

### GitHub Token (for PR Indexing)

```
# VS Code: stored in SecretStorage (set via extension)
# CLI: export GITHUB_TOKEN=ghp_...
```

PR indexing works without a token for public repos (unauthenticated: 60 req/hr). For private repos or higher limits, provide a token. **PR indexing is always optional** — commits + code work without any token.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gitlore.llmProvider` | `"ollama"` | `"ollama"` (local) or `"openai"` (cloud) |
| `gitlore.ollamaEndpoint` | `http://localhost:11434` | Ollama server URL |
| `gitlore.ollamaModel` | `llama3.2` | Ollama model name |
| `gitlore.openaiModel` | `gpt-4o` | OpenAI model name |
| `gitlore.commitDepth` | `1000` | Max commits to index |
| `gitlore.topK` | `5` | Results per query (small repos) |
| `gitlore.githubRepo` | *(auto-detected)* | Override `owner/repo` for PR indexing |

CLI reads from `.gitlore.json` in the project root or env vars (`GITLORE_LLM_PROVIDER`, `GITLORE_OLLAMA_MODEL`, etc.).

---

## Architecture

```
gitlore/
├── packages/
│   ├── core/                 @gitlore/core — framework-agnostic engine
│   │   └── src/
│   │       ├── services/
│   │       │   ├── GitProcessor.ts      Git log extraction, file-level chunking
│   │       │   ├── CodeIndexer.ts       Source file chunking (256-line + summaries)
│   │       │   ├── GitHubService.ts     PR/issue fetching via Octokit
│   │       │   ├── EmbeddingService.ts  all-MiniLM-L6-v2 (transformers.js)
│   │       │   ├── VectorStore.ts       LanceDB wrapper (3 tables + SQ indices)
│   │       │   ├── IntentRouter.ts      Query intent classification + reranking
│   │       │   ├── RAGEngine.ts         Orchestrator (index + query + summarize)
│   │       │   └── llm/
│   │       │       ├── OpenAIProvider.ts
│   │       │       └── OllamaProvider.ts
│   │       ├── types/index.ts           CommitChunk, CodeChunk, PRChunk, etc.
│   │       └── config.ts               GitLoreConfig interface
│   │
│   ├── vscode/               VS Code extension — thin config/UI layer
│   │   ├── src/
│   │   │   ├── extension.ts             Activation, commands, file watcher
│   │   │   └── providers/
│   │   │       └── ChatViewProvider.ts  Webview bridge, config injection
│   │   └── webview/                     React sidebar (Chat UI)
│   │
│   └── cli/                  Terminal tool — commander entry point
│       └── src/index.ts                 All CLI commands
│
├── package.json              npm workspaces root
└── tsconfig.base.json        Shared TS config
```

### Data Flow

**Indexing** (one-time, then incremental):

```
git log → GitProcessor → CommitChunks ──┐
git ls-files → CodeIndexer → CodeChunks ─┼─→ EmbeddingService → VectorStore (LanceDB)
GitHub API → GitHubService → PRChunks ──┘         │
                                         ┌────────┘
                                         ▼
                              Large repos? → ensureSQIndices()
```

**Querying** (every question):

```
Question → embed(question)
              │
              ├── search(commits, topK)
              ├── searchCode(code, topK)  ← directory-scoped for large repos
              └── searchPR(prs, topK)
              │
              ▼
         IntentRouter.classify(question) → weights
              │
              ▼
         rerank(allResults, weights) → sorted by weighted distance
              │
              ▼
         Small-to-Big expansion (top N files → full context)
              │
              ▼
         greedy token fill (60% of 24K budget)
              │
              ▼
         file tree injection (overview/general queries)
              │
              ▼
         buildPrompt(snippets, expandedFiles, tree, history) → LLM → streamed answer
```

### Local Storage

```
.vscode/git-lore/
├── db/                LanceDB vector database (3 tables)
├── models/            Cached embedding model (~80MB, downloaded once)
├── index-meta.json    Last indexed commit hash (for incremental)
├── code-meta.json     File content hashes (for incremental code)
├── pr-meta.json       Last PR fetch timestamp (for incremental)
└── sq-enabled         Marker file when SQ indices are active
```

Add `.vscode/git-lore/` to your `.gitignore`.

---

## VS Code Commands

| Command | Description |
|---------|-------------|
| **Git-Lore: Index Repository** | Full pipeline: commits + code + PRs |
| **Git-Lore: Index Code Files** | Re-index only source files (fast) |
| **Git-Lore: Clear Index** | Delete the local vector database |
| **Git-Lore: Set OpenAI API Key** | Store key in VS Code SecretStorage |
| **Git-Lore: What's Changed?** | Standup summary of recent commits |
| **Git-Lore: Explain This Change** | Right-click a line → blame → RAG query |

---

## Tech Stack

| Component | Library | Role |
|-----------|---------|------|
| Git extraction | `simple-git` | Commit log, diffs, blame, ls-files |
| Embeddings | `@huggingface/transformers` | all-MiniLM-L6-v2, 384-dim, q8 quantized |
| Vector DB | `@lancedb/lancedb` | 3 tables, HNSW-SQ indexing, directory-scoped search |
| GitHub API | `@octokit/rest` | PR descriptions, linked issues |
| OpenAI | `openai` SDK | Streaming chat completions |
| Ollama | REST API (fetch) | Local NDJSON streaming |
| CLI | `commander` | Terminal commands |
| Webview UI | React 18 + Vite | Sidebar chat interface |
| Extension bundler | esbuild | Node CJS bundle, LanceDB external |

---

## Privacy

- **Embeddings are 100% local** — transformers.js runs all-MiniLM-L6-v2 in Node.js. No data leaves your machine during indexing.
- **Vector search is 100% local** — LanceDB runs in-process with no server.
- **Only query context goes to the LLM** — the top-K snippets (typically 5–10) plus your question are sent to Ollama (local) or OpenAI (cloud). Raw diffs, full source files, and the vector database never leave your machine.
- **API keys are stored securely** — VS Code SecretStorage for the extension, environment variables for CLI.

---

## Development

```bash
# Install all dependencies (npm workspaces)
npm install

# Build everything
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
