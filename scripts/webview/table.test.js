// media/table.js: the Commit / Rollback bar of the table viewer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, html, panelBody } = require('./page');

const BODY = panelBody('tablePanel.ts');
const SCRIPTS = ['binaryFormat.js', 'mongoRows.js', 'grid.js', 'txBar.js', 'table.js'];

let browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

const send = (page, msg) => page.evaluate((msg) => window.postMessage(msg, '*'), msg);
const loads = (page) => page.evaluate(() => window.posted.filter((m) => m.type === 'load').length);

/** A table viewer whose page got its init: it asked for its first page of rows. */
async function viewer() {
  const page = await browser.newPage();
  await page.setContent(html(BODY, SCRIPTS));
  await send(page, { type: 'init', pageSize: 100, labels: { where: 'WHERE', orderBy: 'ORDER BY', wherePlaceholder: '', orderPlaceholder: '' }, sortStyle: 'sql' });
  await page.waitForFunction(() => window.posted.some((m) => m.type === 'load'));
  return page;
}

test('the bar shows while changes wait, and its buttons post commit and rollback', async () => {
  const page = await viewer();
  await send(page, { type: 'tx', pending: true, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar:not(.hidden)');
  assert.equal(await page.textContent('#txbar span'), 'Uncommitted changes on local');
  await page.click('#txbar button.secondary');
  assert.deepEqual(await page.evaluate(() => window.posted.at(-1)), { type: 'rollback' });
  await page.close();
});

test('the end of the transaction hides the bar and reloads the page of rows', async () => {
  const page = await viewer();
  assert.equal(await loads(page), 1);
  await send(page, { type: 'tx', pending: false, connected: true, redis: false, connection: 'local' });
  await send(page, { type: 'tx', pending: true, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar:not(.hidden)');
  assert.equal(await loads(page), 1, 'no reload while nothing ended');
  await send(page, { type: 'count', value: 500 });
  await page.fill('#where', 'id = 1'); // typed, not applied
  await send(page, { type: 'tx', pending: false, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar.hidden', { state: 'attached' });
  await page.waitForFunction(() => window.posted.filter((m) => m.type === 'load').length === 2);
  assert.equal(await loads(page), 2, 'rows rolled back must not stay on screen');
  assert.equal(await page.textContent('#countValue'), '', 'nor a count made before the end');
  assert.equal(await page.evaluate(() => window.posted.filter((m) => m.type === 'load').at(-1).where), '', 'the filter last applied, not the one being typed');
  await page.close();
});

test('a disconnect with changes waiting hides the bar but does not read again (that would reconnect)', async () => {
  const page = await viewer();
  await send(page, { type: 'tx', pending: true, connected: true, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar:not(.hidden)');
  await send(page, { type: 'tx', pending: false, connected: false, redis: false, connection: 'local' });
  await page.waitForSelector('#txbar.hidden', { state: 'attached' });
  assert.equal(await loads(page), 1);
  await page.close();
});
