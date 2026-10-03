import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { installVscodeStub } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConnectionStore } = require('../connectionStore') as typeof import('../connectionStore');

/** globalState and SecretStorage in memory. */
function context(configs: object[]) {
  const state = new Map<string, unknown>([['dataLodestar.connections', configs]]);
  return {
    globalState: { get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d), update: async (k: string, v: unknown) => void state.set(k, v) },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
}

test('TLS migration: only connections using TLS are kept unchecked', async () => {
  const base = { kind: 'mysql', host: 'h', port: 3306, user: 'u', txMode: 'auto', savePassword: false, showSystemDatabases: false };
  const store = new ConnectionStore(
    context([
      { ...base, id: 'plain', name: 'plain', ssl: false },
      { ...base, id: 'tls', name: 'tls', ssl: true },
      { ...base, id: 'checked', name: 'checked', ssl: true, sslVerify: true },
    ]) as never,
  );
  assert.deepEqual(await store.migrateTlsVerify(), ['tls']);
  assert.deepEqual(
    store.list().map((c) => [c.name, c.sslVerify]),
    [['checked', true], ['plain', undefined], ['tls', false]],
    'without TLS the setting stays unset: turning TLS on later verifies',
  );
  assert.deepEqual(await store.migrateTlsVerify(), [], 'runs once');
});

test('URI migration: a password that cannot be told apart is left as typed and reported', async () => {
  const base = { kind: 'mongodb', host: 'h', port: 27017, user: '', txMode: 'auto', savePassword: true, showSystemDatabases: false, ssl: false };
  const store = new ConnectionStore(
    context([
      { ...base, id: 'clear', name: 'clear', uri: 'mongodb://u:pw@h/' },
      { ...base, id: 'unclear', name: 'unclear', uri: 'mongodb://u:p@ss@h/' },
    ]) as never,
  );
  const result = await store.migrateUriPasswords();
  assert.deepEqual(result, { moved: ['clear'], dropped: [], unclear: ['unclear'] });
  assert.deepEqual(
    store.list().map((c) => c.uri),
    ['mongodb://u@h/', 'mongodb://u:p@ss@h/'],
    'not split into "p" with "ss" left in the string',
  );
});
