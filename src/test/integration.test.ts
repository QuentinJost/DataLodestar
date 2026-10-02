// Runs against real servers when SQLNAV_IT=1 (see scripts/integration.sh); skipped otherwise.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createDriver } from '../drivers';
import { SqlDriver } from '../drivers/driver';
import { SshTunnel } from '../sshTunnel';
import { DbKind } from '../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { format } = require('../../media/binaryFormat.js');
const UUID = '9c3b6d8e-4f2a-11ee-8f1a-0242ac120002';

const env = process.env;
const enabled = env.SQLNAV_IT === '1';
const skip = !enabled && 'set SQLNAV_IT=1 (scripts/integration.sh)';

const endpoint = (kind: DbKind, database?: string) => ({
  host: kind === 'mysql' ? env.MYSQL_HOST! : env.PG_HOST!,
  port: kind === 'mysql' ? 3306 : 5432,
  user: kind === 'mysql' ? 'root' : 'postgres',
  password: env.DB_PASSWORD,
  database,
  ssl: false,
});

/** TCP ports this container listens on, from /proc (Docker's own DNS resolver included: compare before / after). */
function listeningTcpPorts(): number[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs');
  const ports: number[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of String(readFileSync(file)).split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === '0A') ports.push(parseInt(cols[1].split(':')[1], 16));
    }
  }
  return ports;
}

async function withDriver(kind: DbKind, database: string | undefined, fn: (d: SqlDriver) => Promise<void>) {
  const d = createDriver(kind, endpoint(kind, database)) as SqlDriver;
  await d.connect();
  try {
    await fn(d);
  } finally {
    await d.close();
  }
}

test('mysql: browse databases, tables, structure', { skip }, async () => {
  await withDriver('mysql', undefined, async (d) => {
    await d.execute('CREATE DATABASE IF NOT EXISTS shop', undefined);
    await d.execute('CREATE DATABASE IF NOT EXISTS crm', undefined);
    await d.execute('DROP TABLE IF EXISTS orders', 'shop');
    await d.execute('DROP TABLE IF EXISTS customers', 'shop');
    await d.execute(
      "CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE COMMENT 'login', created_at DATETIME DEFAULT CURRENT_TIMESTAMP) COMMENT 'people'",
      'shop',
    );
    await d.execute(
      'CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2), data BLOB, KEY idx_c (customer_id), CONSTRAINT fk_c FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)',
      'shop',
    );
    await d.execute('CREATE OR REPLACE VIEW big_orders AS SELECT * FROM orders WHERE total > 100', 'shop');
    await d.execute('DROP TABLE IF EXISTS contacts', 'crm');
    await d.execute('CREATE TABLE contacts (id INT PRIMARY KEY)', 'crm');

    const dbs = await d.listDatabases(false);
    assert.ok(dbs.includes('shop') && dbs.includes('crm'));
    assert.ok(!dbs.includes('mysql') && !dbs.includes('information_schema'));
    assert.ok((await d.listDatabases(true)).includes('mysql'));

    const tables = await d.listTables('shop');
    assert.deepEqual(tables.map((t) => `${t.name}:${t.type}`), ['big_orders:view', 'customers:table', 'orders:table']);

    const s = await d.describeTable({ database: 'shop', name: 'orders', type: 'table' });
    assert.deepEqual(s.columns.map((c) => c.name), ['id', 'customer_id', 'total', 'data']);
    assert.equal(s.columns[0].key, 'PRI');
    assert.equal(s.columns[1].nullable, false);
    assert.deepEqual(s.indexes.map((i) => i.name).sort(), ['PRIMARY', 'idx_c']);
    assert.equal(s.foreignKeys[0].refTable, 'customers');
    assert.equal(s.foreignKeys[0].onDelete, 'CASCADE');
    assert.match(s.ddl, /^CREATE TABLE `orders`/);
    const v = await d.describeTable({ database: 'shop', name: 'big_orders', type: 'view' });
    assert.match(v.ddl, /VIEW `shop`\.`big_orders`/);

    // Same session hops between databases of the host.
    await d.execute("INSERT INTO customers (email) VALUES ('a@x.io'), ('b@x.io')", 'shop');
    await d.execute("INSERT INTO orders (customer_id, total, data) VALUES (1, 150.5, x'DEADBEEF')", 'shop');
    await d.execute('INSERT INTO contacts VALUES (7)', 'crm');
    const r1 = await d.execute('SELECT id FROM contacts', 'crm');
    assert.deepEqual(r1.rows, [[7]]);
    const r2 = await d.execute('SELECT email, created_at IS NOT NULL AS has_date FROM customers ORDER BY id', 'shop');
    assert.deepEqual(r2.columns, ['email', 'has_date']);
    assert.deepEqual(r2.rows, [['a@x.io', 1], ['b@x.io', 1]]);
    const r3 = await d.execute('SELECT total, data FROM orders', 'shop');
    assert.deepEqual(r3.rows, [['150.50', { b: 'deadbeef', n: 4 }]]);
    const r4 = await d.execute("UPDATE customers SET email = CONCAT(email, '.fr')", 'shop');
    assert.equal(r4.affectedRows, 2);
    assert.deepEqual(r4.columns, []);

    // Binary UUIDs as MySQL stores them, both byte orders; blobs are cut but keep their size.
    const bin = await d.execute(
      `SELECT UUID_TO_BIN('${UUID}'), UUID_TO_BIN('${UUID}', 1), CAST(REPEAT('a', 5000) AS BINARY)`,
      'shop',
    );
    const [std, swapped, blob] = bin.rows[0] as { b: string; n: number }[];
    assert.equal(format(std, 'uuid'), UUID);
    assert.equal(format(swapped, 'uuidSwapped'), UUID);
    assert.notEqual(format(swapped, 'uuid'), UUID);
    assert.equal(blob.n, 5000);
    assert.equal(blob.b.length, 4096 * 2);

    // A user-typed USE is honoured by the next statement without a database.
    await d.execute('USE crm', 'shop');
    assert.deepEqual((await d.execute('SELECT DATABASE()', undefined)).rows, [['crm']]);
  });
});

test('mysql: manual transactions, commit, rollback, pending flag', { skip }, async () => {
  await withDriver('mysql', 'shop', async (d) => {
    await withDriver('mysql', 'shop', async (other) => {
      await d.setTxMode('manual');
      await d.execute('SELECT COUNT(*) FROM customers', 'shop');
      assert.equal(d.pendingTransaction, false, 'a read is not pending');

      await d.execute("INSERT INTO customers (email) VALUES ('tx@x.io')", 'shop');
      assert.equal(d.pendingTransaction, true);
      const seenInside = await d.execute("SELECT COUNT(*) FROM customers WHERE email = 'tx@x.io'", 'shop');
      assert.deepEqual(seenInside.rows, [[1]]);
      const seenOutside = await other.execute("SELECT COUNT(*) FROM customers WHERE email = 'tx@x.io'", 'shop');
      assert.deepEqual(seenOutside.rows, [[0]], 'uncommitted row invisible to others');

      await d.rollback();
      assert.equal(d.pendingTransaction, false);
      assert.deepEqual((await d.execute("SELECT COUNT(*) FROM customers WHERE email = 'tx@x.io'", 'shop')).rows, [[0]]);

      await d.execute("INSERT INTO customers (email) VALUES ('tx2@x.io')", 'shop');
      await d.commit();
      assert.deepEqual((await other.execute("SELECT COUNT(*) FROM customers WHERE email = 'tx2@x.io'", 'shop')).rows, [[1]]);

      // A typed COMMIT clears the flag too.
      await d.execute("DELETE FROM customers WHERE email = 'tx2@x.io'", 'shop');
      assert.equal(d.pendingTransaction, true);
      await d.execute('COMMIT', 'shop');
      assert.equal(d.pendingTransaction, false);

      await d.setTxMode('auto');
      await d.execute("INSERT INTO customers (email) VALUES ('auto@x.io')", 'shop');
      assert.equal(d.pendingTransaction, false);
      assert.deepEqual((await other.execute("SELECT COUNT(*) FROM customers WHERE email = 'auto@x.io'", 'shop')).rows, [[1]]);
    });
  });
});

test('mysql: cancel aborts a running statement', { skip }, async () => {
  await withDriver('mysql', 'shop', async (d) => {
    const started = Date.now();
    const running = d.execute('SELECT SLEEP(20)', 'shop');
    await new Promise((r) => setTimeout(r, 400));
    await d.cancel();
    await running.catch(() => undefined);
    assert.ok(Date.now() - started < 5000, 'returned well before the 20 s sleep');
    assert.deepEqual((await d.execute('SELECT 1', 'shop')).rows, [[1]], 'session still usable');
  });
});

/** Runs a 2M-row statement capped at 1000 rows: bounded memory and time, session still usable. */
async function assertBounded(d: SqlDriver, sql: string, database: string | undefined) {
  global.gc?.();
  const rss = process.memoryUsage().rss;
  const started = Date.now();
  const r = await d.execute(sql, database, 1000);
  const elapsed = Date.now() - started;
  const grown = (process.memoryUsage().rss - rss) / 1024 / 1024;
  assert.equal(r.rows.length, 1000);
  assert.equal(r.truncated, true);
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  assert.ok(grown < 50, `RSS grew by ${grown.toFixed(1)} MB`);
  assert.deepEqual((await d.execute('SELECT 1', database)).rows, [[1]], 'session still usable');
  const small = await d.execute('SELECT 1 UNION ALL SELECT 2', database, 1000);
  assert.equal(small.truncated, false);
}

test('mysql: a 2M-row SELECT keeps maxRows rows without buffering the rest', { skip }, async () => {
  await withDriver('mysql', 'shop', async (d) => {
    await d.execute('SET SESSION cte_max_recursion_depth = 3000000', 'shop');
    await assertBounded(d, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000000) SELECT i, REPEAT(\'x\', 100) FROM n', 'shop');
  });
});

test('postgres: a 2M-row SELECT keeps maxRows rows without buffering the rest', { skip }, async () => {
  await withDriver('postgres', undefined, async (d) => {
    await d.setTxMode('manual');
    await assertBounded(d, "SELECT i, repeat('x', 100) FROM generate_series(1, 2000000) i", undefined);
    await d.rollback();
  });
});

test('mysql: a SELECT stopped at maxRows says so, and its writes are rolled back', { skip }, async () => {
  await withDriver('mysql', 'shop', async (d) => {
    await d.execute('SET GLOBAL log_bin_trust_function_creators = 1', 'shop');
    await d.execute('DROP TABLE IF EXISTS side_log', 'shop');
    await d.execute('CREATE TABLE side_log (i int) ENGINE=InnoDB', 'shop');
    await d.execute('DROP FUNCTION IF EXISTS log_it', 'shop');
    await d.execute('CREATE FUNCTION log_it(v int) RETURNS int MODIFIES SQL DATA BEGIN INSERT INTO side_log VALUES (v); RETURN v; END', 'shop');
    await d.execute('SET SESSION cte_max_recursion_depth = 200000', 'shop');
    try {
      const r = await d.execute('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000) SELECT log_it(i) FROM n', 'shop', 1000);
      assert.equal(r.rows.length, 1000);
      assert.equal(r.stopped, true, 'KILL QUERY');
      assert.deepEqual((await d.execute('SELECT count(*) FROM side_log', 'shop')).rows, [[0]], 'InnoDB rolled the statement back');
      assert.equal((await d.execute('SELECT log_it(1)', 'shop', 1000)).stopped, undefined, 'a statement that ran to the end');
    } finally {
      await d.execute('DROP FUNCTION log_it', 'shop');
      await d.execute('DROP TABLE side_log', 'shop');
    }
  });
});

test('mysql: TLS verification rejects an unknown CA and a wrong name, accepts the right CA and name', { skip }, async () => {
  const { X509Certificate } = await import('crypto');
  const { readFileSync } = await import('fs');
  const ca = env.MYSQL_CA!;
  // The auto-generated server certificate is named after the server version, not the host.
  const caCn = /CN=([^\n,]+)/.exec(new X509Certificate(readFileSync(ca, 'utf8')).subject)![1];
  const serverCn = caCn.replace('_CA_', '_Server_');
  const tryConnect = async (extra: object) => {
    const d = createDriver('mysql', { ...endpoint('mysql'), ssl: true, ...extra }) as SqlDriver;
    await d.connect();
    const r = await d.execute('SELECT 1', undefined);
    await d.close();
    return r.rows;
  };
  await assert.rejects(tryConnect({ sslVerify: true }), /self[- ]signed|unable to verify|certificate/i, 'unknown CA');
  await assert.rejects(tryConnect({ sslVerify: true, sslCaPath: ca }), /altnames|does not match|Hostname/i, 'host name not in the certificate');
  assert.deepEqual(await tryConnect({ sslVerify: true, sslCaPath: ca, sslServerName: serverCn }), [[1]]);
  assert.deepEqual(await tryConnect({ sslVerify: false }), [[1]], 'opt-out still connects');
});

test('postgres: a SELECT stopped at maxRows says so: per-row writes stopped with it', { skip }, async () => {
  await withDriver('postgres', undefined, async (d) => {
    await d.execute('DROP TABLE IF EXISTS side_log', undefined);
    await d.execute('CREATE TABLE side_log (i int)', undefined);
    await d.execute('CREATE OR REPLACE FUNCTION log_it(v int) RETURNS int LANGUAGE sql AS $$ INSERT INTO side_log VALUES (v) RETURNING v $$', undefined);
    try {
      const r = await d.execute('SELECT log_it(i) FROM generate_series(1, 5000) i', undefined, 1000);
      assert.equal(r.rows.length, 1000);
      assert.equal(r.stopped, true, 'cursor closed');
      const logged = Number((await d.execute('SELECT count(*) FROM side_log', undefined)).rows[0][0]);
      assert.ok(logged >= 1000 && logged < 5000, `only the rows read were logged (${logged})`);
      assert.equal((await d.execute('SELECT log_it(1)', undefined, 1000)).stopped, undefined, 'a statement that ran to the end');
    } finally {
      await d.execute('DROP FUNCTION log_it', undefined);
      await d.execute('DROP TABLE side_log', undefined);
    }
  });
});

test('postgres: TLS checks the certificate name, not the host pg dials', { skip }, async () => {
  // The server certificate is self-signed for db.internal (scripts/integration.sh); pg dials PG_HOST.
  const tryConnect = async (extra: object) => {
    const d = createDriver('postgres', { ...endpoint('postgres'), ssl: true, ...extra }) as SqlDriver;
    await d.connect();
    try {
      return (await d.execute('SELECT 1', undefined)).rows;
    } finally {
      await d.close();
    }
  };
  await assert.rejects(tryConnect({ sslVerify: true }), /self[- ]signed|unable to verify|certificate/i, 'unknown CA');
  await assert.rejects(tryConnect({ sslVerify: true, sslCaPath: env.PG_CA }), /altnames|does not match|Hostname/i, 'host name not in the certificate');
  assert.deepEqual(await tryConnect({ sslVerify: true, sslCaPath: env.PG_CA, sslServerName: 'db.internal' }), [[1]]);
  assert.deepEqual(await tryConnect({ sslVerify: false }), [[1]], 'opt-out still connects');
});

test('postgres: databases, schemas, structure, per-database manual transactions', { skip }, async () => {
  await withDriver('postgres', undefined, async (d) => {
    const existing = await d.execute("SELECT 1 FROM pg_database WHERE datname = 'analytics'", undefined);
    if (!existing.rows.length) await d.execute('CREATE DATABASE analytics', undefined);
    await d.execute('DROP SCHEMA IF EXISTS sales CASCADE', undefined);
    await d.execute('DROP TABLE IF EXISTS public.customers CASCADE', undefined);
    await d.execute('CREATE SCHEMA sales', undefined);
    await d.execute("CREATE TABLE public.customers (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz DEFAULT now())", undefined);
    await d.execute("COMMENT ON COLUMN public.customers.email IS 'login'", undefined);
    await d.execute(
      'CREATE TABLE sales.orders (id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE, total numeric(10,2), meta jsonb)',
      undefined,
    );
    await d.execute('CREATE INDEX idx_total ON sales.orders (total DESC)', undefined);
    await d.execute('CREATE VIEW sales.big AS SELECT * FROM sales.orders WHERE total > 100', undefined);
    await d.execute('DROP TABLE IF EXISTS events', 'analytics');
    await d.execute('CREATE TABLE events (id int PRIMARY KEY, at timestamp)', 'analytics');

    const dbs = await d.listDatabases(false);
    assert.ok(dbs.includes('analytics') && dbs.includes('postgres'));

    const tables = await d.listTables('postgres');
    assert.deepEqual(tables.map((t) => `${t.schema}.${t.name}:${t.type}`), ['public.customers:table', 'sales.big:view', 'sales.orders:table']);
    assert.deepEqual((await d.listTables('analytics')).map((t) => t.name), ['events']);

    const s = await d.describeTable({ database: 'postgres', schema: 'sales', name: 'orders', type: 'table' });
    assert.deepEqual(s.columns.map((c) => `${c.name} ${c.type}`), ['id bigint', 'customer_id integer', 'total numeric(10,2)', 'meta jsonb']);
    assert.equal(s.columns[0].key, 'PRI');
    assert.deepEqual(s.indexes.map((i) => `${i.name}:${i.columns.join(',')}`), ['orders_pkey:id', 'idx_total:total']);
    assert.equal(s.foreignKeys[0].refTable, 'customers');
    assert.equal(s.foreignKeys[0].onDelete, 'CASCADE');
    assert.match(s.ddl, /CREATE TABLE "sales"\."orders"/);
    assert.match(s.ddl, /CREATE INDEX idx_total/);
    const c = await d.describeTable({ database: 'postgres', schema: 'public', name: 'customers', type: 'table' });
    assert.equal(c.columns[0].extra, 'identity always');
    assert.equal(c.columns[1].key, 'UNI');
    assert.equal(c.columns[1].comment, 'login');
    const v = await d.describeTable({ database: 'postgres', schema: 'sales', name: 'big', type: 'view' });
    assert.match(v.ddl, /^CREATE VIEW "sales"\."big" AS/);

    await d.execute("INSERT INTO customers (email) VALUES ('a@x.io')", undefined);
    await d.execute(`INSERT INTO sales.orders (customer_id, total, meta) VALUES (1, 150.5, '{"k":1}')`, undefined);
    const r = await d.execute('SELECT total, meta, created_at IS NOT NULL FROM sales.orders JOIN customers c ON c.id = customer_id', undefined);
    assert.deepEqual(r.rows, [['150.50', '{"k":1}', true]]);
    const bin = await d.execute(`SELECT decode('deadbeef', 'hex'), uuid_send('${UUID}'::uuid)`, undefined);
    assert.deepEqual(bin.rows[0][0], { b: 'deadbeef', n: 4 });
    assert.equal(format(bin.rows[0][1], 'uuid'), UUID);
    await d.execute("INSERT INTO events VALUES (1, '2026-01-02 03:04:05')", 'analytics');
    assert.deepEqual((await d.execute('SELECT at FROM events', 'analytics')).rows, [['2026-01-02 03:04:05.000']]);

    await withDriver('postgres', undefined, async (other) => {
      await d.setTxMode('manual');
      await d.execute('SELECT count(*) FROM customers', undefined);
      assert.equal(d.pendingTransaction, false, 'a read is not pending');
      await d.execute("INSERT INTO customers (email) VALUES ('tx@x.io')", undefined);
      await d.execute('INSERT INTO events VALUES (2, now())', 'analytics');
      assert.equal(d.pendingTransaction, true);
      assert.deepEqual((await other.execute("SELECT count(*)::int FROM customers WHERE email = 'tx@x.io'", undefined)).rows, [[0]]);
      await d.rollback();
      assert.equal(d.pendingTransaction, false);
      assert.deepEqual((await d.execute('SELECT count(*)::int FROM events', 'analytics')).rows, [[1]], 'rollback reached the second database');

      // A failed statement aborts the PostgreSQL transaction: it must stay pending.
      await d.execute("INSERT INTO customers (email) VALUES ('ok@x.io')", undefined);
      await assert.rejects(d.execute('SELECT * FROM missing_table', undefined));
      assert.equal(d.pendingTransaction, true);
      await assert.rejects(d.execute('SELECT 1', undefined), /aborted/);
      await d.rollback();
      assert.deepEqual((await d.execute('SELECT 1', undefined)).rows, [[1]]);

      await d.execute("INSERT INTO customers (email) VALUES ('tx2@x.io')", undefined);
      await d.commit();
      assert.deepEqual((await other.execute("SELECT count(*)::int FROM customers WHERE email = 'tx2@x.io'", undefined)).rows, [[1]]);
      await d.setTxMode('auto');
    });

    const started = Date.now();
    const running = d.execute('SELECT pg_sleep(20)', undefined);
    await new Promise((res) => setTimeout(res, 400));
    await d.cancel();
    await assert.rejects(running, /cancel/i);
    assert.ok(Date.now() - started < 5000);
  });
});

test('postgres: DDL of a manual transaction is listed once committed', { skip }, async () => {
  await withDriver('postgres', undefined, async (d) => {
    await d.execute('DROP TABLE IF EXISTS tx_ddl', undefined);
    const listed = async () => (await d.listTables('postgres')).some((t) => t.name === 'tx_ddl');
    await d.setTxMode('manual');
    await d.execute('CREATE TABLE tx_ddl (i int)', undefined);
    assert.equal(await listed(), false, 'the metadata connection does not see uncommitted DDL');
    await d.rollback();
    assert.equal(await listed(), false, 'so a rollback leaves the listing right');
    await d.execute('CREATE TABLE tx_ddl (i int)', undefined);
    await d.commit();
    assert.equal(await listed(), true, 'a commit changes it: the tree lists again');
    await d.setTxMode('auto');
    await d.execute('DROP TABLE tx_ddl', undefined);
  });
});

test('postgres: idle sessions close unless they hold a transaction or state, and reopen on demand', { skip }, async () => {
  const { PostgresDriver, SESSION_IDLE_MS } = await import('../drivers/postgres');
  const d = new PostgresDriver(endpoint('postgres'));
  await d.connect();
  try {
    await d.execute('SELECT 1', 'postgres');
    await d.execute('SELECT 1', 'analytics');
    await d.execute("SET application_name = 'kept'", 'analytics');
    const later = Date.now() + SESSION_IDLE_MS + 1000;
    assert.deepEqual(await d.closeIdleSessions(Date.now()), [], 'nothing idle yet');
    assert.deepEqual(await d.closeIdleSessions(later), ['postgres'], 'the SET keeps analytics open');
    assert.deepEqual((await d.execute('SELECT 2', 'postgres')).rows, [[2]], 'reopened lazily');
    assert.deepEqual((await d.execute('SHOW application_name', 'analytics')).rows, [['kept']]);
    await d.setTxMode('manual');
    await d.execute('SELECT 3', 'postgres');
    assert.deepEqual(await d.closeIdleSessions(Date.now() + SESSION_IDLE_MS + 1000), [], 'open transaction kept');
    await d.rollback();
  } finally {
    await d.close();
  }
});

test('postgres: an idle session holding a lock or a temp table is kept', { skip }, async () => {
  const { PostgresDriver, SESSION_IDLE_MS } = await import('../drivers/postgres');
  const d = new PostgresDriver(endpoint('postgres'));
  await d.connect();
  try {
    await d.execute('SELECT pg_try_advisory_lock(42)', 'postgres');
    await d.execute('SELECT 1 AS i INTO TEMP kept', 'analytics');
    assert.deepEqual(await d.closeIdleSessions(Date.now() + SESSION_IDLE_MS + 1000), [], 'the lock and the temp table keep their sessions');
    await withDriver('postgres', undefined, async (other) => {
      assert.deepEqual((await other.execute('SELECT pg_try_advisory_lock(42)', undefined)).rows, [[false]], 'lock still held');
    });
    assert.deepEqual((await d.execute('SELECT i FROM kept', 'analytics')).rows, [[1]]);
  } finally {
    await d.close();
  }
});

test('ssh: a changed host key refused by the prompt stops the tunnel', { skip }, async () => {
  const cfg = { enabled: true, host: env.SSH_HOST!, port: 22, username: 'tunnel', auth: 'password' as const, hostFingerprint: 'SHA256:not-the-real-key' };
  const asked: (string | undefined)[] = [];
  await assert.rejects(
    SshTunnel.open(cfg, { sshPassword: env.SSH_PASSWORD }, env.MYSQL_HOST!, 3306, async (_fp, expected) => {
      asked.push(expected);
      return false;
    }),
  );
  assert.deepEqual(asked, ['SHA256:not-the-real-key'], 'asked with the pinned key');
});

test('ssh: tunnel with host key pinning to MySQL', { skip }, async () => {
  const cfg = { enabled: true, host: env.SSH_HOST!, port: 22, username: 'tunnel', auth: 'password' as const };
  const secrets = { sshPassword: env.SSH_PASSWORD };
  const seen: (string | undefined)[] = [];

  const tunnel = await SshTunnel.open(cfg, secrets, env.MYSQL_HOST!, 3306, async (fp, expected) => {
    seen.push(expected);
    return true;
  });
  assert.match(tunnel.fingerprint, /^SHA256:/);
  assert.deepEqual(seen, [undefined], 'unknown key asked once');
  const baseline = listeningTcpPorts();
  const d = createDriver('mysql', { ...endpoint('mysql', 'shop'), stream: () => tunnel.connect() }) as SqlDriver;
  await d.connect();
  assert.ok((await d.listDatabases(false)).includes('shop'));
  assert.deepEqual((await d.execute('SELECT 40 + 2', 'shop')).rows, [[42]]);
  assert.deepEqual(listeningTcpPorts(), baseline, 'no local port opened for the tunnel');
  await d.close();

  // TLS inside the SSH channel, checked against the real server name.
  const { X509Certificate } = await import('crypto');
  const { readFileSync } = await import('fs');
  const cn = /CN=([^\n,]+)/.exec(new X509Certificate(readFileSync(env.MYSQL_CA!, 'utf8')).subject)![1].replace('_CA_', '_Server_');
  const tlsOver = createDriver('mysql', { ...endpoint('mysql', 'shop'), ssl: true, sslVerify: true, sslCaPath: env.MYSQL_CA, sslServerName: cn, stream: () => tunnel.connect() }) as SqlDriver;
  await tlsOver.connect();
  assert.deepEqual((await tlsOver.execute("SHOW SESSION STATUS LIKE 'Ssl_version'", 'shop')).rows[0][1] !== '', true, 'encrypted');
  await tlsOver.close();

  const pg = createDriver('postgres', { ...endpoint('postgres'), stream: () => pgTunnel.connect() }) as SqlDriver;
  const pgTunnel = await SshTunnel.open({ ...cfg, hostFingerprint: tunnel.fingerprint }, secrets, env.PG_HOST!, 5432, async () => false);
  await pg.connect();
  assert.deepEqual((await pg.execute('SELECT 40 + 2 AS n', undefined)).rows, [[42]]);
  assert.deepEqual((await pg.execute('SELECT 1', 'analytics')).rows, [[1]], 'a second database opens a second channel');
  assert.deepEqual(listeningTcpPorts(), baseline);
  await pg.close();
  pgTunnel.close();
  tunnel.close();

  // Known key: no prompt.
  const again = await SshTunnel.open({ ...cfg, hostFingerprint: tunnel.fingerprint }, secrets, env.MYSQL_HOST!, 3306, async () => {
    throw new Error('should not ask');
  });
  again.close();

  // Changed key: asked with the expected value, refusal aborts the connection.
  const expectedSeen: (string | undefined)[] = [];
  await assert.rejects(
    SshTunnel.open({ ...cfg, hostFingerprint: 'SHA256:not-the-real-one' }, secrets, env.MYSQL_HOST!, 3306, async (_fp, expected) => {
      expectedSeen.push(expected);
      return false;
    }),
  );
  assert.deepEqual(expectedSeen, ['SHA256:not-the-real-one']);

  await assert.rejects(SshTunnel.open(cfg, { sshPassword: 'wrong' }, env.MYSQL_HOST!, 3306, async () => true), /authentication/i);
});
