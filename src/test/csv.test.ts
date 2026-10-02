import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toCsv, csvField } = require('../../media/grid.js');

test('formula-like cells are quoted and prefixed with a single quote', () => {
  for (const s of ['=SUM(A1:A2)', '+1+1', '-2+3', '@cmd', '\tx', '\rx']) {
    const out = csvField(s, true);
    assert.equal(out, `"'${s}"`, JSON.stringify(s));
  }
  assert.equal(csvField('=HYPERLINK("http://x","y")', true), `"'=HYPERLINK(""http://x"",""y"")"`);
});

test('plain numbers and ordinary text are left alone', () => {
  for (const s of ['-1', '+3', '-1.5', '-.5', '1e-3', '-2E+10', 'abc', 'a-b', '']) assert.equal(csvField(s, true), s, s);
  assert.equal(csvField('a,b', true), '"a,b"');
});

test('toCsv escapes by default, keeps raw output when asked, numbers as numbers', () => {
  const rows = [['=1+1', -1, '-1', null]];
  assert.equal(toCsv(['f', 'n', 's', 'z'], rows), `f,n,s,z\n"'=1+1",-1,-1,`);
  assert.equal(toCsv(['f', 'n', 's', 'z'], rows, { escapeFormulas: false }), 'f,n,s,z\n=1+1,-1,-1,');
  assert.equal(toCsv(['=h'], [['x']]), `"'=h"\nx`, 'headers too');
});
