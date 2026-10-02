(function () {
  const vscode = acquireVsCodeApi();
  const tabs = document.getElementById('tabs');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  const txbar = document.getElementById('txbar');
  const saved = vscode.getState() || {};
  let items = [];
  let active = 0;
  let binaryDefault = 'auto';
  let escapeFormulas = true;
  let maxCell;
  let jsonView = !!saved.jsonView;
  /** Per column name, kept across runs so a re-run keeps the chosen format. */
  const binaryModes = saved.binaryModes || {};
  /** The page is not retained when hidden: what the user chose survives the reload. */
  const persist = () => vscode.setState({ active, jsonView, binaryModes });
  const gridOpts = () => ({
    binaryModes,
    binaryDefault,
    maxCell,
    onBinaryMode: (column, mode) => {
      binaryModes[column] = mode;
      persist();
      draw();
    },
  });

  const short = (sql) => sql.replace(/\s+/g, ' ').trim();

  function describe(item) {
    if (item.error) return 'Error';
    if (item.columns.length) return `${item.rows.length}${item.truncated ? '+' : ''} rows`;
    return item.affectedRows !== undefined ? `${item.affectedRows} affected` : 'OK';
  }

  /** Tab strip: rebuilt when the results change; a tab click only moves the highlight. */
  function drawTabs() {
    tabs.replaceChildren();
    items.forEach((item, i) => {
      const b = document.createElement('button');
      b.className = 'tab' + (i === active ? ' active' : '') + (item.error ? ' error' : '');
      b.textContent = `${i + 1} · ${describe(item)}`;
      b.title = short(item.sql);
      b.addEventListener('click', () => {
        active = i;
        persist();
        tabs.querySelectorAll('.tab').forEach((t, j) => t.classList.toggle('active', j === i));
        draw();
      });
      tabs.appendChild(b);
    });
    tabs.classList.toggle('hidden', items.length < 2);
  }

  /** Status line and content pane of the active tab. */
  function draw() {
    const item = items[active];
    status.replaceChildren();
    content.replaceChildren();
    if (!item) {
      content.innerHTML = '<div class="message">Run a query to see results here.</div>';
      return;
    }
    const sql = document.createElement('code');
    sql.textContent = short(item.sql).slice(0, 300);
    sql.title = item.sql;
    const meta = document.createElement('span');
    meta.textContent = `${item.connection} · ${describe(item)}` + (item.durationMs !== undefined ? ` · ${item.durationMs} ms` : '');
    status.append(meta);
    if (item.truncated) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = item.stopped
        ? `Stopped after ${item.rows.length} rows (dataLodestar.maxRows): the server did not run the statement to the end.`
        : `Display limited to ${item.rows.length} rows (dataLodestar.maxRows).`;
      status.append(w);
    }
    if (item.documents) {
      const toggle = document.createElement('button');
      toggle.className = 'secondary';
      toggle.textContent = jsonView ? 'Grid' : 'JSON';
      toggle.addEventListener('click', () => {
        jsonView = !jsonView;
        persist();
        draw();
      });
      status.append(toggle);
    }
    if (item.columns.length) {
      const copy = document.createElement('button');
      copy.className = 'secondary';
      copy.textContent = 'Copy as CSV';
      copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: SqlGrid.toCsv(item.columns, item.rows, { ...gridOpts(), escapeFormulas }) }));
      status.append(copy);
    }
    status.append(sql);

    if (item.error) {
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = item.error;
      content.append(box);
    } else if (item.documents && jsonView) {
      const pre = document.createElement('pre');
      pre.className = 'ddl json';
      pre.textContent = item.documents.map((d) => JSON.stringify(d, null, 2)).join('\n');
      content.append(pre);
    } else if (item.columns.length) {
      SqlGrid.render(content, item.columns, item.rows, { ...gridOpts(), onCopy: (text) => vscode.postMessage({ type: 'copy', text }) });
    } else {
      const m = document.createElement('div');
      m.className = 'message';
      m.textContent = item.affectedRows !== undefined ? `Statement executed. ${item.affectedRows} row(s) affected.` : 'Statement executed.';
      content.append(m);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data.type === 'results') {
      items = e.data.items.map((x) => (x.documents && !x.rows.length ? { ...x, rows: SqlMongoRows.rowsFromDocuments(x.columns, x.documents) } : x));
      binaryDefault = e.data.binaryDisplay || 'auto';
      escapeFormulas = e.data.csvEscapeFormulas !== false;
      maxCell = e.data.maxCellChars;
      const firstError = items.findIndex((x) => x.error);
      const lastGrid = items.map((x) => x.columns.length > 0).lastIndexOf(true);
      const restoredTab = e.data.restored && saved.active < items.length ? saved.active : undefined;
      active = restoredTab ?? (firstError >= 0 ? firstError : lastGrid >= 0 ? lastGrid : items.length - 1);
      persist();
      drawTabs();
      draw();
    } else if (e.data.type === 'tx') {
      SqlTxBar.update(txbar, e.data, (type) => vscode.postMessage({ type }));
    }
  });
  draw();
  vscode.postMessage({ type: 'ready' });
})();
