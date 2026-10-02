# DataLodestar

Graphical database client for **VS Code** and **VSCodium**, for **MySQL / MariaDB**, **PostgreSQL**,
**MongoDB** and **Redis**.

- Browse every database of a host, its tables and views (or collections, or keys), and their columns
- Inspect a table's structure: columns, indexes, foreign keys, DDL
- Browse table data with a **WHERE** and an **ORDER BY** field, paging and on-demand row count
- Show binary columns as **UUID**, hex, text or Base64
- Write and run queries from any `.sql` editor, with results in a side panel
- Connect directly or through an **SSH tunnel** (password, private key or agent)
- Choose per host between **auto-commit** and **manual transactions** (commit / rollback)

## Install

```bash
npm install
npm run package                                   # builds datalodestar-<version>.vsix (Node ≥ 22)
code   --install-extension datalodestar-0.4.0.vsix
codium --install-extension datalodestar-0.4.0.vsix
```

## Usage

1. Open the **DataLodestar** view in the activity bar and click **+** to add a connection.
   **Test connection** checks the settings (and the SSH tunnel) before saving.
2. Expand a connection to connect; expand a database to see its tables and views.
3. Click a table to open its data. Type a condition in **WHERE** (`status = 'active' AND id > 100`)
   and/or **ORDER BY** (`created_at DESC`), then press Enter. Clicking a column header cycles
   ASC → DESC → unsorted. **Count rows** runs a `COUNT(*)` with the current WHERE.
   The **Structure** tab shows columns, indexes, foreign keys and the DDL.
4. **New Query** (on a connection, database or table) opens a SQL editor bound to that
   connection and database. The status bar shows the binding; click it to change it.

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Run the selection, or the statement under the cursor |
| `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` | Run the whole script |

Scripts are split on `;` while ignoring strings, comments and PostgreSQL `$$` bodies; the MySQL
`DELIMITER` command is supported. Each statement gets a tab in the results panel. Double-click a
cell to copy it; **Copy as CSV** copies the whole result. The running query can be cancelled from
the progress notification (`KILL QUERY` / `pg_cancel_backend`).

## MongoDB

- The tree lists databases, then **Collections** and **Views**; expanding a collection shows its
  fields, inferred from a random sample of 200 documents (types and share of documents holding them).
- Clicking a collection opens the viewer with **FILTER** and **SORT** instead of WHERE and ORDER BY.
  Both take shell object syntax: `{ status: 'active', createdAt: { $gte: ISODate('2026-01-01') } }`,
  `{ createdAt: -1 }`, `{ _id: ObjectId('…') }`. Clicking a header sorts on that field. **JSON**
  switches the grid to the documents as Extended JSON. The Structure tab shows the sampled fields,
  the indexes and the collection options (validator…).
- **New Query** opens a JavaScript editor using **mongosh syntax**, one statement per line or
  separated by `;`:

  ```js
  db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: 1 }).limit(20)
  db.users.aggregate([{ $group: { _id: '$city', n: { $sum: 1 } } }])
  db.users.updateMany({ active: false }, { $set: { archived: true } })
  db.getSiblingDB('crm').contacts.countDocuments({})
  ```

  Supported: `find` (with `sort`, `limit`, `skip`, `project`, `hint`, `count`, `explain`…),
  `findOne`, `aggregate`, `countDocuments`, `estimatedDocumentCount`, `distinct`, `insertOne/Many`,
  `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `bulkWrite`, `findOneAnd…`, index methods,
  `drop`, `renameCollection`, `stats`, and on `db`: `runCommand`, `adminCommand`,
  `getCollectionNames`, `createCollection`, `createView`, `dropDatabase`, `getSiblingDB`,
  `getCollection`. Helpers: `ObjectId`, `ISODate`, `UUID`, `NumberLong`, `NumberInt`,
  `NumberDecimal`, `BinData`, `Timestamp`, `MinKey`, `MaxKey`. Variables work across statements
  (`const since = ISODate('2026-01-01')`). This is a subset of mongosh: results are not JavaScript
  values, so `db.users.findOne().name` does not work.
- The whole script is read before anything runs, so `drop()`, `dropDatabase()` and
  `deleteMany({})` / `updateMany({}, …)` are confirmed first in auto-commit.
- **Connection string** (e.g. `mongodb+srv://user@cluster0.example.net/`) replaces host, port and
  user; the Password field is used when the string has none. It cannot go through SSH. With host and
  port, the client connects directly to that server (works through an SSH tunnel, even to a replica
  set member). **Auth database** defaults to `admin`.

## Redis

- The tree lists the databases holding keys (`db0 · 1,204 keys`); empty ones are grouped apart.
- Clicking a database opens the key browser: **MATCH** pattern (`user:*`) and **TYPE** filter, keys
  loaded 500 at a time with SCAN (never `KEYS`), up to 10,000 (then narrow the pattern), then the
  selected key's type, size, TTL and value:
  text (JSON is pretty-printed), or a grid for hashes, lists, sets, sorted sets (with scores) and
  streams. Binary values follow the binary display formats below.
- **New Query** opens a command editor: one command per line, redis-cli quoting (`"a b"`, `'it\'s'`,
  `"\x00\xff"` for raw bytes), `#` or `//` comments. `SELECT n` switches the editor's database.
  `FLUSHALL`, `FLUSHDB`, `SWAPDB`, `SHUTDOWN` and `CONFIG SET` ask for confirmation.
  `SUBSCRIBE` and `MONITOR` are refused (use redis-cli).
- **User** is optional (ACL user); **Database index** is the db opened first.

## Binary columns

`BINARY`, `VARBINARY`, `BLOB` (MySQL), `bytea` (PostgreSQL), BSON binary (MongoDB) and non-UTF-8
Redis values get a format picker in their
column header, in the data viewer and in query results:

| Format | Shows |
|---|---|
| Hex | `0x11ee4f2a…` |
| UUID | the 16 bytes in standard order: `11ee4f2a-9c3b-6d8e-…` |
| UUID (swapped) | UUIDs stored with MySQL `UUID_TO_BIN(uuid, 1)`, put back in their text order |
| Text (UTF-8) | the bytes decoded as text |
| Base64 | `Ea5PKpw7bY6PGgJCrBIAAg==` |

By default (`dataLodestar.binaryDisplay: auto`) a column whose values are all 16 bytes shows as
UUID, anything else as hex. UUID formats leave values that are not 16 bytes in hex. The choice is
remembered per table and applies to copied cells and CSV. Only display changes, never the data; to
filter by a UUID, write it in WHERE, e.g. `id = UUID_TO_BIN('9c3b6d8e-…', 1)` (MySQL 8) or
`id = decode(replace('9c3b6d8e-…', '-', ''), 'hex')` (PostgreSQL). Values over 4 KB are cut for
display and show their full size.

## Transactions

The mode is a setting of each connection (edit form, context menu or the status bar item) and
is applied live. MongoDB and Redis have their own rules, below.

- **Auto-commit**: every statement is committed immediately. `UPDATE`/`DELETE` without `WHERE`,
  `DROP` and `TRUNCATE` ask for confirmation (`dataLodestar.confirmDestructive`).
- **Manual**: changes wait for **Commit** or **Rollback** (status bar, context menu or
  command palette). After a write the connection turns orange and the status bar reads
  *uncommitted*. Plain reads never raise that flag. Disconnecting, or switching back to auto,
  with uncommitted changes asks whether to commit or roll back first.

Each host uses one dedicated session for your statements and table browsing (so you see
your own uncommitted rows), plus a separate auto-commit session for the tree and structure.

- **MySQL**: a single session hops between databases with `USE`, so a transaction can span
  several databases of the host. A `USE x` typed in a script updates the editor's binding.
- **PostgreSQL** has no cross-database statements: each database gets its own session and
  transaction; Commit / Rollback apply to all of them. After an error, PostgreSQL rejects further
  statements until you roll back; the connection stays marked as pending for that reason.

- **MongoDB**: manual mode uses a multi-document transaction and needs a replica set or a sharded
  cluster (a single-node replica set is enough); it is refused on a standalone server. MongoDB aborts
  a transaction after 60 s by default: the next statement then says so and the changes are gone.
  Index and collection changes (`createIndex`, `drop`…) run outside transactions, so they are refused
  while writes are pending: commit or roll back first.
- **Redis** has no commit/rollback. Type `MULTI` in the editor: the connection turns orange, the
  following commands are queued, then **Commit** sends `EXEC` and **Rollback** sends `DISCARD`.

## SSH tunnels

Set **Host / port** as seen *from the SSH server* (often `127.0.0.1:3306`). The first connection
shows the server's key fingerprint (`SHA256:…`) for you to trust; it is then pinned. A changed
key refuses the connection, with no button to accept it: if the server key really changed, check
the new fingerprint with its administrator, run **Reset Pinned SSH Host Key** (from that message or
on the connection; it asks you to confirm, naming the host), then connect and trust the new key. Private keys default to `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`.
The **SSH agent** option uses `SSH_AUTH_SOCK`.

## Security notes

- Connection settings (host, port, user, database, SSH host and user, private key *path*, pinned
  host key, MongoDB connection string) are kept unencrypted in VS Code's global state.
- Passwords (database, SSH, key passphrase) are stored only in VS Code's SecretStorage, encrypted
  with a key held by the OS keychain (libsecret / KWallet, macOS Keychain, Windows DPAPI), and only if
  **Save passwords** is checked; otherwise they are asked at each connection and kept in memory
  until you disconnect. Private keys are never copied, only read from their path when connecting.
- A password typed inside a MongoDB connection string is moved to the keychain when saving, and the
  string is stored without it. Saving is refused if passwords are not saved for that connection.
  Connections saved by an earlier version are cleaned the same way at startup.
- The viewer's FILTER / SORT are parsed, never run: only object literals, arrays, strings,
  numbers, booleans, `null`, regular expressions and the helpers listed above are accepted (no
  variables, calls to anything else, member access or template literals), so a pasted filter cannot
  run code.
- MongoDB scripts in the query editor are evaluated in-process with Node's `vm`, like mongosh runs
  your code. It is not a sandbox: a script runs with the extension's privileges (files, network,
  processes). Run only scripts you trust.
- **Copy as CSV** quotes a cell starting with `=`, `+`, `-`, `@`, tab or CR and prefixes it with
  `'`, so a spreadsheet does not run it as a formula (plain numbers such as `-1` are kept as they
  are). Set `dataLodestar.csvEscapeFormulas` to `false` for raw output. Double-clicking a cell
  copies it raw.
- A workspace's `.vscode/settings.json` cannot turn off `dataLodestar.confirmDestructive`, and the
  table viewer accepts a single condition in WHERE / ORDER BY (no `;` followed by another statement).
- On Linux without a running keyring, VS Code falls back to a weak "basic" encryption and warns about
  it at startup: install a keyring or leave **Save passwords** unchecked.
- **Use SSL/TLS** verifies the server certificate by default: its chain (against the system CAs, or
  the **CA certificate** file for a private or self-signed CA) and its name (**Certificate name**,
  default the host; set it when the host is an IP or an alias, as is common through an SSH tunnel
  where the host is often `127.0.0.1` as seen from the SSH server). Unchecking **Verify the
  server certificate** encrypts without checking, so an attacker on the path can read the password.
  TLS connections saved before 0.5.0 keep working unchecked and are listed in a warning at startup. A
  MongoDB connection string sets its own TLS options (`tls=true`, `tlsCAFile=…`). When the
  certificate name is not the host (or the host is an IP), MySQL checks it right after the
  handshake rather than during it.
- Through an SSH tunnel, MySQL, PostgreSQL and Redis talk to the server over SSH channels: no port
  is opened on this machine. MongoDB's driver can only dial an address, so it gets a Unix socket in
  a directory only you can open (removed on disconnect); on Windows it is a `127.0.0.1` port, which
  any local process can reach while the connection is open.

## Settings

| Setting | Default | |
|---|---|---|
| `dataLodestar.maxRows` | 1000 | Rows displayed per query result |
| `dataLodestar.csvEscapeFormulas` | true | Copy as CSV neutralises cells a spreadsheet would run as formulas |
| `dataLodestar.pageSize` | 100 | Default page size of the data viewer |
| `dataLodestar.maxCellChars` | 500 | Characters shown per grid cell (tooltip: 8× more) |
| `dataLodestar.binaryDisplay` | auto | Default format of binary columns |
| `dataLodestar.stopOnError` | true | Stop a script at the first failing statement |
| `dataLodestar.confirmDestructive` | true | Confirm destructive statements in auto-commit |

## Limitations

- A query result stops at `maxRows` rows: the rest is not held in memory. A MySQL read-only
  statement is then stopped on the server (`KILL QUERY`); other MySQL statements run to the end,
  their extra rows dropped as they arrive. PostgreSQL reads `SELECT`, `WITH`, `VALUES`, `TABLE`,
  `SHOW` and `EXPLAIN` through a cursor; other statements (such as `INSERT … RETURNING`) and a
  MySQL `CALL` are read whole. The data viewer always pages with `LIMIT`/`OFFSET`.
- A statement stopped at `maxRows` does not run to the end, and its result says so: what it does
  for each row (a function that writes, say) happens only for the rows read on PostgreSQL, and is
  rolled back with the statement on MySQL (InnoDB). A data-modifying PostgreSQL `WITH` still runs
  whole. Raise `maxRows`, or aggregate (`SELECT count(f(id)) FROM t`), to run such a statement whole.
- Cells are read-only; edit data with `UPDATE` statements.
- A result of more than 50 rows draws only the rows in view, one line each (a line break shows as
  `↵`); hover a cell for its full value, double-click to copy it. Column widths are set from the
  first screen and a sample of the rest, so a longer value further down is cut with `…`.
- The tree keeps what it listed (databases, tables, collections, columns) until **Refresh**, a
  disconnect, a `CREATE` / `DROP` / `ALTER` / `RENAME` (or a MongoDB DDL method) run from the
  editor, or the commit or rollback of pending changes. Objects created another way, or Redis key
  counts, show after a **Refresh**.
- For a MySQL `CALL` returning several result sets, only the first is shown.
- PostgreSQL opens one session per database; one left idle for 10 minutes, outside a transaction,
  is closed and reopened on the next statement. A session that ran `SET`, `PREPARE`, `LISTEN`,
  `DECLARE`, `LOAD`, `CREATE TEMP…`, `SELECT … INTO TEMP`, `set_config()` or took an advisory lock
  stays open.
- Redis Cluster and Sentinel are not supported (single server only). Values and query results are
  read-only in the viewers; change data with commands.
- A MongoDB query can be cancelled only if the user may run `$currentOp` / `killOp`.

## Development

```bash
npm install
npm test                         # compile + unit tests (integration tests are skipped)
./scripts/integration.sh         # throwaway MySQL 8.4, PostgreSQL 17, MongoDB 8 (replica set), Redis 7, sshd
```

`integration.sh` needs Docker; set `HOST_DIR` when the daemon sees this folder under another path
(e.g. from inside a container), and `KEEP=1` to reuse the servers between runs.
Press `F5` with the folder open in VS Code to start an Extension Development Host.
