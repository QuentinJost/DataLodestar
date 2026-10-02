import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** Wraps a page body with the CSP, shared stylesheet and scripts. */
export function renderPage(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, body: string, scripts: string[]): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const tags = ['binaryFormat.js', 'mongoRows.js', 'grid.js', ...scripts].map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('style.css')}">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
${tags}
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
