import * as vscode from 'vscode';
import { AnyDriver } from '../drivers';
import { MongoDriver } from '../drivers/mongo';
import { SessionManager, TxSessions } from '../sessionManager';
import { CellValue, CollectionInfo, CollectionStructure, StructureView, TableRef, TableStructure } from '../types';
import { assertSingleStatement } from '../sqlSplitter';
import { Editability, EditInfo, editability, RowEditError, toUpdates } from '../rowEdit';
import { renderPage } from './webview';

type Tab = 'data' | 'structure';

/** Opens a document bound to a connection; provided by the query runner. */
export type OpenSql = (connId: string, database: string, text: string, language?: string) => Promise<void>;

export interface DataPage {
  columns: string[];
  /** Empty when `documents` is set: the webview derives the rows from them. */
  rows: CellValue[][];
  documents?: unknown[];
  hasMore: boolean;
  durationMs: number;
  /** The query as the user could type it; shown and used by "Open as query". */
  text: string;
  /** Column name → expression used when clicking a header to sort. */
  quoted: Record<string, string>;
}

/** What the viewer needs from an engine: one page of rows, a count, a structure. */
export interface DataSource {
  readonly key: string;
  readonly title: string;
  readonly icon: string;
  readonly database: string;
  readonly queryLanguage: string;
  readonly labels: { where: string; orderBy: string; wherePlaceholder: string; orderPlaceholder: string };
  readonly sortStyle: 'sql' | 'mongo';
  load(where: string, orderBy: string, limit: number, offset: number): Promise<DataPage>;
  count(where: string): Promise<number>;
  structure(): Promise<StructureView>;
  /** Absent: the viewer is read-only (MongoDB). */
  editing?(): Promise<Editability>;
  /** Applies the webview's edits (see RowEdit), all or none. */
  save?(edits: unknown): Promise<void>;
}

const BODY = `
<div class="page">
  <div id="txbar" class="txbar hidden" role="status" aria-live="polite"></div>
  <div class="tabs">
    <button class="tab" data-tab="data">Data</button>
    <button class="tab" data-tab="structure">Structure</button>
  </div>
  <div id="dataPane" class="page subpage">
    <div class="toolbar">
      <label class="grow"><span class="kw" id="whereLabel">WHERE</span><input id="where" type="text" spellcheck="false"></label>
      <label class="grow"><span class="kw" id="orderLabel">ORDER BY</span><input id="orderBy" type="text" spellcheck="false"></label>
      <button id="apply">Apply</button>
    </div>
    <div class="toolbar">
      <label>Rows per page
        <select id="limit"><option>50</option><option>100</option><option>200</option><option>500</option><option>1000</option></select>
      </label>
      <button id="prev" class="secondary" title="Previous page">◀ Prev</button>
      <button id="next" class="secondary" title="Next page">Next ▶</button>
      <button id="refresh" class="secondary">Refresh</button>
      <button id="count" class="secondary" title="Count with the current filter">Count rows</button>
      <span id="countValue"></span>
      <button id="openQuery" class="secondary" title="Open the generated query in an editor">Open as query</button>
      <button id="viewMode" class="secondary hidden" title="Switch between grid and JSON">JSON</button>
      <button id="setNull" class="secondary hidden" title="Set the selected cell to NULL" disabled>Set NULL</button>
      <button id="revertCell" class="secondary hidden" title="Undo the change of the selected cell" disabled>Revert cell</button>
    </div>
    <div id="editbar" class="editbar hidden" role="status" aria-live="polite">
      <span id="editCount"></span>
      <button id="saveEdits">Save</button>
      <button id="discardEdits" class="secondary">Discard</button>
    </div>
    <div class="status"><span id="info"></span><span id="editHint" class="hint"></span><code id="sql"></code></div>
    <div id="dataError" class="error-box hidden"></div>
    <div id="grid" class="scroll"></div>
  </div>
  <div id="structurePane" class="scroll hidden">
    <div class="toolbar"><button id="refreshStructure" class="secondary">Refresh structure</button></div>
    <div id="structure"></div>
  </div>
</div>`;

type SaveOutcome = { type: 'saved' } | { type: 'saveError'; message: string; index?: number };

/** Data browser (filter / sort / paging) and structure view for a table or a collection. */
export class TablePanel {
  private static readonly open = new Map<string, TablePanel>();

  static show(extensionUri: vscode.Uri, sessions: TxSessions, openSql: OpenSql, connId: string, source: DataSource, tab: Tab): void {
    const existing = TablePanel.open.get(source.key);
    if (existing) {
      // A hidden panel reloads when revealed and may miss the message: 'ready' sends it again.
      if (!existing.panel.visible) existing.requestedTab = tab;
      existing.panel.reveal();
      void existing.panel.webview.postMessage({ type: 'showTab', tab });
      return;
    }
    TablePanel.open.set(source.key, new TablePanel(extensionUri, sessions, openSql, connId, source, tab));
  }

  private readonly panel: vscode.WebviewPanel;
  /** Tab to open on the next 'ready': the initial one, then any asked while hidden. */
  private requestedTab?: Tab;
  /** False from hiding (the page is gone) to its next 'ready'. */
  private ready = false;
  /** A save is running: a page reloaded meanwhile shows "Saving…". */
  private saving = false;
  /** Outcome of a save that ended while the page was hidden: sent on its next 'ready'. */
  private saveOutcome?: SaveOutcome;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly sessions: TxSessions,
    private readonly openSql: OpenSql,
    private readonly connId: string,
    private readonly source: DataSource,
    initialTab: Tab,
  ) {
    this.requestedTab = initialTab;
    // Not retained when hidden: the page reloads from its saved state (filters, sort, page).
    this.panel = vscode.window.createWebviewPanel('dataLodestar.table', source.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon(source.icon);
    this.panel.webview.html = renderPage(this.panel.webview, extensionUri, source.title, BODY, ['txBar.js', 'table.js']);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    const txChanges = sessions.onDidChange((id) => id === connId && this.postTx());
    // Not retained: a hidden page is gone, so the outcome of a save waits for its next 'ready'.
    this.panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.visible) this.ready = false;
    });
    this.panel.onDidDispose(() => {
      TablePanel.open.delete(source.key);
      txChanges.dispose();
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private postTx(): void {
    this.post({ type: 'tx', ...this.sessions.txState(this.connId) });
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    const settings = vscode.workspace.getConfiguration('dataLodestar');
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          tab: this.requestedTab,
          pageSize: settings.get<number>('pageSize', 100),
          binaryDisplay: settings.get<string>('binaryDisplay', 'auto'),
          maxCellChars: settings.get<number>('maxCellChars', 500),
          labels: this.source.labels,
          sortStyle: this.source.sortStyle,
          saving: this.saving,
        });
        this.ready = true;
        if (this.saveOutcome) {
          this.post(this.saveOutcome);
          this.saveOutcome = undefined;
        }
        this.requestedTab = undefined;
        this.postTx();
        if (this.source.editing) {
          // After 'init': the rows can show before the structure is read.
          this.source.editing().then(
            (e) => this.post({ type: 'editing', ...e }),
            (err) => this.post({ type: 'editing', editable: false, reason: (err as Error).message }),
          );
        }
        break;
      case 'save': {
        let outcome: SaveOutcome;
        this.saving = true;
        try {
          if (!this.source.save) throw new Error('This viewer is read-only.');
          await this.source.save(msg.edits);
          outcome = { type: 'saved' };
        } catch (err) {
          outcome = { type: 'saveError', message: (err as Error).message, index: err instanceof RowEditError ? err.index : undefined };
        } finally {
          this.saving = false;
        }
        if (this.ready) this.post(outcome);
        else this.saveOutcome = outcome;
        this.postTx();
        break;
      }
      case 'load': {
        const limit = Math.max(1, Math.min(10000, Math.floor(Number(msg.limit)) || 100));
        const offset = Math.max(0, Math.floor(Number(msg.offset)) || 0);
        try {
          this.post({ type: 'data', ...(await this.source.load(String(msg.where ?? ''), String(msg.orderBy ?? ''), limit, offset)) });
        } catch (err) {
          this.post({ type: 'dataError', message: (err as Error).message });
        }
        break;
      }
      case 'count':
        try {
          this.post({ type: 'count', value: await this.source.count(String(msg.where ?? '')) });
        } catch (err) {
          this.post({ type: 'count', error: (err as Error).message });
        }
        break;
      case 'structure':
        try {
          this.post({ type: 'structure', structure: await this.source.structure() });
        } catch (err) {
          this.post({ type: 'structureError', message: (err as Error).message });
        }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text));
        vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        break;
      case 'openSql':
        await this.openSql(this.connId, this.source.database, String(msg.text), msg.language ? String(msg.language) : this.source.queryLanguage);
        break;
      case 'commit':
      case 'rollback': {
        // Sent again whatever happens: a failed commit leaves the bar's buttons usable.
        const again = () => this.postTx();
        await vscode.commands.executeCommand(`dataLodestar.${msg.type}`, this.connId).then(again, again);
        break;
      }
    }
  }
}

/** Browsing goes through the session so uncommitted changes of a manual transaction show up. */
export function sqlSource(sessions: SessionManager, connId: string, connName: string, table: TableRef): DataSource {
  const label = table.schema && table.schema !== 'public' ? `${table.schema}.${table.name}` : table.name;
  const driver = async () => {
    const d = (await sessions.get(connId)).driver;
    if (d.family !== 'sql') throw new Error('Not a SQL connection.');
    return d;
  };
  let editInfo: Promise<Editability> | undefined;
  const editing = () => {
    editInfo ??= driver()
      .then((d) => d.describeTable(table))
      .then((st) => editability(table, st));
    // Read again next time if it failed (connection lost, privileges): not a lasting answer.
    editInfo.catch(() => (editInfo = undefined));
    return editInfo;
  };
  return {
    key: `${connId}|${table.database}|${table.schema ?? ''}|${table.name}`,
    title: `${label} — ${table.database}`,
    icon: table.type === 'view' ? 'eye' : 'table',
    database: table.database,
    queryLanguage: 'sql',
    labels: { where: 'WHERE', orderBy: 'ORDER BY', wherePlaceholder: "e.g. status = 'active' AND id > 100", orderPlaceholder: 'e.g. created_at DESC' },
    sortStyle: 'sql',
    async load(where, orderBy, limit, offset) {
      const d = await driver();
      let sql = `SELECT * FROM ${d.qualifiedName(table)}`;
      if (where) sql += ` WHERE ${where}`;
      if (orderBy) sql += ` ORDER BY ${orderBy}`;
      assertSingleStatement(sql, d.kind);
      // One extra row tells whether a next page exists without a COUNT(*).
      const r = await d.execute(`${sql} LIMIT ${limit + 1} OFFSET ${offset}`, table.database, limit + 1);
      sessions.emit(connId);
      return {
        columns: r.columns,
        rows: r.rows.slice(0, limit),
        hasMore: r.rows.length > limit,
        durationMs: r.durationMs,
        text: `${sql} LIMIT ${limit} OFFSET ${offset}`,
        quoted: Object.fromEntries(r.columns.map((c) => [c, d.quoteIdent(c)])),
      };
    },
    async count(where) {
      const d = await driver();
      const sql = `SELECT COUNT(*) FROM ${d.qualifiedName(table)}${where ? ` WHERE ${where}` : ''}`;
      assertSingleStatement(sql, d.kind);
      const r = await d.execute(sql, table.database);
      return Number(r.rows[0]?.[0]);
    },
    async structure() {
      return sqlStructureView(await (await driver()).describeTable(table));
    },
    editing,
    async save(edits) {
      const e = await editing();
      if (!e.editable) throw new Error(`This table cannot be edited: ${e.reason}.`);
      const updates = toUpdates(e as EditInfo, edits);
      try {
        await (await driver()).updateRows(table, updates);
      } finally {
        sessions.emit(connId);
      }
    },
  };
}

export function mongoSource(sessions: SessionManager, connId: string, coll: CollectionInfo): DataSource {
  const driver = async (): Promise<MongoDriver> => {
    const d: AnyDriver = (await sessions.get(connId)).driver;
    if (d.family !== 'mongo') throw new Error('Not a MongoDB connection.');
    return d;
  };
  const shellText = (filter: string, sort: string, skip: number, limit: number) =>
    `db.getCollection(${JSON.stringify(coll.name)}).find(${filter || '{}'})${sort ? `.sort(${sort})` : ''}.skip(${skip}).limit(${limit})`;
  return {
    key: `${connId}|${coll.database}|${coll.name}`,
    title: `${coll.name} — ${coll.database}`,
    icon: coll.type === 'view' ? 'eye' : 'symbol-namespace',
    database: coll.database,
    queryLanguage: 'javascript',
    labels: { where: 'FILTER', orderBy: 'SORT', wherePlaceholder: "e.g. { status: 'active', age: { $gt: 30 } }", orderPlaceholder: 'e.g. { createdAt: -1 }' },
    sortStyle: 'mongo',
    async load(filter, sort, limit, offset) {
      const d = await driver();
      const r = await d.find(coll.database, coll.name, filter, sort, limit + 1, offset);
      sessions.emit(connId);
      const hasMore = r.rows.length > limit;
      // Documents only: the webview builds the grid cells from them (media/mongoRows.js).
      return {
        columns: r.columns,
        rows: [],
        documents: r.documents?.slice(0, limit),
        hasMore,
        durationMs: r.durationMs,
        text: shellText(filter, sort, offset, limit),
        quoted: Object.fromEntries(r.columns.map((c) => [c, /^[A-Za-z_$][\w$]*$/.test(c) ? c : JSON.stringify(c)])),
      };
    },
    async count(filter) {
      return (await driver()).count(coll.database, coll.name, filter);
    },
    async structure() {
      return mongoStructureView(await (await driver()).describeCollection(coll.database, coll.name));
    },
  };
}

export function sqlStructureView(st: TableStructure): StructureView {
  const sections: StructureView['sections'] = [
    {
      title: `Columns (${st.columns.length})`,
      headers: ['Name', 'Type', 'Nullable', 'Default', 'Key', 'Extra', 'Comment'],
      rows: st.columns.map((c) => [c.name, c.type, c.nullable ? 'YES' : 'NO', c.defaultValue, c.key, c.extra, c.comment]),
    },
  ];
  if (st.indexes.length) {
    sections.push({
      title: `Indexes (${st.indexes.length})`,
      headers: ['Name', 'Columns', 'Unique', 'Primary'],
      rows: st.indexes.map((i) => [i.name, i.columns.join(', '), i.unique ? 'YES' : 'NO', i.primary ? 'YES' : 'NO']),
    });
  }
  if (st.foreignKeys.length) {
    sections.push({
      title: `Foreign keys (${st.foreignKeys.length})`,
      headers: ['Name', 'Columns', 'References', 'On update', 'On delete'],
      rows: st.foreignKeys.map((f) => [f.name, f.columns.join(', '), `${f.refTable} (${f.refColumns.join(', ')})`, f.onUpdate, f.onDelete]),
    });
  }
  return { sections, code: { title: 'DDL', text: st.ddl, language: 'sql' } };
}

export function mongoStructureView(st: CollectionStructure): StructureView {
  const sections: StructureView['sections'] = [
    {
      title: `Fields (from ${st.sampled} sampled document${st.sampled === 1 ? '' : 's'})`,
      headers: ['Path', 'Types', 'Present in'],
      rows: st.fields.map((f) => [f.path, f.types.join(' | '), `${f.presence}%`]),
    },
  ];
  if (st.indexes.length) {
    sections.push({
      title: `Indexes (${st.indexes.length})`,
      headers: ['Name', 'Keys', 'Unique', 'Options'],
      rows: st.indexes.map((i) => [i.name, i.key, i.unique ? 'YES' : 'NO', i.options]),
    });
  }
  return { sections, code: st.options ? { title: 'Collection options', text: st.options, language: 'json' } : undefined };
}
