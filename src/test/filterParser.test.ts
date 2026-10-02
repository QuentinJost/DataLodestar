import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Binary, Decimal128, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from 'mongodb';
import { parseFilter } from '../filterParser';

test('README examples and the usual shell forms', () => {
  assert.deepEqual(parseFilter(''), {});
  assert.deepEqual(parseFilter('  '), {});
  const f = parseFilter("{ status: 'active', createdAt: { $gte: ISODate('2026-01-01') } }") as { status: string; createdAt: { $gte: Date } };
  assert.equal(f.status, 'active');
  assert.equal(f.createdAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(parseFilter('{ createdAt: -1 }'), { createdAt: -1 });
  const id = parseFilter("{ _id: ObjectId('64b7f0c2a1b2c3d4e5f60718') }")._id as ObjectId;
  assert.ok(id instanceof ObjectId);
  assert.equal(id.toHexString(), '64b7f0c2a1b2c3d4e5f60718');
  assert.deepEqual(parseFilter('{ "a.b": { $in: [1, 2.5, "x", true, null] }, n: +3 }'), { 'a.b': { $in: [1, 2.5, 'x', true, null] }, n: 3 });
  assert.deepEqual(parseFilter("{ name: /^ann/i }"), { name: /^ann/i });
  assert.deepEqual(parseFilter('{ 1: "one" }'), { 1: 'one' });
});

test('every helper builds its BSON type', () => {
  const v = parseFilter(`{
    u: UUID('9c3b6d8e-4f2a-11ee-8f1a-0242ac120002'), l: NumberLong('9007199254740993'), i: NumberInt(7),
    d: NumberDecimal('1.10'), b: BinData(0, 'AAE='), t: Timestamp(1, 2), lo: MinKey(), hi: MaxKey(),
    nd: new Date('2026-01-02'), o: new ObjectId('64b7f0c2a1b2c3d4e5f60718')
  }`);
  assert.ok(v.u instanceof UUID);
  assert.ok(v.l instanceof Long && (v.l as Long).toString() === '9007199254740993');
  assert.ok(v.i instanceof Int32);
  assert.ok(v.d instanceof Decimal128);
  assert.ok(v.b instanceof Binary);
  assert.ok(v.t instanceof Timestamp);
  assert.ok(v.lo instanceof MinKey && v.hi instanceof MaxKey);
  assert.ok(v.nd instanceof Date);
  assert.ok(v.o instanceof ObjectId);
});

test('Date with numbers is a local date, as in the shell', () => {
  const f = parseFilter('{ a: new Date(2026, 0, 1), b: Date(2026, 11, 31, 23, 59) }') as { a: Date; b: Date };
  assert.deepEqual([f.a.getFullYear(), f.a.getMonth(), f.a.getDate(), f.a.getHours()], [2026, 0, 1, 0]);
  assert.deepEqual([f.b.getFullYear(), f.b.getMonth(), f.b.getDate(), f.b.getHours(), f.b.getMinutes()], [2026, 11, 31, 23, 59]);
  assert.equal((parseFilter('{ a: new Date(0) }').a as Date).getTime(), 0, 'one number stays milliseconds');
  assert.throws(() => parseFilter("{ a: new Date(2026, '1') }"), /numbers only/);
});

test('a "__proto__" key is a field, as in JSON', () => {
  const f = parseFilter('{ "__proto__": { a: 1 }, b: 2 }');
  assert.deepEqual(Object.keys(f), ['__proto__', 'b']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f, '__proto__')?.value, { a: 1 });
  assert.equal(Object.getPrototypeOf(f), Object.prototype);
});

test('anything that could run code is refused', () => {
  const refused = [
    "{ a: require('child_process') }",
    '{ a: process }',
    "{ a: ObjectId.constructor('return process')() }",
    '{ a: ObjectId().constructor }',
    '{ a: `x${1}` }',
    '{ a: String.raw`x` }',
    '{ a: (() => 1)() }',
    '{ a: function () {} }',
    '{ get a() { return 1 } }',
    '{ a() {} }',
    '{ [k]: 1 }',
    '{ ...x }',
    '{ a }',
    '{ a: [...x] }',
    '{ a: 1 + 1 }',
    '{ a: !0 }',
    '{ a: this }',
    '{ a: ObjectId({ toString: 1 }) }',
    '{ a: 1n }',
    '{ a: undefined }',
  ];
  for (const text of refused) assert.throws(() => parseFilter(text), /not allowed/, text);
});

test('only one object literal', () => {
  assert.throws(() => parseFilter('[1, 2]'), /Expected an object/);
  assert.throws(() => parseFilter("'x'"), /Expected an object/);
  assert.throws(() => parseFilter('while (true) {}'), SyntaxError);
  assert.throws(() => parseFilter('{ a: 1 }), ({ b: 2 }'), /Expected|not allowed|valid/);
  assert.throws(() => parseFilter('{ a: 1 '), /valid/);
});
