import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { installVscodeStub, registered, Uri } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionManager } = require('../sessionManager') as typeof import('../sessionManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activate } = require('../extension') as typeof import('../extension');

/** globalState / workspaceState / SecretStorage in memory. */
function memento(initial: Record<string, unknown>) {
  const state = new Map(Object.entries(initial));
  return { get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d), update: async (k: string, v: unknown) => void state.set(k, v) };
}

test('the editor title buttons act on the connection of their editor', async () => {
  const conn = (id: string) => ({ id, name: id, kind: 'mysql', host: 'h', port: 3306, user: 'u', ssl: false, sslVerify: true, txMode: 'manual', savePassword: false, showSystemDatabases: false });
  const ctx = {
    subscriptions: [] as unknown[],
    extensionUri: new Uri('/ext'),
    globalState: memento({ 'dataLodestar.connections': [conn('c1'), conn('c2')] }),
    workspaceState: memento({ 'dataLodestar.editorBindings': { 'file:///q.sql': { connId: 'c2', database: 'shop' } } }),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  const calls: string[] = [];
  SessionManager.prototype.commit = async function (id: string) {
    calls.push(`commit ${id}`);
  };
  SessionManager.prototype.rollback = async function (id: string) {
    calls.push(`rollback ${id}`);
  };
  activate(ctx as never);
  // VS Code passes the URI of the editor whose title holds the button.
  await registered.get('dataLodestar.commit')!(new Uri('file:///q.sql'));
  await registered.get('dataLodestar.rollback')!(new Uri('file:///q.sql'));
  assert.deepEqual(calls, ['commit c2', 'rollback c2'], 'no quick pick: the editor is bound to c2');
  await registered.get('dataLodestar.commit')!(new Uri('file:///unbound.sql'));
  assert.deepEqual(calls, ['commit c2', 'rollback c2'], 'an unbound editor commits nothing');
});

test('Delete on a database asks first, drops it and re-lists the tree; a failure leaves it listed', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stub = require('./vscodeStub') as typeof import('./vscodeStub');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseNode, RedisDbNode } = require('../treeProvider') as typeof import('../treeProvider');
  const ctx = {
    subscriptions: [] as unknown[],
    extensionUri: new Uri('/ext'),
    globalState: memento({ 'dataLodestar.connections': [{ id: 'c1', name: 'local', kind: 'mysql', host: 'h', port: 3306, user: 'u', ssl: false, txMode: 'auto', savePassword: false, showSystemDatabases: false }] }),
    workspaceState: memento({}),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  const dropped: string[] = [];
  const relisted: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let fail: Error | undefined;
  const driver = {
    family: 'sql',
    dropDatabase: async (db: string) => {
      if (fail) throw fail;
      dropped.push(db);
    },
  };
  SessionManager.prototype.get = async function () {
    return { driver } as never;
  };
  SessionManager.prototype.notifySchemaChange = function (id: string) {
    relisted.push(id);
  };
  const win = stub.window as unknown as Record<'showWarningMessage' | 'showErrorMessage', (message: string) => Promise<string | undefined>>;
  const { showWarningMessage, showErrorMessage } = win;
  win.showWarningMessage = async (message) => (warnings.push(message), stub.answers.next);
  win.showErrorMessage = async (message) => (errors.push(message), undefined);
  try {
    activate(ctx as never);
    const drop = registered.get('dataLodestar.dropDatabase')!;
    const node = new DatabaseNode('c1', 'shop');

    stub.answers.next = undefined; // Cancel / Escape
    await drop(node);
    assert.equal(warnings.length, 1, 'a confirmation is asked');
    assert.match(warnings[0], /Delete database "shop" on "local"\?/);
    assert.deepEqual(dropped, [], 'cancelled: nothing dropped');
    assert.deepEqual(relisted, []);

    stub.answers.next = 'Delete';
    await drop(node);
    assert.deepEqual(dropped, ['shop']);
    assert.deepEqual(relisted, ['c1'], 'the tree lists the databases again, without the dropped one');

    fail = new Error("Access denied for user 'u'@'%' to database 'shop'");
    await drop(node);
    assert.deepEqual(dropped, ['shop'], 'not dropped');
    assert.deepEqual(relisted, ['c1'], 'a failure does not re-list: the database stays');
    assert.deepEqual(errors, ["DataLodestar: Access denied for user 'u'@'%' to database 'shop'"], 'shown like any command error');

    fail = undefined;
    warnings.length = 0;
    await drop(new RedisDbNode('c1', '3', 0));
    await drop(undefined);
    assert.deepEqual(warnings, [], 'only a database node of the tree can be deleted');
    assert.deepEqual(dropped, ['shop']);
  } finally {
    win.showWarningMessage = showWarningMessage;
    win.showErrorMessage = showErrorMessage;
    stub.answers.next = undefined;
  }
});

test('the Delete entry is in the right-click menu of database nodes only, never in the palette', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path') as typeof import('path');
  const contributes = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).contributes;
  const command = contributes.commands.find((c: { command: string }) => c.command === 'dataLodestar.dropDatabase');
  assert.equal(command?.title, 'Delete');
  const entries = contributes.menus['view/item/context'].filter((m: { command: string }) => m.command === 'dataLodestar.dropDatabase');
  assert.deepEqual(entries, [{ command: 'dataLodestar.dropDatabase', when: 'view == dataLodestar.connections && viewItem == database', group: '9_delete@1' }], 'right-click menu, not an inline button');
  assert.deepEqual(contributes.menus.commandPalette.find((m: { command: string }) => m.command === 'dataLodestar.dropDatabase'), { command: 'dataLodestar.dropDatabase', when: 'false' });
});
