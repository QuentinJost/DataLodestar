import { CellValue, TableRef, TableStructure } from './types';

/** How the table viewer may edit a table: the columns naming a row and what each column accepts. */
export interface EditInfo {
  key: string[];
  columns: Record<string, { editable: boolean; nullable: boolean }>;
}

export type Editability = ({ editable: true } & EditInfo) | { editable: false; reason: string };

/** One row as the webview sends it: its key as read, and the new text (or NULL) per changed column. */
export interface RowEdit {
  key: CellValue[];
  changes: Record<string, string | null>;
}

/** One UPDATE, values still unbound: `set` the changed columns `where` the key matches. */
export interface RowUpdate {
  set: [string, string | null][];
  where: [string, unknown][];
}

/** Raw bytes are shown, never edited: a value typed as text would not round-trip. */
const BINARY_TYPE = /^((tiny|medium|long)?blob|(var)?binary|bit|bytea)\b/i;
/** Computed by the server: MySQL "VIRTUAL GENERATED" / "STORED GENERATED", PostgreSQL ones (see describeTable). */
const COMPUTED = /\b(virtual|stored) generated\b|^generated stored$|^identity always$/i;

/** A row is named by the primary key, else by the shortest unique index over NOT NULL columns. */
export function editability(ref: TableRef, st: TableStructure): Editability {
  if (ref.type === 'view') return { editable: false, reason: 'views are read-only' };
  const byName = new Map(st.columns.map((c) => [c.name, c]));
  const usable = (cols: string[]) => cols.length > 0 && cols.every((c) => byName.has(c) && !byName.get(c)!.nullable);
  const key =
    st.indexes.find((i) => i.primary && usable(i.columns)) ??
    st.indexes.filter((i) => i.unique && usable(i.columns)).sort((a, b) => a.columns.length - b.columns.length)[0];
  if (!key) return { editable: false, reason: 'no primary key or unique NOT NULL index to find the rows by' };
  const columns: EditInfo['columns'] = {};
  for (const c of st.columns) columns[c.name] = { editable: !BINARY_TYPE.test(c.type) && !COMPUTED.test(c.extra), nullable: c.nullable };
  return { editable: true, key: key.columns, columns };
}

/** Thrown for the `index`-th row of a save; nothing of the save was kept. */
export class RowEditError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message);
  }
}

/** A key value as read back into what the driver binds: binary cells become bytes again. */
function keyValue(v: unknown, column: string, index: number): unknown {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v && typeof v === 'object' && typeof (v as { b?: unknown }).b === 'string' && typeof (v as { n?: unknown }).n === 'number') {
    const { b, n } = v as { b: string; n: number };
    // Cells carry at most BINARY_LIMIT bytes: a cut key would match nothing, or worse.
    if (b.length !== n * 2 || !/^[0-9a-f]*$/i.test(b)) throw new RowEditError(index, `The key column ${column} is too long to find the row by.`);
    return Buffer.from(b, 'hex');
  }
  throw new RowEditError(index, `The key column ${column} has no value to find the row by.`);
}

/** Checks what the webview sent against the table and turns it into one update per row. */
export function toUpdates(info: EditInfo, edits: unknown): RowUpdate[] {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('Nothing to save.');
  return edits.map((edit, i) => {
    const { key, changes } = (edit ?? {}) as Partial<RowEdit>;
    if (!Array.isArray(key) || key.length !== info.key.length) throw new RowEditError(i, 'The row was read with another key: refresh the page.');
    const set = Object.entries(changes ?? {});
    if (set.length === 0) throw new RowEditError(i, 'The row has no change.');
    for (const [column, value] of set) {
      if (!info.columns[column]?.editable) throw new RowEditError(i, `The column ${column} cannot be edited.`);
      if (value !== null && typeof value !== 'string') throw new RowEditError(i, `The new value of ${column} is not text.`);
    }
    return { set, where: info.key.map((column, k) => [column, keyValue(key[k], column, i)] as [string, unknown]) };
  });
}

/** `UPDATE t SET a = ?, b = ? WHERE k = ?` with the engine's quoting and placeholders. */
export function updateStatement(
  table: string,
  update: RowUpdate,
  quoteIdent: (name: string) => string,
  placeholder: (n: number) => string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown) => (params.push(v), placeholder(params.length));
  const set = update.set.map(([c, v]) => `${quoteIdent(c)} = ${bind(v)}`).join(', ');
  const where = update.where.map(([c, v]) => `${quoteIdent(c)} = ${bind(v)}`).join(' AND ');
  return { sql: `UPDATE ${table} SET ${set} WHERE ${where}`, params };
}

/** "id = 12, lang = 'fr'": the row as the user knows it, for messages. */
export function describeKey(update: RowUpdate): string {
  return update.where
    .map(([c, v]) => `${c} = ${Buffer.isBuffer(v) ? `0x${v.toString('hex')}` : typeof v === 'string' ? `'${v}'` : String(v)}`)
    .join(', ');
}

/**
 * Runs `updates` one by one through `run` (which returns the rows matched). Every update must match
 * exactly one row: otherwise, or on a server error, it throws a RowEditError naming that row. The
 * caller undoes what ran before (savepoint or transaction).
 */
export async function applyUpdates(
  updates: RowUpdate[],
  statement: (u: RowUpdate) => { sql: string; params: unknown[] },
  run: (sql: string, params: unknown[]) => Promise<number>,
): Promise<void> {
  for (const [i, u] of updates.entries()) {
    const { sql, params } = statement(u);
    let matched: number;
    try {
      matched = await run(sql, params);
    } catch (err) {
      throw new RowEditError(i, `Row ${describeKey(u)}: ${(err as Error).message}`);
    }
    if (matched !== 1) {
      throw new RowEditError(i, `Row ${describeKey(u)}: ${matched === 0 ? 'no row has this key any more (changed or deleted since it was read)' : `${matched} rows have this key`}.`);
    }
  }
}
