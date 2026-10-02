// Grid cells of MongoDB documents, built from their relaxed Extended JSON. Shared by the
// driver (tests, host side) and the webviews, which receive the documents only.
(function (root) {
  /** Bytes kept per binary cell, as in src/drivers/driver.ts BINARY_LIMIT. */
  const BINARY_LIMIT = 4096;
  /** Characters kept for an object or array shown in one cell. */
  const MAX_CELL_JSON = 2000;

  /** First `limit` bytes of base64 as hex, plus the full length, without decoding the rest. */
  function binaryCell(base64, limit) {
    const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const n = (base64.length / 4) * 3 - pad;
    const head = atob(base64.slice(0, Math.ceil(limit / 3) * 4));
    let hex = '';
    for (let i = 0; i < Math.min(head.length, limit); i++) hex += head.charCodeAt(i).toString(16).padStart(2, '0');
    return { b: hex, n };
  }

  /** One cell: scalars as they are, BSON wrappers readable, anything else as capped JSON. */
  function cell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object') return v;
    if (!Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        const x = v[keys[0]];
        switch (keys[0]) {
          case '$oid':
            return `ObjectId('${x}')`;
          case '$date': {
            const d = new Date(typeof x === 'string' ? x : Number(x.$numberLong));
            return isNaN(d.getTime()) ? 'Invalid Date' : d.toISOString();
          }
          case '$numberDecimal':
            return x;
          case '$numberLong': {
            const n = Number(x);
            return Number.isSafeInteger(n) ? n : x;
          }
          case '$numberDouble':
          case '$numberInt':
            return Number(x);
          case '$binary':
            return binaryCell(x.base64, BINARY_LIMIT);
        }
      }
    }
    const json = JSON.stringify(v);
    return json.length > MAX_CELL_JSON ? json.slice(0, MAX_CELL_JSON) + '…' : json;
  }

  function rowsFromDocuments(columns, documents) {
    return documents.map((doc) => columns.map((c) => cell(doc[c])));
  }

  const api = { rowsFromDocuments, cell };
  root.SqlMongoRows = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
