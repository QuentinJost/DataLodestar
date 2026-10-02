// Shared result grid for the results and table webviews.
(function () {
  const SqlBinary = typeof window !== 'undefined' ? window.SqlBinary : require('./binaryFormat.js');
  /** Characters shown in a cell; its tooltip holds up to TITLE_FACTOR times more. */
  const MAX_CELL = 500;
  const TITLE_FACTOR = 8;

  /** Text of a cell as shown, copied and exported; `mode` applies to binary cells. */
  function display(value, mode) {
    if (value === null) return 'NULL';
    return SqlBinary.isBinary(value) ? SqlBinary.format(value, mode) : String(value);
  }

  function formatCell(td, value, mode, maxCell, oneLine) {
    if (value === null) {
      td.innerHTML = '<span class="null">NULL</span>';
      return;
    }
    let text = display(value, mode);
    if (SqlBinary.isBinary(value)) td.classList.add('bin');
    if (oneLine) text = text.replace(/\r?\n/g, '↵');
    td.textContent = text.length > maxCell ? text.slice(0, maxCell) + '…' : text;
    if (typeof value === 'number') td.classList.add('num');
  }

  /** Results above this many rows (about one screen) only draw the rows in view (plus BUFFER above and below). */
  const VIRTUAL_MIN_ROWS = 50;
  const BUFFER = 10;
  /** Extra rows, spread over a long result, drawn once to size its columns. */
  const SAMPLE_ROWS = 12;

  /**
   * opts.offset   first row number - 1
   * opts.sort     { column, dir } to draw an arrow
   * opts.onSort   (column) => void; makes headers clickable
   * opts.onCopy   (text) => void; called on cell double-click
   * opts.binaryModes    { column: mode } chosen by the user
   * opts.binaryDefault  mode for columns not in binaryModes ("auto" by default)
   * opts.onBinaryMode   (column, mode) => void; shows a format picker on binary columns
   * opts.maxCell        characters shown per cell (dataLodestar.maxCellChars)
   */
  function render(container, columns, rows, opts) {
    opts = opts || {};
    if (container.__gridCleanup) container.__gridCleanup();
    const modes = columnModes(columns, rows, opts);
    const maxCell = opts.maxCell > 0 ? opts.maxCell : MAX_CELL;
    const virtual = rows.length > VIRTUAL_MIN_ROWS;
    const offset = opts.offset || 0;
    let selected = null;

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

    const drawRow = (r) => {
      const tr = document.createElement('tr');
      tr.dataset.r = String(r);
      const num = tr.insertCell();
      num.className = 'rownum';
      num.textContent = String(offset + r + 1);
      rows[r].forEach((value, c) => formatCell(tr.insertCell(), value, modes[c], maxCell, virtual));
      if (selected && selected.r === r) tr.cells[selected.c + 1].classList.add('selected');
      return tr;
    };
    /** Row and column of a data cell, or null for the row number and spacers. */
    const cellAt = (target) => {
      const td = target.closest('td');
      const tr = td && td.parentElement;
      if (!td || !tr || tr.dataset.r === undefined || td.cellIndex === 0) return null;
      return { td, r: Number(tr.dataset.r), c: td.cellIndex - 1 };
    };

    body.addEventListener('click', (e) => {
      const at = cellAt(e.target);
      if (!at) return;
      table.querySelectorAll('td.selected').forEach((x) => x.classList.remove('selected'));
      at.td.classList.add('selected');
      selected = { r: at.r, c: at.c };
    });
    // One tooltip at a time, built on hover, instead of a long `title` on every cell.
    body.addEventListener('mouseover', (e) => {
      const at = cellAt(e.target);
      if (!at || at.td.title) return;
      const v = rows[at.r][at.c];
      if (v === null) return;
      const text = display(v, modes[at.c]);
      const maxTitle = maxCell * TITLE_FACTOR;
      if (text.length > 40 || text.includes('\n')) at.td.title = text.length > maxTitle ? text.slice(0, maxTitle) + '…' : text;
    });
    if (opts.onCopy) {
      body.addEventListener('dblclick', (e) => {
        const at = cellAt(e.target);
        if (at) opts.onCopy(display(rows[at.r][at.c], modes[at.c]));
      });
    }

    if (!virtual) {
      rows.forEach((_, r) => body.appendChild(drawRow(r)));
      container.replaceChildren(table);
      return;
    }
    container.replaceChildren(table);
    const scroller = container.closest('.scroll') || container;
    if (!scroller.clientHeight) {
      // Drawn while hidden (another tab): nothing can be measured yet, so draw again once shown.
      const observer = new ResizeObserver(() => {
        if (!scroller.clientHeight) return;
        observer.disconnect();
        render(container, columns, rows, opts);
      });
      observer.observe(scroller);
      container.__gridCleanup = () => {
        observer.disconnect();
        container.__gridCleanup = undefined;
      };
      return;
    }
    virtualise(container, table, body, rows.length, columns.length + 1, drawRow);
  }

  /**
   * Keeps only the rows in view in the DOM. Columns are sized once on a sample so they
   * do not jump while scrolling; rows are one line each, so they share one height.
   */
  function virtualise(container, table, body, count, width, drawRow) {
    const scroller = container.closest('.scroll') || container;
    // Size the columns on the first screen plus a spread sample, then fix them.
    const firstScreen = Math.min(count, Math.ceil(scroller.clientHeight / 16) + BUFFER);
    const spread = [];
    for (let i = 1; i <= SAMPLE_ROWS; i++) spread.push(Math.floor((i * (count - 1)) / SAMPLE_ROWS));
    for (let r = 0; r < firstScreen; r++) body.appendChild(drawRow(r));
    const sampled = spread.filter((r) => r >= firstScreen).map((r) => body.appendChild(drawRow(r)));
    const widths = [...table.tHead.rows[0].cells].map((th) => th.getBoundingClientRect().width);
    const rowHeight = body.rows[0].getBoundingClientRect().height || 20;
    sampled.forEach((tr) => tr.remove());
    const colgroup = document.createElement('colgroup');
    widths.forEach((w) => {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      colgroup.appendChild(col);
    });
    table.insertBefore(colgroup, table.firstChild);
    table.style.tableLayout = 'fixed';
    table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';

    const spacer = () => {
      const tr = document.createElement('tr');
      tr.className = 'spacer';
      tr.insertCell().colSpan = width;
      return tr;
    };
    const top = spacer();
    const bottom = spacer();
    body.insertBefore(top, body.firstChild);
    body.appendChild(bottom);
    // Rows [first, last) are in the DOM between the two spacers.
    let first = 0;
    let last = firstScreen;
    const tableTop = () => table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + table.tHead.getBoundingClientRect().height;
    let headOffset = tableTop();

    const update = () => {
      const visible = Math.ceil(scroller.clientHeight / rowHeight);
      const f = Math.max(0, Math.min(count - visible, Math.floor((scroller.scrollTop - headOffset) / rowHeight)) - BUFFER);
      const l = Math.min(count, Math.max(0, f) + visible + 2 * BUFFER);
      const nf = Math.max(0, f);
      if (nf === first && l === last) return;
      if (nf >= last || l <= first) {
        // No overlap: redraw the window.
        while (top.nextSibling !== bottom) top.nextSibling.remove();
        const fragment = document.createDocumentFragment();
        for (let r = nf; r < l; r++) fragment.appendChild(drawRow(r));
        body.insertBefore(fragment, bottom);
      } else {
        // Overlap: only rows entering or leaving the window change.
        for (let r = first; r < nf; r++) top.nextSibling.remove();
        for (let r = last; r > l; r--) bottom.previousSibling.remove();
        const before = document.createDocumentFragment();
        for (let r = nf; r < first; r++) before.appendChild(drawRow(r));
        body.insertBefore(before, top.nextSibling);
        const after = document.createDocumentFragment();
        for (let r = Math.max(last, nf); r < l; r++) after.appendChild(drawRow(r));
        body.insertBefore(after, bottom);
      }
      first = nf;
      last = l;
      top.firstChild.style.height = first * rowHeight + 'px';
      bottom.firstChild.style.height = (count - last) * rowHeight + 'px';
    };
    let frame = 0;
    const onScroll = () => {
      // The grid was replaced (JSON view, error): stop following the scroller.
      if (!table.isConnected) return container.__gridCleanup && container.__gridCleanup();
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), update()));
    };
    const onResize = () => {
      headOffset = tableTop();
      onScroll();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    container.__gridCleanup = () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
      container.__gridCleanup = undefined;
    };
    top.firstChild.style.height = '0px';
    bottom.firstChild.style.height = (count - last) * rowHeight + 'px';
    update();
  }

  /** Per rows array: which columns hold binary values, and whether all of them are 16 bytes. */
  const binaryInfo = new WeakMap();

  function binaryColumns(columns, rows) {
    let info = binaryInfo.get(rows);
    if (!info) {
      info = columns.map((_, c) => {
        let binary = false;
        let all16 = true;
        for (const row of rows) {
          const v = row[c];
          if (!SqlBinary.isBinary(v)) continue;
          binary = true;
          if (v.n !== 16) all16 = false;
        }
        return { binary, all16 };
      });
      binaryInfo.set(rows, info);
    }
    return info;
  }

  /** Resolved display mode per column index; undefined for non-binary columns. Scanned once per result. */
  function columnModes(columns, rows, opts) {
    return binaryColumns(columns, rows).map((info, c) => {
      if (!info.binary) return undefined;
      const chosen = (opts.binaryModes && opts.binaryModes[columns[c]]) || opts.binaryDefault || 'auto';
      return chosen !== 'auto' ? chosen : info.all16 ? 'uuid' : 'hex';
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
