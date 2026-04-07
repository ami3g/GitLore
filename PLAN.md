# PLAN.md — Git-Lore Source of Truth

> Last updated: 2026-04-07

## Feature Status

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

### Phase 3: Embedding & Vector Storage
- [x] `EmbeddingService` — `@huggingface/transformers` pipeline, lazy init, 384-dim vectors
- [x] `VectorStore` — LanceDB wrapper (connect, createTable, addRecords, search, clear, getStatus)
- [x] **True batch embedding** — sends 32 strings at once to the model (not sequential)
- [x] **Streaming DB writes** — 100-chunk windows: embed → write → clear → repeat (limits memory)
- [x] Metadata persistence (`index-meta.json`) tracking last indexed commit hash

### Phase 4: LLM Provider Layer
- [x] `LLMProvider` interface (sendMessage with streaming, testConnection)
- [x] `OpenAIProvider` — OpenAI SDK, streaming, SecretStorage for API key
- [x] `OllamaProvider` — fetch + NDJSON streaming, configurable endpoint

### Phase 5: RAG Engine
- [x] `RAGEngine` orchestrator — indexRepository (full or incremental), query (embed→search→prompt→stream)
- [x] Incremental indexing: detects existing index + metadata, only processes commits since `lastIndexedHash`
- [x] **Rebase safety**: verifies `lastIndexedHash` exists via `git cat-file` before incremental; auto-rebuilds if missing
- [x] **Conversation history**: last 5 exchanges (10 messages) passed to LLM for follow-up context
- [x] **Token budget**: trims oldest history messages to stay under 24K char limit; snippets are never trimmed
- [x] **"What's Changed?" summarization**: direct LLM call with all commits since last index (no embedding needed)
- [x] File-level context-aware prompt construction with system message + retrieved snippets
- [x] Custom system prompt: prioritizes retrieved snippets over conversation history for accuracy
- [x] Provider selection from VS Code settings

### Phase 6: Wire UI ↔ Backend
- [x] Typed message protocol (WebviewToExtensionMessage / ExtensionToWebviewMessage)
- [x] ChatViewProvider dispatches to RAGEngine, streams chunks back
- [x] React UI handles streaming, progress, errors, status

### Phase 7: Polish & Documentation
- [x] SecretStorage for OpenAI API key (gitlore.setApiKey command)
- [x] README.md with setup, config, architecture
- [x] PLAN.md (this file)
- [ ] Error handling polish (Ollama not running, no Git repo, empty index)
- [ ] End-to-end testing with real repository
- [ ] Markdown rendering in chat messages
- [ ] Conversation history persistence (webview state — survives panel close)

## Known Limitations (v0.1)

- **Single branch** — indexes all branches via `--all` flag, but no branch filtering
- **No file navigation** — can't click commit hashes to open diffs in VS Code
- **No multi-repo** — first workspace folder only
- **No conversation persistence** — in-memory only; chat clears on panel close
- **No markdown rendering** — LLM responses display as plain text
- **Embedding model download** — first index requires ~80MB model download

## Future Ideas (v0.2+)

- [ ] Hybrid search (combine vector + keyword search for function names)
- [ ] Worker thread for embedding (unblock extension host)
- [ ] Branch-aware indexing with branch filter
- [ ] Click commit hash → open diff in VS Code
- [ ] Multi-root workspace support
- [ ] Anthropic Claude provider
- [ ] Conversation history with export
- [ ] File-scoped queries ("Why did auth.ts change?")
- [ ] PR/merge commit summarization
- [ ] Blame integration (right-click line → "Why did this change?")

## Architecture Notes

- **Build split**: esbuild handles extension host (Node), Vite handles React webview (browser)
- **LanceDB is native**: marked `external` in esbuild — ships via `node_modules` at runtime
- **Embeddings are local**: transformers.js runs all-MiniLM-L6-v2 in Node.js, no external API needed
- **Privacy**: vector search is 100% local. Only the top-K commit snippets + user question go to the LLM.
- **API keys**: stored in VS Code's SecretStorage (OS keychain), never in settings JSON
- **Incremental indexing**: `index-meta.json` stores `lastIndexedHash`. On re-index, `git log lastHash..HEAD` fetches only new commits → embed → append to LanceDB table. Full re-index on first run or after `Clear Index`.
- **Rebase safety**: `git cat-file -t <hash>` verifies `lastIndexedHash` exists before incremental indexing. If missing (rebase/reset), triggers automatic full rebuild.
- **Conversation history**: Last 5 exchanges stored in ChatViewProvider, passed to `buildPrompt()`. System prompt instructs LLM to prioritize retrieved snippets over history.
- **Token budget**: `MAX_PROMPT_CHARS = 24000`. System prompt + snippets are fixed cost; oldest history messages are dropped first. Snippets are never trimmed.
- **"What's Changed?"**: `summarizeRecent()` skips embedding entirely — extracts raw diffs between `lastIndexedHash` and HEAD, sends directly to LLM for standup-style summarization.
