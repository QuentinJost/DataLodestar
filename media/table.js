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
  };
  let binaryDefault = 'auto';
  let maxCell;
  let sortStyle = 'sql';
  let jsonView = !!saved.jsonView;
  let lastData = null;
  let structureLoaded = false;

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

  function renderData(msg) {
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
    SqlGrid.render($('grid'), msg.columns, msg.rows, {
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
    });
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
      case 'count':
        $('countValue').textContent = msg.error ? `error: ${msg.error}` : `${Number(msg.value).toLocaleString()} rows`;
        break;
      case 'structure':
        renderStructure(msg.structure);
        break;
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
