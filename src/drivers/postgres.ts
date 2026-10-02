import { Client } from 'pg';
import Cursor from 'pg-cursor';
import { CellValue, ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TableRef, TableStructure, TxMode } from '../types';
import { tlsOptions } from './tls';
import { Endpoint, SqlDriver, isReadOnly, isTxBegin, isTxControl, leadingKeyword, Mutex, normalizeValue } from './driver';

const FK_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

type Row = Record<string, unknown>;

/** A per-database session left idle this long is closed, unless it holds state. */
export const SESSION_IDLE_MS = 10 * 60 * 1000;

/** Leaves something behind in the session (settings, temp objects, locks): never closed when idle. */
export const holdsSessionState = (sql: string) =>
  ['set', 'prepare', 'listen', 'declare', 'load'].includes(leadingKeyword(sql)) ||
  (leadingKeyword(sql) === 'create' && /^\s*create\s+(global\s+|local\s+)?temp(orary)?\b/i.test(sql)) ||
  /\binto\s+temp(orary)?\b/i.test(sql) ||
  /\b(pg_(try_)?advisory_(xact_)?lock(_shared)?|set_config)\s*\(/i.test(sql);

/** Statements read through a cursor, which stops after `maxRows` rows; the rest are buffered. */
const ROW_STATEMENTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain']);

/** A closed cursor stops a read; a data-modifying WITH and EXPLAIN (ANALYZE) run whole regardless. */
const stopsWithCursor = (sql: string) => isReadOnly(sql) && leadingKeyword(sql) !== 'explain';

interface CursorResult {
  fields: { name: string }[];
  rowCount: number | null;
}

/** Fetches one batch of `maxRows + 1` rows (the extra one tells truncation) and closes the portal. */
function readCursor(client: Client, sql: string, maxRows: number): Promise<QueryResult> {
  const cursor = client.query(new Cursor(sql, undefined, { rowMode: 'array' }));
  const batch = Number.isFinite(maxRows) ? maxRows + 1 : 0;
  return new Promise<QueryResult>((resolve, reject) => {
    const rows: CellValue[][] = [];
    const step = () =>
      cursor.read(batch || 10000, (err: Error | undefined, got: unknown[][], result: CursorResult) => {
        if (err) return reject(err);
        for (const row of got) if (rows.length < maxRows) rows.push(row.map(normalizeValue));
        const more = got.length === (batch || 10000);
        if (more && !batch) return step();
        const done = () => {
          const fields = result.fields ?? [];
          resolve(
            fields.length
              ? { columns: fields.map((f) => f.name), rows, truncated: got.length > maxRows, ...(more && stopsWithCursor(sql) ? { stopped: true } : {}), durationMs: 0 }
              : { columns: [], rows: [], affectedRows: result.rowCount ?? undefined, durationMs: 0 },
          );
        };
        if (more) cursor.close((closeErr?: Error) => (closeErr ? reject(closeErr) : done()));
        else done();
      });
    step();
  });
}

async function buffered(client: Client, sql: string): Promise<QueryResult> {
  const res = await client.query({ text: sql, rowMode: 'array' });
  // Only `sql` with several statements returns an array; keep the last result.
  const r = Array.isArray(res) ? res[res.length - 1] : res;
  if (r.fields && r.fields.length > 0) {
    return { columns: r.fields.map((f: { name: string }) => f.name), rows: (r.rows as unknown[][]).map((row) => row.map(normalizeValue)), durationMs: 0 };
  }
  return { columns: [], rows: [], affectedRows: r.rowCount ?? undefined, durationMs: 0 };
}

/**
 * PostgreSQL has no cross-database queries, so each database gets its own pair of
 * clients, opened lazily. A manual transaction therefore lives per database;
 * commit/rollback apply to every database with an open transaction.
 */
export class PostgresDriver implements SqlDriver {
  readonly kind = 'postgres' as const;
  readonly family = 'sql' as const;
  readonly supportsManualTx = true;
  onLost?: (err: Error) => void;

  private readonly sessions = new Map<string, Client>();
  private readonly metas = new Map<string, Client>();
  /** Databases whose session has a transaction open (BEGIN sent). */
  private readonly openTx = new Set<string>();
  /** Subset of openTx where a write ran: what "pending" means to the user. */
  private readonly dirtyTx = new Set<string>();
  private readonly defaultDb: string;
  private running?: Client;
  /** Last statement time per database session, for the idle sweep. */
  private readonly lastUsed = new Map<string, number>();
  /** Databases whose session holds state (see holdsSessionState): kept open. */
  private readonly stateful = new Set<string>();
  private sweeper?: NodeJS.Timeout;
  private mode: TxMode = 'auto';
  private readonly lock = new Mutex();

  constructor(private readonly endpoint: Endpoint) {
    this.defaultDb = endpoint.database || 'postgres';
  }

  get pendingTransaction(): boolean {
    return this.dirtyTx.size > 0;
  }

  async connect(): Promise<void> {
    await this.client(this.defaultDb, 'meta');
    this.sweeper = setInterval(() => void this.closeIdleSessions(), 60_000);
    this.sweeper.unref();
  }

  /** Closes sessions idle for SESSION_IDLE_MS with no transaction and no state; reopened on the next statement. */
  closeIdleSessions(now = Date.now()): Promise<string[]> {
    return this.lock.run(async () => {
      const closed: string[] = [];
      for (const [db, client] of [...this.sessions]) {
        if (this.openTx.has(db) || this.stateful.has(db) || now - (this.lastUsed.get(db) ?? now) < SESSION_IDLE_MS) continue;
        this.sessions.delete(db);
        this.lastUsed.delete(db);
        closed.push(db);
        await client.end().catch(() => undefined);
      }
      return closed;
    });
  }

  private async client(database: string, role: 'session' | 'meta'): Promise<Client> {
    const pool = role === 'session' ? this.sessions : this.metas;
    const existing = pool.get(database);
    if (existing) return existing;
    const e = this.endpoint;
    const stream = e.stream ? await e.stream() : undefined;
    const client = new Client({
      stream: stream && (() => stream),
      host: e.host,
      port: e.port,
      user: e.user,
      password: e.password,
      database,
      ssl: tlsOptions(e),
      connectionTimeoutMillis: 15000,
      application_name: 'DataLodestar',
    });
    await client.connect();
    client.on('error', (err) => {
      // A client closed on purpose (idle sweep) is no longer in the pool: nothing was lost.
      if (pool.get(database) !== client) return;
      pool.delete(database);
      if (role === 'session') {
        this.openTx.delete(database);
        this.dirtyTx.delete(database);
        this.stateful.delete(database);
        this.lastUsed.delete(database);
        this.onLost?.(err);
      }
    });
    pool.set(database, client);
    return client;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.lastUsed.clear();
    this.stateful.clear();
    const all = [...this.sessions.values(), ...this.metas.values()];
    this.sessions.clear();
    this.metas.clear();
    this.openTx.clear();
    this.dirtyTx.clear();
    await Promise.allSettled(all.map((c) => c.end()));
  }

  private async metaQuery(database: string, sql: string, params: unknown[] = []): Promise<Row[]> {
    const res = await (await this.client(database, 'meta')).query(sql, params);
    return res.rows;
  }

  async listDatabases(showSystem: boolean): Promise<string[]> {
    const rows = await this.metaQuery(
      this.defaultDb,
      'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname',
    );
    return rows.map((r) => String(r.datname)).filter((d) => showSystem || d !== 'postgres' || d === this.defaultDb);
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.metaQuery(
      database,
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
              c.reltuples::bigint AS est, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname <> 'public', n.nspname, c.relname`,
    );
    return rows.map((r) => ({
      database,
      schema: String(r.schema),
      name: String(r.name),
      type: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table',
      estimatedRows: r.est === null || Number(r.est) < 0 ? undefined : Number(r.est),
      comment: r.comment ? String(r.comment) : undefined,
    }));
  }

  async describeTable(ref: TableRef): Promise<TableStructure> {
    const db = ref.database;
    const rel = [this.qualifiedName(ref)];
    const [cols, idx, fks, cons] = await Promise.all([
      this.metaQuery(
        db,
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS def, col_description(a.attrelid, a.attnum) AS comment,
                a.attidentity AS identity, a.attgenerated AS generated
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        rel,
      ),
      this.metaQuery(
        db,
        `SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS pk, pg_get_indexdef(ix.indexrelid) AS def,
                EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid) AS from_constraint,
                array(SELECT coalesce(a.attname, '(expr)') FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(n, o)
                        LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = $1::regclass ORDER BY ix.indisprimary DESC, i.relname`,
        rel,
      ),
      this.metaQuery(
        db,
        `SELECT c.conname AS name, c.confrelid::regclass::text AS ref, c.confupdtype AS upd, c.confdeltype AS del,
                array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
                array(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
                        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS refcols
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f' ORDER BY c.conname`,
        rel,
      ),
      this.metaQuery(
        db,
        `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass ORDER BY contype = 'p' DESC, conname`,
        rel,
      ),
    ]);

    const pkCols = new Set<string>((idx.find((i) => i.pk)?.cols as string[]) ?? []);
    const uniqueCols = new Set<string>(idx.filter((i) => i.uniq && !i.pk && (i.cols as string[]).length === 1).map((i) => (i.cols as string[])[0]));
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: String(c.name),
      type: String(c.type),
      nullable: Boolean(c.nullable),
      defaultValue: c.def === null ? null : String(c.def),
      key: pkCols.has(String(c.name)) ? 'PRI' : uniqueCols.has(String(c.name)) ? 'UNI' : '',
      extra: c.identity === 'a' ? 'identity always' : c.identity === 'd' ? 'identity by default' : c.generated === 's' ? 'generated stored' : '',
      comment: c.comment ? String(c.comment) : '',
    }));
    const indexes: IndexInfo[] = idx.map((i) => ({ name: String(i.name), columns: i.cols as string[], unique: Boolean(i.uniq), primary: Boolean(i.pk) }));
    const foreignKeys: ForeignKeyInfo[] = fks.map((f) => ({
      name: String(f.name),
      columns: f.cols as string[],
      refTable: String(f.ref),
      refColumns: f.refcols as string[],
      onUpdate: FK_ACTIONS[String(f.upd)] ?? String(f.upd),
      onDelete: FK_ACTIONS[String(f.del)] ?? String(f.del),
    }));

    let ddl: string;
    if (ref.type === 'view') {
      const [v] = await this.metaQuery(db, 'SELECT pg_get_viewdef($1::regclass, true) AS def', rel);
      ddl = `CREATE VIEW ${rel[0]} AS\n${String(v?.def ?? '').trimEnd()}`;
    } else {
      const lines = columns.map((c) => {
        let line = `  ${this.quoteIdent(c.name)} ${c.type}`;
        if (c.extra.startsWith('identity')) line += ` GENERATED ${c.extra === 'identity always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
        else if (c.defaultValue !== null) line += ` DEFAULT ${c.defaultValue}`;
        if (!c.nullable) line += ' NOT NULL';
        return line;
      });
      for (const k of cons) lines.push(`  CONSTRAINT ${this.quoteIdent(String(k.name))} ${k.def}`);
      const extraIdx = idx.filter((i) => !i.from_constraint).map((i) => `${i.def};`);
      ddl = [`CREATE TABLE ${rel[0]} (\n${lines.join(',\n')}\n);`, ...extraIdx].join('\n\n');
    }
    return { columns, indexes, foreignKeys, ddl };
  }

  execute(sql: string, database: string | undefined, maxRows = Infinity): Promise<QueryResult> {
    const db = database || this.defaultDb;
    return this.lock.run(async () => {
      const client = await this.client(db, 'session');
      this.lastUsed.set(db, Date.now());
      if (holdsSessionState(sql)) this.stateful.add(db);
      if (this.mode === 'manual' && !this.openTx.has(db) && !isTxBegin(sql) && !isTxControl(sql)) {
        await client.query('BEGIN');
        this.openTx.add(db);
      }
      const started = Date.now();
      this.running = client;
      try {
        const result = ROW_STATEMENTS.has(leadingKeyword(sql)) ? await readCursor(client, sql, maxRows) : await buffered(client, sql);
        result.durationMs = Date.now() - started;
        this.track(db, sql);
        return result;
      } catch (err) {
        // A failed COMMIT/ROLLBACK still ends the transaction; a failed write aborts it
        // and PostgreSQL then needs a ROLLBACK, so it counts as pending.
        this.track(db, sql);
        if (this.openTx.has(db)) this.dirtyTx.add(db);
        throw err;
      } finally {
        this.running = undefined;
      }
    });
  }

  private track(db: string, sql: string): void {
    if (isTxControl(sql)) {
      this.openTx.delete(db);
      this.dirtyTx.delete(db);
    } else if (isTxBegin(sql)) {
      this.openTx.add(db);
      this.dirtyTx.add(db);
    } else if (this.openTx.has(db) && !isReadOnly(sql)) {
      this.dirtyTx.add(db);
    }
  }

  async cancel(): Promise<void> {
    const pid = (this.running as unknown as { processID?: number } | undefined)?.processID;
    if (pid) await this.metaQuery(this.defaultDb, 'SELECT pg_cancel_backend($1)', [pid]);
  }

  setTxMode(mode: TxMode): Promise<void> {
    return this.lock.run(async () => {
      this.mode = mode;
    });
  }

  commit(): Promise<void> {
    return this.endTransactions('COMMIT');
  }

  rollback(): Promise<void> {
    return this.endTransactions('ROLLBACK');
  }

  private endTransactions(verb: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    return this.lock.run(async () => {
      for (const db of [...this.openTx]) {
        await this.sessions.get(db)?.query(verb);
        this.openTx.delete(db);
        this.dirtyTx.delete(db);
      }
    });
  }

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  qualifiedName(ref: TableRef): string {
    return ref.schema ? `${this.quoteIdent(ref.schema)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name);
  }
}
