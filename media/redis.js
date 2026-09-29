(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || {};
  /** Past this many keys, "Load more" stops: the pattern should be narrowed instead. */
  const MAX_KEYS = 10000;
  let cursor = '0';
  let keys = [];
  let selected = saved.selected || null;
  let binaryDefault = 'auto';
  let maxCell;
  const binaryModes = {};

  const quoteArg = (k) => (/^[^\s"'\\]+$/.test(k) ? k : '"' + k.replace(/[\\"]/g, (c) => '\\' + c).replace(/\n/g, '\\n') + '"');

  function ttlText(ms) {
    if (ms === -1) return 'no expiry';
    if (ms < 0) return 'expired';
    const s = Math.round(ms / 1000);
    if (s < 120) return `${s}s`;
    if (s < 7200) return `${Math.round(s / 60)}min`;
    if (s < 172800) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  function scan(reset) {
    if (reset) cursor = '0';
    $('scanError').classList.add('hidden');
    $('scan').disabled = true;
    $('info').textContent = 'Scanning…';
    vscode.setState({ ...vscode.getState(), pattern: $('pattern').value, keyType: $('type').value, selected });
    vscode.postMessage({ type: 'scan', pattern: $('pattern').value.trim() || '*', keyType: $('type').value, cursor });
  }

  function keyRow(body, k) {
    const tr = body.insertRow();
    tr.className = 'clickable' + (k.key === selected ? ' current' : '');
    tr.dataset.key = k.key;
    [k.key, k.type, ttlText(k.ttl)].forEach((v) => (tr.insertCell().textContent = v));
    tr.title = k.key;
  }

  /** Rebuilds the list; `added` only appends those rows to the one drawn. */
  function drawKeys(added) {
    const body = $('keys').querySelector('tbody');
    if (added && body) {
      added.forEach((k) => keyRow(body, k));
      return;
    }
    const t = document.createElement('table');
    t.className = 'grid keylist';
    const h = t.createTHead().insertRow();
    ['Key', 'Type', 'TTL'].forEach((x) => {
      const th = document.createElement('th');
      th.textContent = x;
      h.appendChild(th);
    });
    const tbody = t.createTBody();
    keys.forEach((k) => keyRow(tbody, k));
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.key !== undefined) select(tr.dataset.key);
    });
    $('keys').replaceChildren(t);
    if (!keys.length) $('keys').innerHTML = '<div class="message">No key matches.</div>';
  }

  /** Moves the highlight without redrawing the list. */
  function markSelected() {
    $('keys').querySelectorAll('tr.current').forEach((tr) => tr.classList.remove('current'));
    $('keys').querySelectorAll('tr[data-key]').forEach((tr) => tr.dataset.key === selected && tr.classList.add('current'));
  }

  function select(key) {
    selected = key;
    vscode.setState({ ...vscode.getState(), selected });
    markSelected();
    $('detailError').classList.add('hidden');
    $('detail').innerHTML = '<div class="message">Loading…</div>';
    vscode.postMessage({ type: 'value', key });
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function drawValue(v) {
    const head = $('detailHead');
    head.classList.remove('hidden');
    head.replaceChildren();
    const name = document.createElement('code');
    name.textContent = v.key;
    const meta = document.createElement('span');
    const unit = v.type === 'string' ? 'bytes' : 'elements';
    meta.textContent = `${v.type} · ${v.length.toLocaleString()} ${unit} · TTL ${ttlText(v.ttl)}`;
    head.append(
      name,
      meta,
      button('Copy key', () => vscode.postMessage({ type: 'copy', text: v.key })),
      button('Refresh', () => select(v.key)),
    );
    if (v.truncated) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = `Showing the first ${v.rows.length} of ${v.length}.`;
      head.append(w);
    }

    const detail = $('detail');
    if (v.columns) {
      SqlGrid.render(detail, v.columns, v.rows, {
        binaryModes,
        binaryDefault,
        maxCell,
        onBinaryMode: (c, m) => {
          binaryModes[c] = m;
          drawValue(v);
        },
        onCopy: (text) => vscode.postMessage({ type: 'copy', text }),
      });
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'ddl';
    let text = v.text === null ? 'NULL' : SqlBinary.isBinary(v.text) ? SqlBinary.format(v.text, SqlBinary.resolve(binaryDefault, [v.text])) : String(v.text);
    try {
      if (/^\s*[[{]/.test(text)) text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON: show as is
    }
    pre.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'actions section';
    actions.append(button('Copy value', () => vscode.postMessage({ type: 'copy', text })));
    detail.replaceChildren(actions, pre);
  }

  $('scan').addEventListener('click', () => scan(true));
  $('more').addEventListener('click', () => scan(false));
  $('pattern').addEventListener('keydown', (e) => e.key === 'Enter' && scan(true));
  $('type').addEventListener('change', () => scan(true));
  $('query').addEventListener('click', () => vscode.postMessage({ type: 'openSql', text: selected ? `TYPE ${quoteArg(selected)}\n` : '' }));

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        binaryDefault = msg.binaryDisplay || 'auto';
        maxCell = msg.maxCellChars;
        if (saved.pattern) $('pattern').value = saved.pattern;
        if (saved.keyType) $('type').value = saved.keyType;
        scan(true);
        if (selected) select(selected);
        break;
      case 'keys':
        if (msg.append) {
          const added = msg.keys.slice(0, MAX_KEYS - keys.length);
          for (const k of added) keys.push(k);
          drawKeys(added);
        } else {
          keys = msg.keys.slice(0, MAX_KEYS);
          drawKeys();
        }
        cursor = msg.cursor;
        const capped = keys.length >= MAX_KEYS && cursor !== '0';
        $('scan').disabled = false;
        $('more').disabled = cursor === '0' || capped;
        $('info').textContent =
          `${keys.length.toLocaleString()} key(s)` +
          (cursor === '0' ? ' — scan complete' : capped ? ` — list capped at ${MAX_KEYS.toLocaleString()}: refine the MATCH pattern` : ' — more available') +
          ` · ${msg.durationMs} ms`;
        break;
      case 'scanError':
        $('scan').disabled = false;
        $('info').textContent = '';
        $('scanError').textContent = msg.message;
        $('scanError').classList.remove('hidden');
        break;
      case 'value':
        drawValue(msg.value);
        break;
      case 'valueError':
        $('detail').replaceChildren();
        $('detailError').textContent = msg.message;
        $('detailError').classList.remove('hidden');
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
