(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || {};
  const state = {
    tab: saved.tab || 'data',
    where: saved.where || '',
    orderBy: saved.orderBy || '',
    limit: saved.limit || 100,
    offset: saved.offset || 0,
    binaryModes: saved.binaryModes || {},
    /** Unsaved edits, by row key (JSON): { key, changes: { column: text | null } }. Kept across pages and reloads. */
    edits: saved.edits || {},
  };
  let binaryDefault = 'auto';
  let maxCell;
  let sortStyle = 'sql';
  let jsonView = !!saved.jsonView;
  let lastData = null;
  let structureLoaded = false;
  let txPending = false;
  /** { editable, key, columns } or { editable: false, reason }, from the extension; null until then. */
  let editInfo = null;
  /** Grid of the current page ({ refresh }) and the cell selected in it. */
  let grid = null;
  let selectedCell = null;
  let saving = false;

  const where = $('where');
  const orderBy = $('orderBy');
  const limit = $('limit');

  function persist() {
    vscode.setState(state);
  }

  function showTab(tab) {
    state.tab = tab;
    persist();
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('dataPane').classList.toggle('hidden', tab !== 'data');
    $('structurePane').classList.toggle('hidden', tab !== 'structure');
    if (tab === 'structure' && !structureLoaded) {
      structureLoaded = true;
      $('structure').innerHTML = '<div class="message">Loading…</div>';
      vscode.postMessage({ type: 'structure' });
    }
  }

  function load(resetOffset) {
    state.where = where.value.trim();
    state.orderBy = orderBy.value.trim();
    state.limit = Number(limit.value);
    if (resetOffset) state.offset = 0;
    persist();
    request();
  }

  /** Asks for the page `state` describes: the filter and sort last applied, not what is being typed. */
  function request() {
    $('dataError').classList.add('hidden');
    $('apply').disabled = true;
    $('info').textContent = 'Loading…';
    vscode.postMessage({ type: 'load', where: state.where, orderBy: state.orderBy, limit: state.limit, offset: state.offset });
  }

  /** Header click cycles ASC → DESC → none on that single column. */
  function sortBy(column, quoted) {
    const current = parseSort();
    const asc = current && current.column === column ? current.dir !== 'ASC' : true;
    const clear = current && current.column === column && current.dir === 'DESC';
    if (clear) orderBy.value = '';
    else if (sortStyle === 'mongo') orderBy.value = `{ ${quoted}: ${asc ? 1 : -1} }`;
    else orderBy.value = `${quoted} ${asc ? 'ASC' : 'DESC'}`;
    load(true);
  }

  function parseSort() {
    if (!lastData) return null;
    const m =
      sortStyle === 'mongo'
        ? /^\s*\{\s*(.+?)\s*:\s*(-?1)\s*\}\s*$/.exec(state.orderBy)
        : /^\s*(.+?)\s+(ASC|DESC)\s*$/i.exec(state.orderBy);
    if (!m) return null;
    const key = m[1].replace(/^(['"])(.*)\1$/, '$2');
    const column = lastData.columns.find((c) => lastData.quoted[c] === m[1] || c === m[1] || c === key);
    const dir = sortStyle === 'mongo' ? (m[2] === '1' ? 'ASC' : 'DESC') : m[2].toUpperCase();
    return column ? { column, dir } : null;
  }

  /** Positions of the key columns in the page, or null when the page cannot be edited. */
  function keyIndexes(columns) {
    if (!editInfo || !editInfo.editable) return null;
    const idx = editInfo.key.map((k) => columns.indexOf(k));
    return idx.every((i) => i >= 0) ? idx : null;
  }

  const rowId = (keys, row) => JSON.stringify(keys.map((i) => row[i]));

  /** Same as what was read: the change is dropped rather than saved. */
  const sameAsRead = (read, text) => (read === null ? text === null : text !== null && String(read) === text);

  /** The grid's editing callbacks for the page `msg`, or undefined when it is read-only. */
  function editOptions(msg) {
    const keys = keyIndexes(msg.columns);
    if (!keys || msg.documents) return undefined;
    const columnInfo = (c) => editInfo.columns[msg.columns[c]];
    return {
      can: (r, c) => !saving && !!(columnInfo(c) && columnInfo(c).editable) && !SqlBinary.isBinary(msg.rows[r][c]),
      value: (r, c) => {
        const e = state.edits[rowId(keys, msg.rows[r])];
        const column = msg.columns[c];
        return e && Object.prototype.hasOwnProperty.call(e.changes, column) ? { value: e.changes[column] } : undefined;
      },
      // Bound to this page: a page that arrives while a cell is being edited is another set of rows.
      onChange: (r, c, text) => setCell(msg, r, c, text),
    };
  }

  /** Records `text` (or null, or undefined to undo) as the new value of a cell of the page `data`. */
  function setCell(data, r, c, text) {
    const keys = keyIndexes(data.columns);
    const row = data.rows[r];
    const id = rowId(keys, row);
    const column = data.columns[c];
    const entry = state.edits[id] || { key: keys.map((i) => row[i]), changes: {} };
    if (text === undefined || sameAsRead(row[c], text)) delete entry.changes[column];
    else entry.changes[column] = text;
    if (Object.keys(entry.changes).length) state.edits[id] = entry;
    else delete state.edits[id];
    persist();
    updateEditBar();
  }

  function updateEditBar() {
    const entries = Object.values(state.edits);
    const cells = entries.reduce((n, e) => n + Object.keys(e.changes).length, 0);
    $('editbar').classList.toggle('hidden', cells === 0);
    $('editCount').textContent = `${cells} unsaved change${cells === 1 ? '' : 's'} in ${entries.length} row${entries.length === 1 ? '' : 's'}`;
    $('saveEdits').disabled = saving;
    $('discardEdits').disabled = saving;
    $('saveEdits').textContent = saving ? 'Saving…' : 'Save';
    updateCellButtons();
  }

  /** Set NULL / Revert cell act on the selected cell of the current page. */
  function updateCellButtons() {
    const opts = lastData && editOptions(lastData);
    $('setNull').classList.toggle('hidden', !opts);
    $('revertCell').classList.toggle('hidden', !opts);
    if (!opts) return;
    const at = selectedCell && selectedCell.data === lastData ? selectedCell : null;
    const column = at && editInfo.columns[lastData.columns[at.c]];
    $('setNull').disabled = !at || !opts.can(at.r, at.c) || !column.nullable;
    $('revertCell').disabled = !at || saving || !opts.value(at.r, at.c);
  }

  function updateEditHint() {
    const hint = $('editHint');
    if (!editInfo || (lastData && lastData.documents)) hint.textContent = '';
    else if (!editInfo.editable) hint.textContent = `Read-only: ${editInfo.reason}`;
    else if (lastData && !keyIndexes(lastData.columns)) hint.textContent = 'Read-only: the key columns are not in the page';
    else hint.textContent = 'Double-click a cell (or Enter) to edit it';
  }

  function renderData(msg) {
    // An open cell editor belongs to the page being replaced: its text goes to that page's row.
    const open = document.querySelector('textarea.cell-editor');
    if (open) open.blur();
    if (msg.documents && !msg.rows.length) msg.rows = SqlMongoRows.rowsFromDocuments(msg.columns, msg.documents);
    lastData = msg;
    $('apply').disabled = false;
    const from = msg.rows.length ? state.offset + 1 : 0;
    const to = state.offset + msg.rows.length;
    $('info').textContent = `Rows ${from}–${to}${msg.hasMore ? '' : ' (end)'} · ${msg.durationMs} ms`;
    $('sql').textContent = msg.text;
    $('sql').title = msg.text;
    $('prev').disabled = state.offset === 0;
    $('next').disabled = !msg.hasMore;
    $('viewMode').classList.toggle('hidden', !msg.documents);
    $('viewMode').textContent = jsonView ? 'Grid' : 'JSON';
    if (msg.documents && jsonView) {
      const pre = document.createElement('pre');
      pre.className = 'ddl json';
      pre.textContent = msg.documents.map((d) => JSON.stringify(d, null, 2)).join('\n');
      $('grid').replaceChildren(pre);
      return;
    }
    selectedCell = null;
    updateEditHint();
    grid = SqlGrid.render($('grid'), msg.columns, msg.rows, {
      offset: state.offset,
      sort: parseSort(),
      onSort: (c) => sortBy(c, msg.quoted[c] || c),
      onCopy: (text) => vscode.postMessage({ type: 'copy', text }),
      binaryModes: state.binaryModes,
      binaryDefault,
      maxCell,
      // Formatting is client-side: re-render the current page, no query.
      onBinaryMode: (column, mode) => {
        state.binaryModes[column] = mode;
        persist();
        renderData(lastData);
      },
      edit: editOptions(msg),
      onSelect: (r, c) => {
        selectedCell = { data: msg, r, c };
        updateCellButtons();
      },
    });
    updateEditBar();
  }

  function cellTable(headers, rows) {
    const t = document.createElement('table');
    t.className = 'grid';
    const h = t.createTHead().insertRow();
    headers.forEach((x) => {
      const th = document.createElement('th');
      th.textContent = x;
      h.appendChild(th);
    });
    const b = t.createTBody();
    rows.forEach((r) => {
      const tr = b.insertRow();
      r.forEach((v) => {
        const td = tr.insertCell();
        if (v === null) td.innerHTML = '<span class="null">NULL</span>';
        else td.textContent = String(v);
      });
    });
    return t;
  }

  function section(title, node) {
    const s = document.createElement('div');
    s.className = 'section';
    const h = document.createElement('h3');
    h.textContent = title;
    s.append(h, node);
    return s;
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** { sections: [{ title, headers, rows }], code?: { title, text, language } } */
  function renderStructure(st) {
    const root = $('structure');
    root.replaceChildren();
    st.sections.forEach((sec) => root.append(section(sec.title, cellTable(sec.headers, sec.rows))));
    if (st.code) {
      const pre = document.createElement('pre');
      pre.className = 'ddl';
      pre.textContent = st.code.text;
      const actions = document.createElement('div');
      actions.className = 'actions spaced';
      actions.append(
        button(`Copy ${st.code.title}`, () => vscode.postMessage({ type: 'copy', text: st.code.text })),
        button('Open in editor', () => vscode.postMessage({ type: 'openSql', text: st.code.text, language: st.code.language })),
      );
      const wrap = document.createElement('div');
      wrap.append(actions, pre);
      root.append(section(st.code.title, wrap));
    }
  }

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('apply').addEventListener('click', () => load(true));
  $('refresh').addEventListener('click', () => load(false));
  [where, orderBy].forEach((el) => el.addEventListener('keydown', (e) => e.key === 'Enter' && load(true)));
  limit.addEventListener('change', () => load(true));
  $('prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    load(false);
  });
  $('next').addEventListener('click', () => {
    state.offset += state.limit;
    load(false);
  });
  $('count').addEventListener('click', () => {
    $('countValue').textContent = 'counting…';
    vscode.postMessage({ type: 'count', where: where.value.trim() });
  });
  $('openQuery').addEventListener('click', () => lastData && vscode.postMessage({ type: 'openSql', text: lastData.text + (sortStyle === 'sql' ? ';' : '') }));
  $('viewMode').addEventListener('click', () => {
    jsonView = !jsonView;
    state.jsonView = jsonView;
    persist();
    if (lastData) renderData(lastData);
  });
  $('setNull').addEventListener('click', () => {
    if (!selectedCell) return;
    if (selectedCell.data !== lastData) return;
    setCell(selectedCell.data, selectedCell.r, selectedCell.c, null);
    grid.refresh(selectedCell.r);
  });
  $('revertCell').addEventListener('click', () => {
    if (!selectedCell) return;
    if (selectedCell.data !== lastData) return;
    setCell(selectedCell.data, selectedCell.r, selectedCell.c, undefined);
    grid.refresh(selectedCell.r);
  });
  $('saveEdits').addEventListener('click', () => {
    const edits = Object.values(state.edits);
    if (!edits.length || saving) return;
    saving = true;
    $('dataError').classList.add('hidden');
    updateEditBar();
    vscode.postMessage({ type: 'save', edits });
  });
  $('discardEdits').addEventListener('click', () => {
    state.edits = {};
    persist();
    updateEditBar();
    if (grid) grid.refresh();
  });
  $('refreshStructure').addEventListener('click', () => {
    structureLoaded = false;
    showTab('structure');
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        if (!saved.limit) state.limit = msg.pageSize;
        binaryDefault = msg.binaryDisplay || 'auto';
        maxCell = msg.maxCellChars;
        sortStyle = msg.sortStyle || 'sql';
        if (msg.labels) {
          $('whereLabel').textContent = msg.labels.where;
          $('orderLabel').textContent = msg.labels.orderBy;
          where.placeholder = msg.labels.wherePlaceholder;
          orderBy.placeholder = msg.labels.orderPlaceholder;
          $('count').title = `Count with the current ${msg.labels.where}`;
        }
        if (msg.tab) state.tab = msg.tab;
        where.value = state.where;
        orderBy.value = state.orderBy;
        if (![...limit.options].some((o) => Number(o.value) === state.limit)) limit.add(new Option(String(state.limit), String(state.limit)));
        limit.value = String(state.limit);
        showTab(state.tab);
        load(false);
        break;
      case 'showTab':
        showTab(msg.tab);
        break;
      case 'data':
        renderData(msg);
        break;
      case 'dataError':
        $('apply').disabled = false;
        $('info').textContent = '';
        $('dataError').textContent = msg.message;
        $('dataError').classList.remove('hidden');
        break;
      case 'editing':
        editInfo = msg;
        // Edits kept from an earlier page load, for a table that turned read-only, cannot be saved.
        if (!msg.editable) state.edits = {};
        persist();
        if (lastData) renderData(lastData);
        else updateEditBar();
        break;
      case 'saved':
        saving = false;
        state.edits = {};
        persist();
        updateEditBar();
        request();
        break;
      case 'saveError':
        saving = false;
        updateEditBar();
        $('dataError').textContent = `Nothing was saved. ${msg.message}`;
        $('dataError').classList.remove('hidden');
        break;
      case 'count':
        $('countValue').textContent = msg.error ? `error: ${msg.error}` : `${Number(msg.value).toLocaleString()} rows`;
        break;
      case 'structure':
        renderStructure(msg.structure);
        break;
      case 'tx': {
        // The transaction ended (commit or rollback): rows read through it may be gone.
        const ended = txPending && !msg.pending;
        txPending = msg.pending;
        SqlTxBar.update($('txbar'), msg, (type) => vscode.postMessage({ type }));
        // Ended by a disconnect (or a lost connection): reading again would reconnect.
        if (ended && msg.connected) {
          // A count made before the end may include rows rolled back.
          $('countValue').textContent = '';
          request();
        }
        break;
      }
      case 'structureError':
        $('structure').innerHTML = '';
        const box = document.createElement('div');
        box.className = 'error-box';
        box.textContent = msg.message;
        $('structure').append(box);
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
