// The channel grid in a real browser: arrow keys, the Mode column, paste from Excel, copy, and the split Write menu.
// Skipped if Playwright isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(await readFile(join(root, path || 'index.html'))); }
    catch { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('channel grid: keys, mode, paste, copy and split write', { skip: !chromium && 'playwright not installed' }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.addInitScript(() => { localStorage.setItem('lito.lang', 'en'); localStorage.setItem('lito.theme', 'dark'); localStorage.setItem('lito.amb', 'off'); localStorage.setItem('lito.bandplan', 'au'); });
    await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
    await page.click('#btnDemo'); await page.waitForSelector('#connStatus.on'); await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) await page.click('#btnAddCh'); // the demo radio holds one custom channel
    assert.equal(await page.$$eval('#chTable tbody tr', (t) => t.length), 4);

    // Arrow keys move between cells; Left/Right in a text box only leave it at the edge.
    await page.focus('#chTable tbody tr:nth-child(1) td.c-chName input');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#chTable tbody tr')].indexOf(document.activeElement.closest('tr'))), 1);
    await page.keyboard.press('ArrowRight'); // all text selected: just collapses to the end
    assert.ok(await page.evaluate(() => document.activeElement.closest('td').classList.contains('c-chName')));
    await page.keyboard.press('ArrowRight');
    assert.ok(await page.evaluate(() => document.activeElement.closest('td').classList.contains('c-rx')));
    const rxBefore = await page.$eval('#chTable tbody tr:nth-child(2) td.c-rx select', (s) => s.value);
    await page.keyboard.press('ArrowDown'); // on a select, moves instead of changing the value
    assert.equal(await page.$eval('#chTable tbody tr:nth-child(2) td.c-rx select', (s) => s.value), rxBefore);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#chTable tbody tr')].indexOf(document.activeElement.closest('tr'))), 2);

    // Mode: put row 1 on CH5, which can only transmit through the repeater.
    await page.selectOption('#chTable tbody tr:nth-child(1) td.c-rx select', String(476425000 + 4 * 25000));
    assert.equal(await page.$eval('#chTable tbody tr:nth-child(1) td.c-mode select', (s) => s.value), 'repeater');
    assert.equal(await page.$eval('#chTable tbody tr:nth-child(1) td.c-tx select', (s) => s.value), String(476425000 + 4 * 25000 + 750000));
    await page.selectOption('#chTable tbody tr:nth-child(1) td.c-mode select', 'listen');
    assert.equal(await page.$eval('#chTable tbody tr:nth-child(1) td.c-tx select', (s) => s.value), '0');

    // Paste two rows from Excel (with a header) into row 2.
    await page.focus('#chTable tbody tr:nth-child(2) td.c-chName input');
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'Name\tRX MHz\tTX tone\r\nHome\t476.825\t103.5\r\nConvoy\tCH40\tOff\r\n');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const got = await page.$$eval('#chTable tbody tr', (trs) => trs.slice(1, 3).map((tr) => [tr.querySelector('.c-chName input').value, tr.querySelector('.c-rx select').value, tr.querySelector('.c-tx select').value, tr.querySelector('.c-txTone select').selectedOptions[0].textContent]));
    assert.deepEqual(got, [['Home', '476825000', '476825000', '103.5'], ['Convoy', '477400000', '477400000', 'Off']]);
    assert.match(await page.textContent('#bannerText'), /Pasted 2 row/);

    // Copy the ticked rows as tab-separated text.
    await page.check('#chTable tbody tr:nth-child(2) td:first-child input');
    await page.focus('#chTable tbody tr:nth-child(2) td:first-child input');
    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    });
    assert.match(copied, /^Slot\tName\tRX MHz\tMode\tTX MHz\tRX tone\tTX tone\r\nC02\tHome\t476.82500\tSimplex\t476.82500\tOff\t103.5\r\n$/);

    // Split Write: settings only touches no channels.
    await page.click('[data-tab=radio]');
    const vt = await page.$eval('#f_voiceType', (s) => ({ cur: s.value, all: [...s.options].map((o) => o.value) }));
    await page.selectOption('#f_voiceType', vt.all.find((v) => v !== vt.cur));
    await page.click('[data-tab=channels]');
    await page.click('#btnWriteMore');
    assert.equal(await page.isVisible('#writeMenu'), true);
    await page.click('#writeMenu [data-write=settings]');
    await page.waitForFunction(() => /Saved: voiceType/.test(document.querySelector('#bannerText').textContent));
    assert.equal(await page.isVisible('#writeMenu'), false);
    assert.match(dialogs.at(-1), /Settings: voiceType/); assert.doesNotMatch(dialogs.at(-1), /Channels:/);
    // Channels edits are still pending.
    assert.equal(await page.$$eval('#chTable tbody tr:is(.st-modify, .st-insert)', (t) => t.length), 4);

    // Channels only writes them.
    await page.click('#btnWriteMore'); await page.click('#writeMenu [data-write=channels]');
    await page.waitForFunction(() => /Wrote \d+ channel change/.test(document.querySelector('#bannerText').textContent));
    assert.match(dialogs.at(-1), /Channels: 3 new, 1 changed, 0 deleted/);
    assert.doesNotMatch(dialogs.at(-1), /Settings:/);
    assert.equal(await page.$$eval('#chTable tbody tr:is(.st-modify, .st-insert)', (t) => t.length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
