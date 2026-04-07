# Git-Lore

**Chat with your repository's Git history.** Privacy-first, RAG-powered project intelligence for VS Code.

Git-Lore indexes your local commit history into a local vector database, then lets you ask natural-language questions about _why_ code changed — backed by real commit evidence.

## Features

- **Local-first RAG pipeline** — Commits are extracted, embedded, and stored entirely on your machine
- **File-level chunking** — Each file changed in a commit gets its own embedding, so queries match the exact file change — not a whole commit blob
- **Smart truncation** — Code files (`.ts`, `.py`, `.go`) get 3× more diff budget than config/docs files
- **Hybrid LLM support** — Use **Ollama** (local, private) or **OpenAI** (cloud)
- **Incremental indexing** — After the first full index, subsequent runs only process new commits
- **Rebase-safe** — Detects history rewrites (rebase/reset) and auto-rebuilds the index
- **Conversation memory** — Remembers the last 5 exchanges so you can ask follow-up questions
- **Token budget management** — Automatically trims conversation history to fit LLM context limits
- **"What's Changed?" standup summary** — One-click summary of all commits since your last index
- **Batch embedding** — Sends 32 texts at once for faster indexing
- **Streaming DB writes** — Writes in 100-chunk windows to limit memory on large repos
- **Sidebar chat UI** — Ask questions from a dedicated panel in the activity bar
- **Streaming responses** — See answers as they're generated
- **Privacy by design** — Only the top 5 most relevant commit snippets are sent to the LLM
- **Configurable** — Control commit depth, retrieval count, model selection, and provider

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run compile
```

### 3. Run

Press **F5** in VS Code to launch the Extension Development Host.

### 4. Index Your Repository

1. Open a project with Git history
2. Click the **Git-Lore** icon in the activity bar (left sidebar)
3. Click **"Index Repo"** — this extracts commits, generates embeddings, and stores them locally
4. Start asking questions!

## LLM Providers

### Ollama (Default — Local & Private)

1. [Install Ollama](https://ollama.ai)
2. Pull a model: `ollama pull llama3.2`
3. Git-Lore connects to `http://localhost:11434` by default

### OpenAI

1. Run command: **Git-Lore: Set OpenAI API Key**
2. Enter your API key (stored securely in VS Code's SecretStorage)
3. Change the provider in settings: `gitlore.llmProvider` → `"openai"`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gitlore.llmProvider` | `"ollama"` | LLM provider: `"ollama"` or `"openai"` |
| `gitlore.ollamaEndpoint` | `http://localhost:11434` | Ollama server URL |
| `gitlore.ollamaModel` | `llama3.2` | Ollama model to use |
| `gitlore.openaiModel` | `gpt-4o-mini` | OpenAI model to use |
| `gitlore.commitDepth` | `1000` | Number of commits to index |
| `gitlore.topK` | `5` | Number of commit snippets retrieved per query |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                   │
│                                                     │
│  extension.ts → ChatViewProvider (sidebar)          │
│       │                                             │
│       ├── GitProcessor      (simple-git)            │
│       │     └── extract commits → file-level chunks  │
│       │     └── smart truncation by file type        │
│       │                                             │
│       ├── EmbeddingService  (transformers.js)       │
│       │     └── all-MiniLM-L6-v2, 384-dim vectors  │
│       │                                             │
│       ├── VectorStore       (LanceDB)               │
│       │     └── .vscode/git-lore/db/               │
│       │     └── incremental append + metadata       │
│       │                                             │
│       ├── RAGEngine         (orchestrator)          │
│       │     └── full or incremental index           │
│       │     └── query → search → prompt → LLM      │
│       │                                             │
│       └── LLMProvider (interface)                   │
│             ├── OpenAIProvider                      │
│             └── OllamaProvider                      │
│                                                     │
│  React Webview (Vite-bundled, browser context)      │
│       └── Chat UI ←→ postMessage ←→ Extension Host  │
└─────────────────────────────────────────────────────┘
```

## Data Storage

All data is stored locally in `.vscode/git-lore/` within your workspace:

```
.vscode/git-lore/
├── db/              # LanceDB vector database
├── models/          # Cached embedding model (all-MiniLM-L6-v2)
└── index-meta.json  # Tracks last indexed commit hash for incremental runs
```

Add `.vscode/git-lore/` to your `.gitignore`.

## Commands

| Command | Description |
|---------|-------------|
| `Git-Lore: Index Repository` | Extract, embed, and index commit history |
| `Git-Lore: Clear Index` | Delete the local vector database |
| `Git-Lore: Set OpenAI API Key` | Securely store your OpenAI API key |
| `Git-Lore: What's Changed?` | Summarize commits since the last index (standup-ready) |

## Tech Stack

| Component | Library |
|-----------|---------|
| Git extraction | `simple-git` |
| Embeddings | `@huggingface/transformers` (all-MiniLM-L6-v2) |
| Vector DB | `@lancedb/lancedb` |
| OpenAI | `openai` SDK |
| Ollama | REST API (fetch) |
| Webview UI | React 18 + Vite |
| Extension bundler | esbuild |

## Development

```bash
# Watch extension (Node side)
npm run watch:extension

# Watch webview (React side)
npm run dev:webview

# Build both
npm run compile
```

## License

MIT
