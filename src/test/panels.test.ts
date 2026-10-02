import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { installVscodeStub, panels } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ResultsPanel } = require('../views/resultsPanel') as typeof import('../views/resultsPanel');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TablePanel } = require('../views/tablePanel') as typeof import('../views/tablePanel');

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

/** Opens a table panel on `tab` and loads its page; returns the panel and a way to ask for a tab again. */
function openTable(key: string, tab: 'data' | 'structure') {
  const source = { key, title: key, icon: 'table', database: 'shop', queryLanguage: 'sql', labels: {}, sortStyle: 'sql' };
  const show = (t: 'data' | 'structure') => TablePanel.show(extensionUri, async () => undefined, 'c1', source as never, t);
  show(tab);
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  assert.equal(panel.posted.at(-1)!.tab, tab);
  return { panel, show };
}

test('table: a tab asked while the panel is visible is not forced again on its next reload', () => {
  const { panel, show } = openTable('t1', 'data');
  show('structure');
  assert.deepEqual(panel.posted.at(-1), { type: 'showTab', tab: 'structure' });
  // The user goes back to Data, then hides and shows the panel: the page reloads.
  panel.setVisible(false);
  panel.setVisible(true);
  panel.fromPage({ type: 'ready' });
  assert.equal(panel.posted.at(-1)!.type, 'init');
  assert.equal(panel.posted.at(-1)!.tab, undefined, 'the page keeps the tab it saved');
});

test('table: a tab asked while the panel is hidden opens once its page has reloaded', () => {
  const { panel, show } = openTable('t2', 'data');
  panel.setVisible(false);
  show('structure');
  panel.fromPage({ type: 'ready' });
  assert.equal(panel.posted.at(-1)!.tab, 'structure');
});
