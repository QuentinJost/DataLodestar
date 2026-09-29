import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter, installVscodeStub } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NavigatorTree } = require('../treeProvider') as typeof import('../treeProvider');
type Node = import('../treeProvider').NavNode;

const config = { id: 'c1', name: 'local', kind: 'mysql', host: 'h', port: 3306, user: 'u', ssl: false, txMode: 'manual', savePassword: false, showSystemDatabases: false };

function setup() {
  const calls = { listDatabases: 0, listTables: 0, describeTable: 0 };
  const driver = {
    family: 'sql',
    pendingTransaction: false,
    listDatabases: async () => (calls.listDatabases++, ['shop', 'crm', 'hr']),
    listTables: async (db: string) => (calls.listTables++, [{ database: db, name: 't', type: 'table' }]),
    describeTable: async () => (calls.describeTable++, { columns: [], indexes: [], foreignKeys: [], ddl: '' }),
  };
  const session = { id: 'c1', driver, txMode: 'manual' };
  const changed = new EventEmitter<string>();
  const schema = new EventEmitter<string>();
  const sessions = { current: () => session, get: async () => session, onDidChange: changed.event, onDidChangeSchema: schema.event };
  const store = { list: () => [config], onDidChange: new EventEmitter<void>().event };
  const tree = new NavigatorTree(store as never, sessions as never);
  const fired: (Node | undefined)[] = [];
  tree.onDidChangeTreeData((n) => fired.push(n));
  /** What VS Code does after a change event: re-read the node and its expanded descendants. */
  const expandAll = async (from?: Node): Promise<void> => {
    for (const child of await tree.getChildren(from)) if (child.kind !== 'column' && child.kind !== 'message') await expandAll(child);
  };
  return { tree, calls, driver, changed, schema, fired, expandAll };
}

test('pending-transaction changes redraw one connection from the cache: no metadata query', async () => {
  const { calls, driver, changed, fired, expandAll } = setup();
  await expandAll();
  const before = { ...calls };
  assert.deepEqual(before, { listDatabases: 1, listTables: 3, describeTable: 3 });
  for (let i = 0; i < 10; i++) {
    driver.pendingTransaction = i % 2 === 0;
    changed.fire('c1');
    const node = fired.at(-1);
    assert.equal(node?.kind, 'connection', 'only the connection node is redrawn');
    assert.equal((node as { contextValue?: string }).contextValue, driver.pendingTransaction ? 'connection.on.pending' : 'connection.on');
    await expandAll(node);
  }
  assert.deepEqual(calls, before, 'no re-query across 10 writes');
});

test('Refresh, DDL and disconnect drop the cache of that connection', async () => {
  const { tree, calls, schema, expandAll } = setup();
  await expandAll();
  tree.refresh();
  await expandAll();
  assert.equal(calls.listDatabases, 2, 'Refresh re-lists');
  schema.fire('c1');
  await expandAll();
  assert.equal(calls.listTables, 9, 'a CREATE/DROP/ALTER/RENAME re-lists');
});

test('a failed listing is not cached', async () => {
  const { tree, driver, expandAll } = setup();
  let fail = true;
  const real = driver.listDatabases;
  driver.listDatabases = async () => {
    if (fail) throw new Error('down');
    return real();
  };
  const [conn] = await tree.getChildren();
  assert.equal((await tree.getChildren(conn))[0].kind, 'message');
  fail = false;
  assert.equal((await tree.getChildren(conn))[0].kind, 'database');
  await expandAll();
});
