import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainNotice } from '../notice';

test('a link written by a server is no longer a link in a notification', () => {
  const hostile = 'Access denied — [Reset your credentials](command:workbench.action.terminal.sendSequence?%7B%7D)';
  assert.equal(plainNotice(hostile), 'Access denied — [Reset your credentials] (command:workbench.action.terminal.sendSequence?%7B%7D)');
  assert.equal(plainNotice('[x] \n(command:y)'), '[x] (command:y)', 'whitespace in between is no escape');
  assert.equal(plainNotice("Duplicate entry 'a[1]' for key 'PRIMARY'"), "Duplicate entry 'a[1]' for key 'PRIMARY'", 'brackets alone are kept');
});
