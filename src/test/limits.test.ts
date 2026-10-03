import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boundedSetting } from '../limits';

const settings = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback) });

test('a size setting is kept within its bounds, whatever a workspace writes', () => {
  assert.equal(boundedSetting(settings({}), 'maxRows'), 1000, 'default');
  assert.equal(boundedSetting(settings({ maxRows: 5000 }), 'maxRows'), 5000, 'a value within bounds is kept, per project too');
  assert.equal(boundedSetting(settings({ maxRows: 100_000_000 }), 'maxRows'), 100_000);
  assert.equal(boundedSetting(settings({ maxRows: 0 }), 'maxRows'), 1);
  assert.equal(boundedSetting(settings({ maxRows: 12.9 }), 'maxRows'), 12);
  assert.equal(boundedSetting(settings({ maxRows: 'lots' }), 'maxRows'), 1000, 'not a number: the default');
  assert.equal(boundedSetting(settings({ maxRows: Infinity }), 'maxRows'), 1000);
  assert.equal(boundedSetting(settings({ maxCellChars: 1e9 }), 'maxCellChars'), 100_000);
  assert.equal(boundedSetting(settings({ maxCellChars: 5 }), 'maxCellChars'), 20);
});

test('the bounds match the settings schema', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const props = require('../../package.json').contributes.configuration.properties;
  assert.deepEqual([props['dataLodestar.maxRows'].minimum, props['dataLodestar.maxRows'].maximum, props['dataLodestar.maxRows'].default], [1, 100_000, 1000]);
  assert.deepEqual([props['dataLodestar.maxCellChars'].minimum, props['dataLodestar.maxCellChars'].maximum, props['dataLodestar.maxCellChars'].default], [20, 100_000, 500]);
});
