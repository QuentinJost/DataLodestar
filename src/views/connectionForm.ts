import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConnectionStore } from '../connectionStore';
import { connectWith, SessionManager } from '../sessionManager';
import { ConnectionConfig, ConnectionSecrets } from '../types';
import { splitUriPassword } from '../uriCredentials';
import { renderPage } from './webview';

const BODY = `
<form id="form" class="conn" autocomplete="off">
  <fieldset>
    <legend>Connection</legend>
    <div class="row"><label for="name">Name</label><input id="name" type="text" required></div>
    <div class="row"><label for="kind">Engine</label>
      <select id="kind"><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option><option value="mongodb">MongoDB</option><option value="redis">Redis</option></select>
    </div>
    <div class="row" id="uriRow"><label for="uri">Connection string</label><input id="uri" type="text" spellcheck="false" placeholder="optional, e.g. mongodb+srv://user@cluster0.example.net/ — replaces host, port and user; Password is used when the string has none"></div>
    <div class="row"><label for="host">Host / port</label>
      <div class="pair"><input id="host" type="text" required><input id="port" type="number" min="1" max="65535" required></div>
    </div>
    <div class="row"><span></span><span class="hint" id="hostHint"></span></div>
    <div class="row"><label for="user">User</label><input id="user" type="text"></div>
    <div class="row"><label for="password">Password</label><input id="password" class="secret" type="password"></div>
    <div class="row"><label for="database" id="databaseLabel">Default database</label><input id="database" type="text" placeholder="optional"></div>
    <div class="row" id="authSourceRow"><label for="authSource">Auth database</label><input id="authSource" type="text" placeholder="admin"></div>
    <div class="row" id="txRow"><label for="txMode">Transactions</label>
      <select id="txMode"><option value="auto">Auto-commit</option><option value="manual">Manual (commit / rollback)</option></select>
    </div>
    <div class="row inline"><input id="savePassword" type="checkbox"><label for="savePassword">Save passwords in the OS keychain</label></div>
    <div class="row inline" id="sslRow"><input id="ssl" type="checkbox"><label for="ssl">Use SSL/TLS</label></div>
    <div class="row inline" id="sslVerifyRow"><input id="sslVerify" type="checkbox"><label for="sslVerify">Verify the server certificate</label></div>
    <div class="row" id="sslCaRow"><label for="sslCa">CA certificate</label>
      <div class="pair pair-button"><input id="sslCa" type="text" spellcheck="false" placeholder="optional PEM file, for a private or self-signed CA"><button type="button" id="browseCa" class="secondary">Browse…</button></div>
    </div>
    <div class="row" id="sslNameRow"><label for="sslServerName">Certificate name</label><input id="sslServerName" type="text" spellcheck="false" placeholder="optional; default: the host above"></div>
    <div class="row inline" id="showSystemRow"><input id="showSystem" type="checkbox"><label for="showSystem">Show system databases</label></div>
    <div class="row"><span></span><span class="hint" id="kindHint"></span></div>
  </fieldset>
  <fieldset>
    <legend><label><input id="sshEnabled" type="checkbox"> SSH tunnel</label></legend>
    <div id="sshFields" class="stack">
      <div class="row"><label for="sshHost">SSH host / port</label>
        <div class="pair"><input id="sshHost" type="text"><input id="sshPort" type="number" min="1" max="65535"></div>
      </div>
      <div class="row"><label for="sshUser">SSH user</label><input id="sshUser" type="text"></div>
      <div class="row"><label for="sshAuth">Authentication</label>
        <select id="sshAuth"><option value="privateKey">Private key</option><option value="password">Password</option><option value="agent">SSH agent</option></select>
      </div>
      <div class="row" id="sshPasswordRow"><label for="sshPassword">SSH password</label><input id="sshPassword" class="secret" type="password"></div>
      <div class="row" id="sshKeyRow"><label for="sshKey">Private key</label>
        <div class="pair pair-button"><input id="sshKey" type="text" placeholder="~/.ssh/id_ed25519 (default keys tried when empty)"><button type="button" id="browseKey" class="secondary">Browse…</button></div>
      </div>
      <div class="row" id="sshPassphraseRow"><label for="sshPassphrase">Key passphrase</label><input id="sshPassphrase" class="secret" type="password"></div>
      <div class="row"><span></span><span class="hint" id="fingerprint"></span></div>
    </div>
  </fieldset>
  <div class="actions">
    <button type="submit">Save</button>
    <button type="button" id="test" class="secondary">Test connection</button>
    <span id="result"></span>
  </div>
</form>`;

/** Add / edit form for a connection, with a live "Test connection". */
export class ConnectionForm {
  private static current?: ConnectionForm;

  static show(extensionUri: vscode.Uri, store: ConnectionStore, sessions: SessionManager, existing?: ConnectionConfig): void {
    ConnectionForm.current?.panel.dispose();
    ConnectionForm.current = new ConnectionForm(extensionUri, store, sessions, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private trustedFingerprint?: { host: string; value: string };

  private constructor(
    extensionUri: vscode.Uri,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly existing?: ConnectionConfig,
  ) {
    const title = existing ? `Edit ${existing.name}` : 'New connection';
    this.panel = vscode.window.createWebviewPanel('dataLodestar.connection', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('database');
    this.panel.webview.html = renderPage(this.panel.webview, extensionUri, title, BODY, ['connection.js']);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      if (ConnectionForm.current === this) ConnectionForm.current = undefined;
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: { type: string; config?: ConnectionConfig; secrets?: Record<string, string | null> }): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const hasSecrets = this.existing ? Object.keys(await this.store.getSecrets(this.existing.id)).length > 0 : false;
        this.post({ type: 'init', editing: !!this.existing, hasSecrets, config: this.existing ?? { savePassword: true } });
        break;
      }
      case 'browseKey': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          defaultUri: vscode.Uri.file(require('os').homedir() + '/.ssh'),
          openLabel: 'Use this key',
        });
        if (picked?.[0]) this.post({ type: 'keyPath', path: picked[0].fsPath });
        break;
      }
      case 'browseCa': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this CA', filters: { 'PEM certificates': ['pem', 'crt', 'cer'], 'All files': ['*'] } });
        if (picked?.[0]) this.post({ type: 'caPath', path: picked[0].fsPath });
        break;
      }
      case 'test':
        await this.test(this.build(msg.config!), msg.secrets ?? {});
        break;
      case 'save':
        await this.save(this.build(msg.config!), msg.secrets ?? {});
        break;
    }
  }

  private build(raw: ConnectionConfig): ConnectionConfig {
    const config: ConnectionConfig = { ...raw, id: this.existing?.id ?? randomUUID() };
    if (!config.ssh?.enabled) {
      config.ssh = config.ssh ? { ...config.ssh, enabled: false } : undefined;
      return config;
    }
    const sshHost = `${config.ssh.host}:${config.ssh.port}`;
    const previous = this.existing?.ssh;
    if (this.trustedFingerprint?.host === sshHost) config.ssh.hostFingerprint = this.trustedFingerprint.value;
    else if (previous && `${previous.host}:${previous.port}` === sshHost) config.ssh.hostFingerprint = previous.hostFingerprint;
    return config;
  }

  /** null = keep the stored value (edit form left the field empty). */
  private async mergeSecrets(raw: Record<string, string | null>): Promise<ConnectionSecrets> {
    const stored = this.existing ? await this.store.getSecrets(this.existing.id) : {};
    const pick = (k: keyof ConnectionSecrets) => (raw[k] === null ? stored[k] : (raw[k] ?? undefined));
    return { password: pick('password'), sshPassword: pick('sshPassword'), sshPassphrase: pick('sshPassphrase') };
  }

  /**
   * A password typed inside the connection string moves to the Password field, so
   * it lands in the keychain and never in the (unencrypted) connection settings.
   */
  private liftUriPassword(config: ConnectionConfig, raw: Record<string, string | null>): string | undefined {
    if (!config.uri) return undefined;
    const split = splitUriPassword(config.uri);
    config.uri = split.uri;
    if (split.password !== undefined) raw.password = split.password;
    return split.password;
  }

  private async test(config: ConnectionConfig, raw: Record<string, string | null>): Promise<void> {
    this.liftUriPassword(config, raw);
    const secrets = await this.mergeSecrets(raw);
    try {
      const started = Date.now();
      const { driver, tunnel } = await connectWith(config, secrets, async (fp, expected) => {
        const trust = 'Trust this key';
        const text = expected
          ? `SSH HOST KEY CHANGED.\nExpected ${expected}\nReceived ${fp}`
          : `Unknown SSH host key:\n${fp}\nTrust it?`;
        return (await vscode.window.showWarningMessage(text, { modal: true }, trust)) === trust;
      });
      try {
        const dbs = await driver.listDatabases(config.showSystemDatabases);
        if (tunnel) {
          this.trustedFingerprint = { host: `${config.ssh!.host}:${config.ssh!.port}`, value: tunnel.fingerprint };
          this.post({ type: 'fingerprint', value: tunnel.fingerprint });
        }
        this.post({ type: 'testResult', ok: true, message: `Connected in ${Date.now() - started} ms · ${dbs.length} database(s) visible.` });
      } finally {
        await driver.close();
        tunnel?.close();
      }
    } catch (err) {
      this.post({ type: 'testResult', ok: false, message: (err as Error).message || String(err) });
    }
  }

  private async save(config: ConnectionConfig, raw: Record<string, string | null>): Promise<void> {
    const lifted = this.liftUriPassword(config, raw);
    if (lifted !== undefined && !config.savePassword) {
      this.post({
        type: 'testResult',
        ok: false,
        message:
          'The connection string contains a password. Check "Save passwords in the OS keychain" to keep it there, ' +
          'or remove it from the string: it will then be asked at each connection. Nothing was saved.',
      });
      return;
    }
    if (lifted !== undefined) this.post({ type: 'uri', value: config.uri });
    const secrets: ConnectionSecrets = {};
    for (const k of ['password', 'sshPassword', 'sshPassphrase'] as const) {
      if (raw[k] !== null && raw[k] !== undefined) secrets[k] = raw[k]!;
    }
    await this.store.save(config, secrets);
    this.panel.dispose();
    if (this.sessions.isConnected(config.id)) {
      const choice = await vscode.window.showInformationMessage(`"${config.name}" saved. Reconnect to apply the changes?`, 'Reconnect');
      if (choice === 'Reconnect') {
        await this.sessions.disconnect(config.id);
        if (!this.sessions.isConnected(config.id)) await this.sessions.get(config.id);
      }
    } else {
      vscode.window.setStatusBarMessage(`DataLodestar: "${config.name}" saved`, 3000);
    }
  }
}
