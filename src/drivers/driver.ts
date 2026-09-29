import { BinaryCell, CellValue, DbKind, Family, QueryResult, TableInfo, TableRef, TableStructure, TxMode } from '../types';

export interface Endpoint {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl: boolean;
  uri?: string;
  authSource?: string;
}

/**
 * One driver instance = one logical connection to a host. It owns a "session"
 * connection used for user statements (so a manual transaction spans them) and a
 * separate metadata connection that always auto-commits, so browsing the tree
 * never runs inside — or gets blocked by — the user's transaction.
 */
export interface BaseDriver {
  readonly kind: DbKind;
  readonly family: Family;
  /** False when the engine has no commit/rollback mode (Redis). */
  readonly supportsManualTx: boolean;
  /** True while writes wait for commit/rollback (or a Redis MULTI waits for EXEC). */
  readonly pendingTransaction: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  listDatabases(showSystem: boolean): Promise<string[]>;
  /** Asks the server to abort the statement currently running in the session. */
  cancel(): Promise<void>;
  setTxMode(mode: TxMode): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Called when the server drops the session. */
  onLost?: (err: Error) => void;
}

export interface SqlDriver extends BaseDriver {
  readonly family: 'sql';
  listTables(database: string): Promise<TableInfo[]>;
  describeTable(ref: TableRef): Promise<TableStructure>;
  /**
   * Runs a single statement in the session, against `database` when given. At most
   * `maxRows` rows are kept (and read, where the engine allows); `truncated` says more existed.
   */
  execute(sql: string, database: string | undefined, maxRows?: number): Promise<QueryResult>;
  quoteIdent(name: string): string;
  qualifiedName(ref: TableRef): string;
}

/** Serialises async work so session statements never interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Bytes sent to the grid per binary cell: enough for any key, bounded for blobs. */
export const BINARY_LIMIT = 4096;

/** Turns driver values into something JSON-safe and readable in a grid. */
export function normalizeValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').replace('Z', '');
  if (Buffer.isBuffer(v)) return { b: v.subarray(0, BINARY_LIMIT).toString('hex'), n: v.length } satisfies BinaryCell;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const LEADING_NOISE = /^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|\()+/;

/** First keyword of a statement, ignoring leading comments and parentheses. */
export const leadingKeyword = (sql: string) => (/^[a-z]+/i.exec(sql.replace(LEADING_NOISE, ''))?.[0] ?? '').toLowerCase();

/**
 * Statements that neither change data nor take row locks; they do not make a
 * manual transaction "pending". Errs on the side of pending.
 */
export function isReadOnly(sql: string): boolean {
  if (!['select', 'show', 'describe', 'desc', 'explain', 'values', 'table', 'with'].includes(leadingKeyword(sql))) return false;
  return !/\b(insert|update|delete|merge|into|for\s+(update|share|no\s+key\s+update|key\s+share)|lock\s+in\s+share\s+mode)\b/i.test(sql);
}

export const isTxControl = (sql: string) => /^\s*(commit|rollback|end)\b/i.test(sql);
export const isTxBegin = (sql: string) => /^\s*(begin|start\s+transaction)\b/i.test(sql);
