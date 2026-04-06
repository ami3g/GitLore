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
