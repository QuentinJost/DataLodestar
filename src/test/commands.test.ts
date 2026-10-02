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
