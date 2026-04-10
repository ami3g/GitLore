import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { RAGEngine, GitProcessor, GitHubService, type GitLoreConfig, type WebviewToExtensionMessage, type ExtensionToWebviewMessage, type LLMMessage } from '@gitlore/core';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitlore.chatView';

  private view?: vscode.WebviewView;
  private ragEngine: RAGEngine;
  private conversationHistory: LLMMessage[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ragEngine = new RAGEngine(this.buildConfig());
  }

  /** Read VS Code settings + secrets → GitLoreConfig */
  private buildConfig(): GitLoreConfig {
    const cfg = vscode.workspace.getConfiguration('gitlore');
    return {
      commitDepth: cfg.get<number>('commitDepth', 1000),
      topK: cfg.get<number>('topK', 5),
      llmProvider: cfg.get<'openai' | 'ollama'>('llmProvider', 'ollama'),
      ollamaEndpoint: cfg.get<string>('ollamaEndpoint', 'http://localhost:11434'),
      ollamaModel: cfg.get<string>('ollamaModel', 'llama3.2'),
      openaiModel: cfg.get<string>('openaiModel', 'gpt-4o'),
      getApiKey: () => this.context.secrets.get('gitlore.openaiApiKey'),
      getGitHubToken: () => this.context.secrets.get('gitlore.githubToken'),
      githubRepo: cfg.get<string>('githubRepo', ''),
    };
  }

  /** Workspace root path helper */
  private getRepoPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleMessage(message)
    );

    // Send initial status when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendStatus();
      }
    });

    this.sendStatus();
  }

  // ─── Public methods for command dispatching ───

  public async handleIndexRepository(): Promise<void> {
    const repoPath = this.getRepoPath();
    if (!repoPath) {
      this.postMessage({ command: 'error', payload: { message: 'No workspace folder open.' } });
      vscode.window.showErrorMessage('Git-Lore: No workspace folder open.');
      return;
    }

    try {
      await this.ragEngine.indexRepository(
        repoPath,
        (phase: string, current: number, total: number) => {
          this.postMessage({
            command: 'indexProgress',
            payload: { phase, current, total },
          });
        }
      );

      // Detect repo scale for adaptive code indexing
      const ghService = new GitHubService();
      const scale = await ghService.detectScale(repoPath);

      // Also index current code files (hierarchical chunking for large repos)
      await this.ragEngine.indexCode(
        repoPath,
        (phase: string, current: number, total: number) => {
          this.postMessage({
            command: 'indexProgress',
            payload: { phase, current, total },
          });
        },
        scale
      );

      // Also index PRs/issues from GitHub (non-blocking — skips silently if no remote)
      try {
        await this.ragEngine.indexPRs(
          repoPath,
          (phase: string, current: number, total: number) => {
            this.postMessage({
              command: 'indexProgress',
              payload: { phase, current, total },
            });
          }
        );
      } catch {
        // PR indexing is optional — don't fail the whole operation
      }

      const status = await this.ragEngine.getStatus(repoPath);
      this.postMessage({ command: 'indexComplete', payload: status });

      const parts = [`${status.commitCount} commit chunks`, `${status.codeFileCount} code chunks`];
      if (status.prCount > 0) parts.push(`${status.prCount} PRs`);
      vscode.window.showInformationMessage(`Git-Lore: Indexed ${parts.join(' + ')}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: 'error', payload: { message: msg } });
      vscode.window.showErrorMessage(`Git-Lore: Indexing failed — ${msg}`);
    }
  }

  public async handleClearIndex(): Promise<void> {
    const repoPath = this.getRepoPath();
    try {
      await this.ragEngine.clearIndex(repoPath ?? '');
      this.postMessage({
        command: 'indexComplete',
        payload: { indexed: false, commitCount: 0, codeFileCount: 0, prCount: 0, lastIndexedAt: null, lastIndexedHash: null },
      });
      vscode.window.showInformationMessage('Git-Lore: Index cleared.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git-Lore: Failed to clear index — ${msg}`);
    }
  }

  public async handleIndexCode(): Promise<void> {
    const repoPath = this.getRepoPath();
    if (!repoPath) {
      vscode.window.showErrorMessage('Git-Lore: No workspace folder open.');
      return;
    }

    try {
      // Detect scale for adaptive indexing
      const ghService = new GitHubService();
      const scale = await ghService.detectScale(repoPath);

      const result = await this.ragEngine.indexCode(
        repoPath,
        (phase: string, current: number, total: number) => {
          this.postMessage({
            command: 'indexProgress',
            payload: { phase, current, total },
          });
        },
        scale
      );

      const status = await this.ragEngine.getStatus(repoPath);
      this.postMessage({ command: 'indexComplete', payload: status });

      if (result.changedFiles === 0) {
        vscode.window.showInformationMessage('Git-Lore: Code index already up to date.');
      } else {
        vscode.window.showInformationMessage(
          `Git-Lore: Re-indexed ${result.changedFiles} files (${result.totalChunks} chunks).`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git-Lore: Code indexing failed — ${msg}`);
    }
  }

  public onConfigChanged(): void {
    this.ragEngine.updateConfig(this.buildConfig());
  }

  public async handleExplainLine(filePath: string, line: number): Promise<void> {
    const repoPath = this.getRepoPath();
    if (!repoPath) {
      vscode.window.showErrorMessage('Git-Lore: No workspace folder open.');
      return;
    }

    // Ensure sidebar is visible
    await vscode.commands.executeCommand('gitlore.chatView.focus');

    const gitProcessor = new GitProcessor(repoPath);

    const blame = await gitProcessor.blameLineHash(filePath, line);
    if (!blame) {
      this.postMessage({ command: 'error', payload: { message: `Could not determine blame for ${filePath}:${line}` } });
      return;
    }

    // Build a targeted query and send it through the normal query pipeline
    const question = `Tell me the lore behind commit ${blame.hash.substring(0, 8)} by ${blame.author}. ` +
      `The commit message was: "${blame.message}". ` +
      `Specifically, why was line ${line} of \`${filePath}\` changed? What was the context and motivation?`;

    await this.handleQuery(question);
  }

  public async handleSummarizeRecent(): Promise<void> {
    const messageId = crypto.randomUUID();

    try {
      const repoPath = this.getRepoPath();
      let fullResponse = '';
      await this.ragEngine.summarizeRecent(repoPath ?? '', (chunk: string) => {
        fullResponse += chunk;
        this.postMessage({
          command: 'streamChunk',
          payload: { id: messageId, content: chunk },
        });
      });

      // Add to conversation history for follow-ups
      this.conversationHistory.push(
        { role: 'user', content: "What's changed recently?" },
        { role: 'assistant', content: fullResponse }
      );
      if (this.conversationHistory.length > 10) {
        this.conversationHistory = this.conversationHistory.slice(-10);
      }

      this.postMessage({
        command: 'streamEnd',
        payload: { id: messageId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: 'error', payload: { message: msg } });
    }
  }

  // ─── Message handling ───

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.command) {
      case 'query':
        await this.handleQuery(message.payload.text);
        break;
      case 'index':
        await this.handleIndexRepository();
        break;
      case 'summarize':
        await this.handleSummarizeRecent();
        break;
      case 'getStatus':
        await this.sendStatus();
        break;
      case 'setApiKey':
        await this.context.secrets.store('gitlore.openaiApiKey', message.payload.key);
        break;
    }
  }

  private async handleQuery(text: string): Promise<void> {
    const messageId = crypto.randomUUID();

    // Track user message
    this.conversationHistory.push({ role: 'user', content: text });

    try {
      const repoPath = this.getRepoPath();

      // Derive active directory from current editor for directory scoping
      const activeEditor = vscode.window.activeTextEditor;
      let activeDirectory: string | undefined;
      if (activeEditor && repoPath) {
        const filePath = activeEditor.document.uri.fsPath;
        const relative = path.relative(repoPath, filePath);
        if (!relative.startsWith('..')) {
          activeDirectory = path.dirname(relative).replace(/\\/g, '/');
          if (activeDirectory === '.') activeDirectory = undefined;
        }
      }

      let fullResponse = '';
      await this.ragEngine.query(repoPath ?? '', text, (chunk: string) => {
        fullResponse += chunk;
        this.postMessage({
          command: 'streamChunk',
          payload: { id: messageId, content: chunk },
        });
      }, this.conversationHistory.slice(0, -1), activeDirectory);

      // Track assistant response
      this.conversationHistory.push({ role: 'assistant', content: fullResponse });

      // Keep only last 10 messages (5 exchanges)
      if (this.conversationHistory.length > 10) {
        this.conversationHistory = this.conversationHistory.slice(-10);
      }

      this.postMessage({
        command: 'streamEnd',
        payload: { id: messageId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: 'error', payload: { message: msg } });
    }
  }

  private async sendStatus(): Promise<void> {
    try {
      const repoPath = this.getRepoPath();
      const status = await this.ragEngine.getStatus(repoPath ?? '');
      this.postMessage({ command: 'status', payload: status });
    } catch {
      this.postMessage({
        command: 'status',
        payload: { indexed: false, commitCount: 0, lastIndexedAt: null, lastIndexedHash: null },
      });
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  // ─── HTML generation ───

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'app.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'app.css')
    );
    const nonce = crypto.randomBytes(16).toString('hex');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      connect-src https://api.openai.com http://localhost:11434;
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} https:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Git-Lore</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
