import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter, executed, installVscodeStub, window } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StatusBar } = require('../statusBar') as typeof import('../statusBar');

/** Last value given to a context key. */
const contextKey = (key: string) => executed.filter((c) => c[0] === 'setContext' && c[1] === key).at(-1)?.[2];

test('the editor title offers Commit / Rollback while the connection of the editor has pending changes', () => {
  const changed = new EventEmitter<string>();
  const driver = { pendingTransaction: false };
  const config = { id: 'c1', name: 'local', kind: 'mysql', txMode: 'manual', user: 'u', host: 'h', port: 3306 };
  const sessions = { current: () => ({ txMode: 'manual', driver }), onDidChange: changed.event };
  const store = { get: () => config, onDidChange: new EventEmitter<void>().event };
  let bound = true;
  const runner = { binding: () => (bound ? { connId: 'c1', database: 'shop' } : undefined), onDidChangeBinding: new EventEmitter<void>().event };
  window.activeTextEditor = { document: { uri: { toString: () => 'untitled:Untitled-1' }, languageId: 'sql' } };
  const bar = new StatusBar(store as never, sessions as never, runner as never);
  assert.equal(contextKey('dataLodestar.editorTxPending'), false);
  driver.pendingTransaction = true; // a write in manual mode
  changed.fire('c1');
  assert.equal(contextKey('dataLodestar.editorTxPending'), true);
  bound = false;
  bar.update();
  assert.equal(contextKey('dataLodestar.editorTxPending'), false, 'an editor bound to no connection');
  bar.dispose();
});
