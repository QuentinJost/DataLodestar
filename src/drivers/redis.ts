import Redis, { RedisOptions } from 'ioredis';
import AbstractConnector from 'ioredis/built/connectors/AbstractConnector';
import { Duplex } from 'stream';
import { connect as tlsConnect, ConnectionOptions } from 'tls';
import { CellValue, QueryResult, RedisKeyInfo, RedisValue, TxMode } from '../types';
import { BaseDriver, BINARY_LIMIT, Endpoint, Mutex } from './driver';
import { tlsOptions } from './tls';

/** Commands that would turn the session into a push-only connection. */
const REFUSED = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC']);
/** Replies made of field/value pairs, shown as two columns. */
const PAIR_REPLIES = new Set(['HGETALL', 'CONFIG', 'HRANDFIELD']);
const SCAN_BATCH = 1000;
const SCAN_ROUNDS = 50;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text when the bytes are valid UTF-8, a binary cell otherwise. */
function bufferToCell(b: Buffer): CellValue {
  try {
    return utf8.decode(b);
  } catch {
    return { b: b.subarray(0, BINARY_LIMIT).toString('hex'), n: b.length };
  }
}

function replyToCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return bufferToCell(v);
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (Buffer.isBuffer(x) ? String(bufferToCell(x)) : Array.isArray(x) ? replyToCell(x) : x)));
  if (v instanceof Error) return `(error) ${v.message}`;
  return String(v);
}

export class RedisDriver implements BaseDriver {
  readonly kind = 'redis' as const;
  readonly family = 'redis' as const;
  readonly supportsManualTx = false;
  onLost?: (err: Error) => void;

  private session?: Redis;
  private meta?: Redis;
  private sessionDb = 0;
  private metaDb = 0;
  private inMulti = false;
  private readonly lock = new Mutex();
  private readonly metaLock = new Mutex();

  constructor(private readonly endpoint: Endpoint) {}

  get pendingTransaction(): boolean {
    return this.inMulti;
  }

  async connect(): Promise<void> {
    const e = this.endpoint;
    const db = Number(e.database) || 0;
    const options: RedisOptions = {
      host: e.host,
      port: e.port,
      username: e.user || undefined,
      password: e.password || undefined,
      db,
      tls: tlsOptions(e),
      lazyConnect: true,
      connectTimeout: 15000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null, // a lost session is reported, not silently re-opened (MULTI/SELECT state)
      connectionName: 'datalodestar', // Redis refuses spaces in client names
      Connector: e.stream ? streamConnector(e.stream, tlsOptions(e)) : undefined,
    };
    this.session = new Redis(options);
    this.meta = new Redis(options);
    const quiet = () => undefined;
    this.session.on('error', quiet);
    this.meta.on('error', quiet);
    await this.session.connect();
    await this.meta.connect();
    this.sessionDb = this.metaDb = db;
    this.session.on('end', () => this.onLost?.(new Error('connection closed by the server')));
  }

  async close(): Promise<void> {
    const conns = [this.session, this.meta];
    this.session = this.meta = undefined;
    this.inMulti = false;
    await Promise.allSettled(conns.map((c) => c?.quit().catch(() => c.disconnect())));
  }

  /** Database indexes "0".."n-1" (CONFIG may be disabled on managed servers: 16 then). */
  async listDatabases(): Promise<string[]> {
    let count = 16;
    try {
      const reply = (await this.meta!.config('GET', 'databases')) as string[];
      if (reply[1]) count = Number(reply[1]);
    } catch {
      // keep 16
    }
    return Array.from({ length: count }, (_, i) => String(i));
  }

  /** Key count per database index, from INFO keyspace. */
  async keyspace(): Promise<Record<string, number>> {
    const info = await this.meta!.info('keyspace');
    const out: Record<string, number> = {};
    for (const m of info.matchAll(/^db(\d+):keys=(\d+)/gm)) out[m[1]] = Number(m[2]);
    return out;
  }

  private onMeta<T>(db: string, work: (r: Redis) => Promise<T>): Promise<T> {
    return this.metaLock.run(async () => {
      const n = Number(db) || 0;
      if (n !== this.metaDb) {
        await this.meta!.select(n);
        this.metaDb = n;
      }
      return work(this.meta!);
    });
  }

  /** SCAN with MATCH / TYPE until `wanted` keys are found or the scan completes. */
  scan(db: string, pattern: string, type: string | undefined, cursor: string, wanted = 500): Promise<{ keys: RedisKeyInfo[]; cursor: string }> {
    return this.onMeta(db, async (r) => {
      const names: string[] = [];
      let next = cursor;
      for (let round = 0; round < SCAN_ROUNDS; round++) {
        const args: (string | number)[] = [next, 'MATCH', pattern || '*', 'COUNT', SCAN_BATCH];
        if (type) args.push('TYPE', type);
        const [c, batch] = (await r.call('SCAN', ...args)) as [string, string[]];
        for (const name of batch) names.push(name);
        next = c;
        if (next === '0' || names.length >= wanted) break;
      }
      const pipe = r.pipeline();
      for (const k of names) pipe.type(k).pttl(k);
      const replies = (await pipe.exec()) ?? [];
      const keys = names.map((key, i) => ({ key, type: String(replies[i * 2]?.[1] ?? '?'), ttl: Number(replies[i * 2 + 1]?.[1] ?? -1) }));
      keys.sort((a, b) => a.key.localeCompare(b.key));
      return { keys, cursor: next };
    });
  }

  /** Value of a key according to its type, capped at `limit` elements. */
  getValue(db: string, key: string, limit = 500): Promise<RedisValue> {
    return this.onMeta(db, async (r) => {
      const [type, ttl] = await Promise.all([r.type(key), r.pttl(key)]);
      const base = { key, type, ttl, truncated: false };
      const pairs = (flat: Buffer[], a: string, b: string) => {
        const rows: CellValue[][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) rows.push([bufferToCell(flat[i]), bufferToCell(flat[i + 1])]);
        return { columns: [a, b], rows };
      };
      switch (type) {
        case 'string': {
          const v = await r.getBuffer(key);
          return { ...base, length: v?.length ?? 0, text: v ? bufferToCell(v) : null };
        }
        case 'hash': {
          const length = await r.hlen(key);
          const flat = await scanAll(r, 'HSCAN', key, limit * 2);
          return { ...base, length, ...pairs(flat, 'field', 'value'), truncated: flat.length / 2 < length };
        }
        case 'list': {
          const length = await r.llen(key);
          const items = await r.lrangeBuffer(key, 0, limit - 1);
          return { ...base, length, columns: ['value'], rows: items.map((x) => [bufferToCell(x)]), truncated: items.length < length };
        }
        case 'set': {
          const length = await r.scard(key);
          const items = await scanAll(r, 'SSCAN', key, limit);
          return { ...base, length, columns: ['member'], rows: items.map((x) => [bufferToCell(x)]), truncated: items.length < length };
        }
        case 'zset': {
          const length = await r.zcard(key);
          const flat = (await r.callBuffer('ZRANGE', key, 0, limit - 1, 'WITHSCORES')) as Buffer[];
          const { rows } = pairs(flat, 'member', 'score');
          return { ...base, length, columns: ['member', 'score'], rows: rows.map(([m, s]) => [m, Number(s)]), truncated: rows.length < length };
        }
        case 'stream': {
          const length = await r.xlen(key);
          const entries = (await r.xrangeBuffer(key, '-', '+', 'COUNT', limit)) as [Buffer, Buffer[]][];
          const rows = entries.map(([id, fields]) => {
            const obj: Record<string, CellValue> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) obj[String(bufferToCell(fields[i]))] = bufferToCell(fields[i + 1]);
            return [id.toString(), JSON.stringify(obj)];
          });
          return { ...base, length, columns: ['id', 'fields'], rows, truncated: rows.length < length };
        }
        case 'ReJSON-RL': {
          const v = (await r.call('JSON.GET', key)) as string | null;
          return { ...base, length: v?.length ?? 0, text: v };
        }
        case 'none':
          throw new Error(`Key "${key}" no longer exists.`);
        default:
          return { ...base, length: 0, text: `(type ${type} is not displayed; use the query editor)` };
      }
    });
  }

  /** Runs one command (already tokenized) in the session, against db index `database`. */
  execute(argv: (string | Buffer)[], database: string | undefined): Promise<QueryResult> {
    const args = argv.map((a) => (typeof a === 'string' ? a : a.toString('utf8')));
    return this.lock.run(async () => {
      const cmd = (args[0] ?? '').toUpperCase();
      if (!cmd) throw new Error('Empty command.');
      if (REFUSED.has(cmd)) throw new Error(`${cmd} switches the connection to push mode and is not supported here; use redis-cli.`);
      const db = database === undefined ? this.sessionDb : Number(database) || 0;
      if (db !== this.sessionDb && !this.inMulti) {
        await this.session!.select(db);
        this.sessionDb = db;
      }
      const started = Date.now();
      const reply = await this.session!.callBuffer(args[0], ...argv.slice(1));
      const durationMs = Date.now() - started;

      if (cmd === 'SELECT') this.sessionDb = Number(args[1]) || 0;
      if (cmd === 'MULTI') this.inMulti = true;
      if (cmd === 'EXEC' || cmd === 'DISCARD') this.inMulti = false;

      if (Array.isArray(reply)) {
        const withScores = args.some((a) => /^withscores$/i.test(a));
        if (PAIR_REPLIES.has(cmd) || withScores) {
          const rows: CellValue[][] = [];
          for (let i = 0; i + 1 < reply.length; i += 2) rows.push([replyToCell(reply[i]), replyToCell(reply[i + 1])]);
          return { columns: withScores ? ['member', 'score'] : ['field', 'value'], rows, durationMs };
        }
        return { columns: ['value'], rows: reply.map((x) => [replyToCell(x)]), durationMs };
      }
      return { columns: ['result'], rows: [[replyToCell(reply)]], durationMs };
    });
  }

  async cancel(): Promise<void> {
    // Redis commands are atomic and cannot be interrupted from another client.
  }

  async setTxMode(mode: TxMode): Promise<void> {
    if (mode === 'manual') throw new Error('Redis has no commit/rollback mode. Type MULTI in the editor: Commit then sends EXEC and Rollback sends DISCARD.');
  }

  commit(): Promise<void> {
    return this.endMulti('EXEC');
  }

  rollback(): Promise<void> {
    return this.endMulti('DISCARD');
  }

  private endMulti(cmd: 'EXEC' | 'DISCARD'): Promise<void> {
    return this.lock.run(async () => {
      if (!this.inMulti) return;
      try {
        await this.session!.call(cmd);
      } finally {
        this.inMulti = false;
      }
    });
  }
}

/** ioredis connector over a stream the caller opens (an SSH channel), with TLS on top when asked. */
function streamConnector(open: () => Promise<Duplex>, tls: ConnectionOptions | undefined) {
  return class StreamConnector extends AbstractConnector {
    constructor(options: unknown) {
      super((options as { disconnectTimeout?: number }).disconnectTimeout ?? 2000);
    }
    async connect() {
      this.connecting = true;
      const raw = await open();
      this.stream = (tls ? tlsConnect({ ...tls, socket: raw }) : raw) as never;
      return this.stream;
    }
  };
}

/** HSCAN / SSCAN until `wanted` items; items are pushed one by one (a spread of a huge batch overflows the stack). */
export async function scanAll(r: Pick<Redis, 'callBuffer'>, cmd: 'HSCAN' | 'SSCAN', key: string, wanted: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let cursor = '0';
  do {
    const [next, batch] = (await r.callBuffer(cmd, key, cursor, 'COUNT', SCAN_BATCH)) as [Buffer, Buffer[]];
    for (const item of batch) {
      out.push(item);
      if (out.length >= wanted) return out;
    }
    cursor = next.toString();
  } while (cursor !== '0');
  return out;
}
