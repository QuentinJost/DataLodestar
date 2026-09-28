(function () {
  const vscode = acquireVsCodeApi();
  const tabs = document.getElementById('tabs');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  let items = [];
  let active = 0;
  let binaryDefault = 'auto';
  let jsonView = false;
  /** Per column name, kept across runs so a re-run keeps the chosen format. */
  const binaryModes = {};
  const gridOpts = () => ({
    binaryModes,
    binaryDefault,
    onBinaryMode: (column, mode) => {
      binaryModes[column] = mode;
      draw();
    },
  });

  const short = (sql) => sql.replace(/\s+/g, ' ').trim();

  function describe(item) {
    if (item.error) return 'Error';
    if (item.columns.length) return `${item.rows.length}${item.truncated ? '+' : ''} rows`;
    return item.affectedRows !== undefined ? `${item.affectedRows} affected` : 'OK';
  }

  function draw() {
    tabs.replaceChildren();
    items.forEach((item, i) => {
      const b = document.createElement('button');
      b.className = 'tab' + (i === active ? ' active' : '') + (item.error ? ' error' : '');
      b.textContent = `${i + 1} · ${describe(item)}`;
      b.title = short(item.sql);
      b.addEventListener('click', () => {
        active = i;
        draw();
      });
      tabs.appendChild(b);
    });
    tabs.classList.toggle('hidden', items.length < 2);

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
      w.textContent = `Display limited to ${item.rows.length} rows (dataLodestar.maxRows).`;
      status.append(w);
    }
    if (item.documents) {
      const toggle = document.createElement('button');
      toggle.className = 'secondary';
      toggle.textContent = jsonView ? 'Grid' : 'JSON';
      toggle.addEventListener('click', () => {
        jsonView = !jsonView;
        draw();
      });
      status.append(toggle);
    }
    if (item.columns.length) {
      const copy = document.createElement('button');
      copy.className = 'secondary';
      copy.textContent = 'Copy as CSV';
      copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: SqlGrid.toCsv(item.columns, item.rows, gridOpts()) }));
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
      items = e.data.items;
      binaryDefault = e.data.binaryDisplay || 'auto';
      const firstError = items.findIndex((x) => x.error);
      const lastGrid = items.map((x) => x.columns.length > 0).lastIndexOf(true);
      active = firstError >= 0 ? firstError : lastGrid >= 0 ? lastGrid : items.length - 1;
      draw();
    }
  });
  draw();
  vscode.postMessage({ type: 'ready' });
})();
