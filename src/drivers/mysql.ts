import * as mysql from 'mysql2/promise';
import { checkServerIdentity, TLSSocket } from 'tls';
import { CellValue, ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TableRef, TableStructure, TxMode } from '../types';
import { applyUpdates, RowUpdate, updateStatement } from '../rowEdit';
import { mysqlTlsOptions } from './tls';
import { EDIT_SAVEPOINT, Endpoint, SqlDriver, isReadOnly, isTxBegin, isTxControl, leadingKeyword, Mutex, normalizeValue } from './driver';

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

type Row = Record<string, unknown>;

/** The callback connection behind mysql2/promise, whose queries emit rows one by one. */
interface CoreConnection {
  query(options: { sql: string; rowsAsArray: boolean }): NodeJS.EventEmitter;
}

/** "Query execution was interrupted": the answer to our own KILL QUERY. */
const ER_QUERY_INTERRUPTED = 1317;
/** OK packet status bit: a transaction is open on the server. */
const SERVER_STATUS_IN_TRANS = 0x0001;
/** "SAVEPOINT … does not exist": the transaction holding it was rolled back (deadlock, lock wait timeout). */
const ER_SP_DOES_NOT_EXIST = 1305;

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

  private async open(): Promise<mysql.Connection> {
    const e = this.endpoint;
    const { ssl, nameAfterConnect } = mysqlTlsOptions(e);
    const stream = e.stream ? await e.stream() : undefined;
    const conn = await mysql.createConnection({
      stream,
      host: e.host,
      port: e.port,
      user: e.user,
      password: e.password,
      database: e.database || undefined,
      ssl: ssl as mysql.SslOptions | undefined,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      connectTimeout: 15000,
    });
    if (nameAfterConnect) {
      const socket = (conn as unknown as { connection: { stream: TLSSocket } }).connection.stream;
      const mismatch = checkServerIdentity(nameAfterConnect, socket.getPeerCertificate());
      if (mismatch) {
        conn.destroy();
        throw mismatch;
      }
    }
    return conn;
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

  execute(sql: string, database: string | undefined, maxRows = Infinity): Promise<QueryResult> {
    return this.lock.run(async () => {
      const conn = this.session!;
      if (database && database !== this.currentDb) {
        await conn.query(`USE ${this.quoteIdent(database)}`);
        this.currentDb = database;
      }
      const started = Date.now();
      const result = leadingKeyword(sql) === 'call' ? await this.buffered(conn, sql) : await this.streamed(conn, sql, maxRows);
      result.durationMs = Date.now() - started;

      const use = /^\s*use\s+`?((?:[^`]|``)+?)`?\s*$/i.exec(sql);
      if (use) this.currentDb = use[1].replace(/``/g, '`');
      this.trackTransaction(sql);
      return result;
    });
  }

  /** CALL may return several result sets; it is buffered and shows the first one. */
  private async buffered(conn: mysql.Connection, sql: string): Promise<QueryResult> {
    const [result, fields] = await conn.query({ sql, rowsAsArray: true });
    // CALL returns [resultSet..., header].
    if (Array.isArray(result) && Array.isArray(fields) && Array.isArray(fields[0])) {
      const f = fields[0] as mysql.FieldPacket[];
      return { columns: f.map((x) => x.name), rows: (result[0] as unknown[][]).map((r) => r.map(normalizeValue)), durationMs: 0 };
    }
    if (Array.isArray(result) && fields) {
      const f = fields as mysql.FieldPacket[];
      return { columns: f.map((x) => x.name), rows: (result as unknown[][]).map((r) => r.map(normalizeValue)), durationMs: 0 };
    }
    return { columns: [], rows: [], affectedRows: (result as mysql.ResultSetHeader).affectedRows, durationMs: 0 };
  }

  /**
   * Keeps at most `maxRows` rows: past that, a read-only statement is killed on the
   * server (nothing to undo) and any other one has its remaining rows dropped as
   * they arrive, so memory stays bounded either way.
   */
  private streamed(conn: mysql.Connection, sql: string, maxRows: number): Promise<QueryResult> {
    const core = (conn as unknown as { connection: CoreConnection }).connection;
    return new Promise<QueryResult>((resolve, reject) => {
      let columns: string[] | undefined;
      const rows: CellValue[][] = [];
      let affectedRows: number | undefined;
      let truncated = false;
      let killing: Promise<unknown> | undefined;
      const query = core.query({ sql, rowsAsArray: true });
      // Statements without a result set emit 'fields' with nothing, then their header as a 'result'.
      query.on('fields', (fields?: mysql.FieldPacket[]) => {
        if (fields) columns = fields.map((f) => f.name);
      });
      query.on('result', (row: unknown) => {
        if (!Array.isArray(row)) {
          affectedRows = (row as mysql.ResultSetHeader).affectedRows;
          return;
        }
        if (truncated) return;
        if (rows.length < maxRows) {
          rows.push(row.map(normalizeValue));
          return;
        }
        truncated = true;
        if (isReadOnly(sql) && this.meta) killing = this.meta.query('KILL QUERY ?', [conn.threadId]).catch(() => undefined);
      });
      let settled = false;
      const done = (err?: mysql.QueryError) => {
        if (settled) return;
        settled = true;
        // Wait for the KILL so it cannot land on the next statement of the session.
        void Promise.resolve(killing).then(() => {
          if (err && !(truncated && err.errno === ER_QUERY_INTERRUPTED)) reject(err);
          else resolve(columns ? { columns, rows, truncated, ...(err ? { stopped: true } : {}), durationMs: 0 } : { columns: [], rows: [], affectedRows, durationMs: 0 });
        });
      };
      query.on('error', (err: mysql.QueryError) => done(err));
      query.on('end', () => done());
    });
  }

  private trackTransaction(sql: string): void {
    if (isTxControl(sql)) this.pendingTransaction = false;
    else if (isTxBegin(sql) || (this.mode === 'manual' && !isReadOnly(sql))) this.pendingTransaction = true;
  }

  updateRows(ref: TableRef, updates: RowUpdate[]): Promise<void> {
    return this.lock.run(async () => {
      const conn = this.session!;
      // A transaction is open in manual mode (autocommit off) or after a BEGIN typed in auto mode;
      // START TRANSACTION there would commit it.
      let inTx = this.mode === 'manual' || this.pendingTransaction;
      if (inTx) {
        const [header] = await conn.query(`SAVEPOINT ${EDIT_SAVEPOINT}`);
        // No transaction holds the savepoint, so it would undo nothing: in manual mode none has started
        // yet (a SAVEPOINT does not start one), so start it; after a typed BEGIN, it was implicitly
        // committed since (DDL, LOCK TABLES, SET autocommit = 1), so the save goes on its own.
        if (!((header as mysql.ResultSetHeader).serverStatus & SERVER_STATUS_IN_TRANS)) {
          if (this.mode === 'manual') {
            await conn.query('START TRANSACTION');
            await conn.query(`SAVEPOINT ${EDIT_SAVEPOINT}`);
          } else {
            inTx = false;
            this.pendingTransaction = false;
          }
        }
      }
      if (!inTx) await conn.query('START TRANSACTION');
      try {
        await applyUpdates(
          updates,
          (u) => updateStatement(this.qualifiedName(ref), u, (n) => this.quoteIdent(n), () => '?'),
          async (sql, params) => {
            const header = (await conn.query(sql, params))[0] as mysql.ResultSetHeader;
            // Without a strict sql_mode, MySQL stores a truncated or zeroed value and only warns.
            if (header.warningStatus > 0) {
              const [warnings] = await conn.query('SHOW WARNINGS');
              throw new Error((warnings as Row[]).map((w) => String(w.Message)).join('; '));
            }
            // FOUND_ROWS (a mysql2 default): rows matched, even those already holding the value.
            return header.affectedRows;
          },
        );
        await conn.query(inTx ? `RELEASE SAVEPOINT ${EDIT_SAVEPOINT}` : 'COMMIT');
      } catch (err) {
        try {
          await conn.query(inTx ? `ROLLBACK TO SAVEPOINT ${EDIT_SAVEPOINT}` : 'ROLLBACK');
        } catch (undo) {
          // A deadlock rolled the whole transaction back, the user's own writes included.
          if ((undo as mysql.QueryError).errno === ER_SP_DOES_NOT_EXIST) {
            this.pendingTransaction = false;
            throw new Error(`${(err as Error).message} The server rolled back the whole transaction, earlier changes included.`);
          }
        }
        throw err;
      }
      if (inTx) this.pendingTransaction = true;
    });
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
