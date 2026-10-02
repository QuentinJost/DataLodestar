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
   * opts.onSelect       (r, c) => void; called when a data cell gets selected
   * opts.edit           in-place editing (table viewer):
   *   can(r, c)          true when the cell may be edited
   *   value(r, c)        { value } when the cell has an unsaved change (text or null), else undefined
   *   onChange(r, c, v)  the cell was edited to `v` (text); the grid then redraws its row
   * Returns { refresh(r?) } to redraw one row, or every row drawn, after a change made outside.
   */
  function render(container, columns, rows, opts) {
    opts = opts || {};
    if (container.__gridCleanup) container.__gridCleanup();
    const modes = columnModes(columns, rows, opts);
    const maxCell = opts.maxCell > 0 ? opts.maxCell : MAX_CELL;
    const virtual = rows.length > VIRTUAL_MIN_ROWS;
    const offset = opts.offset || 0;
    let selected = null;
    const edit = opts.edit;
    /** The value shown in a cell: its unsaved change, if any, else what was read. */
    const shown = (r, c) => {
      const changed = edit && edit.value(r, c);
      return changed ? changed.value : rows[r][c];
    };

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
      rows[r].forEach((_, c) => {
        const td = tr.insertCell();
        formatCell(td, shown(r, c), modes[c], maxCell, virtual);
        if (edit && edit.value(r, c)) td.classList.add('edited');
      });
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

    const select = (at) => {
      table.querySelectorAll('td.selected').forEach((x) => x.classList.remove('selected'));
      at.td.classList.add('selected');
      selected = { r: at.r, c: at.c };
      if (opts.onSelect) opts.onSelect(at.r, at.c);
    };
    /** The drawn cell of a row and column, if its row is in the DOM. */
    const cellOf = (r, c) => {
      const tr = body.querySelector(`tr[data-r="${r}"]`);
      return tr ? tr.cells[c + 1] : null;
    };
    const refresh = (r) => {
      const trs = r === undefined ? [...body.querySelectorAll('tr[data-r]')] : [body.querySelector(`tr[data-r="${r}"]`)];
      trs.filter(Boolean).forEach((tr) => tr.replaceWith(drawRow(Number(tr.dataset.r))));
    };

    body.addEventListener('click', (e) => {
      const at = cellAt(e.target);
      if (at) select(at);
    });
    // One tooltip at a time, built on hover, instead of a long `title` on every cell.
    body.addEventListener('mouseover', (e) => {
      const at = cellAt(e.target);
      if (!at || at.td.title) return;
      const v = shown(at.r, at.c);
      if (v === null) return;
      const text = display(v, modes[at.c]);
      const maxTitle = maxCell * TITLE_FACTOR;
      if (text.length > 40 || text.includes('\n')) at.td.title = text.length > maxTitle ? text.slice(0, maxTitle) + '…' : text;
    });
    const copy = (r, c) => opts.onCopy && opts.onCopy(display(shown(r, c), modes[c]));
    // Double-click edits a cell that can be, and copies any other one.
    body.addEventListener('dblclick', (e) => {
      const at = cellAt(e.target);
      if (!at) return;
      if (edit && edit.can(at.r, at.c)) startEdit(at.r, at.c);
      else copy(at.r, at.c);
    });
    // Focusable, so that the selected cell answers the keyboard.
    table.tabIndex = 0;
    table.addEventListener('keydown', (e) => {
      if (!selected || e.target !== table) return;
      const { r, c } = selected;
      if ((e.key === 'Enter' || e.key === 'F2') && edit && edit.can(r, c)) {
        e.preventDefault();
        startEdit(r, c);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !String(window.getSelection())) {
        e.preventDefault();
        copy(r, c);
      }
    });

    /**
     * A text box over the cell: Enter keeps the text, Shift+Enter starts a new line, Escape
     * cancels; leaving it (click elsewhere, scroll) keeps the text too.
     */
    function startEdit(r, c) {
      const td = cellOf(r, c);
      if (!td) return;
      select({ td, r, c });
      const before = shown(r, c);
      const box = document.createElement('textarea');
      box.className = 'cell-editor';
      box.spellcheck = false;
      box.value = before === null ? '' : String(before);
      if (before === null) box.placeholder = 'NULL';
      const rect = td.getBoundingClientRect();
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = Math.max(rect.width, 200) + 'px';
      box.rows = Math.min(8, Math.max(1, box.value.split('\n').length));
      document.body.appendChild(box);
      box.focus();
      box.select();
      let typed = false;
      let closed = false;
      const scroller = container.closest('.scroll') || container;
      const close = (keep) => {
        if (closed) return;
        closed = true;
        scroller.removeEventListener('scroll', onScroll);
        box.remove();
        // A NULL cell opened and left without typing stays NULL, not ''.
        if (keep && (before === null ? typed : box.value !== String(before))) edit.onChange(r, c, box.value);
        refresh(r);
        if (table.isConnected) table.focus();
      };
      const onScroll = () => close(true);
      box.addEventListener('input', () => (typed = true));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(false);
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          close(true);
        }
      });
      box.addEventListener('blur', () => close(true));
      scroller.addEventListener('scroll', onScroll, { passive: true });
    }

    const handle = { refresh };
    if (!virtual) {
      rows.forEach((_, r) => body.appendChild(drawRow(r)));
      container.replaceChildren(table);
      return handle;
    }
    container.replaceChildren(table);
    const scroller = container.closest('.scroll') || container;
    if (!scroller.clientHeight) {
      // Drawn while hidden (another tab): nothing can be measured yet, so draw again once shown.
      const observer = new ResizeObserver(() => {
        // Replaced meanwhile (another tab, JSON view, error): nothing to draw any more.
        if (!table.isConnected) return observer.disconnect();
        if (!scroller.clientHeight) return;
        observer.disconnect();
        Object.assign(handle, render(container, columns, rows, opts));
      });
      observer.observe(scroller);
      container.__gridCleanup = () => {
        observer.disconnect();
        container.__gridCleanup = undefined;
      };
      return handle;
    }
    virtualise(container, table, body, rows.length, columns.length + 1, drawRow);
    return handle;
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
