// Loads media/ scripts into headless Chromium the way the webviews do, for scripts/webview/*.test.js.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const media = (file) => fs.readFileSync(path.join(__dirname, '../../media', file), 'utf8');

/** A page with the shared stylesheet, `body`, a stub of the VS Code API (messages kept in `posted`), then `scripts` from media/. */
function html(body, scripts) {
  return `<!DOCTYPE html><html><head><style>${media('style.css')}</style></head><body>${body}
<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.posted.push(m), getState: () => undefined, setState: () => undefined });</script>
${scripts.map((s) => `<script>${media(s)}</script>`).join('\n')}
</body></html>`;
}

/** Resolves after `n` animation frames: layout, ResizeObserver and scroll handlers have run. */
const frames = (page, n = 3) =>
  page.evaluate((n) => new Promise((resolve) => {
    const next = (k) => (k ? requestAnimationFrame(() => next(k - 1)) : resolve());
    next(n);
  }), n);

/** The page markup of a panel: the `BODY` constant of its src/views/ file. */
const panelBody = (file) => /const BODY =\s*([`'])([\s\S]*?)\1;/.exec(fs.readFileSync(path.join(__dirname, '../../src/views', file), 'utf8'))[2];

module.exports = { chromium, html, frames, panelBody };
