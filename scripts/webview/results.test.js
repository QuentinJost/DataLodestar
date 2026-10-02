// media/results.js: the warning of a result cut at maxRows.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, html, panelBody } = require('./page');

const BODY = panelBody('resultsPanel.ts');
const SCRIPTS = ['binaryFormat.js', 'mongoRows.js', 'grid.js', 'txBar.js', 'results.js'];

let browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

async function warning(item) {
  const page = await browser.newPage();
  await page.setContent(html(BODY, SCRIPTS));
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

/** The bar after the extension sent `state`: shown, its text and buttons. */
const bar = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('txbar');
    return { shown: !el.classList.contains('hidden'), text: el.querySelector('span')?.textContent, buttons: [...el.querySelectorAll('button')].map((b) => [b.textContent, b.disabled]) };
  });
const tx = (page, state) => page.evaluate((state) => window.postMessage({ type: 'tx', ...state }, '*'), state);

test('pending changes show a Commit / Rollback bar; a click sends it once', async () => {
  const page = await browser.newPage();
  await page.setContent(html(BODY, SCRIPTS));
  assert.equal((await bar(page)).shown, false, 'hidden until the extension says so');
  await tx(page, { pending: true, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar:not(.hidden)');
  assert.deepEqual(await bar(page), { shown: true, text: 'Uncommitted changes on local', buttons: [['Commit', false], ['Rollback', false]] });
  await page.click('#txbar button:first-of-type');
  assert.deepEqual(await page.evaluate(() => window.posted.filter((m) => m.type !== 'ready')), [{ type: 'commit' }]);
  assert.deepEqual((await bar(page)).buttons, [['Commit', true], ['Rollback', true]], 'disabled until the new state arrives');
  await tx(page, { pending: false, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar.hidden', { state: 'attached' });
  await page.close();
});

test('a Redis MULTI names its buttons EXEC and DISCARD', async () => {
  const page = await browser.newPage();
  await page.setContent(html(BODY, SCRIPTS));
  await tx(page, { pending: true, redis: true, connection: 'cache' });
  await page.waitForSelector('#txbar:not(.hidden)');
  assert.deepEqual(await bar(page), { shown: true, text: 'MULTI open on cache', buttons: [['EXEC', false], ['DISCARD', false]] });
  await page.close();
});
