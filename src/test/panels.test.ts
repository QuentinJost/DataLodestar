import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { commands, EventEmitter, executed, FakeWebviewPanel, installVscodeStub, panels } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ResultsPanel } = require('../views/resultsPanel') as typeof import('../views/resultsPanel');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TablePanel } = require('../views/tablePanel') as typeof import('../views/tablePanel');

const extensionUri = { path: '/ext' } as never;
const run = (sql: string) => [{ sql, connection: 'local', columns: ['a'], rows: [[1]] }];
/** Messages of one type posted to the page, in order. */
const sent = (panel: FakeWebviewPanel, type: string) => panel.posted.filter((m) => m.type === type);
/** Lets a command started by a page message finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Sessions as the panels see them: a pending flag per connection, set by the test. */
function fakeSessions() {
  const changed = new EventEmitter<string>();
  const pending = new Map<string, boolean>();
  return {
    onDidChange: changed.event,
    txState: (id: string) => ({ pending: !!pending.get(id), redis: false, connection: id }),
    set(id: string, value: boolean) {
      pending.set(id, value);
      changed.fire(id);
    },
  };
}

test('results: a run made while the panel is hidden waits for the reloaded page', () => {
  const results = new ResultsPanel(extensionUri, fakeSessions());
  results.show(run('SELECT 1'), 'c1');
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  assert.equal(sent(panel, 'results').length, 1);
  panel.setVisible(false); // not retained: the page is gone
  results.show(run('SELECT 2'), 'c1'); // revealed: the page reloads
  assert.equal(sent(panel, 'results').length, 1, 'nothing posted to a page that is reloading');
  panel.fromPage({ type: 'ready' });
  const last = sent(panel, 'results').at(-1)!;
  assert.equal((last.items as { sql: string }[])[0].sql, 'SELECT 2');
  assert.equal(last.restored, false, 'a new run opens its error or last grid, not the tab saved for the previous one');
});

test('results: shown again without a new run, the page restores its tab', () => {
  const results = new ResultsPanel(extensionUri, fakeSessions());
  results.show(run('SELECT 1'), 'c1');
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  panel.setVisible(false);
  panel.setVisible(true);
  panel.fromPage({ type: 'ready' });
  assert.equal(sent(panel, 'results').length, 2);
  assert.equal(sent(panel, 'results').at(-1)!.restored, true);
});

test('results: the bar follows the pending changes of the connection that ran', async () => {
  const sessions = fakeSessions();
  const results = new ResultsPanel(extensionUri, sessions);
  results.show(run('UPDATE t SET a = 1'), 'c1');
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  assert.deepEqual(panel.posted.at(-1), { type: 'tx', pending: false, redis: false, connection: 'c1' }, 'with the results, and after each reload');
  sessions.set('c1', true);
  assert.equal(panel.posted.at(-1)!.pending, true);
  const before = panel.posted.length;
  sessions.set('c2', true);
  assert.equal(panel.posted.length, before, 'another connection does not touch the bar');
  panel.fromPage({ type: 'commit' });
  await settle();
  assert.deepEqual(executed.at(-1), ['dataLodestar.commit', 'c1']);
  assert.equal(panel.posted.at(-1)!.type, 'tx', 'sent again even if the commit failed, so the buttons work again');
  panel.fromPage({ type: 'rollback' });
  await settle();
  assert.deepEqual(executed.at(-1), ['dataLodestar.rollback', 'c1']);
});

/** Opens a table panel on `tab` and loads its page; returns the panel, its sessions and a way to ask for a tab again. */
function openTable(key: string, tab: 'data' | 'structure') {
  const sessions = fakeSessions();
  const source = { key, title: key, icon: 'table', database: 'shop', queryLanguage: 'sql', labels: {}, sortStyle: 'sql' };
  const show = (t: 'data' | 'structure') => TablePanel.show(extensionUri, sessions, async () => undefined, 'c1', source as never, t);
  show(tab);
  const panel = panels.at(-1)!;
  panel.fromPage({ type: 'ready' });
  assert.equal(sent(panel, 'init').at(-1)!.tab, tab);
  return { panel, sessions, show };
}

test('table: a tab asked while the panel is visible is not forced again on its next reload', () => {
  const { panel, show } = openTable('t1', 'data');
  show('structure');
  assert.deepEqual(panel.posted.at(-1), { type: 'showTab', tab: 'structure' });
  // The user goes back to Data, then hides and shows the panel: the page reloads.
  panel.setVisible(false);
  panel.setVisible(true);
  panel.fromPage({ type: 'ready' });
  assert.equal(sent(panel, 'init').length, 2);
  assert.equal(sent(panel, 'init').at(-1)!.tab, undefined, 'the page keeps the tab it saved');
});

test('table: a tab asked while the panel is hidden opens once its page has reloaded', () => {
  const { panel, show } = openTable('t2', 'data');
  panel.setVisible(false);
  show('structure');
  panel.fromPage({ type: 'ready' });
  assert.equal(sent(panel, 'init').at(-1)!.tab, 'structure');
});

test('table: the bar follows the pending changes of its connection until the panel closes', async () => {
  const { panel, sessions } = openTable('t3', 'data');
  assert.deepEqual(panel.posted.at(-1), { type: 'tx', pending: false, redis: false, connection: 'c1' }, 'right after init');
  sessions.set('c1', true);
  assert.equal(panel.posted.at(-1)!.pending, true);
  panel.fromPage({ type: 'rollback' });
  await settle();
  assert.deepEqual(executed.at(-1), ['dataLodestar.rollback', 'c1']);
  assert.equal(panel.posted.at(-1)!.type, 'tx');
  panel.dispose();
  const before = panel.posted.length;
  sessions.set('c1', false);
  assert.equal(panel.posted.length, before, 'a closed panel no longer listens');
});

test('results and table: a commit that fails still sends the bar again, so its buttons work', async () => {
  const sessions = fakeSessions();
  const results = new ResultsPanel(extensionUri, sessions);
  results.show(run('UPDATE t SET a = 1'), 'c1');
  const resultsPage = panels.at(-1)!;
  resultsPage.fromPage({ type: 'ready' });
  const { panel: tablePage } = openTable('t4', 'data');
  const real = commands.executeCommand;
  commands.executeCommand = async () => {
    throw new Error('Deadlock found when trying to get lock');
  };
  try {
    for (const page of [resultsPage, tablePage]) {
      const before = sent(page, 'tx').length;
      page.fromPage({ type: 'commit' });
      await settle();
      assert.equal(sent(page, 'tx').length, before + 1);
    }
  } finally {
    commands.executeCommand = real;
  }
});
