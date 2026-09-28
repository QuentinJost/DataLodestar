(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mongodb: 27017, redis: 6379 };
  const HINTS = {
    mysql: '',
    postgres: '',
    mongodb: 'Manual transactions need a replica set or a sharded cluster. User is optional.',
    redis: 'User is optional (ACL). Redis has no commit/rollback: MULTI in the editor, then Commit = EXEC, Rollback = DISCARD.',
  };
  let editing = false;
  let hasSecrets = false;

  function syncVisibility() {
    const kind = $('kind').value;
    const ssh = $('sshEnabled').checked;
    $('uriRow').classList.toggle('hidden', kind !== 'mongodb');
    $('authSourceRow').classList.toggle('hidden', kind !== 'mongodb');
    $('txRow').classList.toggle('hidden', kind === 'redis');
    $('showSystemRow').classList.toggle('hidden', kind === 'redis');
    $('databaseLabel').textContent = kind === 'redis' ? 'Database index' : 'Default database';
    $('database').placeholder = kind === 'redis' ? '0' : 'optional';
    $('user').required = kind === 'mysql' || kind === 'postgres';
    const byUri = kind === 'mongodb' && $('uri').value.trim() !== '';
    ['host', 'port', 'user'].forEach((id) => {
      $(id).required = !byUri && (id !== 'user' || $('user').required);
      $(id).disabled = byUri;
    });
    $('kindHint').textContent = HINTS[kind];
    $('sshFields').classList.toggle('hidden', !ssh);
    const auth = $('sshAuth').value;
    $('sshPasswordRow').classList.toggle('hidden', auth !== 'password');
    $('sshKeyRow').classList.toggle('hidden', auth !== 'privateKey');
    $('sshPassphraseRow').classList.toggle('hidden', auth !== 'privateKey');
    $('hostHint').textContent = ssh ? 'Host as seen from the SSH server (often 127.0.0.1).' : '';
    const save = $('savePassword').checked;
    document.querySelectorAll('.secret').forEach((el) => {
      el.placeholder = !save ? 'not saved: used by Test, asked at each connection' : editing && hasSecrets ? '(unchanged)' : '';
    });
  }

  function fill(c) {
    $('name').value = c.name || '';
    $('kind').value = c.kind || 'mysql';
    $('host').value = c.host || '127.0.0.1';
    $('port').value = c.port || DEFAULT_PORTS[$('kind').value];
    $('user').value = c.user || '';
    $('database').value = c.database || '';
    $('uri').value = c.uri || '';
    $('authSource').value = c.authSource || '';
    $('ssl').checked = !!c.ssl;
    $('txMode').value = c.txMode || 'auto';
    $('savePassword').checked = c.savePassword !== false;
    $('showSystem').checked = !!c.showSystemDatabases;
    const s = c.ssh || {};
    $('sshEnabled').checked = !!s.enabled;
    $('sshHost').value = s.host || '';
    $('sshPort').value = s.port || 22;
    $('sshUser').value = s.username || '';
    $('sshAuth').value = s.auth || 'privateKey';
    $('sshKey').value = s.privateKeyPath || '';
    $('fingerprint').textContent = s.hostFingerprint ? `Trusted host key: ${s.hostFingerprint}` : '';
    syncVisibility();
  }

  /** Empty secret fields mean "keep the stored one" when editing. */
  const secret = (id) => {
    const v = $(id).value;
    return v === '' && editing && hasSecrets ? null : v;
  };

  function collect() {
    return {
      config: {
        name: $('name').value.trim(),
        kind: $('kind').value,
        host: $('host').value.trim(),
        port: Number($('port').value),
        user: $('user').value.trim(),
        database: $('database').value.trim() || undefined,
        uri: $('kind').value === 'mongodb' ? $('uri').value.trim() || undefined : undefined,
        authSource: $('kind').value === 'mongodb' ? $('authSource').value.trim() || undefined : undefined,
        ssl: $('ssl').checked,
        txMode: $('kind').value === 'redis' ? 'auto' : $('txMode').value,
        savePassword: $('savePassword').checked,
        showSystemDatabases: $('showSystem').checked,
        ssh: {
          enabled: $('sshEnabled').checked,
          host: $('sshHost').value.trim(),
          port: Number($('sshPort').value) || 22,
          username: $('sshUser').value.trim(),
          auth: $('sshAuth').value,
          privateKeyPath: $('sshKey').value.trim() || undefined,
        },
      },
      secrets: { password: secret('password'), sshPassword: secret('sshPassword'), sshPassphrase: secret('sshPassphrase') },
    };
  }

  function result(text, ok) {
    const el = $('result');
    el.textContent = text;
    el.className = ok ? 'result-ok' : 'result-err';
  }

  $('kind').addEventListener('change', () => {
    const port = Number($('port').value);
    if (!port || Object.values(DEFAULT_PORTS).includes(port)) $('port').value = DEFAULT_PORTS[$('kind').value];
    syncVisibility();
  });
  $('uri').addEventListener('input', syncVisibility);
  ['sshEnabled', 'sshAuth', 'savePassword'].forEach((id) => $(id).addEventListener('change', syncVisibility));
  $('browseKey').addEventListener('click', () => vscode.postMessage({ type: 'browseKey' }));
  $('test').addEventListener('click', () => {
    if (!form.reportValidity()) return;
    result('Testing…', true);
    vscode.postMessage({ type: 'test', ...collect() });
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    vscode.postMessage({ type: 'save', ...collect() });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
      editing = !!msg.editing;
      hasSecrets = !!msg.hasSecrets;
      fill(msg.config || {});
    } else if (msg.type === 'keyPath') {
      $('sshKey').value = msg.path;
    } else if (msg.type === 'testResult') {
      result(msg.message, msg.ok);
    } else if (msg.type === 'uri') {
      $('uri').value = msg.value;
    } else if (msg.type === 'fingerprint') {
      $('fingerprint').textContent = `Trusted host key: ${msg.value}`;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
