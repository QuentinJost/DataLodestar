// MongoDB and Redis against real servers when SQLNAV_IT=1 (see scripts/integration.sh).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MongoDriver } from '../drivers/mongo';
import { RedisDriver } from '../drivers/redis';
import { createShellContext, evaluate, MongoOp } from '../mongoShell';
import { tokenizeBuffers } from '../redisCommand';
import { SshTunnel } from '../sshTunnel';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { format } = require('../../media/binaryFormat.js');
const env = process.env;
const skip = env.SQLNAV_IT !== '1' && 'set SQLNAV_IT=1 (scripts/integration.sh)';
const UUID = '9c3b6d8e-4f2a-11ee-8f1a-0242ac120002';

const mongoEndpoint = (database?: string, host = env.MONGO_HOST!, port = 27017) => ({ host, port, user: 'root', password: env.DB_PASSWORD, database, ssl: false });
const redisEndpoint = (host = env.REDIS_HOST!, port = 6379) => ({ host, port, user: '', password: env.DB_PASSWORD, ssl: false });

async function withMongo(fn: (d: MongoDriver) => Promise<void>) {
  const d = new MongoDriver(mongoEndpoint('shop'));
  await d.connect();
  try {
    await fn(d);
  } finally {
    await d.close();
  }
}

const shell = (d: MongoDriver, maxRows = 1000) => {
  const ctx = createShellContext();
  return (src: string, db = 'shop') => d.runOp(evaluate(src, ctx) as MongoOp, db, maxRows);
};

test('mongodb: browse, structure, viewer filters, shell operations', { skip }, async () => {
  await withMongo(async (d) => {
    const run = shell(d);
    await run('db.dropDatabase()'); // start from an empty "shop" on reused servers
    const ins = await run(
      `db.users.insertMany([
        { _id: 1, name: 'Ann', age: 34, tags: ['a'], addr: { city: 'Rennes' }, at: ISODate('2026-01-02T03:04:05Z'), uid: UUID('${UUID}') },
        { _id: 2, name: 'Bob', age: 25 },
        { _id: 3, name: 'Cyd', age: 41, nick: 'C' }
      ])`,
    );
    assert.equal(ins.affectedRows, 3);
    await run("db.users.createIndex({ name: 1 }, { unique: true })");
    await run("db.createView('adults', 'users', [{ $match: { age: { $gte: 30 } } }])");
    await run("db.getSiblingDB('crm').contacts.insertOne({ x: 1 })");

    const dbs = await d.listDatabases(false);
    assert.ok(dbs.includes('shop') && dbs.includes('crm'));
    assert.ok(!dbs.includes('admin'));
    assert.deepEqual((await d.listCollections('shop')).map((c) => `${c.name}:${c.type}`), ['adults:view', 'users:collection']);

    const st = await d.describeCollection('shop', 'users');
    assert.equal(st.sampled, 3);
    const field = (p: string) => st.fields.find((f) => f.path === p);
    assert.equal(st.fields[0].path, '_id');
    assert.deepEqual(field('name')?.types, ['string']);
    assert.equal(field('nick')?.presence, 33);
    assert.deepEqual(field('addr.city')?.types, ['string']);
    assert.deepEqual(field('uid')?.types, ['uuid']);
    const idx = st.indexes.find((i) => i.name === 'name_1');
    assert.equal(idx?.unique, true);
    assert.equal(idx?.key, '{"name":1}');
    assert.equal((await d.describeCollection('shop', 'adults')).sampled, 2);

    // Collection viewer: shell literals for filter and sort.
    const page = await d.find('shop', 'users', '{ age: { $gt: 30 } }', '{ age: -1 }', 10, 0);
    assert.equal(page.columns[0], '_id');
    assert.deepEqual(page.rows.map((r) => r[page.columns.indexOf('name')]), ['Cyd', 'Ann']);
    const ann = page.rows[1];
    assert.equal(format(ann[page.columns.indexOf('uid')], 'uuid'), UUID);
    assert.equal(ann[page.columns.indexOf('at')], '2026-01-02T03:04:05.000Z');
    assert.equal(ann[page.columns.indexOf('addr')], '{"city":"Rennes"}');
    assert.equal((page.documents?.[1] as { addr: { city: string } }).addr.city, 'Rennes');
    assert.equal(await d.count('shop', 'users', '{ age: { $gt: 30 } }'), 2);
    const byId = await d.find('shop', 'users', '{ _id: { $in: [1, 3] } }', '', 10, 1);
    assert.deepEqual(byId.rows.map((r) => r[0]), [3], 'skip applies');

    const proj = await run('db.users.find({}, { name: 1 }).sort({ name: -1 }).limit(2)');
    assert.deepEqual(proj.columns, ['_id', 'name']);
    assert.deepEqual(proj.rows, [[3, 'Cyd'], [2, 'Bob']]);
    const agg = await run("db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 }, oldest: { $max: '$age' } } }])");
    assert.deepEqual(agg.rows, [[null, 3, 41]]);
    assert.deepEqual((await run('db.users.find({ age: { $gt: 30 } }).count()')).rows, [[2]]);
    assert.deepEqual((await run("db.users.distinct('name')")).rows, [['Ann'], ['Bob'], ['Cyd']]);
    const upd = await run('db.users.updateMany({ age: { $lt: 30 } }, { $set: { young: true } })');
    assert.equal(upd.affectedRows, 1);
    assert.deepEqual((await run('db.runCommand({ ping: 1 })')).rows, [[1]]);
    assert.deepEqual((await run('db.getCollectionNames()')).rows, [['adults'], ['users']]);
    assert.ok((await d.listCollections('crm')).some((c) => c.name === 'contacts'));
    await assert.rejects(run("db.users.insertOne({ _id: 9, name: 'Ann' })"), /duplicate key/);

    const capped = await shell(d, 2)('db.users.find()');
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.truncated, true);
  });
});

test('mongodb: manual transactions on a replica set', { skip }, async () => {
  await withMongo(async (d) => {
    await withMongo(async (other) => {
      const run = shell(d);
      await run('db.tx.deleteMany({})');
      await d.setTxMode('manual');
      await d.count('shop', 'tx', '{}');
      assert.equal(d.pendingTransaction, false, 'a read is not pending');

      await run("db.tx.insertOne({ _id: 'r' })");
      assert.equal(d.pendingTransaction, true);
      assert.equal(await d.count('shop', 'tx', '{}'), 1, 'own write visible inside');
      assert.equal(await other.count('shop', 'tx', '{}'), 0, 'invisible to others');
      await d.rollback();
      assert.equal(d.pendingTransaction, false);
      assert.equal(await d.count('shop', 'tx', '{}'), 0);

      await run("db.tx.insertOne({ _id: 'c' })");
      // DDL runs outside transactions and would break the commit: refused while writes wait.
      await assert.rejects(run('db.tx.createIndex({ a: 1 })'), /Commit or roll back/);
      assert.equal(d.pendingTransaction, true, 'the refusal keeps the pending changes');
      await d.commit();
      await d.count('shop', 'tx', '{}'); // read-only transaction open again
      await run('db.tx.createIndex({ a: 1 })'); // closed first, then runs
      assert.equal(await other.count('shop', 'tx', '{}'), 1);
      await d.setTxMode('auto');
    });
  });
});

test('mongodb: connection string without password takes the Password field', { skip }, async () => {
  const uri = `mongodb://root@${env.MONGO_HOST}:27017/?directConnection=true&authSource=admin`;
  const d = new MongoDriver({ ...mongoEndpoint('shop'), uri, user: '' });
  await d.connect();
  assert.ok((await d.listDatabases(false)).includes('shop'));
  await d.close();
  const noPassword = new MongoDriver({ ...mongoEndpoint('shop'), uri, user: '', password: undefined });
  await assert.rejects(noPassword.connect(), /auth/i);
  await noPassword.close();
});

test('redis: databases, commands, key browser, MULTI as a transaction', { skip }, async () => {
  const r = new RedisDriver(redisEndpoint());
  await r.connect();
  const exec = (line: string, db = '0') => r.execute(tokenizeBuffers(line), db);
  try {
    await exec('FLUSHALL');
    assert.equal((await r.listDatabases()).length, 16);
    await exec('SET user:1:name "Ann Dupont"');
    await exec('SET user:1:json \'{"a":1,"b":[2,3]}\'');
    await exec('HSET user:1 name Ann city Rennes');
    await exec('RPUSH queue a b c');
    await exec('SADD tags x y');
    await exec('ZADD board 10 ann 20 bob');
    await exec('XADD events * kind login who ann');
    await exec('SET bin "\\x00\\x80\\xff"');
    await exec('EXPIRE user:1:name 3600');
    await exec('SET other 1', '3');

    const ks = await r.keyspace();
    assert.equal(ks['0'], 8);
    assert.equal(ks['3'], 1);

    assert.deepEqual((await exec('GET user:1:name')).rows, [['Ann Dupont']]);
    assert.deepEqual((await exec('GET other')).rows, [[null]], 'db 0 again after db 3');
    assert.deepEqual((await exec('GET other', '3')).rows, [['1']]);
    const h = await exec('HGETALL user:1');
    assert.deepEqual(h.columns, ['field', 'value']);
    assert.deepEqual(h.rows, [['name', 'Ann'], ['city', 'Rennes']]);
    const z = await exec('ZRANGE board 0 -1 WITHSCORES');
    assert.deepEqual(z.columns, ['member', 'score']);
    assert.deepEqual(z.rows, [['ann', '10'], ['bob', '20']]);
    assert.deepEqual((await exec('LRANGE queue 0 -1')).rows, [['a'], ['b'], ['c']]);
    assert.deepEqual((await exec('INCR counter')).rows, [[1]]);
    assert.deepEqual((await exec('GET bin')).rows, [[{ b: '0080ff', n: 3 }]]);
    await assert.rejects(exec('SUBSCRIBE news'), /not supported/);
    await assert.rejects(exec('NOPE'), /unknown command/i);

    const all = await r.scan('0', 'user:*', undefined, '0');
    assert.equal(all.cursor, '0');
    assert.deepEqual(all.keys.map((k) => `${k.key}:${k.type}`), ['user:1:hash', 'user:1:json:string', 'user:1:name:string']);
    assert.ok(all.keys.find((k) => k.key === 'user:1:name')!.ttl > 3_000_000);
    assert.deepEqual((await r.scan('0', '*', 'zset', '0')).keys.map((k) => k.key), ['board']);
    assert.deepEqual((await r.scan('3', '*', undefined, '0')).keys.map((k) => k.key), ['other']);

    const v = (key: string) => r.getValue('0', key);
    assert.equal((await v('user:1:json')).text, '{"a":1,"b":[2,3]}');
    assert.deepEqual((await v('user:1')).rows, [['name', 'Ann'], ['city', 'Rennes']]);
    assert.deepEqual((await v('queue')).rows, [['a'], ['b'], ['c']]);
    assert.deepEqual(((await v('tags')).rows ?? []).map((x) => x[0]).sort(), ['x', 'y']);
    assert.deepEqual((await v('board')).rows, [['ann', 10], ['bob', 20]]);
    const stream = await v('events');
    assert.equal(stream.length, 1);
    assert.equal(stream.rows?.[0][1], '{"kind":"login","who":"ann"}');
    assert.deepEqual((await v('bin')).text, { b: '0080ff', n: 3 });
    await assert.rejects(v('missing'), /no longer exists/);

    // MULTI is the pending transaction: Rollback = DISCARD, Commit = EXEC.
    await exec('MULTI');
    assert.equal(r.pendingTransaction, true);
    assert.deepEqual((await exec('SET tx 1')).rows, [['QUEUED']]);
    await r.rollback();
    assert.equal(r.pendingTransaction, false);
    assert.deepEqual((await exec('EXISTS tx')).rows, [[0]]);
    await exec('MULTI');
    await exec('SET tx 2');
    await r.commit();
    assert.deepEqual((await exec('GET tx')).rows, [['2']]);
    await assert.rejects(r.setTxMode('manual'), /MULTI/);
  } finally {
    await r.close();
  }
});

test('ssh: tunnels to MongoDB and Redis', { skip }, async () => {
  const cfg = { enabled: true, host: env.SSH_HOST!, port: 22, username: 'tunnel', auth: 'password' as const };
  const secrets = { sshPassword: env.SSH_PASSWORD };
  const trust = async () => true;

  const mt = await SshTunnel.open(cfg, secrets, env.MONGO_HOST!, 27017, trust);
  const m = new MongoDriver(mongoEndpoint('shop', '127.0.0.1', mt.localPort));
  await m.connect();
  assert.ok((await m.listDatabases(false)).includes('shop'));
  await m.close();
  mt.close();

  const rt = await SshTunnel.open(cfg, secrets, env.REDIS_HOST!, 6379, trust);
  const r = new RedisDriver(redisEndpoint('127.0.0.1', rt.localPort));
  await r.connect();
  assert.deepEqual((await r.execute(['PING'], '0')).rows, [['PONG']]);
  await r.close();
  rt.close();
});
