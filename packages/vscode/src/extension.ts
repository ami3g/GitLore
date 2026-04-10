import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatViewProvider } from './providers/ChatViewProvider';

let chatViewProvider: ChatViewProvider;
let headWatcher: fs.FSWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Git-Lore');
  outputChannel.appendLine('Git-Lore extension activating...');

  chatViewProvider = new ChatViewProvider(context);

  // Register sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitlore.chatView', chatViewProvider)
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.indexRepository', async () => {
      await chatViewProvider.handleIndexRepository();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.clearIndex', async () => {
      await chatViewProvider.handleClearIndex();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API key',
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store('gitlore.openaiApiKey', key);
        vscode.window.showInformationMessage('Git-Lore: OpenAI API key saved securely.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.summarizeRecent', async () => {
      await chatViewProvider.handleSummarizeRecent();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.explainLine', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Git-Lore: No active editor.');
        return;
      }
      const line = editor.selection.active.line + 1; // 1-based
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      await chatViewProvider.handleExplainLine(filePath, line);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlore.indexCode', async () => {
      await chatViewProvider.handleIndexCode();
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitlore')) {
        chatViewProvider.onConfigChanged();
      }
    })
  );

  // ─── Watch .git/refs for new commits (push/pull/fetch) ───
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const refsPath = path.join(workspaceFolder.uri.fsPath, '.git', 'refs');
    let lastKnownHead = '';
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Read current HEAD on startup
    try {
      const headPath = path.join(workspaceFolder.uri.fsPath, '.git', 'HEAD');
      const headContent = fs.readFileSync(headPath, 'utf-8').trim();
      if (headContent.startsWith('ref: ')) {
        const refFile = path.join(workspaceFolder.uri.fsPath, '.git', headContent.slice(5));
        lastKnownHead = fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf-8').trim() : '';
      } else {
        lastKnownHead = headContent;
      }
    } catch { /* OK */ }

    try {
      headWatcher = fs.watch(refsPath, { recursive: true }, (_eventType, _filename) => {
        // Debounce — git operations write multiple ref files quickly
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const headPath = path.join(workspaceFolder.uri.fsPath, '.git', 'HEAD');
            const headContent = fs.readFileSync(headPath, 'utf-8').trim();
            let currentHead = headContent;
            if (headContent.startsWith('ref: ')) {
              const refFile = path.join(workspaceFolder.uri.fsPath, '.git', headContent.slice(5));
              currentHead = fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf-8').trim() : '';
            }

            if (currentHead && currentHead !== lastKnownHead) {
              lastKnownHead = currentHead;
              outputChannel.appendLine(`Git-Lore: New commits detected (HEAD: ${currentHead.substring(0, 8)})`);

              const action = await vscode.window.showInformationMessage(
                'Git-Lore: New commits detected in the repository. Update the index?',
                'Update Index',
                'Dismiss'
              );

              if (action === 'Update Index') {
                await chatViewProvider.handleIndexRepository();
              }
            }
          } catch {
            // git operations in progress — ignore
          }
        }, 3000); // 3s debounce
      });

      context.subscriptions.push({ dispose: () => headWatcher?.close() });
    } catch {
      outputChannel.appendLine('Git-Lore: Could not watch .git/refs — auto-detect disabled.');
    }
  }

  outputChannel.appendLine('Git-Lore extension activated.');
}

export function deactivate() {
  // Cleanup handled by disposables
}
