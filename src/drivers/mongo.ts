import { Binary, BSON, ClientSession, Decimal128, Document, Long, MongoClient, MongoClientOptions, ObjectId, Sort } from 'mongodb';
import { parseFilter } from '../filterParser';
import { DDL_METHODS, MongoOp, WRITE_METHODS } from '../mongoShell';
import { splitUriPassword } from '../uriCredentials';
import { CellValue, CollectionInfo, CollectionStructure, FieldInfo, QueryResult, TxMode } from '../types';
import { BaseDriver, BINARY_LIMIT, Endpoint, Mutex } from './driver';
import { mongoTlsOptions } from './tls';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rowsFromDocuments } = require('../../media/mongoRows.js') as { rowsFromDocuments: (columns: string[], documents: unknown[]) => CellValue[][] };

const { EJSON } = BSON;

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);
const SAMPLE_SIZE = 200;
const FIELD_DEPTH = 3;
const MAX_CELL_JSON = 2000;

/** Server error codes meaning "your transaction no longer exists". */
const TX_GONE = new Set([251 /* NoSuchTransaction */, 256 /* TransactionCommitted */]);
/** Conflicts that abort the transaction, sometimes reported without the TransientTransactionError label. */
const TX_CONFLICT = new Set([112 /* WriteConflict */]);

export class MongoDriver implements BaseDriver {
  readonly kind = 'mongodb' as const;
  readonly family = 'mongo' as const;
  readonly supportsManualTx = true;
  onLost?: (err: Error) => void;

  private client?: MongoClient;
  private session?: ClientSession;
  private mode: TxMode = 'auto';
  private dirty = false;
  private runningTag?: string;
  private readonly lock = new Mutex();

  constructor(private readonly endpoint: Endpoint) {}

  get pendingTransaction(): boolean {
    return this.dirty;
  }

  /** Database used when the editor has none: the configured one, else "test" like mongosh. */
  get defaultDatabase(): string {
    return this.endpoint.database || 'test';
  }

  async connect(): Promise<void> {
    const e = this.endpoint;
    const options: MongoClientOptions = {
      appName: 'DataLodestar',
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    };
    let url = e.uri;
    if (url) {
      // "mongodb+srv://user@host/" plus the Password field kept in the keychain.
      const parsed = splitUriPassword(url);
      if (parsed.user && parsed.password === undefined && e.password) {
        options.auth = { username: parsed.user, password: e.password };
      }
    } else {
      // A path is the Unix socket of an SSH tunnel (see SshTunnel.listen).
      url = e.host.startsWith('/') ? `mongodb://${encodeURIComponent(e.host)}` : `mongodb://${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}`;
      // A single explicit host, possibly an SSH tunnel: never follow replica-set member names.
      options.directConnection = true;
      if (e.user) {
        options.auth = { username: e.user, password: e.password };
        options.authSource = e.authSource || 'admin';
      }
      Object.assign(options, mongoTlsOptions(e));
    }
    this.client = new MongoClient(url, options);
    await this.client.connect();
    await this.client.db('admin').command({ ping: 1 });
    this.client.on('serverHeartbeatFailed', (ev) => this.onLost?.(ev.failure));
  }

  async close(): Promise<void> {
    await this.session?.endSession().catch(() => undefined);
    this.session = undefined;
    this.dirty = false;
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }

  async listDatabases(showSystem: boolean): Promise<string[]> {
    try {
      const res = await this.client!.db('admin').command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
      const names = (res.databases as { name: string }[]).map((d) => d.name).sort();
      return names.filter((d) => showSystem || !SYSTEM_DATABASES.has(d) || d === this.endpoint.database);
    } catch {
      // Users without listDatabases still browse their own database.
      return [this.defaultDatabase];
    }
  }

  async listCollections(database: string): Promise<CollectionInfo[]> {
    const infos = await this.client!.db(database).listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray();
    return infos
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ database, name: c.name, type: (c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : 'collection') as CollectionInfo['type'] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Field list inferred from a random sample, plus indexes and collection options. */
  async describeCollection(database: string, name: string): Promise<CollectionStructure> {
    const db = this.client!.db(database);
    const [info] = await db.listCollections({ name }).toArray();
    const isView = info?.type === 'view';
    const coll = db.collection(name);
    const sample = isView ? await coll.find().limit(SAMPLE_SIZE).toArray() : await coll.aggregate([{ $sample: { size: SAMPLE_SIZE } }]).toArray();
    const stats = new Map<string, { types: Set<string>; count: number }>();
    for (const doc of sample) collectFields(doc, '', 0, stats);
    const fields: FieldInfo[] = [...stats.entries()]
      .map(([path, s]) => ({ path, types: [...s.types].sort(), presence: sample.length ? Math.round((s.count / sample.length) * 100) : 0 }))
      .sort((a, b) => (a.path === '_id' ? -1 : b.path === '_id' ? 1 : 0));
    const indexes = isView
      ? []
      : (await coll.indexes()).map((i) => {
          const { v: _v, key, name: idxName, unique, ns: _ns, ...rest } = i as Document;
          return { name: String(idxName), key: JSON.stringify(key), unique: Boolean(unique), options: Object.keys(rest).length ? EJSON.stringify(rest, { relaxed: true }) : '' };
        });
    const options = info ? EJSON.stringify({ type: info.type, options: (info as Document).options }, undefined, 2, { relaxed: true }) : '';
    return { sampled: sample.length, fields, indexes, options };
  }

  /** Collection viewer page. Filter and sort are shell object literals, parsed, never run. */
  find(database: string, collection: string, filterText: string, sortText: string, limit: number, skip: number): Promise<QueryResult> {
    const filter = parseFilter(filterText);
    const sort = parseFilter(sortText);
    return this.inSession(false, async (session) => {
      const started = Date.now();
      const docs = await this.client!.db(database).collection(collection).find(filter, { sort: sort as Sort, skip, limit, session }).toArray();
      return { ...documentsToResult(docs, docs.length), durationMs: Date.now() - started };
    });
  }

  count(database: string, collection: string, filterText: string): Promise<number> {
    const filter = parseFilter(filterText);
    return this.inSession(false, (session) => this.client!.db(database).collection(collection).countDocuments(filter, { session }));
  }

  /** Executes a call recorded by the shell. `maxRows` caps what cursors return. */
  runOp(op: MongoOp, editorDatabase: string | undefined, maxRows: number): Promise<QueryResult> {
    const database = op.database ?? editorDatabase ?? this.defaultDatabase;
    const write = WRITE_METHODS.has(op.method);
    const ddl = DDL_METHODS.has(op.method) || (op.method === 'aggregate' && hasOutStage(op.args[0]));
    if (ddl && this.mode === 'manual') return this.runDdl(op, database, maxRows);
    return this.inSession(write, async (session) => {
      const tag = `sqlnav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.runningTag = tag;
      const started = Date.now();
      try {
        const result = await execute(this.client!, database, op, ddl ? undefined : session, maxRows, tag);
        return { ...result, durationMs: Date.now() - started };
      } finally {
        this.runningTag = undefined;
      }
    });
  }

  /**
   * MongoDB runs index and collection changes outside transactions, and they
   * conflict with a transaction that touched the same collection (the commit
   * then fails). So: refused while writes are pending; a read-only transaction
   * is simply closed first.
   */
  private runDdl(op: MongoOp, database: string, maxRows: number): Promise<QueryResult> {
    return this.lock.run(async () => {
      if (this.dirty) {
        throw new Error(`Commit or roll back the open transaction before ${op.method}(): MongoDB runs it outside transactions and it would conflict with your pending changes.`);
      }
      if (this.session?.inTransaction()) await this.session.abortTransaction().catch(() => undefined);
      const started = Date.now();
      return { ...(await execute(this.client!, database, op, undefined, maxRows, 'sqlnav-ddl')), durationMs: Date.now() - started };
    });
  }

  /**
   * Runs work with the transaction session when in manual mode. Read-only work
   * whose transaction expired server-side is retried once in a fresh one.
   */
  private inSession<T>(write: boolean, work: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      if (this.mode === 'auto') return work(undefined);
      for (let attempt = 0; ; attempt++) {
        const session = this.transaction();
        try {
          const result = await work(session);
          if (write) this.dirty = true;
          return result;
        } catch (err) {
          const e = err as { code?: number; message?: string; hasErrorLabel?: (l: string) => boolean };
          const gone = e.code !== undefined && TX_GONE.has(e.code);
          const transient = !!e.hasErrorLabel?.('TransientTransactionError') || (e.code !== undefined && TX_CONFLICT.has(e.code));
          if (gone || transient) {
            // The server already aborted the transaction: nothing of it survives.
            await session.abortTransaction().catch(() => undefined);
            if (!this.dirty && attempt === 0) continue; // only reads were lost: retry transparently
            this.dirty = false;
            throw new Error(
              gone
                ? 'The transaction expired on the server (MongoDB aborts transactions after 60 s by default); its changes were rolled back.'
                : `MongoDB aborted the transaction (${e.message}); its changes were rolled back. Run them again.`,
            );
          }
          if (write) this.dirty = true; // a failed write still leaves the transaction to settle
          throw err;
        }
      }
    });
  }

  private transaction(): ClientSession {
    this.session ??= this.client!.startSession();
    if (!this.session.inTransaction()) this.session.startTransaction();
    return this.session;
  }

  async cancel(): Promise<void> {
    const tag = this.runningTag;
    if (!tag || !this.client) return;
    const admin = this.client.db('admin');
    const ops = await admin.aggregate([{ $currentOp: { allUsers: true } }, { $match: { 'command.comment': tag } }]).toArray();
    for (const o of ops) await admin.command({ killOp: 1, op: o.opid });
  }

  async setTxMode(mode: TxMode): Promise<void> {
    await this.lock.run(async () => {
      if (mode === 'manual') {
        const hello = await this.client!.db('admin').command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid') {
          throw new Error('MongoDB transactions need a replica set or a sharded cluster; this server is standalone. Keep auto-commit.');
        }
      } else if (this.session?.inTransaction()) {
        await this.session.commitTransaction();
      }
      this.mode = mode;
      this.dirty = false;
    });
  }

  commit(): Promise<void> {
    return this.endTransaction((s) => s.commitTransaction());
  }

  rollback(): Promise<void> {
    return this.endTransaction((s) => s.abortTransaction());
  }

  private endTransaction(end: (s: ClientSession) => Promise<unknown>): Promise<void> {
    return this.lock.run(async () => {
      try {
        if (this.session?.inTransaction()) await end(this.session);
      } catch (err) {
        await this.session?.abortTransaction().catch(() => undefined);
        throw new Error(`MongoDB rejected the commit (${(err as Error).message}); the transaction's changes were rolled back.`);
      } finally {
        this.dirty = false;
      }
    });
  }
}

async function execute(client: MongoClient, database: string, op: MongoOp, session: ClientSession | undefined, maxRows: number, comment: string): Promise<Omit<QueryResult, 'durationMs'>> {
  const db = client.db(database);
  const a = op.args as any[];
  const opts = (o: unknown) => ({ ...(o as object), session, comment });

  if (op.collection === undefined) {
    switch (op.method) {
      case 'runCommand':
      case 'adminCommand': {
        // Like mongosh, hide the replica-set gossip fields.
        const { $clusterTime: _t, operationTime: _o, ...reply } = await db.command(a[0], { session });
        return documentsToResult([reply], maxRows);
      }
      case 'getCollectionNames':
        return valuesToResult(
          (await db.listCollections({}, { nameOnly: true }).toArray())
            .map((c) => c.name)
            .filter((n) => !n.startsWith('system.'))
            .sort(),
        );
      case 'getCollectionInfos':
        return documentsToResult(await db.listCollections(a[0] ?? {}).toArray(), maxRows);
      case 'stats':
        return documentsToResult([await db.stats()], maxRows);
      case 'createCollection':
        await db.createCollection(a[0], a[1]);
        return { columns: ['ok'], rows: [[1]] };
      case 'createView':
        await db.createCollection(a[0], { viewOn: a[1], pipeline: a[2], ...(a[3] ?? {}) });
        return { columns: ['ok'], rows: [[1]] };
      case 'dropDatabase':
        return valuesToResult([await db.dropDatabase()]);
    }
    throw new Error(`Unsupported: db.${op.method}()`);
  }

  const coll = db.collection(op.collection);
  switch (op.method) {
    case 'find':
    case 'aggregate': {
      const cursor = op.method === 'find' ? coll.find(a[0] ?? {}, opts({ projection: a[1] })) : coll.aggregate(a[0] ?? [], opts(a[1]));
      let userLimit: number | undefined;
      for (const { method, args } of op.chain) {
        const c = cursor as any;
        if (method === 'count' || method === 'itcount') {
          const filter = op.method === 'find' ? (a[0] ?? {}) : undefined;
          if (filter === undefined) return valuesToResult([(await cursor.toArray()).length]);
          return valuesToResult([await coll.countDocuments(filter, { session })]);
        }
        if (method === 'explain') return documentsToResult([await cursor.explain(args[0] as any)], maxRows);
        if (method === 'toArray') continue;
        if (method === 'limit') userLimit = Number(args[0]);
        const target = method === 'projection' ? 'project' : method;
        if (typeof c[target] !== 'function') throw new Error(`Unsupported cursor method: ${method}()`);
        c[target](...args);
      }
      const docs: Document[] = [];
      const cap = Math.min(userLimit || Infinity, maxRows + 1);
      for await (const doc of cursor) {
        docs.push(doc);
        if (docs.length >= cap) break;
      }
      await cursor.close();
      return documentsToResult(docs, maxRows);
    }
    case 'findOne': {
      const doc = await coll.findOne(a[0] ?? {}, opts({ projection: a[1] }));
      return doc ? documentsToResult([doc], maxRows) : { columns: [], rows: [], affectedRows: 0 };
    }
    case 'countDocuments':
    case 'count':
      return valuesToResult([await coll.countDocuments(a[0] ?? {}, opts(a[1]))]);
    case 'estimatedDocumentCount':
      return valuesToResult([await coll.estimatedDocumentCount()]);
    case 'distinct':
      return valuesToResult(await coll.distinct(a[0], a[1] ?? {}, opts(a[2])));
    case 'insertOne': {
      const r = await coll.insertOne(a[0], opts(a[1]));
      return { ...documentsToResult([{ acknowledged: r.acknowledged, insertedId: r.insertedId }], maxRows), affectedRows: 1 };
    }
    case 'insertMany': {
      const r = await coll.insertMany(a[0], opts(a[1]));
      return { ...documentsToResult([{ acknowledged: r.acknowledged, insertedCount: r.insertedCount, insertedIds: r.insertedIds }], maxRows), affectedRows: r.insertedCount };
    }
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne': {
      const r = op.method === 'replaceOne' ? await coll.replaceOne(a[0], a[1], opts(a[2])) : await coll[op.method](a[0], a[1], opts(a[2]));
      return { ...documentsToResult([{ ...r }], maxRows), affectedRows: r.modifiedCount + (r.upsertedCount ?? 0) };
    }
    case 'deleteOne':
    case 'deleteMany': {
      const r = await coll[op.method](a[0] ?? {}, opts(a[1]));
      return { ...documentsToResult([{ ...r }], maxRows), affectedRows: r.deletedCount };
    }
    case 'bulkWrite': {
      const r = await coll.bulkWrite(a[0], opts(a[1]));
      return documentsToResult([{ insertedCount: r.insertedCount, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, deletedCount: r.deletedCount, upsertedCount: r.upsertedCount }], maxRows);
    }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const doc =
        op.method === 'findOneAndDelete'
          ? await coll.findOneAndDelete(a[0], opts(a[1]))
          : op.method === 'findOneAndReplace'
            ? await coll.findOneAndReplace(a[0], a[1], opts(a[2]))
            : await coll.findOneAndUpdate(a[0], a[1], opts(a[2]));
      return doc ? documentsToResult([doc], maxRows) : { columns: [], rows: [], affectedRows: 0 };
    }
    case 'createIndex':
      return valuesToResult([await coll.createIndex(a[0], a[1])]);
    case 'createIndexes':
      return valuesToResult(await coll.createIndexes(a[0], a[1]));
    case 'dropIndex':
      return documentsToResult([await coll.dropIndex(a[0])], maxRows);
    case 'dropIndexes':
      return valuesToResult([await coll.dropIndexes()]);
    case 'getIndexes':
    case 'indexes':
      return documentsToResult(await coll.indexes(), maxRows);
    case 'drop':
      return valuesToResult([await coll.drop()]);
    case 'renameCollection':
      await coll.rename(a[0], a[1]);
      return { columns: ['ok'], rows: [[1]] };
    case 'stats':
      return documentsToResult([await db.command({ collStats: op.collection })], maxRows);
  }
  throw new Error(`Unsupported: ${op.method}()`);
}

const hasOutStage = (pipeline: unknown) => Array.isArray(pipeline) && pipeline.some((s) => s && typeof s === 'object' && ('$out' in s || '$merge' in s));

/** Grid of top-level fields (in first-seen order, _id first) plus relaxed EJSON for the JSON view. */
export function documentsToResult(docs: Document[], maxRows: number): Omit<QueryResult, 'durationMs'> {
  const truncated = docs.length > maxRows;
  const shown = truncated ? docs.slice(0, maxRows) : docs;
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const doc of shown) {
    for (const k of Object.keys(doc)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const id = columns.indexOf('_id');
  if (id > 0) columns.unshift(...columns.splice(id, 1));
  const documents = shown.map(toExtendedJson);
  return { columns, rows: rowsFromDocuments(columns, documents), documents, truncated };
}

/**
 * Relaxed Extended JSON, except integers past 2^53 (a Long the driver did not turn into
 * a number, or a bigint), kept exact as { $numberLong } instead of rounded.
 */
export function toExtendedJson(v: unknown): unknown {
  if (typeof v === 'bigint') return { $numberLong: v.toString() };
  if (v instanceof Long) return Number.isSafeInteger(v.toNumber()) ? v.toNumber() : { $numberLong: v.toString() };
  if (Array.isArray(v)) return v.map(toExtendedJson);
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toExtendedJson(x)]));
  }
  return EJSON.serialize(v, { relaxed: true });
}

function valuesToResult(values: unknown[]): Omit<QueryResult, 'durationMs'> {
  return { columns: ['value'], rows: values.map((v) => [bsonToCell(v)]) };
}

export function bsonToCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof ObjectId) return `ObjectId('${v.toHexString()}')`;
  if (v instanceof Binary) {
    const bytes = Buffer.from(v.buffer);
    return { b: bytes.subarray(0, BINARY_LIMIT).toString('hex'), n: bytes.length };
  }
  if (v instanceof Decimal128) return v.toString();
  if (v instanceof Long) return Number.isSafeInteger(v.toNumber()) ? v.toNumber() : v.toString();
  const json = EJSON.stringify(v as Document, { relaxed: true });
  return json.length > MAX_CELL_JSON ? json.slice(0, MAX_CELL_JSON) + '…' : json;
}

function bsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (v instanceof ObjectId) return 'objectId';
  if (v instanceof Binary) return v.sub_type === 4 ? 'uuid' : 'binData';
  if (v instanceof Decimal128) return 'decimal';
  if (v instanceof Long) return 'long';
  if (v instanceof RegExp) return 'regex';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'object') {
    const t = (v as { _bsontype?: string })._bsontype;
    return t ? t.charAt(0).toLowerCase() + t.slice(1) : 'object';
  }
  return typeof v === 'boolean' ? 'bool' : typeof v;
}

function collectFields(doc: Document, prefix: string, depth: number, stats: Map<string, { types: Set<string>; count: number }>): void {
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const entry = stats.get(path) ?? { types: new Set<string>(), count: 0 };
    entry.types.add(bsonType(v));
    entry.count++;
    stats.set(path, entry);
    if (depth + 1 < FIELD_DEPTH && bsonType(v) === 'object') collectFields(v as Document, path, depth + 1, stats);
  }
}
