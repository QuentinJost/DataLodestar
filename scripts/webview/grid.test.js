// media/grid.js drawn while its tab is hidden (table viewer: Show Structure, then Data).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, html, frames } = require('./page');

const BODY = `<div class="page">
  <div id="dataPane" class="page subpage hidden">
    <div class="toolbar"><label>WHERE <input></label><button>Apply</button></div>
    <div class="status"><span>Rows 1–100</span></div>
    <div id="grid" class="scroll"></div>
  </div>
  <div id="structurePane" class="scroll">Columns…</div>
</div>`;

let browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

/** 100 rows drawn into the Data pane while the Structure pane is shown. */
async function hiddenGrid() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.setContent(html(BODY, ['binaryFormat.js', 'grid.js']));
  await page.evaluate(() => {
    const columns = ['id', 'email', 'name', 'city', 'created_at', 'notes'];
    const rows = Array.from({ length: 100 }, (_, i) => [i + 1, `user${i + 1}@example.org`, `User number ${i + 1}`, 'Rennes', '2026-10-02 10:00:00', 'some longer text '.repeat(3)]);
    SqlGrid.render(document.getElementById('grid'), columns, rows, {});
  });
  return page;
}

const showData = (page) =>
  page.evaluate(() => {
    document.getElementById('dataPane').classList.remove('hidden');
    document.getElementById('structurePane').classList.add('hidden');
  });

/** Scrolls the grid to `top` (or its end) and returns the row under the header and the last row drawn. */
const scrollTo = (page, top) =>
  page.evaluate(async (top) => {
    const grid = document.getElementById('grid');
    grid.scrollTop = top ?? grid.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = grid.getBoundingClientRect();
    const y = box.top + grid.querySelector('thead').getBoundingClientRect().height + 2;
    const rows = [...grid.querySelectorAll('tbody tr:not(.spacer)')];
    const under = rows.find((tr) => tr.getBoundingClientRect().top <= y && tr.getBoundingClientRect().bottom > y);
    const last = rows[rows.length - 1].getBoundingClientRect();
    return { under: under && under.cells[0].textContent, last: rows[rows.length - 1].cells[0].textContent, lastInside: last.top >= box.top - 1 && last.bottom <= box.bottom + 1 };
  }, top);

test('a grid drawn in a hidden tab is sized and scrolls right once shown', async () => {
  const page = await hiddenGrid();
  await showData(page);
  await frames(page);
  const widths = await page.evaluate(() => [...document.querySelectorAll('#grid col')].map((c) => parseFloat(c.style.width)));
  assert.equal(widths.length, 7);
  assert.ok(widths.every((w) => w > 0), `column widths: ${widths}`);
  const rowHeight = await page.evaluate(() => document.querySelector('#grid tbody tr:not(.spacer)').getBoundingClientRect().height);
  assert.equal((await scrollTo(page, Math.round(49 * rowHeight))).under, '50', 'row heights were measured');
  const end = await scrollTo(page);
  assert.deepEqual([end.last, end.lastInside], ['100', true], 'the last row is reachable');
  await page.close();
});

test('a grid drawn in a hidden tab, then replaced, is not drawn back once shown', async () => {
  const page = await hiddenGrid();
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = 'relation "t" does not exist';
    document.getElementById('grid').replaceChildren(box);
  });
  await showData(page);
  await frames(page);
  assert.equal(await page.evaluate(() => document.getElementById('grid').firstElementChild.className), 'error-box');
  await page.close();
});
