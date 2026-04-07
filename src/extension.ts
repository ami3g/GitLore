import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/ChatViewProvider';

let chatViewProvider: ChatViewProvider;

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

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitlore')) {
        chatViewProvider.onConfigChanged();
      }
    })
  );

  outputChannel.appendLine('Git-Lore extension activated.');
}

export function deactivate() {
  // Cleanup handled by disposables
}
