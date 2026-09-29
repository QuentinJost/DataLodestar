import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { SessionManager } from './sessionManager';
import { CollectionInfo, ColumnInfo, ConnectionConfig, familyOf, FieldInfo, TableInfo } from './types';

export type NavNode = ConnectionNode | DatabaseNode | FolderNode | TableNode | CollectionNode | RedisDbNode | RedisEmptyDbsNode | ColumnNode | MessageNode;

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection';
  constructor(readonly config: ConnectionConfig, readonly connected: boolean, pending: boolean, manual: boolean) {
    super(config.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    // The id changes with the connected flag so VS Code re-applies the collapsible state.
    this.id = `conn:${config.id}:${connected ? 'on' : 'off'}`;
    this.update(pending, manual);
  }

  /** Transaction state shown on the node; changed in place so VS Code keeps the expanded children. */
  update(pending: boolean, manual: boolean): void {
    const config = this.config;
    const connected = this.connected;
    const redis = config.kind === 'redis';
    const via = config.ssh?.enabled ? ` via ssh ${config.ssh.host}` : '';
    const where = config.uri ? redactUri(config.uri) : `${config.user ? `${config.user}@` : ''}${config.host}:${config.port}`;
    const tx = redis ? (pending ? ' · MULTI ●' : '') : ` · ${manual ? (pending ? 'manual ●' : 'manual') : 'auto'}`;
    this.description = `${where}${via}${tx}`;
    this.tooltip = new vscode.MarkdownString(
      `**${config.name}** (${config.kind})\n\n${where}${via}\n\n` +
        (redis
          ? pending
            ? 'MULTI open: Commit sends EXEC, Rollback sends DISCARD'
            : 'Redis: every command applies immediately'
          : `Transactions: **${manual ? 'manual' : 'auto-commit'}**${pending ? ' — *uncommitted changes*' : ''}`),
    );
    this.contextValue = connected ? (pending ? 'connection.on.pending' : 'connection.on') : 'connection.off';
    this.iconPath = new vscode.ThemeIcon(
      redis ? 'layers' : config.kind === 'mongodb' ? 'json' : 'database',
      connected ? new vscode.ThemeColor(pending ? 'charts.orange' : 'charts.green') : undefined,
    );
  }
}

export class DatabaseNode extends vscode.TreeItem {
  readonly kind = 'database';
  constructor(readonly connId: string, readonly database: string) {
    super(database, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `db:${connId}:${database}`;
    this.contextValue = 'database';
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

export class FolderNode extends vscode.TreeItem {
  readonly kind = 'folder';
  constructor(
    readonly connId: string,
    readonly database: string,
    readonly family: 'sql' | 'mongo',
    readonly items: (TableInfo | CollectionInfo)[],
    label: 'Tables' | 'Views' | 'Collections',
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `folder:${connId}:${database}:${label}`;
    this.description = String(items.length);
    this.contextValue = 'folder';
    this.iconPath = new vscode.ThemeIcon(label === 'Views' ? 'eye' : 'files');
  }
}

export class TableNode extends vscode.TreeItem {
  readonly kind = 'table';
  constructor(readonly connId: string, readonly table: TableInfo) {
    super(table.schema && table.schema !== 'public' ? `${table.schema}.${table.name}` : table.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `table:${connId}:${table.database}:${table.schema ?? ''}:${table.name}`;
    this.contextValue = table.type;
    this.iconPath = new vscode.ThemeIcon(table.type === 'view' ? 'eye' : 'table');
    if (table.estimatedRows !== undefined) this.description = `~${table.estimatedRows.toLocaleString()} rows`;
    if (table.comment) this.tooltip = table.comment;
    this.command = { command: 'dataLodestar.openTable', title: 'Open Table Data', arguments: [this] };
  }
}

export class CollectionNode extends vscode.TreeItem {
  readonly kind = 'collection';
  constructor(readonly connId: string, readonly collection: CollectionInfo) {
    super(collection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `coll:${connId}:${collection.database}:${collection.name}`;
    this.contextValue = 'collection';
    this.iconPath = new vscode.ThemeIcon(collection.type === 'view' ? 'eye' : collection.type === 'timeseries' ? 'graph-line' : 'symbol-namespace');
    if (collection.type !== 'collection') this.description = collection.type;
    this.command = { command: 'dataLodestar.openTable', title: 'Open Documents', arguments: [this] };
  }
}

export class RedisDbNode extends vscode.TreeItem {
  readonly kind = 'redisdb';
  constructor(readonly connId: string, readonly database: string, keys: number) {
    super(`db${database}`, vscode.TreeItemCollapsibleState.None);
    this.id = `redis:${connId}:${database}`;
    this.description = `${keys.toLocaleString()} key${keys === 1 ? '' : 's'}`;
    this.contextValue = 'redisdb';
    this.iconPath = new vscode.ThemeIcon('symbol-key');
    this.command = { command: 'dataLodestar.openTable', title: 'Browse Keys', arguments: [this] };
  }
}

/** Groups the empty Redis databases so the 16 indexes do not flood the tree. */
export class RedisEmptyDbsNode extends vscode.TreeItem {
  readonly kind = 'redisempty';
  constructor(readonly connId: string, readonly databases: string[]) {
    super('Empty databases', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `redisempty:${connId}`;
    this.description = String(databases.length);
    this.iconPath = new vscode.ThemeIcon('circle-slash');
  }
}

export class ColumnNode extends vscode.TreeItem {
  readonly kind = 'column';
  constructor(parentId: string, readonly column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${parentId}:${column.name}`;
    this.description = `${column.type}${column.nullable ? '' : ' not null'}${column.key ? ` ${column.key}` : ''}`;
    this.tooltip = [column.comment, column.defaultValue !== null ? `default ${column.defaultValue}` : '', column.extra].filter(Boolean).join('\n') || undefined;
    this.contextValue = 'column';
    this.iconPath = new vscode.ThemeIcon(column.key === 'PRI' ? 'key' : column.key ? 'symbol-key' : 'symbol-field');
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message';
  constructor(message: string, error = false) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(error ? 'error' : 'info', error ? new vscode.ThemeColor('errorForeground') : undefined);
    this.tooltip = message;
  }
}

/** Sampled MongoDB fields shown like columns: "_id" as key, presence as nullability. */
export function fieldAsColumn(f: FieldInfo): ColumnInfo {
  return {
    name: f.path,
    type: f.types.join(' | '),
    nullable: true,
    defaultValue: null,
    key: f.path === '_id' ? 'PRI' : '',
    extra: `in ${f.presence}% of sampled documents`,
    comment: '',
  };
}

export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]*)@/, (_m, cred: string) => `//${cred.split(':')[0]}:***@`);
}

export class NavigatorTree implements vscode.TreeDataProvider<NavNode> {
  private readonly changed = new vscode.EventEmitter<NavNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly connections = new Map<string, ConnectionNode>();
  /** Metadata per connection (databases, tables, collections, columns), keyed by what was listed. */
  private readonly cache = new Map<string, Map<string, Promise<unknown>>>();

  constructor(private readonly store: ConnectionStore, private readonly sessions: SessionManager) {
    store.onDidChange(() => this.refresh());
    sessions.onDidChange((id) => this.onSessionChange(id));
    sessions.onDidChangeSchema((id) => {
      const node = this.connections.get(id);
      if (node) this.refresh(node);
      else this.cache.delete(id);
    });
  }

  /** Drops the cached metadata of the node's connection (all when no node) and redraws it. */
  refresh(node?: NavNode): void {
    const connId = node ? ('config' in node ? node.config.id : 'connId' in node ? node.connId : undefined) : undefined;
    if (connId) this.cache.delete(connId);
    else this.cache.clear();
    this.changed.fire(node);
  }

  /**
   * Connect / disconnect redraw the root; a mode or pending-transaction change only
   * updates that connection's node, whose children come from the cache.
   */
  private onSessionChange(id: string): void {
    const s = this.sessions.current(id);
    if (!s) this.cache.delete(id);
    const node = this.connections.get(id);
    if (!node || node.connected !== !!s) {
      this.changed.fire(undefined);
      return;
    }
    node.update(!!s?.driver.pendingTransaction, (s?.txMode ?? node.config.txMode) === 'manual' && familyOf(node.config.kind) !== 'redis');
    this.changed.fire(node);
  }

  private cached<T>(connId: string, key: string, load: () => Promise<T>): Promise<T> {
    let entries = this.cache.get(connId);
    if (!entries) this.cache.set(connId, (entries = new Map()));
    let hit = entries.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      entries.set(key, hit);
      // A failure is shown once, then retried on the next expand.
      hit.catch(() => this.cache.get(connId)?.get(key) === hit && this.cache.get(connId)!.delete(key));
    }
    return hit;
  }

  getTreeItem(node: NavNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: NavNode): Promise<NavNode[]> {
    if (!node) {
      this.connections.clear();
      return this.store.list().map((c) => {
        const s = this.sessions.current(c.id);
        const n = new ConnectionNode(c, !!s, !!s?.driver.pendingTransaction, (s?.txMode ?? c.txMode) === 'manual' && familyOf(c.kind) !== 'redis');
        this.connections.set(c.id, n);
        return n;
      });
    }
    try {
      switch (node.kind) {
        case 'connection': {
          const id = node.config.id;
          const d = (await this.sessions.get(id)).driver;
          const dbs = await this.cached(id, 'dbs', () => d.listDatabases(node.config.showSystemDatabases));
          if (d.family === 'redis') {
            const counts = await this.cached(id, 'keyspace', () => d.keyspace());
            const used = dbs.filter((db) => counts[db] || db === (node.config.database || '0'));
            const empty = dbs.filter((db) => !used.includes(db));
            return [...used.map((db) => new RedisDbNode(node.config.id, db, counts[db] ?? 0)), ...(empty.length ? [new RedisEmptyDbsNode(node.config.id, empty)] : [])];
          }
          return dbs.length ? dbs.map((db) => new DatabaseNode(node.config.id, db)) : [new MessageNode('No database visible for this user')];
        }
        case 'redisempty':
          return node.databases.map((db) => new RedisDbNode(node.connId, db, 0));
        case 'database': {
          const d = (await this.sessions.get(node.connId)).driver;
          if (d.family === 'mongo') {
            const colls = await this.cached(node.connId, `db:${node.database}`, () => d.listCollections(node.database));
            return [
              new FolderNode(node.connId, node.database, 'mongo', colls.filter((c) => c.type !== 'view'), 'Collections'),
              new FolderNode(node.connId, node.database, 'mongo', colls.filter((c) => c.type === 'view'), 'Views'),
            ];
          }
          if (d.family !== 'sql') return [];
          const tables = await this.cached(node.connId, `db:${node.database}`, () => d.listTables(node.database));
          return [
            new FolderNode(node.connId, node.database, 'sql', tables.filter((t) => t.type === 'table'), 'Tables'),
            new FolderNode(node.connId, node.database, 'sql', tables.filter((t) => t.type === 'view'), 'Views'),
          ];
        }
        case 'folder':
          if (!node.items.length) return [new MessageNode('Empty')];
          return node.items.map((i) => (node.family === 'sql' ? new TableNode(node.connId, i as TableInfo) : new CollectionNode(node.connId, i as CollectionInfo)));
        case 'table': {
          const d = (await this.sessions.get(node.connId)).driver;
          if (d.family !== 'sql') return [];
          const structure = await this.cached(node.connId, node.id!, () => d.describeTable(node.table));
          return structure.columns.map((c) => new ColumnNode(node.id!, c));
        }
        case 'collection': {
          const d = (await this.sessions.get(node.connId)).driver;
          if (d.family !== 'mongo') return [];
          const s = await this.cached(node.connId, node.id!, () => d.describeCollection(node.collection.database, node.collection.name));
          return s.fields.length ? s.fields.map((f) => new ColumnNode(node.id!, fieldAsColumn(f))) : [new MessageNode('No document to sample')];
        }
        default:
          return [];
      }
    } catch (err) {
      return [new MessageNode((err as Error).message, true)];
    }
  }
}
