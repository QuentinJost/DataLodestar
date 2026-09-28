import * as vscode from 'vscode';
import { SessionManager } from '../sessionManager';
import { renderPage } from './webview';
import { OpenSql } from './tablePanel';

const BODY = `
<div class="page">
  <div class="toolbar">
    <label class="grow"><span class="kw">MATCH</span><input id="pattern" type="text" spellcheck="false" value="*" placeholder="e.g. user:*"></label>
    <label><span class="kw">TYPE</span>
      <select id="type">
        <option value="">any</option><option>string</option><option>hash</option><option>list</option>
        <option>set</option><option>zset</option><option>stream</option>
      </select>
    </label>
    <button id="scan">Scan</button>
    <button id="more" class="secondary" disabled>Load more</button>
    <button id="query" class="secondary" title="Open a command editor on this database">New command</button>
  </div>
  <div class="status"><span id="info"></span></div>
  <div id="scanError" class="error-box hidden"></div>
  <div class="split">
    <div id="keys" class="scroll keys"></div>
    <div class="scroll detail">
      <div id="detailHead" class="status hidden"></div>
      <div id="detailError" class="error-box hidden"></div>
      <div id="detail"><div class="message">Select a key.</div></div>
    </div>
  </div>
</div>`;

/** Key browser of one Redis database: SCAN with MATCH / TYPE, then a type-aware value view. */
export class RedisPanel {
  private static readonly open = new Map<string, RedisPanel>();

  static show(extensionUri: vscode.Uri, sessions: SessionManager, openSql: OpenSql, connId: string, connName: string, database: string): void {
    const key = `${connId}|${database}`;
    const existing = RedisPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    RedisPanel.open.set(key, new RedisPanel(key, extensionUri, sessions, openSql, connId, connName, database));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    key: string,
    extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    private readonly openSql: OpenSql,
    private readonly connId: string,
    connName: string,
    private readonly database: string,
  ) {
    const title = `db${database} — ${connName}`;
    this.panel = vscode.window.createWebviewPanel('dataLodestar.redis', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('symbol-key');
    this.panel.webview.html = renderPage(this.panel.webview, extensionUri, title, BODY, ['redis.js']);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => RedisPanel.open.delete(key));
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async driver() {
    const d = (await this.sessions.get(this.connId)).driver;
    if (d.family !== 'redis') throw new Error('Not a Redis connection.');
    return d;
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'init', binaryDisplay: vscode.workspace.getConfiguration('dataLodestar').get<string>('binaryDisplay', 'auto') });
        break;
      case 'scan':
        try {
          const started = Date.now();
          const res = await (await this.driver()).scan(this.database, String(msg.pattern || '*'), msg.keyType ? String(msg.keyType) : undefined, String(msg.cursor ?? '0'));
          this.post({ type: 'keys', ...res, append: msg.cursor !== '0', durationMs: Date.now() - started });
        } catch (err) {
          this.post({ type: 'scanError', message: (err as Error).message });
        }
        break;
      case 'value':
        try {
          this.post({ type: 'value', value: await (await this.driver()).getValue(this.database, String(msg.key)) });
        } catch (err) {
          this.post({ type: 'valueError', message: (err as Error).message });
        }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text));
        vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        break;
      case 'openSql':
        await this.openSql(this.connId, this.database, String(msg.text ?? ''), 'plaintext');
        break;
    }
  }
}
