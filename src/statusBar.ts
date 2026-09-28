import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { QueryRunner } from './queryRunner';
import { SessionManager } from './sessionManager';

/** Shows, for the active SQL editor, its connection/database and the transaction state. */
export class StatusBar implements vscode.Disposable {
  private readonly bindingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly txItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly store: ConnectionStore, private readonly sessions: SessionManager, private readonly runner: QueryRunner) {
    this.bindingItem.command = 'dataLodestar.selectEditorConnection';
    this.txItem.command = 'dataLodestar.transactionMenu';
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      store.onDidChange(() => this.update()),
      sessions.onDidChange(() => this.update()),
      runner.onDidChangeBinding(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    const binding = editor && this.runner.binding(editor.document);
    // Keybindings for JavaScript / plain-text editors only apply to bound documents.
    void vscode.commands.executeCommand('setContext', 'dataLodestar.editorBound', !!binding);
    if (!editor || (editor.document.languageId !== 'sql' && !binding)) {
      this.bindingItem.hide();
      this.txItem.hide();
      return;
    }
    const config = binding && this.store.get(binding.connId);
    if (!config) {
      this.bindingItem.text = '$(database) Select connection';
      this.bindingItem.tooltip = 'Choose the connection and database this editor runs against';
      this.bindingItem.show();
      this.txItem.hide();
      return;
    }
    const session = this.sessions.current(config.id);
    const dbName = binding.database === undefined ? '' : config.kind === 'redis' ? `db${binding.database}` : binding.database;
    this.bindingItem.text = `$(database) ${config.name}${dbName ? ` › ${dbName}` : ''}`;
    this.bindingItem.tooltip = `${config.user}@${config.host}:${config.port}${session ? '' : ' (not connected)'} — click to change`;
    this.bindingItem.show();

    const mode = session?.txMode ?? config.txMode;
    const pending = !!session?.driver.pendingTransaction;
    if (config.kind === 'redis') {
      // Redis has no mode: only surface an open MULTI.
      this.txItem.text = '$(lock) MULTI open';
      this.txItem.tooltip = 'Commit sends EXEC, Rollback sends DISCARD';
      this.txItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      if (pending) this.txItem.show();
      else this.txItem.hide();
      return;
    }
    this.txItem.text = mode === 'auto' ? '$(unlock) Auto-commit' : pending ? '$(lock) Manual · uncommitted' : '$(lock) Manual';
    this.txItem.tooltip = mode === 'auto' ? 'Every statement is committed immediately. Click to change.' : 'Changes wait for Commit or Rollback. Click for options.';
    this.txItem.backgroundColor = pending ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.txItem.show();
  }

  dispose(): void {
    this.bindingItem.dispose();
    this.txItem.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
