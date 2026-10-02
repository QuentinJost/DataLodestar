import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter, executed, installVscodeStub, window, workspace } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StatusBar } = require('../statusBar') as typeof import('../statusBar');

/** Last value given to a context key. */
const contextKey = (key: string) => executed.filter((c) => c[0] === 'setContext' && c[1] === key).at(-1)?.[2];

test('the editor title offers Commit / Rollback over each document whose connection has pending changes', () => {
  const changed = new EventEmitter<string>();
  const drivers: Record<string, { pendingTransaction: boolean }> = { c1: { pendingTransaction: false }, c2: { pendingTransaction: false } };
  const config = { id: 'c1', name: 'local', kind: 'mysql', txMode: 'manual', user: 'u', host: 'h', port: 3306 };
  const sessions = { current: (id: string) => ({ txMode: 'manual', driver: drivers[id] }), onDidChange: changed.event };
  const store = { get: () => config, onDidChange: new EventEmitter<void>().event };
  const doc = (name: string) => ({ uri: { fsPath: name, toString: () => `untitled:${name}` }, languageId: 'sql' });
  const q1 = doc('Untitled-1');
  const q2 = doc('Untitled-2');
  const readme = { uri: { fsPath: '/w/README.md', toString: () => 'file:///w/README.md' }, languageId: 'markdown' };
  const bindings = new Map<unknown, { connId: string; database: string }>([[q1.uri, { connId: 'c1', database: 'shop' }], [q2.uri, { connId: 'c2', database: 'shop' }]]);
  const runner = { binding: (d: { uri: unknown }) => bindings.get(d.uri), onDidChangeBinding: new EventEmitter<void>().event };
  workspace.textDocuments = [q1, q2, readme];
  window.activeTextEditor = { document: q1 };
  const bar = new StatusBar(store as never, sessions as never, runner as never);
  assert.deepEqual(contextKey('dataLodestar.pendingDocs'), []);
  drivers.c2.pendingTransaction = true; // a write in manual mode, from the editor of the other group
  changed.fire('c2');
  assert.deepEqual(contextKey('dataLodestar.pendingDocs'), ['Untitled-2'], 'the inactive group gets its buttons, the active one does not');
  bindings.delete(q2.uri);
  bar.update();
  assert.deepEqual(contextKey('dataLodestar.pendingDocs'), [], 'a document bound to no connection');
  bar.dispose();
  workspace.textDocuments = [];
});
