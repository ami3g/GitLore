import {
  ipcMain,
  dialog,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  RAGEngine,
  MermaidService,
  VectorStore,
  EmbeddingService,
  CallGraphService,
  DEFAULT_CONFIG,
  type GitLoreConfig,
  type IndexStatus,
  type SearchResult,
} from '@gitlore/core';
import type { DesktopConfig, DiagramType, DiagramOptions, SavedDiagram } from '../shared/ipc-types';

// ─── State ───

let engine: RAGEngine | null = null;
let config: DesktopConfig = {
  llmProvider: 'ollama',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openaiModel: 'gpt-4o',
  commitDepth: 1000,
  topK: 5,
};

const configPath = () => {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  return path.join(appData, 'gitlore', 'config.json');
};

function loadConfig(): DesktopConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return { ...config, ...JSON.parse(raw) };
  } catch {
    return config;
  }
}

function saveConfig(cfg: DesktopConfig) {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  // Never persist secrets to disk — only non-sensitive settings
  const { openaiApiKey, githubToken, ...safe } = cfg;
  fs.writeFileSync(configPath(), JSON.stringify(safe, null, 2));
}

function getEngine(): RAGEngine {
  if (!engine) {
    const cfg = loadConfig();
    config = cfg;
    const engineConfig: GitLoreConfig = {
      commitDepth: cfg.commitDepth,
      topK: cfg.topK,
      llmProvider: cfg.llmProvider,
      ollamaEndpoint: cfg.ollamaEndpoint,
      ollamaModel: cfg.ollamaModel,
      openaiModel: cfg.openaiModel,
      getApiKey: async () => cfg.openaiApiKey || process.env.OPENAI_API_KEY,
      getGitHubToken: async () => cfg.githubToken || process.env.GITHUB_TOKEN,
      githubRepo: cfg.githubRepo,
    };
    engine = new RAGEngine(engineConfig);
  }
  return engine;
}

function getWindow(getter: () => BrowserWindow | null): BrowserWindow {
  const win = getter();
  if (!win) throw new Error('No window available');
  return win;
}

// ─── Register All IPC Handlers ───

export function registerIPCHandlers(getWin: () => BrowserWindow | null) {
  // Open folder dialog
  ipcMain.handle('gitlore:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a Git Repository',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Get index status
  ipcMain.handle('gitlore:status', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    return getEngine().getStatus(repoPath);
  });

  // Index commits
  ipcMain.handle(
    'gitlore:index',
    async (_e: IpcMainInvokeEvent, repoPath: string, commitDepth?: number) => {
      const eng = getEngine();
      if (commitDepth) eng.updateConfig({ commitDepth });
      const win = getWindow(getWin);
      await eng.indexRepository(repoPath, (phase, current, total) => {
        win.webContents.send('gitlore:index-progress', { phase, current, total });
      });
      const status = await eng.getStatus(repoPath);
      win.webContents.send('gitlore:index-complete', status);
    },
  );

  // Index code files
  ipcMain.handle('gitlore:index-code', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    const win = getWindow(getWin);
    return getEngine().indexCode(repoPath, (phase, current, total) => {
      win.webContents.send('gitlore:index-progress', { phase, current, total });
    });
  });

  // Index PRs
  ipcMain.handle('gitlore:index-prs', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    const win = getWindow(getWin);
    return getEngine().indexPRs(repoPath, (phase, current, total) => {
      win.webContents.send('gitlore:index-progress', { phase, current, total });
    });
  });

  // Query with streaming + plexus hit events
  ipcMain.handle(
    'gitlore:query',
    async (_e: IpcMainInvokeEvent, repoPath: string, question: string, topK?: number) => {
      const win = getWindow(getWin);
      const streamId = `q-${Date.now()}`;

      const answer = await getEngine().query(
        repoPath,
        question,
        (chunk) => {
          win.webContents.send('gitlore:stream-chunk', { id: streamId, content: chunk });
        },
        undefined,
        undefined,
        topK,
      );

      win.webContents.send('gitlore:stream-end', { id: streamId });
      return answer;
    },
  );

  // Summarize recent
  ipcMain.handle('gitlore:summarize', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    const win = getWindow(getWin);
    const streamId = `s-${Date.now()}`;
    const answer = await getEngine().summarizeRecent(repoPath, (chunk) => {
      win.webContents.send('gitlore:stream-chunk', { id: streamId, content: chunk });
    });
    win.webContents.send('gitlore:stream-end', { id: streamId });
    return answer;
  });

  // Clear index
  ipcMain.handle('gitlore:clear', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    return getEngine().clearIndex(repoPath);
  });

  // Generate diagrams
  ipcMain.handle(
    'gitlore:diagram',
    async (
      _e: IpcMainInvokeEvent,
      repoPath: string,
      type: DiagramType,
      options?: DiagramOptions,
    ) => {
      const mermaid = new MermaidService();
      const storePath = path.join(repoPath, '.vscode', 'git-lore');

      // Access stores directly for diagram data
      const store = new VectorStore(path.join(storePath, 'db'));
      const embeddingService = new EmbeddingService(path.join(storePath, 'models'));

      switch (type) {
        case 'architecture': {
          const edges = await store.getAllCallGraphEdges();
          // Build symbols map from code chunks
          const allPaths = await store.getAllUniqueFilePaths();
          const allSymbols = new Map();
          // Use a lightweight symbols approach — architecture diagram mainly needs edges  
          for (const fp of allPaths) {
            allSymbols.set(fp, { filePath: fp, language: '', functions: [], classes: [], imports: [], exports: [], callSites: [] });
          }
          return mermaid.generateCodeArchitecture(allSymbols, edges);
        }
        case 'callgraph': {
          const edges = await store.getAllCallGraphEdges();
          let closure: { file: string; name: string }[] | undefined;
          if (options?.entryFile && options?.entryFunction) {
            const callGraph = new CallGraphService();
            closure = callGraph.getTransitiveClosure(
              options.entryFile,
              options.entryFunction,
              edges,
            );
          }
          return mermaid.generateCallGraph(edges, closure);
        }
        case 'commits': {
          const chunks = await store.getRecentCommits(options?.limit ?? 30);
          return mermaid.generateCommitTimeline(chunks, options?.limit ?? 30);
        }
        case 'prs': {
          const prs = await store.getPRChunks();
          return mermaid.generatePRIssueFlow(prs);
        }
        default:
          throw new Error(`Unknown diagram type: ${type}`);
      }
    },
  );

  // ─── Diagram persistence ───

  const getDiagramsDir = (repoPath: string) =>
    path.join(repoPath, '.vscode', 'git-lore', 'diagrams');

  ipcMain.handle(
    'gitlore:diagram-save',
    async (_e: IpcMainInvokeEvent, repoPath: string, name: string, type: DiagramType, code: string) => {
      const dir = getDiagramsDir(repoPath);
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${type}_${ts}.mmd`;
      const meta = JSON.stringify({ name, type, createdAt: new Date().toISOString() });
      fs.writeFileSync(path.join(dir, filename), `%%${meta}%%\n${code}`, 'utf-8');
    },
  );

  ipcMain.handle(
    'gitlore:diagram-list',
    async (_e: IpcMainInvokeEvent, repoPath: string): Promise<SavedDiagram[]> => {
      const dir = getDiagramsDir(repoPath);
      if (!fs.existsSync(dir)) return [];
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mmd'));
      return files.map((filename) => {
        const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
        const metaMatch = content.match(/^%%(.+?)%%/);
        if (metaMatch) {
          try {
            const meta = JSON.parse(metaMatch[1]);
            return { filename, name: meta.name, type: meta.type, createdAt: meta.createdAt };
          } catch { /* fall through */ }
        }
        const type = filename.split('_')[0] as DiagramType;
        return { filename, name: filename, type, createdAt: '' };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  );

  ipcMain.handle(
    'gitlore:diagram-load',
    async (_e: IpcMainInvokeEvent, repoPath: string, filename: string): Promise<string> => {
      const safeName = path.basename(filename);
      const content = fs.readFileSync(path.join(getDiagramsDir(repoPath), safeName), 'utf-8');
      // Strip metadata line
      return content.replace(/^%%.*%%\n/, '');
    },
  );

  ipcMain.handle(
    'gitlore:diagram-delete',
    async (_e: IpcMainInvokeEvent, repoPath: string, filename: string) => {
      const safeName = path.basename(filename);
      const fp = path.join(getDiagramsDir(repoPath), safeName);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    },
  );

  // Config management
  ipcMain.handle('gitlore:config-get', async () => {
    return loadConfig();
  });

  ipcMain.handle(
    'gitlore:config-set',
    async (_e: IpcMainInvokeEvent, key: string, value: string | number) => {
      const cfg = loadConfig();
      (cfg as unknown as Record<string, unknown>)[key] = value;
      saveConfig(cfg);
      config = cfg;
      // Reset engine so next call picks up new config
      engine = null;
    },
  );

  // Get total commit count for depth slider max
  ipcMain.handle('gitlore:total-commits', async (_e: IpcMainInvokeEvent, repoPath: string) => {
    try {
      const count = execSync('git rev-list --count HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();
      return parseInt(count, 10) || 1000;
    } catch {
      return 1000;
    }
  });
}
