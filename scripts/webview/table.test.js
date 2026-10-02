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

const EDITING = { type: 'editing', editable: true, key: ['id'], columns: { id: { editable: true, nullable: false }, name: { editable: true, nullable: true }, photo: { editable: false, nullable: true } } };
const cell = (r, c) => `#grid tbody tr[data-r="${r}"] td:nth-child(${c + 2})`;

/** A viewer on `count` rows of (id, name, photo) that may be edited. */
async function editableViewer(count = 3) {
  const page = await viewer();
  await send(page, EDITING);
  const rows = Array.from({ length: count }, (_, i) => [i + 1, i === 1 ? null : `name ${i + 1}`, { b: '00ff', n: 2 }]);
  await send(page, { type: 'data', columns: ['id', 'name', 'photo'], rows, hasMore: false, durationMs: 1, text: 'SELECT', quoted: {} });
  await page.waitForSelector(cell(0, 1));
  return page;
}

const posted = (page, type) => page.evaluate((type) => window.posted.filter((m) => m.type === type), type);

test('editing: double-click, type, Enter: the cell shows the change and Save sends it with the row key', async () => {
  const page = await editableViewer();
  assert.match(await page.textContent('#editHint'), /Double-click a cell/);
  assert.equal(await page.isHidden('#editbar'), true);
  await page.dblclick(cell(0, 1));
  await page.fill('textarea.cell-editor', 'Zoé');
  await page.keyboard.press('Enter');
  assert.equal(await page.textContent(cell(0, 1)), 'Zoé');
  assert.ok(await page.evaluate((s) => document.querySelector(s).classList.contains('edited'), cell(0, 1)));
  assert.equal(await page.textContent('#editCount'), '1 unsaved change in 1 row');
  await page.click('#saveEdits');
  assert.deepEqual((await posted(page, 'save'))[0].edits, [{ key: [1], changes: { name: 'Zoé' } }]);
  assert.equal(await page.isDisabled('#saveEdits'), true, 'one save at a time');
  await send(page, { type: 'saved' });
  await page.waitForSelector('#editbar.hidden', { state: 'attached' });
  assert.equal(await loads(page), 2, 'the saved rows are read again');
  await page.close();
});

test('editing: Escape cancels, a NULL cell left untouched stays NULL, typing the read value is no change', async () => {
  const page = await editableViewer();
  await page.dblclick(cell(0, 1));
  await page.fill('textarea.cell-editor', 'nope');
  await page.keyboard.press('Escape');
  assert.equal(await page.textContent(cell(0, 1)), 'name 1');
  await page.dblclick(cell(1, 1));
  assert.equal(await page.getAttribute('textarea.cell-editor', 'placeholder'), 'NULL');
  await page.click('#info'); // leaves the box without typing
  assert.equal(await page.textContent(cell(1, 1)), 'NULL');
  await page.dblclick(cell(2, 1));
  await page.fill('textarea.cell-editor', 'other');
  await page.keyboard.press('Enter');
  await page.dblclick(cell(2, 1));
  await page.fill('textarea.cell-editor', 'name 3');
  await page.keyboard.press('Enter');
  assert.equal(await page.isHidden('#editbar'), true, 'back to the value read: nothing to save');
  await page.close();
});

test('editing: binary cells copy on double-click; Set NULL and Revert act on the selected cell', async () => {
  const page = await editableViewer();
  await page.dblclick(cell(0, 2));
  assert.equal(await page.$('textarea.cell-editor'), null);
  assert.equal((await posted(page, 'copy')).length, 1);
  await page.click(cell(0, 0));
  assert.equal(await page.isDisabled('#setNull'), true, 'id is NOT NULL');
  await page.click(cell(0, 1));
  await page.click('#setNull');
  assert.equal(await page.textContent(cell(0, 1)), 'NULL');
  assert.equal(await page.textContent('#editCount'), '1 unsaved change in 1 row');
  await page.click('#revertCell');
  assert.equal(await page.textContent(cell(0, 1)), 'name 1');
  assert.equal(await page.isHidden('#editbar'), true);
  await page.close();
});

test('editing: a failed save keeps the changes and says nothing was saved', async () => {
  const page = await editableViewer();
  await page.click(cell(0, 1));
  await page.keyboard.press('Enter');
  await page.fill('textarea.cell-editor', 'x');
  await page.keyboard.press('Enter');
  await page.click('#saveEdits');
  await send(page, { type: 'saveError', message: 'Row id = 1: Duplicate entry', index: 0 });
  await page.waitForSelector('#dataError:not(.hidden)');
  assert.equal(await page.textContent('#dataError'), 'Nothing was saved. Row id = 1: Duplicate entry');
  assert.equal(await page.isDisabled('#saveEdits'), false);
  assert.equal(await page.textContent('#editCount'), '1 unsaved change in 1 row');
  await page.close();
});

test('editing: changes follow their row through a reload, and a long page edits like a short one', async () => {
  const page = await editableViewer(200);
  await page.dblclick(cell(3, 1));
  await page.fill('textarea.cell-editor', 'kept');
  await page.keyboard.press('Enter');
  // The same rows come back in another order (a reload after a rollback, a new sort).
  const rows = Array.from({ length: 200 }, (_, i) => [200 - i, `name ${200 - i}`, { b: '00ff', n: 2 }]);
  await send(page, { type: 'data', columns: ['id', 'name', 'photo'], rows, hasMore: false, durationMs: 1, text: 'SELECT', quoted: {} });
  await page.waitForFunction(() => document.querySelector('#grid tbody tr[data-r="0"] td:nth-child(2)').textContent === '200');
  await page.evaluate(() => (document.getElementById('grid').scrollTop = 1e6));
  await page.waitForSelector('#grid tbody tr[data-r="196"]');
  assert.equal(await page.textContent(cell(196, 1)), 'kept', 'id 4 is now row 196');
  await page.close();
});

test('editing: a read-only table says why and opens no editor', async () => {
  const page = await viewer();
  await send(page, { type: 'editing', editable: false, reason: 'views are read-only' });
  await send(page, { type: 'data', columns: ['id'], rows: [[1]], hasMore: false, durationMs: 1, text: 'SELECT', quoted: {} });
  await page.waitForSelector(cell(0, 0));
  assert.equal(await page.textContent('#editHint'), 'Read-only: views are read-only');
  await page.dblclick(cell(0, 0));
  assert.equal(await page.$('textarea.cell-editor'), null);
  assert.equal(await page.isHidden('#setNull'), true);
  await page.close();
});

test('editing: a page that arrives while a cell is being edited keeps the text on the row it was typed for', async () => {
  const page = await editableViewer();
  await page.dblclick(cell(0, 1));
  await page.fill('textarea.cell-editor', 'typed for id 1');
  // A reload (end of a transaction) brings the same rows in another order before Enter.
  const rows = [[3, 'name 3', { b: '00ff', n: 2 }], [2, null, { b: '00ff', n: 2 }], [1, 'name 1', { b: '00ff', n: 2 }]];
  await send(page, { type: 'data', columns: ['id', 'name', 'photo'], rows, hasMore: false, durationMs: 1, text: 'SELECT', quoted: {} });
  await page.waitForFunction(() => document.querySelector('#grid tbody tr[data-r="0"] td:nth-child(2)').textContent === '3');
  assert.equal(await page.$('textarea.cell-editor'), null, 'the editor of the replaced page is closed');
  assert.equal(await page.textContent(cell(2, 1)), 'typed for id 1', 'id 1 is now the third row');
  assert.equal(await page.textContent(cell(0, 1)), 'name 3');
  await page.click('#saveEdits');
  assert.deepEqual((await posted(page, 'save'))[0].edits, [{ key: [1], changes: { name: 'typed for id 1' } }]);
  await page.close();
});

test('editing: a page reloaded while a save runs shows Saving… until the outcome arrives', async () => {
  const page = await browser.newPage();
  await page.setContent(html(BODY, SCRIPTS));
  await send(page, { type: 'init', pageSize: 100, saving: true, labels: { where: 'WHERE', orderBy: 'ORDER BY', wherePlaceholder: '', orderPlaceholder: '' }, sortStyle: 'sql' });
  await send(page, EDITING);
  await send(page, { type: 'data', columns: ['id', 'name', 'photo'], rows: [[1, 'a', null]], hasMore: false, durationMs: 1, text: 'SELECT', quoted: {} });
  await page.waitForSelector(cell(0, 1));
  assert.equal(await page.textContent('#saveEdits'), 'Saving…');
  await page.dblclick(cell(0, 1));
  assert.equal(await page.$('textarea.cell-editor'), null, 'no edit while the save runs');
  await send(page, { type: 'saved' });
  await page.waitForFunction(() => document.getElementById('saveEdits').textContent === 'Save');
  await page.close();
});
