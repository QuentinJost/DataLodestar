import { DbKind } from './types';

export interface Statement {
  text: string;
  /** Offset of the first non-blank character of the statement. */
  start: number;
  /** Offset right after the last character, delimiter excluded. */
  end: number;
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const DELIMITER_CMD = /^DELIMITER[ \t]+(\S+)[^\n]*(\n|$)/i;

/**
 * Splits a script into statements, ignoring delimiters inside strings, quoted
 * identifiers, comments and PostgreSQL dollar-quoted bodies. Honours the MySQL
 * client `DELIMITER` command so procedure bodies survive.
 */
export function splitSql(sql: string, dialect: DbKind): Statement[] {
  const out: Statement[] = [];
  const n = sql.length;
  let delimiter = ';';
  let start = 0;
  let hasCode = false;
  let i = 0;

  const flush = (end: number, next: number) => {
    if (hasCode) {
      let s = start;
      while (s < end && /\s/.test(sql[s])) s++;
      let e = end;
      while (e > s && /\s/.test(sql[e - 1])) e--;
      out.push({ text: sql.slice(s, e), start: s, end: e });
    }
    start = next;
    hasCode = false;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (dialect === 'mysql' && !hasCode && (c === 'D' || c === 'd')) {
      const m = DELIMITER_CMD.exec(sql.slice(i));
      if (m) {
        delimiter = m[1];
        i += m[0].length;
        start = i;
        continue;
      }
    }

    if (c === '-' && next === '-' && (dialect === 'postgres' || i + 2 >= n || /\s/.test(sql[i + 2]))) {
      i = skipTo(sql, i, '\n');
      continue;
    }
    if (c === '#' && dialect === 'mysql') {
      i = skipTo(sql, i, '\n');
      continue;
    }
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    if (sql.startsWith(delimiter, i)) {
      flush(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }

    if (!/\s/.test(c)) hasCode = true;

    if (c === "'" || c === '"' || (c === '`' && dialect === 'mysql')) {
      const backslash = dialect === 'mysql' ? c !== '`' : c === "'" && /[eE]/.test(sql[i - 1] ?? '');
      i = skipQuoted(sql, i, c, backslash);
      continue;
    }
    if (c === '$' && dialect === 'postgres') {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
        continue;
      }
    }
    i++;
  }
  flush(n, n);
  return out;
}

/**
 * Guard for text spliced into a generated query (the viewer's WHERE / ORDER BY):
 * PostgreSQL's simple protocol would run a second statement smuggled after ";".
 */
export function assertSingleStatement(sql: string, dialect: DbKind): void {
  if (splitSql(sql, dialect).length > 1) throw new Error('Only one condition is allowed here: remove the ";". Run other statements from a query editor.');
}

/** Statement under the cursor: the last one starting at or before it. */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  let found: Statement | undefined;
  for (const s of statements) {
    if (s.start <= offset) found = s;
    else break;
  }
  return found ?? statements[0];
}

function skipTo(sql: string, i: number, ch: string): number {
  const idx = sql.indexOf(ch, i);
  return idx < 0 ? sql.length : idx + 1;
}

function skipQuoted(sql: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslash && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return j;
}
