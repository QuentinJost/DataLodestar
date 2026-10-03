import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const settings = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).contributes.configuration.properties;

test('a workspace cannot turn off a protection: those settings are user settings only', () => {
  for (const key of ['dataLodestar.confirmDestructive', 'dataLodestar.csvEscapeFormulas']) {
    assert.equal(settings[key].scope, 'application', key);
    assert.equal(settings[key].default, true, key);
  }
});
