# PLAN.md — Git-Lore Source of Truth

> Last updated: 2026-04-06

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
- [x] `VectorStore` — LanceDB wrapper (connect, createTable, search, clear, getStatus)
- [x] Batch embedding with progress

### Phase 4: LLM Provider Layer
- [x] `LLMProvider` interface (sendMessage with streaming, testConnection)
- [x] `OpenAIProvider` — OpenAI SDK, streaming, SecretStorage for API key
- [x] `OllamaProvider` — fetch + NDJSON streaming, configurable endpoint

### Phase 5: RAG Engine
- [x] `RAGEngine` orchestrator — indexRepository (extract→embed→store), query (embed→search→prompt→stream)
- [x] File-level context-aware prompt construction with system message + retrieved snippets
- [x] Custom system prompt: professional, developer-centric tone with structured markdown output
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
- [ ] Conversation history persistence (webview state)
- [ ] Incremental indexing (only new commits since last index)

## Known Limitations (v0.1)

- **No incremental indexing** — full re-index each time
- **Single branch** — indexes current branch only (--all flag in git log)
- **No file navigation** — can't click commit hashes to open diffs
- **No multi-repo** — first workspace folder only
- **No conversation persistence** — chat clears on panel close
- **Embedding model download** — first index requires ~80MB model download

## Future Ideas (v0.2+)

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
