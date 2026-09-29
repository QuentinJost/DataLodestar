import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createShellContext, evaluate, evaluateObject, isDestructiveOp, MongoOp, splitScript } from '../mongoShell';
import { commandAt, isDestructiveCommand, splitCommands, tokenize } from '../redisCommand';

test('mongo: splits top-level statements, semicolons optional', () => {
  const src = "db.users.find({ a: ';' })\nconst x = 1;\n\ndb.users.insertOne({ note: `multi\nline` });";
  assert.deepEqual(splitScript(src).map((s) => s.text), ["db.users.find({ a: ';' })", 'const x = 1;', 'db.users.insertOne({ note: `multi\nline` });']);
});

test('mongo: syntax errors carry the line', () => {
  assert.throws(() => splitScript('db.a.find({)\n'), /line 1/);
});

test('mongo: statements record operations without running them', () => {
  const ctx = createShellContext();
  const find = evaluate("db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: -1 }).skip(5).limit(10)", ctx) as MongoOp;
  assert.ok(find instanceof MongoOp);
  assert.equal(find.collection, 'users');
  assert.equal(find.method, 'find');
  assert.deepEqual(find.args, [{ age: { $gt: 30 } }, { name: 1 }]);
  assert.deepEqual(find.chain.map((c) => c.method), ['sort', 'skip', 'limit']);

  const other = evaluate("db.getSiblingDB('crm').getCollection('my-coll').countDocuments({})", ctx) as MongoOp;
  assert.equal(other.database, 'crm');
  assert.equal(other.collection, 'my-coll');

  const nested = evaluate('db.system.profile.find()', ctx) as MongoOp;
  assert.equal(nested.collection, 'system.profile');

  const cmd = evaluate('db.runCommand({ ping: 1 })', ctx) as MongoOp;
  assert.equal(cmd.collection, undefined);
  assert.equal(cmd.method, 'runCommand');

  assert.equal(evaluate('const limit = 3', ctx), undefined);
  const withVar = evaluate('db.a.find().limit(limit)', ctx) as MongoOp;
  assert.deepEqual(withVar.chain[0].args, [3], 'variables persist across statements');
  assert.equal(evaluate('1 + 1', ctx), 2);
});

test('mongo: BSON helpers produce driver types', () => {
  const ctx = createShellContext();
  const op = evaluate("db.a.find({ _id: ObjectId('64b7f0c2a1b2c3d4e5f60718'), at: { $gte: ISODate('2026-01-01') } })", ctx) as MongoOp;
  const filter = op.args[0] as { _id: ObjectId; at: { $gte: Date } };
  assert.ok(filter._id instanceof ObjectId);
  assert.equal(filter._id.toHexString(), '64b7f0c2a1b2c3d4e5f60718');
  assert.equal(filter.at.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('mongo: viewer filters are object literals', () => {
  assert.deepEqual(evaluateObject(''), {});
  assert.deepEqual(evaluateObject("{ status: 'active', n: { $in: [1, 2] } }"), { status: 'active', n: { $in: [1, 2] } });
  assert.throws(() => evaluateObject('[1, 2]'), /Expected an object/);
  assert.throws(() => evaluateObject('while (true) {}'));
});

test('mongo: destructive operations', () => {
  const ctx = createShellContext();
  const d = (s: string) => isDestructiveOp(evaluate(s, ctx) as MongoOp);
  assert.equal(d('db.a.deleteMany({})'), true);
  assert.equal(d('db.a.deleteMany()'), true);
  assert.equal(d("db.a.deleteMany({ x: 1 })"), false);
  assert.equal(d('db.a.updateMany({}, { $set: { y: 1 } })'), true);
  assert.equal(d('db.a.drop()'), true);
  assert.equal(d('db.dropDatabase()'), true);
  assert.equal(d('db.a.find({})'), false);
});

test('redis: tokenizer follows redis-cli quoting', () => {
  assert.deepEqual(tokenize('SET  user:1   "Jean \\"JJ\\" Dupont"'), ['SET', 'user:1', 'Jean "JJ" Dupont']);
  assert.deepEqual(tokenize("HSET h f 'it\\'s' g \"a\\nb\\x41\""), ['HSET', 'h', 'f', "it's", 'g', 'a\nbA']);
  assert.deepEqual(tokenize('SET k ""'), ['SET', 'k', '']);
  assert.throws(() => tokenize('GET "open'), /Unbalanced/);
  assert.throws(() => tokenize('GET "a"b'), /followed by a space/);
});

test('redis: one command per line, comments skipped, command at cursor', () => {
  const text = '# setup\nSET a 1\n\n// read\nGET a\n';
  const cmds = splitCommands(text);
  assert.deepEqual(cmds.map((c) => c.text), ['SET a 1', 'GET a']);
  assert.equal(commandAt(cmds, text, text.indexOf('GET') + 2)?.text, 'GET a');
  assert.equal(commandAt(cmds, text, text.indexOf('\n\n') + 1)?.text, 'SET a 1', 'blank line picks the previous command');
  assert.equal(commandAt(cmds, text, 0)?.text, 'SET a 1');
});

test('redis: destructive commands', () => {
  assert.equal(isDestructiveCommand(['flushall']), true);
  assert.equal(isDestructiveCommand(['FLUSHDB', 'ASYNC']), true);
  assert.equal(isDestructiveCommand(['CONFIG', 'SET', 'maxmemory', '1']), true);
  assert.equal(isDestructiveCommand(['CONFIG', 'GET', 'maxmemory']), false);
  assert.equal(isDestructiveCommand(['DEL', 'a']), false);
});

import { tokenizeBuffers } from '../redisCommand';

test('redis: \\xHH is a raw byte, typed text is UTF-8', () => {
  const [, , v] = tokenizeBuffers('SET k "\\x80\\xffé"');
  assert.deepEqual([...v], [0x80, 0xff, 0xc3, 0xa9]);
});

test('redis scanAll: a 200,000-item batch does not overflow and stops at the wanted count', async () => {
  const { scanAll } = await import('../drivers/redis');
  const big = Array.from({ length: 200_000 }, (_, i) => Buffer.from(`m${i}`));
  let calls = 0;
  const client = {
    callBuffer: async () => {
      calls++;
      return [Buffer.from(calls === 1 ? '42' : '0'), big];
    },
  };
  const out = await scanAll(client as never, 'SSCAN', 'k', 1000);
  assert.equal(out.length, 1000);
  assert.equal(calls, 1, 'no round trip once enough items are in');
  const all = await scanAll({ callBuffer: async () => [Buffer.from('0'), big] } as never, 'SSCAN', 'k', 500_000);
  assert.equal(all.length, 200_000);
});
