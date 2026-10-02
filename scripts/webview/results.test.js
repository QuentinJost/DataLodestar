// media/results.js: the warning of a result cut at maxRows.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, html } = require('./page');

const BODY = '<div class="page"><div class="tabs" id="tabs"></div><div class="status" id="status"></div><div class="scroll" id="content"></div></div>';

let browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

async function warning(item) {
  const page = await browser.newPage();
  await page.setContent(html(BODY, ['binaryFormat.js', 'mongoRows.js', 'grid.js', 'results.js']));
  await page.evaluate((item) => window.postMessage({ type: 'results', items: [item] }, '*'), item);
  await page.waitForSelector('#status .warn');
  const text = await page.textContent('#status .warn');
  await page.close();
  return text;
}

const rows = Array.from({ length: 1000 }, (_, i) => [i]);

test('a result stopped on the server says the statement did not run to the end', async () => {
  const text = await warning({ sql: 'SELECT f(id) FROM t', connection: 'local', columns: ['f'], rows, truncated: true, stopped: true });
  assert.equal(text, 'Stopped after 1000 rows (dataLodestar.maxRows): the server did not run the statement to the end.');
});

test('a result only cut for display keeps the display message', async () => {
  const text = await warning({ sql: 'SELECT * FROM t FOR UPDATE', connection: 'local', columns: ['f'], rows, truncated: true });
  assert.equal(text, 'Display limited to 1000 rows (dataLodestar.maxRows).');
});
