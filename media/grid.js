// Shared result grid for the results and table webviews.
(function () {
  const SqlBinary = typeof window !== 'undefined' ? window.SqlBinary : require('./binaryFormat.js');
  const MAX_CELL = 500;

  /** Text of a cell as shown, copied and exported; `mode` applies to binary cells. */
  function display(value, mode) {
    if (value === null) return 'NULL';
    return SqlBinary.isBinary(value) ? SqlBinary.format(value, mode) : String(value);
  }

  function formatCell(td, value, mode) {
    if (value === null) {
      td.innerHTML = '<span class="null">NULL</span>';
      return;
    }
    const text = display(value, mode);
    if (SqlBinary.isBinary(value)) td.classList.add('bin');
    td.textContent = text.length > MAX_CELL ? text.slice(0, MAX_CELL) + '…' : text;
    if (text.length > 40 || text.includes('\n')) td.title = text.length > 4000 ? text.slice(0, 4000) + '…' : text;
    if (typeof value === 'number') td.classList.add('num');
  }

  /**
   * opts.offset   first row number - 1
   * opts.sort     { column, dir } to draw an arrow
   * opts.onSort   (column) => void; makes headers clickable
   * opts.onCopy   (text) => void; called on cell double-click
   * opts.binaryModes    { column: mode } chosen by the user
   * opts.binaryDefault  mode for columns not in binaryModes ("auto" by default)
   * opts.onBinaryMode   (column, mode) => void; shows a format picker on binary columns
   */
  function render(container, columns, rows, opts) {
    opts = opts || {};
    const modes = columnModes(columns, rows, opts);
    const table = document.createElement('table');
    table.className = 'grid';
    const head = table.createTHead().insertRow();
    const hash = document.createElement('th');
    hash.className = 'rownum';
    hash.textContent = '#';
    head.appendChild(hash);
    columns.forEach((name, c) => {
      const th = document.createElement('th');
      let label = name;
      if (opts.sort && opts.sort.column === name) label += opts.sort.dir === 'DESC' ? ' ▼' : ' ▲';
      th.textContent = label;
      if (opts.onSort) {
        th.classList.add('sortable');
        th.title = 'Click to sort';
        th.addEventListener('click', () => opts.onSort(name));
      }
      if (modes[c] && opts.onBinaryMode) th.appendChild(modePicker(name, modes[c], opts.onBinaryMode));
      head.appendChild(th);
    });
    const body = table.createTBody();
    const offset = opts.offset || 0;
    rows.forEach((row, r) => {
      const tr = body.insertRow();
      const num = tr.insertCell();
      num.className = 'rownum';
      num.textContent = String(offset + r + 1);
      row.forEach((value, c) => {
        const td = tr.insertCell();
        formatCell(td, value, modes[c]);
        td.dataset.r = String(r);
        td.dataset.c = String(c);
      });
    });
    body.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td || td.classList.contains('rownum')) return;
      table.querySelectorAll('td.selected').forEach((x) => x.classList.remove('selected'));
      td.classList.add('selected');
    });
    if (opts.onCopy) {
      body.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td');
        if (!td || td.dataset.r === undefined) return;
        const v = rows[Number(td.dataset.r)][Number(td.dataset.c)];
        opts.onCopy(display(v, modes[Number(td.dataset.c)]));
      });
    }
    container.replaceChildren(table);
  }

  /** Resolved display mode per column index; undefined for non-binary columns. */
  function columnModes(columns, rows, opts) {
    return columns.map((name, c) => {
      const cells = rows.map((r) => r[c]);
      if (!cells.some(SqlBinary.isBinary)) return undefined;
      const chosen = (opts.binaryModes && opts.binaryModes[name]) || opts.binaryDefault || 'auto';
      return SqlBinary.resolve(chosen, cells);
    });
  }

  function modePicker(column, current, onChange) {
    const select = document.createElement('select');
    select.className = 'binfmt';
    select.title = 'Display binary values as…';
    SqlBinary.MODES.forEach(([value, label]) => select.add(new Option(label, value, false, value === current)));
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => onChange(column, select.value));
    return select;
  }

  /** Starts a spreadsheet formula (CSV injection) unless the text is just a number such as -1. */
  const FORMULA_START = /^[=+\-@\t\r]/;
  const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

  /** One CSV field; with `escapeFormulas`, a formula-like text is quoted and prefixed with '. */
  function csvField(s, escapeFormulas) {
    if (escapeFormulas && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) return '"\'' + s.replace(/"/g, '""') + '"';
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** opts.escapeFormulas (default true) neutralises cells a spreadsheet would run. */
  function toCsv(columns, rows, opts) {
    opts = opts || {};
    const escapeFormulas = opts.escapeFormulas !== false;
    const modes = columnModes(columns, rows, opts);
    const esc = (v, c) => (v === null ? '' : csvField(display(v, modes[c]), escapeFormulas));
    return [columns.map((name) => csvField(name, escapeFormulas)).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  }

  const api = { render, toCsv, csvField };
  if (typeof window !== 'undefined') window.SqlGrid = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
