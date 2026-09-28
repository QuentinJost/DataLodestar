import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertSingleStatement, splitSql, statementAt } from '../sqlSplitter';

const texts = (sql: string, d: 'mysql' | 'postgres' = 'mysql') => splitSql(sql, d).map((s) => s.text);

test('splits on semicolons and trims', () => {
  assert.deepEqual(texts('SELECT 1;\n  SELECT 2 ;\n\nSELECT 3'), ['SELECT 1', 'SELECT 2', 'SELECT 3']);
});

test('ignores delimiters in strings, identifiers and comments', () => {
  const sql = "SELECT 'a;b', \"c;d\", `e;f` FROM t -- x;y\n WHERE a = 'it''s;' /* ; */;\n# only; comment\nSELECT 'x\\';y'";
  assert.deepEqual(texts(sql), [
    "SELECT 'a;b', \"c;d\", `e;f` FROM t -- x;y\n WHERE a = 'it''s;' /* ; */",
    "# only; comment\nSELECT 'x\\';y'",
  ]);
});

test('drops comment-only chunks', () => {
  assert.deepEqual(texts('-- nothing;\n/* still nothing */;\n;SELECT 1;'), ['SELECT 1']);
});

test('mysql: "--" without a following space is an operator', () => {
  assert.deepEqual(texts('SELECT 5--1;SELECT 2'), ['SELECT 5--1', 'SELECT 2']);
});

test('mysql: DELIMITER blocks keep procedure bodies whole', () => {
  const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();';
  assert.deepEqual(texts(sql), ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
});

test('postgres: dollar quotes and E-strings', () => {
  const sql = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql;\nSELECT E'a\\';b', $$x;y$$, $1;";
  assert.deepEqual(texts(sql, 'postgres'), [
    'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql',
    "SELECT E'a\\';b', $$x;y$$, $1",
  ]);
});

test('postgres: backslash is literal in standard strings and # is not a comment', () => {
  assert.deepEqual(texts("SELECT 'a\\';SELECT 1 # 2;", 'postgres'), ["SELECT 'a\\'", 'SELECT 1 # 2']);
});

test('statementAt picks the statement under or before the cursor', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;';
  const st = splitSql(sql, 'mysql');
  assert.equal(statementAt(st, 3)?.text, 'SELECT 1');
  assert.equal(statementAt(st, 9)?.text, 'SELECT 1');
  assert.equal(statementAt(st, 10)?.text, 'SELECT 1');
  assert.equal(statementAt(st, 13)?.text, 'SELECT 2');
  assert.equal(statementAt(st, 0)?.text, 'SELECT 1');
});

import { isReadOnly, leadingKeyword } from '../drivers/driver';

test('leadingKeyword skips comments and parentheses', () => {
  assert.equal(leadingKeyword('-- hi\n/* x */ (SELECT 1)'), 'select');
  assert.equal(leadingKeyword('# c\nupdate t set a=1'), 'update');
});

test('isReadOnly separates reads from writes and locking reads', () => {
  assert.equal(isReadOnly('SELECT * FROM t'), true);
  assert.equal(isReadOnly('show tables'), true);
  assert.equal(isReadOnly('WITH x AS (SELECT 1) SELECT * FROM x'), true);
  assert.equal(isReadOnly('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'), false);
  assert.equal(isReadOnly('SELECT * FROM t FOR UPDATE'), false);
  assert.equal(isReadOnly('SELECT a INTO @v FROM t'), false);
  assert.equal(isReadOnly('UPDATE t SET a = 1'), false);
  assert.equal(isReadOnly('SET @a = 1'), false);
});

test('viewer conditions cannot smuggle a second statement', () => {
  assert.doesNotThrow(() => assertSingleStatement("SELECT * FROM t WHERE a = ';' ORDER BY b", 'postgres'));
  assert.doesNotThrow(() => assertSingleStatement('SELECT * FROM t WHERE a = 1;', 'mysql'), 'a trailing ; is harmless');
  assert.throws(() => assertSingleStatement('SELECT * FROM t WHERE 1=1; DROP TABLE t', 'postgres'), /Only one condition/);
  assert.throws(() => assertSingleStatement('SELECT * FROM t WHERE 1=1; DELETE FROM t -- ', 'mysql'), /Only one condition/);
});
