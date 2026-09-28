import * as vscode from 'vscode';
import { CellValue } from '../types';
import { renderPage } from './webview';

export interface ResultItem {
  sql: string;
  connection: string;
  columns: string[];
  rows: CellValue[][];
  affectedRows?: number;
  durationMs?: number;
  truncated?: boolean;
  error?: string;
  documents?: unknown[];
}

/** Single reusable panel showing the outcome of the last run, one tab per statement. */
export class ResultsPanel {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pending?: ResultItem[];

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(items: ResultItem[]): void {
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel(
        'dataLodestar.results',
        'SQL Results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
      );
      this.panel.iconPath = new vscode.ThemeIcon('table');
      this.panel.webview.html = renderPage(
        this.panel.webview,
        this.extensionUri,
        'SQL Results',
        '<div class="page"><div class="tabs" id="tabs"></div><div class="status" id="status"></div><div class="scroll" id="content"></div></div>',
        ['results.js'],
      );
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready') {
          this.ready = true;
          if (this.pending) this.post(this.pending);
        } else if (msg.type === 'copy') {
          void vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        }
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(undefined, true);
    }
    this.pending = items;
    if (this.ready) this.post(items);
  }

  private post(items: ResultItem[]): void {
    this.pending = undefined;
    const binaryDisplay = vscode.workspace.getConfiguration('dataLodestar').get<string>('binaryDisplay', 'auto');
    void this.panel?.webview.postMessage({ type: 'results', items, binaryDisplay });
  }
}
