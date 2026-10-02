// media/connection.js: the TLS checkboxes of the connection form.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, html, panelBody } = require('./page');

const BODY = panelBody('connectionForm.ts');

let browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

async function form(config) {
  const page = await browser.newPage();
  await page.setContent(html(BODY, ['connection.js']));
  await page.evaluate((config) => window.postMessage({ type: 'init', editing: true, hasSecrets: false, config }, '*'), config);
  await page.waitForFunction(() => document.getElementById('name').value !== '');
  return page;
}

const base = { id: 'x', kind: 'mysql', host: 'db.example.net', port: 3306, user: 'u', savePassword: false, txMode: 'auto' };
const checked = (page, id) => page.evaluate((id) => document.getElementById(id).checked, id);

test('turning TLS on checks Verify, whatever was stored while TLS was off', async () => {
  const page = await form({ ...base, name: 'plain', ssl: false, sslVerify: false });
  await page.click('#ssl');
  assert.equal(await checked(page, 'sslVerify'), true);
  assert.equal(await page.evaluate(() => document.getElementById('sslCaRow').classList.contains('hidden')), false, 'CA and name rows shown');
  await page.close();
});

test('a TLS connection left unchecked stays unchecked when opened', async () => {
  const page = await form({ ...base, name: 'legacy', ssl: true, sslVerify: false });
  assert.equal(await checked(page, 'sslVerify'), false);
  await page.close();
});
