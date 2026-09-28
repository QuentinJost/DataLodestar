import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Plain browser script shared with the webviews; it also exports for Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { format, resolve } = require('../../media/binaryFormat.js');

const u = { b: '11ee4f2a9c3b6d8e8f1a0242ac120002', n: 16 };

test('formats 16 bytes as a standard UUID', () => {
  assert.equal(format(u, 'uuid'), '11ee4f2a-9c3b-6d8e-8f1a-0242ac120002');
});

test('uuidSwapped reverses MySQL UUID_TO_BIN(u, 1)', () => {
  // UUID_TO_BIN('9c3b6d8e-4f2a-11ee-8f1a-0242ac120002', 1) = 11ee4f2a9c3b6d8e8f1a0242ac120002
  assert.equal(format(u, 'uuidSwapped'), '9c3b6d8e-4f2a-11ee-8f1a-0242ac120002');
});

test('UUID modes fall back to hex for other lengths; cut values say their size', () => {
  assert.equal(format({ b: 'deadbeef', n: 4 }, 'uuid'), '0xdeadbeef');
  assert.equal(format({ b: 'dead', n: 5000 }, 'hex'), '0xdead… (5000 bytes)');
});

test('text and base64', () => {
  assert.equal(format({ b: Buffer.from('héllo').toString('hex'), n: 6 }, 'text'), 'héllo');
  assert.equal(format({ b: 'deadbeef', n: 4 }, 'base64'), '3q2+7w==');
});

test('auto picks UUID only when every binary value is 16 bytes', () => {
  assert.equal(resolve('auto', [u, null, u]), 'uuid');
  assert.equal(resolve('auto', [u, { b: 'ab', n: 1 }]), 'hex');
  assert.equal(resolve('auto', [null]), 'hex');
  assert.equal(resolve('base64', [u]), 'base64');
});
