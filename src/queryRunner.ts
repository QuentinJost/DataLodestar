import * as vscode from 'vscode';
import { boundedSetting } from './limits';
import { ConnectionStore } from './connectionStore';
import { AnyDriver } from './drivers';
import { leadingKeyword } from './drivers/driver';
import { createShellContext, DDL_METHODS, evaluate, isDestructiveOp, MongoOp, splitScript } from './mongoShell';
import { commandAt, isDestructiveCommand, splitCommands, tokenizeBuffers } from './redisCommand';
import { Session, SessionManager } from './sessionManager';
import { splitSql, statementAt } from './sqlSplitter';
import { ConnectionConfig, familyOf } from './types';
import { ResultItem, ResultsPanel } from './views/resultsPanel';

export interface Binding {
  connId: string;
  database?: string;
}

const BINDINGS_KEY = 'dataLodestar.editorBindings';
const MYSQL_USE = /^\s*use\s+`?((?:[^`]|``)+?)`?\s*$/i;

/** Editor language used for new query documents of each family. */
export const QUERY_LANGUAGE = { sql: 'sql', mongo: 'javascript', redis: 'plaintext' } as const;

/** Statements after which the tree lists objects again. */
const SCHEMA_KEYWORDS = new Set(['create', 'drop', 'alter', 'rename']);

interface Piece {
  /** Text shown in the results tab. */
  label: string;
  run: () => Promise<Omit<ResultItem, 'sql' | 'connection'>>;
  destructive: boolean;
  /** May add, drop or rename objects shown in the tree. */
  schema?: boolean;
  /** Error found before running (syntax, evaluation); shown in its tab. */
  error?: string;
}

export function isDestructive(sql: string): boolean {
  const k = leadingKeyword(sql);
  if (k === 'drop' || k === 'truncate') return true;
  return (k === 'delete' || k === 'update') && !/\bwhere\b/i.test(sql);
}

/** Binds SQL editors to a connection + database and runs their statements. */
export class QueryRunner {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeBinding = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly results: ResultsPanel,
  ) {}

  binding(doc: Pick<vscode.TextDocument, 'uri'>): Binding | undefined {
    const b = this.ctx.workspaceState.get<Record<string, Binding>>(BINDINGS_KEY, {})[doc.uri.toString()];
    return b && this.store.get(b.connId) ? b : undefined;
  }

  async setBinding(doc: vscode.TextDocument, binding: Binding): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, Binding>>(BINDINGS_KEY, {}) };
    all[doc.uri.toString()] = binding;
    await this.ctx.workspaceState.update(BINDINGS_KEY, all);
    this.changed.fire();
  }

  async pickBinding(doc: vscode.TextDocument): Promise<Binding | undefined> {
    const connections = this.store.list();
    if (!connections.length) {
      void vscode.commands.executeCommand('dataLodestar.addConnection');
      return undefined;
    }
    const conn = await vscode.window.showQuickPick(
      connections.map((c) => ({
        label: c.name,
        description: `${c.user}@${c.host}:${c.port}${c.ssh?.enabled ? ' (ssh)' : ''}`,
        detail: this.sessions.isConnected(c.id) ? '$(plug) connected' : undefined,
        id: c.id,
      })),
      { placeHolder: 'Connection for this editor' },
    );
    if (!conn) return undefined;
    const session = await this.sessions.get(conn.id);
    const config = this.store.get(conn.id)!;
    const dbs = await session.driver.listDatabases(config.showSystemDatabases);
    const current = this.binding(doc)?.database ?? config.database ?? (config.kind === 'redis' ? '0' : undefined);
    const db = await vscode.window.showQuickPick(
      dbs.map((d) => ({ label: config.kind === 'redis' ? `db${d}` : d, value: d, description: d === current ? 'current' : undefined })),
      { placeHolder: 'Database' },
    );
    if (!db) return undefined;
    const binding = { connId: conn.id, database: db.value };
    await this.setBinding(doc, binding);
    return binding;
  }

  async openSql(connId: string, database: string | undefined, text: string, language?: string): Promise<void> {
    const kind = this.store.get(connId)?.kind ?? 'mysql';
    const doc = await vscode.workspace.openTextDocument({ language: language ?? QUERY_LANGUAGE[familyOf(kind)], content: text });
    await this.setBinding(doc, { connId, database });
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
    const end = doc.positionAt(text.length);
    editor.selection = new vscode.Selection(end, end);
  }

  async run(editor: vscode.TextEditor, scope: 'statement' | 'script'): Promise<void> {
    const doc = editor.document;
    const binding = this.binding(doc) ?? (await this.pickBinding(doc));
    if (!binding) return;
    const config = this.store.get(binding.connId)!;
    const session = await this.sessions.get(binding.connId);

    // Selection, statement under the cursor, or the whole document, as [start, text] ranges.
    const sel = editor.selection;
    const base = sel.isEmpty ? 0 : doc.offsetAt(sel.start);
    const source = sel.isEmpty ? doc.getText() : doc.getText(sel);
    const cursor = sel.isEmpty && scope === 'statement' ? doc.offsetAt(sel.active) : undefined;
    const settings = vscode.workspace.getConfiguration('dataLodestar');
    const maxRows = boundedSetting(settings, 'maxRows');
    const state = { database: binding.database };

    let pieces: Piece[];
    try {
      pieces = this.plan(session, config, source, cursor, state, maxRows, (start, end) => flash(editor, new vscode.Range(doc.positionAt(base + start), doc.positionAt(base + end))));
    } catch (err) {
      this.results.show([{ sql: source.slice(0, 200), connection: config.name, columns: [], rows: [], error: (err as Error).message }], binding.connId);
      return;
    }
    if (!pieces.length) {
      vscode.window.setStatusBarMessage('DataLodestar: nothing to run', 3000);
      return;
    }

    if (settings.get('confirmDestructive', true) && session.txMode === 'auto') {
      const risky = pieces.filter((p) => p.destructive);
      if (risky.length) {
        const preview = risky[0].label.replace(/\s+/g, ' ').slice(0, 200);
        const more = risky.length > 1 ? `\n(+${risky.length - 1} more)` : '';
        const ok = await vscode.window.showWarningMessage(
          `${config.kind === 'redis' ? 'This' : 'Auto-commit is on and this'} cannot be undone:\n\n${preview}${more}`,
          { modal: true },
          'Run anyway',
        );
        if (ok !== 'Run anyway') return;
      }
    }

    const stopOnError = settings.get<boolean>('stopOnError', true);
    const dbLabel = () => `${config.name}${state.database ? ` › ${config.kind === 'redis' ? `db${state.database}` : state.database}` : ''}`;
    const items: ResultItem[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Running on ${dbLabel()}`, cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => session.driver.cancel().catch(() => undefined));
        for (let i = 0; i < pieces.length && !token.isCancellationRequested; i++) {
          const piece = pieces[i];
          if (pieces.length > 1) progress.report({ message: `${i + 1}/${pieces.length}` });
          const connection = dbLabel();
          if (piece.error) {
            items.push({ sql: piece.label, connection, columns: [], rows: [], error: piece.error });
            if (stopOnError) break;
            continue;
          }
          try {
            items.push({ sql: piece.label, connection, ...(await piece.run()) });
          } catch (err) {
            items.push({ sql: piece.label, connection, columns: [], rows: [], error: (err as Error).message || String(err) });
            if (stopOnError) break;
          }
        }
      },
    );
    if (state.database !== binding.database) await this.setBinding(doc, { connId: binding.connId, database: state.database });
    this.sessions.emit(binding.connId);
    if (pieces.slice(0, items.length).some((p) => p.schema)) this.sessions.notifySchemaChange(binding.connId);
    this.results.show(items, binding.connId);
  }

  /** Splits the text into runnable pieces for the connection's engine. */
  private plan(
    session: Session,
    config: ConnectionConfig,
    source: string,
    cursor: number | undefined,
    state: { database?: string },
    maxRows: number,
    highlight: (start: number, end: number) => void,
  ): Piece[] {
    const d: AnyDriver = session.driver;
    const pick = <T extends { start: number; end: number }>(all: T[], at: (xs: T[]) => T | undefined): T[] => {
      if (cursor === undefined) return all;
      const one = at(all);
      if (one) highlight(one.start, one.end);
      return one ? [one] : [];
    };

    if (d.family === 'sql') {
      return pick(splitSql(source, config.kind), (xs) => statementAt(xs, cursor!)).map(({ text }) => ({
        label: text,
        destructive: isDestructive(text),
        schema: SCHEMA_KEYWORDS.has(leadingKeyword(text)),
        run: async () => {
          const r = await d.execute(text, state.database, maxRows);
          const use = config.kind === 'mysql' ? MYSQL_USE.exec(text) : null;
          if (use) state.database = use[1].replace(/``/g, '`');
          return r;
        },
      }));
    }

    if (d.family === 'mongo') {
      // Evaluate everything first: ops are only recorded, so destructive ones are known before any runs.
      const context = createShellContext();
      return pick(splitScript(source), (xs) => statementAt(xs, cursor!)).flatMap(({ text }): Piece[] => {
        let value: unknown;
        try {
          value = evaluate(text, context);
        } catch (err) {
          return [{ label: text, destructive: false, error: (err as Error).message, run: async () => ({ columns: [], rows: [] }) }];
        }
        if (value instanceof MongoOp) {
          const op = value;
          return [{ label: text, destructive: isDestructiveOp(op), schema: DDL_METHODS.has(op.method), run: () => d.runOp(op, state.database, maxRows) }];
        }
        if (value === undefined) return []; // declarations, assignments to nothing
        return [{ label: text, destructive: false, run: async () => ({ columns: ['value'], rows: [[typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean)]] }) }];
      });
    }

    return pick(splitCommands(source), (xs) => commandAt(xs, source, cursor!)).map(({ text }): Piece => {
      let argv: Buffer[];
      try {
        argv = tokenizeBuffers(text);
      } catch (err) {
        return { label: text, destructive: false, error: (err as Error).message, run: async () => ({ columns: [], rows: [] }) };
      }
      return {
        label: text,
        destructive: isDestructiveCommand(argv.map((b) => b.toString('utf8'))),
        run: async () => {
          const args = argv.map((b) => b.toString('utf8'));
          const r = await d.execute(argv, state.database);
          if (/^select$/i.test(args[0]) && args[1] !== undefined) state.database = String(Number(args[1]) || 0);
          return r;
        },
      };
    });
  }
}

const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
});

function flash(editor: vscode.TextEditor, range: vscode.Range): void {
  editor.setDecorations(flashDecoration, [range]);
  setTimeout(() => editor.setDecorations(flashDecoration, []), 600);
}
