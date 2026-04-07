import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { RAGEngine } from '../services/RAGEngine';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage, LLMMessage } from '../types';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitlore.chatView';

  private view?: vscode.WebviewView;
  private ragEngine: RAGEngine;
  private conversationHistory: LLMMessage[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ragEngine = new RAGEngine(context);
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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postMessage({ command: 'error', payload: { message: 'No workspace folder open.' } });
      vscode.window.showErrorMessage('Git-Lore: No workspace folder open.');
      return;
    }

    try {
      await this.ragEngine.indexRepository(
        workspaceFolder.uri.fsPath,
        (phase: string, current: number, total: number) => {
          this.postMessage({
            command: 'indexProgress',
            payload: { phase, current, total },
          });
        }
      );

      const status = await this.ragEngine.getStatus();
      this.postMessage({ command: 'indexComplete', payload: status });
      vscode.window.showInformationMessage(
        `Git-Lore: Indexed ${status.commitCount} chunks.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: 'error', payload: { message: msg } });
      vscode.window.showErrorMessage(`Git-Lore: Indexing failed — ${msg}`);
    }
  }

  public async handleClearIndex(): Promise<void> {
    try {
      await this.ragEngine.clearIndex();
      this.postMessage({
        command: 'indexComplete',
        payload: { indexed: false, commitCount: 0, lastIndexedAt: null, lastIndexedHash: null },
      });
      vscode.window.showInformationMessage('Git-Lore: Index cleared.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git-Lore: Failed to clear index — ${msg}`);
    }
  }

  public onConfigChanged(): void {
    this.ragEngine.onConfigChanged();
  }

  public async handleExplainLine(filePath: string, line: number): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('Git-Lore: No workspace folder open.');
      return;
    }

    // Ensure sidebar is visible
    await vscode.commands.executeCommand('gitlore.chatView.focus');

    const { GitProcessor } = await import('../services/GitProcessor');
    const gitProcessor = new GitProcessor(workspaceFolder.uri.fsPath);

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
      let fullResponse = '';
      await this.ragEngine.summarizeRecent((chunk: string) => {
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
      let fullResponse = '';
      await this.ragEngine.query(text, (chunk: string) => {
        fullResponse += chunk;
        this.postMessage({
          command: 'streamChunk',
          payload: { id: messageId, content: chunk },
        });
      }, this.conversationHistory.slice(0, -1)); // pass history without the current question

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
      const status = await this.ragEngine.getStatus();
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
