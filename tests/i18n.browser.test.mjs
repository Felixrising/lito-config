// Switches through every interface language in a real browser and checks that nothing is left behind:
// in each language no visible text or tooltip may still be an English string that has a translation,
// and switching back to English must restore the page exactly. Skipped if Playwright isn't installed.
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

// Every visible text node and tooltip, outside the English-only developer tools.
const snapshot = () => {
  const out = [];
  const visible = (el) => el && !el.closest('[data-i18n-skip], script, style') && (el.offsetParent || el.closest('header, nav, select'));
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim() && visible(n.parentElement)) out.push(n.data.replace(/\s+/g, ' ').trim());
  for (const el of document.querySelectorAll('[title], [aria-label]')) if (visible(el)) for (const a of ['title', 'aria-label']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
  return out;
};

for (const theme of ['dark', 'console']) test(`every language switch leaves no stale text (${theme} theme)`, { skip: !chromium && 'playwright not installed' }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((theme) => { localStorage.setItem('lito.lang', 'en'); localStorage.setItem('lito.theme', theme); localStorage.setItem('lito.amb', 'off'); localStorage.setItem('lito.bulk', '1'); }, theme);
    await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
    await page.click('#btnDemo'); await page.waitForSelector('#connStatus.on'); await page.waitForTimeout(300);
    await page.click('#bannerClose');
    const langs = await page.$$eval('#langSel option', (os) => os.map((o) => o.value));
    assert.equal(langs.length, 6);
    const english = await page.evaluate(snapshot);
    for (const tab of ['channels', 'radio', 'about']) {
      await page.click(`[data-tab=${tab}]`);
      const base = await page.evaluate(snapshot);
      for (const lang of [...langs.filter((l) => l !== 'en'), 'en', 'zh-CN', 'fr', 'en']) {
        await page.selectOption('#langSel', lang); await page.waitForTimeout(50);
        const now = await page.evaluate(snapshot);
        if (lang === 'en') { assert.deepEqual(now, base, `${tab} tab: switching back to English left translated text`); continue; }
        const dict = (await import(`../app/locales/${lang}.js`)).default;
        const stale = now.filter((s) => dict[s] && dict[s] !== s);
        assert.deepEqual(stale, [], `${tab} tab in ${lang}: still English`);
      }
    }
    await page.click('[data-tab=channels]'); await page.selectOption('#langSel', 'en');
    assert.deepEqual(await page.evaluate(snapshot), english, 'back in English the page matches the original');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
