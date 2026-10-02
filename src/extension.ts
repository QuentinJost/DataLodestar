import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { QueryRunner } from './queryRunner';
import { SessionManager } from './sessionManager';
import { StatusBar } from './statusBar';
import { CollectionNode, ColumnNode, ConnectionNode, DatabaseNode, NavigatorTree, NavNode, RedisDbNode, TableNode } from './treeProvider';
import { familyOf } from './types';
import { ConnectionForm } from './views/connectionForm';
import { RedisPanel } from './views/redisPanel';
import { ResultsPanel } from './views/resultsPanel';
import { mongoSource, sqlSource, TablePanel } from './views/tablePanel';

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new ConnectionStore(ctx);
  void migrate(store);
  const sessions = new SessionManager(store);
  const results = new ResultsPanel(ctx.extensionUri);
  const runner = new QueryRunner(ctx, store, sessions, results);
  const tree = new NavigatorTree(store, sessions);
  const statusBar = new StatusBar(store, sessions, runner);
  const view = vscode.window.createTreeView('dataLodestar.connections', { treeDataProvider: tree, showCollapseAll: true });
  const openSql = (connId: string, database: string | undefined, text: string, language?: string) => runner.openSql(connId, database, text, language);

  /** Connection targeted by a command: tree node, else active editor binding, else a quick pick. */
  async function targetConnection(node?: NavNode | string, onlyConnected = false): Promise<string | undefined> {
    if (typeof node === 'string') return store.get(node) ? node : undefined;
    if (node instanceof ConnectionNode) return node.config.id;
    if (node && 'connId' in node) return node.connId;
    const editor = vscode.window.activeTextEditor;
    const bound = editor?.document.languageId === 'sql' ? runner.binding(editor.document) : undefined;
    if (bound) return bound.connId;
    const candidates = store.list().filter((c) => !onlyConnected || sessions.isConnected(c.id));
    if (candidates.length === 1) return candidates[0].id;
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: c.name, description: `${c.user}@${c.host}:${c.port}`, id: c.id })),
      { placeHolder: onlyConnected ? 'Connected host' : 'Connection' },
    );
    return pick?.id;
  }

  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        void vscode.window.showErrorMessage(`DataLodestar: ${(err as Error).message || err}`);
      }
    };

  const register = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));

  register('dataLodestar.addConnection', () => ConnectionForm.show(ctx.extensionUri, store, sessions));

  register('dataLodestar.editConnection', async (node?: NavNode) => {
    const id = await targetConnection(node);
    const config = id && store.get(id);
    if (config) ConnectionForm.show(ctx.extensionUri, store, sessions, config);
  });

  register('dataLodestar.resetHostKey', async (node?: NavNode) => {
    const id = await targetConnection(node);
    const config = id && store.get(id);
    if (!config) return;
    const ssh = config.ssh;
    if (!ssh?.hostFingerprint) {
      void vscode.window.showInformationMessage(`DataLodestar: "${config.name}" has no pinned SSH host key.`);
      return;
    }
    const host = `${ssh.host}:${ssh.port}`;
    const forget = `Forget the key of ${host}`;
    const ok = await vscode.window.showWarningMessage(
      `Forget the pinned SSH host key of ${host} (${ssh.hostFingerprint})?\n` +
        'Only do this if the server key really changed. The next connection shows the new fingerprint and asks you to trust it: compare it with the one given by the server administrator.',
      { modal: true },
      forget,
    );
    if (ok !== forget) return;
    await store.save({ ...config, ssh: { ...ssh, hostFingerprint: undefined } });
    void vscode.window.showInformationMessage(`DataLodestar: pinned host key of ${host} forgotten.`);
  });

  register('dataLodestar.deleteConnection', async (node?: NavNode) => {
    const id = await targetConnection(node);
    const config = id && store.get(id);
    if (!config) return;
    const ok = await vscode.window.showWarningMessage(`Delete connection "${config.name}" and its saved passwords?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await sessions.disconnect(config.id);
    if (!sessions.isConnected(config.id)) await store.remove(config.id);
  });

  register('dataLodestar.connect', async (node?: NavNode) => {
    const id = await targetConnection(node);
    if (id) await sessions.get(id);
  });

  register('dataLodestar.disconnect', async (node?: NavNode) => {
    const id = await targetConnection(node, true);
    if (id) await sessions.disconnect(id);
  });

  register('dataLodestar.refresh', (node?: NavNode) => tree.refresh(node));

  register('dataLodestar.newQuery', async (node?: NavNode) => {
    if (node instanceof TableNode) {
      const d = (await sessions.get(node.connId)).driver;
      if (d.family === 'sql') return openSql(node.connId, node.table.database, `SELECT *\nFROM ${d.qualifiedName(node.table)}\nLIMIT 100;\n`);
    }
    if (node instanceof CollectionNode) {
      return openSql(node.connId, node.collection.database, `db.getCollection(${JSON.stringify(node.collection.name)}).find({}).limit(100)\n`);
    }
    if (node instanceof DatabaseNode || node instanceof RedisDbNode) return openSql(node.connId, node.database, '');
    const id = await targetConnection(node);
    if (id) await openSql(id, store.get(id)?.database, '');
  });

  const showTable = (node: NavNode | undefined, tab: 'data' | 'structure') => {
    if (!node || !('connId' in node)) return;
    const name = store.get(node.connId)?.name ?? '';
    if (node instanceof TableNode) TablePanel.show(ctx.extensionUri, openSql, node.connId, sqlSource(sessions, node.connId, name, node.table), tab);
    else if (node instanceof CollectionNode) TablePanel.show(ctx.extensionUri, openSql, node.connId, mongoSource(sessions, node.connId, node.collection), tab);
    else if (node instanceof RedisDbNode) RedisPanel.show(ctx.extensionUri, sessions, openSql, node.connId, name, node.database);
  };
  register('dataLodestar.openTable', (node?: NavNode) => showTable(node, 'data'));
  register('dataLodestar.showStructure', (node?: NavNode) => showTable(node, 'structure'));

  register('dataLodestar.copyName', async (node?: NavNode) => {
    const name =
      node instanceof DatabaseNode
        ? node.database
        : node instanceof TableNode
          ? node.table.name
          : node instanceof CollectionNode
            ? node.collection.name
            : node instanceof ColumnNode
              ? node.column.name
              : undefined;
    if (name) await vscode.env.clipboard.writeText(name);
  });

  register('dataLodestar.runStatement', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.run(editor, 'statement');
  });
  register('dataLodestar.runScript', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.run(editor, 'script');
  });
  register('dataLodestar.selectEditorConnection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.pickBinding(editor.document);
  });

  const txMode = (id: string) => sessions.current(id)?.txMode ?? store.get(id)?.txMode ?? 'auto';

  register('dataLodestar.toggleTxMode', async (node?: NavNode) => {
    const id = await targetConnection(node);
    if (!id) return;
    if (store.get(id)?.kind === 'redis') {
      void vscode.window.showInformationMessage('Redis has no commit/rollback mode. Type MULTI in the editor: Commit then sends EXEC, Rollback sends DISCARD.');
      return;
    }
    await sessions.setTxMode(id, txMode(id) === 'auto' ? 'manual' : 'auto');
  });
  register('dataLodestar.commit', async (node?: NavNode) => {
    const id = await targetConnection(node, true);
    if (id) {
      await sessions.commit(id);
      vscode.window.setStatusBarMessage('$(check) Committed', 3000);
    }
  });
  register('dataLodestar.rollback', async (node?: NavNode) => {
    const id = await targetConnection(node, true);
    if (id) {
      await sessions.rollback(id);
      vscode.window.setStatusBarMessage('$(discard) Rolled back', 3000);
    }
  });
  register('dataLodestar.transactionMenu', async () => {
    const id = await targetConnection();
    if (!id) return;
    const mode = txMode(id);
    const pending = !!sessions.current(id)?.driver.pendingTransaction;
    const redis = familyOf(store.get(id)?.kind ?? 'mysql') === 'redis';
    const items = redis
      ? [
          { label: '$(check) EXEC', description: 'run the queued commands', cmd: 'dataLodestar.commit' },
          { label: '$(discard) DISCARD', description: 'drop the queued commands', cmd: 'dataLodestar.rollback' },
        ]
      : [
      ...(mode === 'manual' && sessions.isConnected(id)
        ? [
            { label: '$(check) Commit', description: pending ? 'uncommitted changes' : '', cmd: 'dataLodestar.commit' },
            { label: '$(discard) Rollback', cmd: 'dataLodestar.rollback' },
          ]
        : []),
      mode === 'auto'
        ? { label: '$(lock) Switch to manual transactions', description: 'changes wait for Commit / Rollback', cmd: 'dataLodestar.toggleTxMode' }
        : { label: '$(unlock) Switch to auto-commit', description: 'every statement is committed immediately', cmd: 'dataLodestar.toggleTxMode' },
        ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${store.get(id)?.name}: ${mode === 'auto' ? 'auto-commit' : 'manual transactions'}` });
    if (!pick) return;
    const node = store.get(id) && new ConnectionNode(store.get(id)!, sessions.isConnected(id), pending, mode === 'manual');
    await vscode.commands.executeCommand(pick.cmd, node);
  });

  ctx.subscriptions.push(view, sessions, statusBar);
}

export function deactivate(): void {
  // Sessions are closed by SessionManager.dispose (registered in subscriptions).
}

/** One-time rewrites of saved connections, in sequence: each one reads and rewrites the whole list. */
async function migrate(store: ConnectionStore): Promise<void> {
  const { moved, dropped } = await store.migrateUriPasswords();
  if (moved.length) {
    void vscode.window.showInformationMessage(`DataLodestar: the password of ${moved.join(', ')} was moved from the connection string to the OS keychain.`);
  }
  if (dropped.length) {
    void vscode.window.showWarningMessage(
      `DataLodestar: the password was removed from the connection string of ${dropped.join(', ')} (passwords are not saved for it); it will be asked at the next connection.`,
    );
  }
  const unchecked = await store.migrateTlsVerify();
  if (unchecked.length) {
    void vscode.window.showWarningMessage(
      `DataLodestar: ${unchecked.join(', ')} use${unchecked.length === 1 ? 's' : ''} SSL/TLS without checking the server certificate. ` +
        'Edit the connection and check "Verify the server certificate" (with a CA file for a self-signed server).',
    );
  }
}
