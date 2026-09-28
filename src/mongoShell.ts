import * as acorn from 'acorn';
import { Binary, Decimal128, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from 'mongodb';
import * as vm from 'vm';

export interface ScriptStatement {
  text: string;
  start: number;
  end: number;
}

/** Top-level JavaScript statements of a mongosh-style script. */
export function splitScript(source: string): ScriptStatement[] {
  let program: acorn.Program;
  try {
    program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (err) {
    const e = err as SyntaxError & { loc?: { line: number; column: number } };
    throw new SyntaxError(e.loc ? `${e.message.replace(/\s*\(\d+:\d+\)$/, '')} (line ${e.loc.line}, column ${e.loc.column + 1})` : e.message);
  }
  return program.body.filter((s) => s.type !== 'EmptyStatement').map((s) => ({ text: source.slice(s.start, s.end), start: s.start, end: s.end }));
}

/**
 * Rebuilds values created inside the vm context with this realm's Object / Array /
 * Date / RegExp, so the driver and BSON serializer see ordinary values. BSON
 * instances (ObjectId…) already come from this realm and are kept as they are.
 */
export function toHostRealm(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v, toHostRealm); // not v.map: it would build a vm-realm array
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return new Date((v as Date).getTime());
  if (tag === '[object RegExp]') return new RegExp((v as RegExp).source, (v as RegExp).flags);
  if ('_bsontype' in v) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== null && proto.constructor?.name !== 'Object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toHostRealm(x)]));
}

/** A deferred database call recorded by the `db` proxy; the driver executes it. */
export class MongoOp {
  readonly chain: { method: string; args: unknown[] }[] = [];

  constructor(
    /** undefined = the editor's database. */
    readonly database: string | undefined,
    /** undefined for database-level methods. */
    readonly collection: string | undefined,
    readonly method: string,
    readonly args: unknown[],
  ) {
    this.args = args.map(toHostRealm);
  }

  /** Human-readable form for result tabs and confirmations. */
  describe(): string {
    const target = this.collection === undefined ? 'db' : `db.${this.collection}`;
    const call = (m: string, a: unknown[]) => `${m}(${a.map(preview).join(', ')})`;
    return [`${this.database ? `db.getSiblingDB(${JSON.stringify(this.database)})` : ''}${this.database ? target.slice(2) : target}`, call(this.method, this.args), ...this.chain.map((c) => call(c.method, c.args))].join('.');
  }
}

const CURSOR_METHODS = ['sort', 'limit', 'skip', 'project', 'projection', 'hint', 'maxTimeMS', 'collation', 'comment', 'batchSize', 'allowDiskUse', 'toArray', 'count', 'explain', 'pretty', 'itcount'];

export const COLLECTION_METHODS = [
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'count', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'getIndexes', 'indexes', 'drop', 'renameCollection', 'stats',
] as const;

export const DB_METHODS = ['runCommand', 'adminCommand', 'getCollectionNames', 'getCollectionInfos', 'stats', 'createCollection', 'createView', 'dropDatabase'] as const;

/** Methods that change data; used for the pending-transaction flag. */
export const WRITE_METHODS = new Set([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
]);

/** Methods that cannot run inside a multi-document transaction. */
export const DDL_METHODS = new Set(['createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'drop', 'renameCollection', 'createCollection', 'createView', 'dropDatabase', 'adminCommand']);

function cursorProxy(op: MongoOp): unknown {
  const cursor: Record<string, unknown> = {};
  for (const m of CURSOR_METHODS) {
    cursor[m] = (...args: unknown[]) => {
      if (m !== 'pretty') op.chain.push({ method: m, args: args.map(toHostRealm) });
      return m === 'toArray' || m === 'count' || m === 'explain' || m === 'itcount' ? op : cursor;
    };
  }
  // The cursor object stands for the op when it is the statement's value.
  Object.defineProperty(cursor, '__op', { value: op });
  return cursor;
}

function collectionProxy(database: string | undefined, name: string): unknown {
  const methods: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of COLLECTION_METHODS) {
    methods[m] = (...args: unknown[]) => {
      const op = new MongoOp(database, name, m, args);
      return m === 'find' || m === 'aggregate' ? cursorProxy(op) : op;
    };
  }
  methods.getName = () => name;
  return new Proxy(methods, {
    get: (target, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return collectionProxy(database, `${name}.${prop}`); // db.a.b = collection "a.b"
    },
  });
}

function dbProxy(database: string | undefined): unknown {
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    getSiblingDB: (name: unknown) => dbProxy(String(name)),
    getCollection: (name: unknown) => collectionProxy(database, String(name)),
    getName: () => database,
  };
  for (const m of DB_METHODS) methods[m] = (...args: unknown[]) => new MongoOp(m === 'adminCommand' ? 'admin' : database, undefined, m, args);
  return new Proxy(methods, {
    get: (target, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return collectionProxy(database, prop);
    },
  });
}

/** Shell globals: the recording `db` plus the usual BSON constructors. */
export function createShellContext(): vm.Context {
  return vm.createContext({
    db: dbProxy(undefined),
    ObjectId: (hex?: string) => (hex === undefined ? new ObjectId() : new ObjectId(hex)),
    ISODate: (s?: string) => (s === undefined ? new Date() : new Date(s)),
    Date,
    NumberLong: (v: unknown) => Long.fromString(String(v)),
    NumberInt: (v: unknown) => new Int32(Number(v)),
    NumberDecimal: (v: unknown) => Decimal128.fromString(String(v)),
    Decimal128: (v: unknown) => Decimal128.fromString(String(v)),
    UUID: (s?: string) => (s === undefined ? new UUID() : new UUID(s)),
    BinData: (subtype: number, base64: string) => new Binary(Buffer.from(base64, 'base64'), subtype),
    Timestamp: (t: number, i: number) => new Timestamp({ t, i }),
    MinKey: () => new MinKey(),
    MaxKey: () => new MaxKey(),
    Math,
    JSON,
  });
}

const SYNC_TIMEOUT_MS = 2000;

/** Evaluates one statement; returns a MongoOp for database calls, else the plain value. */
export function evaluate(statement: string, context: vm.Context): unknown {
  const value = vm.runInContext(statement, context, { timeout: SYNC_TIMEOUT_MS });
  if (value && typeof value === 'object' && '__op' in value) return (value as { __op: MongoOp }).__op;
  return value instanceof MongoOp ? value : toHostRealm(value);
}

/** Evaluates a filter / sort / projection object typed in the collection viewer. */
export function evaluateObject(text: string, context: vm.Context = createShellContext()): Record<string, unknown> {
  if (!text.trim()) return {};
  const value = vm.runInContext(`(${text}\n)`, context, { timeout: SYNC_TIMEOUT_MS });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object like { field: value }, got: ${text}`);
  return toHostRealm(value) as Record<string, unknown>;
}

const isEmptyFilter = (f: unknown) => f === undefined || (typeof f === 'object' && f !== null && Object.keys(f).length === 0);

/** Irreversible in auto mode: drops, and updates/deletes over the whole collection. */
export function isDestructiveOp(op: MongoOp): boolean {
  if (op.method === 'drop' || op.method === 'dropDatabase' || op.method === 'dropIndexes') return true;
  return (op.method === 'deleteMany' || op.method === 'updateMany') && isEmptyFilter(op.args[0]);
}

function preview(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    return s === undefined ? String(v) : s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return String(v);
  }
}
