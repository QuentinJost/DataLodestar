import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { installVscodeStub, panels } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ResultsPanel } = require('../views/resultsPanel') as typeof import('../views/resultsPanel');

const extensionUri = { path: '/ext' } as never;
const run = (sql: string) => [{ sql, connection: 'local', columns: ['a'], rows: [[1]] }];

test('results: a run made while the panel is hidden waits for the reloaded page', () => {
  const results = new ResultsPanel(extensionUri);
  results.show(run('SELECT 1'));
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  assert.equal(panel.posted.length, 1);
  panel.setVisible(false); // not retained: the page is gone
  results.show(run('SELECT 2')); // revealed: the page reloads
  assert.equal(panel.posted.length, 1, 'nothing posted to a page that is reloading');
  panel.fromPage({ type: 'ready' });
  const last = panel.posted.at(-1)!;
  assert.equal((last.items as { sql: string }[])[0].sql, 'SELECT 2');
  assert.equal(last.restored, false, 'a new run opens its error or last grid, not the tab saved for the previous one');
});

test('results: shown again without a new run, the page restores its tab', () => {
  const results = new ResultsPanel(extensionUri);
  results.show(run('SELECT 1'));
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  panel.setVisible(false);
  panel.setVisible(true);
  panel.fromPage({ type: 'ready' });
  assert.equal(panel.posted.length, 2);
  assert.equal(panel.posted.at(-1)!.restored, true);
});
