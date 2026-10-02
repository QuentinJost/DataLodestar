import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyUpdates, editability, EditInfo, RowEditError, toUpdates, updateStatement } from '../rowEdit';
import { ColumnInfo, IndexInfo, TableStructure } from '../types';

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  type: 'varchar(50)',
  nullable: false,
  defaultValue: null,
  key: '',
  extra: '',
  comment: '',
  ...extra,
});
const idx = (name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo => ({ name, columns, unique: true, primary: false, ...extra });
const structure = (columns: ColumnInfo[], indexes: IndexInfo[]): TableStructure => ({ columns, indexes, foreignKeys: [], ddl: '' });
const table = { database: 'shop', name: 't', type: 'table' as const };

test('editability: rows are found by the primary key', () => {
  const e = editability(table, structure([col('id', { type: 'int' }), col('name')], [idx('PRIMARY', ['id'], { primary: true }), idx('u_name', ['name'])]));
  assert.ok(e.editable);
  assert.deepEqual(e.key, ['id']);
});

test('editability: without a primary key, the shortest unique index over NOT NULL columns', () => {
  const columns = [col('a'), col('b'), col('c', { nullable: true })];
  const e = editability(table, structure(columns, [idx('u_ab', ['a', 'b']), idx('u_c', ['c']), idx('u_b', ['b'])]));
  assert.ok(e.editable);
  assert.deepEqual(e.key, ['b'], 'u_c skipped: NULLs are not unique');
});

test('editability: views, keyless tables and expression indexes are read-only', () => {
  const view = editability({ ...table, type: 'view' }, structure([col('id')], []));
  assert.equal(view.editable, false);
  const keyless = editability(table, structure([col('a', { nullable: true })], [idx('u_a', ['a']), idx('u_expr', ['lower(a)'])]));
  assert.equal(keyless.editable, false);
  assert.match((keyless as { reason: string }).reason, /no primary key/);
});

test('editability: binary, JSON-shown and server-computed columns are shown, not edited; DEFAULT_GENERATED is not computed', () => {
  const e = editability(
    table,
    structure(
      [
        col('id', { type: 'binary(16)' }),
        col('photo', { type: 'mediumblob' }),
        col('raw', { type: 'bytea' }),
        col('total', { extra: 'STORED GENERATED' }),
        col('pg_total', { extra: 'generated stored' }),
        col('seq', { extra: 'identity always' }),
        col('seq2', { extra: 'identity by default' }),
        col('created_at', { type: 'datetime', extra: 'DEFAULT_GENERATED' }),
        col('tags', { type: 'character varying(20)[]' }),
        col('ints', { type: 'integer[]' }),
        col('every', { type: 'interval' }),
        col('pg_point', { type: 'point' }),
        col('shape', { type: 'geometry' }),
        col('route', { type: 'multilinestring' }),
        col('pointless', { type: 'varchar(10)' }),
      ],
      [idx('PRIMARY', ['id'], { primary: true })],
    ),
  );
  assert.ok(e.editable);
  const editable = Object.entries(e.columns).filter(([, c]) => c.editable).map(([n]) => n);
  assert.deepEqual(editable, ['seq2', 'created_at', 'pointless'], 'arrays, intervals and geometry show as JSON the server refuses');
});

const info: EditInfo = { key: ['id', 'uid'], columns: { id: { editable: true, nullable: false }, uid: { editable: false, nullable: false }, name: { editable: true, nullable: true } } };

test('toUpdates: the key comes back as read, binary cells as bytes', () => {
  const [u] = toUpdates(info, [{ key: [12, { b: '0aff', n: 2 }], changes: { name: null } }]);
  assert.deepEqual(u.set, [['name', null]]);
  assert.equal(u.where[0][1], 12);
  assert.deepEqual(u.where[1][1], Buffer.from([0x0a, 0xff]));
});

test('toUpdates: refuses what could reach another row or column', () => {
  const fails = (edits: unknown, re: RegExp, index?: number) =>
    assert.throws(
      () => toUpdates(info, edits),
      (err: Error) => re.test(err.message) && (index === undefined || (err as RowEditError).index === index),
    );
  fails([], /Nothing to save/);
  fails([{ key: [1], changes: { name: 'x' } }], /another key/, 0);
  fails([{ key: [1, 'a'], changes: { name: 'x' } }, { key: [1, { b: '0a', n: 4096 }], changes: { name: 'x' } }], /too long/, 1);
  fails([{ key: [1, null], changes: { name: 'x' } }], /no value/);
  fails([{ key: [1, 'a'], changes: {} }], /no change/);
  fails([{ key: [1, 'a'], changes: { uid: 'x' } }], /uid cannot be edited/);
  fails([{ key: [1, 'a'], changes: { missing: 'x' } }], /missing cannot be edited/);
  fails([{ key: [1, 'a'], changes: { name: 3 } }], /not text/);
});

test('updateStatement: quoted names and numbered or positional placeholders', () => {
  const u = { set: [['na"me', 'x'], ['b', null]] as [string, string | null][], where: [['id', 7] as [string, unknown]] };
  const pg = updateStatement('"public"."t"', u, (n) => `"${n.replace(/"/g, '""')}"`, (n) => `$${n}`);
  assert.equal(pg.sql, 'UPDATE "public"."t" SET "na""me" = $1, "b" = $2 WHERE "id" = $3');
  assert.deepEqual(pg.params, ['x', null, 7]);
  const my = updateStatement('`shop`.`t`', u, (n) => `\`${n}\``, () => '?');
  assert.equal(my.sql, 'UPDATE `shop`.`t` SET `na"me` = ?, `b` = ? WHERE `id` = ?');
});

test('applyUpdates: stops at the first row that does not match exactly once, naming it', async () => {
  const updates = toUpdates(info, [
    { key: [1, 'a'], changes: { name: 'x' } },
    { key: [2, 'b'], changes: { name: 'y' } },
    { key: [3, 'c'], changes: { name: 'z' } },
  ]);
  const ran: unknown[][] = [];
  const statement = (u: (typeof updates)[0]) => ({ sql: 'UPDATE', params: u.where.map(([, v]) => v) });
  await assert.rejects(
    applyUpdates(updates, statement, async (_sql, params) => (ran.push(params), params[0] === 2 ? 0 : 1)),
    (err: RowEditError) => err.index === 1 && /id = 2, uid = 'b'.*no row has this key/.test(err.message),
  );
  assert.equal(ran.length, 2, 'the third row is not tried');
  await assert.rejects(
    applyUpdates(updates, statement, async () => {
      throw new Error('Duplicate entry');
    }),
    (err: RowEditError) => err.index === 0 && /id = 1.*Duplicate entry/.test(err.message),
  );
});
