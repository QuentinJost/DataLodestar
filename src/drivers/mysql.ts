import * as mysql from 'mysql2/promise';
import { ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TableRef, TableStructure, TxMode } from '../types';
import { Endpoint, SqlDriver, isReadOnly, isTxBegin, isTxControl, Mutex, normalizeValue } from './driver';

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

type Row = Record<string, unknown>;

export class MysqlDriver implements SqlDriver {
  readonly kind = 'mysql' as const;
  readonly family = 'sql' as const;
  readonly supportsManualTx = true;
  pendingTransaction = false;
  onLost?: (err: Error) => void;

  private session?: mysql.Connection;
  private meta?: mysql.Connection;
  private currentDb?: string;
  private mode: TxMode = 'auto';
  private readonly lock = new Mutex();

  constructor(private readonly endpoint: Endpoint) {}

  async connect(): Promise<void> {
    this.session = await this.open();
    this.meta = await this.open();
    this.currentDb = this.endpoint.database || undefined;
    this.session.on('error', (err) => this.onLost?.(err));
  }

  private open(): Promise<mysql.Connection> {
    const e = this.endpoint;
    return mysql.createConnection({
      host: e.host,
      port: e.port,
      user: e.user,
      password: e.password,
      database: e.database || undefined,
      ssl: e.ssl ? { rejectUnauthorized: false } : undefined,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      connectTimeout: 15000,
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.session?.end(), this.meta?.end()]);
    this.session = this.meta = undefined;
  }

  private async metaQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
    const [rows] = await this.meta!.query(sql, params);
    return rows as Row[];
  }

  async listDatabases(showSystem: boolean): Promise<string[]> {
    const rows = await this.metaQuery('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    return rows.map((r) => String(r.name)).filter((d) => showSystem || !SYSTEM_DATABASES.has(d));
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.metaQuery(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est, TABLE_COMMENT AS comment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((r) => ({
      database,
      name: String(r.name),
      type: String(r.type).includes('VIEW') ? 'view' : 'table',
      estimatedRows: r.est === null ? undefined : Number(r.est),
      comment: r.comment ? String(r.comment) : undefined,
    }));
  }

  async describeTable(ref: TableRef): Promise<TableStructure> {
    const q = this.qualifiedName(ref);
    const [cols, idx, fks, ddlRows] = await Promise.all([
      this.metaQuery(`SHOW FULL COLUMNS FROM ${q}`),
      ref.type === 'table' ? this.metaQuery(`SHOW INDEX FROM ${q}`) : Promise.resolve([]),
      this.metaQuery(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rdb,
                k.REFERENCED_TABLE_NAME AS rtable, k.REFERENCED_COLUMN_NAME AS rcol,
                r.UPDATE_RULE AS upd, r.DELETE_RULE AS del
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [ref.database, ref.name],
      ),
      this.metaQuery(`SHOW CREATE ${ref.type === 'view' ? 'VIEW' : 'TABLE'} ${q}`),
    ]);

    const columns: ColumnInfo[] = cols.map((c) => ({
      name: String(c.Field),
      type: String(c.Type),
      nullable: c.Null === 'YES',
      defaultValue: c.Default === null ? null : String(c.Default),
      key: String(c.Key ?? ''),
      extra: String(c.Extra ?? ''),
      comment: String(c.Comment ?? ''),
    }));

    const indexes = new Map<string, IndexInfo>();
    for (const r of idx) {
      const name = String(r.Key_name);
      const entry = indexes.get(name) ?? { name, columns: [], unique: Number(r.Non_unique) === 0, primary: name === 'PRIMARY' };
      entry.columns.push(String(r.Column_name ?? r.Expression));
      indexes.set(name, entry);
    }

    const foreignKeys = new Map<string, ForeignKeyInfo>();
    for (const r of fks) {
      const name = String(r.name);
      const refTable = r.rdb === ref.database ? String(r.rtable) : `${r.rdb}.${r.rtable}`;
      const entry = foreignKeys.get(name) ?? { name, columns: [], refTable, refColumns: [], onUpdate: String(r.upd), onDelete: String(r.del) };
      entry.columns.push(String(r.col));
      entry.refColumns.push(String(r.rcol));
      foreignKeys.set(name, entry);
    }

    const ddlRow = ddlRows[0] ?? {};
    const ddl = String(ddlRow['Create Table'] ?? ddlRow['Create View'] ?? '');
    return { columns, indexes: [...indexes.values()], foreignKeys: [...foreignKeys.values()], ddl };
  }

  execute(sql: string, database: string | undefined): Promise<QueryResult> {
    return this.lock.run(async () => {
      const conn = this.session!;
      if (database && database !== this.currentDb) {
        await conn.query(`USE ${this.quoteIdent(database)}`);
        this.currentDb = database;
      }
      const started = Date.now();
      const [result, fields] = await conn.query({ sql, rowsAsArray: true });
      const durationMs = Date.now() - started;

      const use = /^\s*use\s+`?((?:[^`]|``)+?)`?\s*$/i.exec(sql);
      if (use) this.currentDb = use[1].replace(/``/g, '`');
      this.trackTransaction(sql);

      // CALL returns [resultSet..., header]; show the first result set.
      if (Array.isArray(result) && Array.isArray(fields) && Array.isArray(fields[0])) {
        const f = fields[0] as mysql.FieldPacket[];
        return { columns: f.map((x) => x.name), rows: (result[0] as unknown[][]).map((r) => r.map(normalizeValue)), durationMs };
      }
      if (Array.isArray(result) && fields) {
        const f = fields as mysql.FieldPacket[];
        return { columns: f.map((x) => x.name), rows: (result as unknown[][]).map((r) => r.map(normalizeValue)), durationMs };
      }
      const header = result as mysql.ResultSetHeader;
      return { columns: [], rows: [], affectedRows: header.affectedRows, durationMs };
    });
  }

  private trackTransaction(sql: string): void {
    if (isTxControl(sql)) this.pendingTransaction = false;
    else if (isTxBegin(sql) || (this.mode === 'manual' && !isReadOnly(sql))) this.pendingTransaction = true;
  }

  async cancel(): Promise<void> {
    if (this.session && this.meta) await this.meta.query('KILL QUERY ?', [this.session.threadId]);
  }

  setTxMode(mode: TxMode): Promise<void> {
    return this.lock.run(async () => {
      await this.session!.query(`SET autocommit = ${mode === 'auto' ? 1 : 0}`);
      this.mode = mode;
      this.pendingTransaction = false;
    });
  }

  commit(): Promise<void> {
    return this.lock.run(async () => {
      await this.session!.query('COMMIT');
      this.pendingTransaction = false;
    });
  }

  rollback(): Promise<void> {
    return this.lock.run(async () => {
      await this.session!.query('ROLLBACK');
      this.pendingTransaction = false;
    });
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  qualifiedName(ref: TableRef): string {
    return `${this.quoteIdent(ref.database)}.${this.quoteIdent(ref.name)}`;
  }
}
