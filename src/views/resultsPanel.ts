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
  /** Last results shown, posted again when the (not retained) page reloads. */
  private last?: ResultItem[];

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(items: ResultItem[]): void {
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel(
        'dataLodestar.results',
        'SQL Results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
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
          else if (this.last) this.post(this.last, true);
        } else if (msg.type === 'copy') {
          void vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.last = undefined;
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.pending = items;
    if (this.ready) this.post(items);
  }

  private post(items: ResultItem[], restored = false): void {
    this.pending = undefined;
    this.last = items;
    const settings = vscode.workspace.getConfiguration('dataLodestar');
    const binaryDisplay = settings.get<string>('binaryDisplay', 'auto');
    const csvEscapeFormulas = settings.get<boolean>('csvEscapeFormulas', true);
    void this.panel?.webview.postMessage({ type: 'results', items, binaryDisplay, csvEscapeFormulas, restored });
  }
}
