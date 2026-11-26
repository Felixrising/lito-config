// Interface languages. English text is the key; each locale file maps English → translation.
// Static page text and any text the app later puts on screen are translated by watching the DOM, so plain
// strings need no code changes. Text with values in it goes through t('… {n} …', { n }).
// Elements inside [data-i18n-skip] (developer tools) stay in English.
import fr from './locales/fr.js';
import es from './locales/es.js';
import pt from './locales/pt.js';
import zhCN from './locales/zh-CN.js';
import zhTW from './locales/zh-TW.js';

export const LANGS = { en: 'English', fr: 'Français', es: 'Español', pt: 'Português', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };
const DICTS = { en: {}, fr, es, pt, 'zh-CN': zhCN, 'zh-TW': zhTW };
const KEY = 'lito.lang';

/** Best match for a browser language tag, e.g. pt-BR → pt, zh-HK → zh-TW. */
export function matchLang(tag = '') {
  const l = tag.toLowerCase();
  if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
  const base = l.split('-')[0];
  return base in DICTS ? base : 'en';
}

let lang = 'en';
try { lang = localStorage.getItem(KEY) || matchLang((navigator.languages || [navigator.language])[0]); } catch { lang = 'en'; }
if (!(lang in DICTS)) lang = 'en';
export const getLang = () => lang;

/** Translate English text, filling {name} placeholders from vars. */
export function t(en, vars) {
  let s = (DICTS[lang][en] ?? en);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// ---------- DOM translation ----------
const ATTRS = ['title', 'aria-label', 'placeholder'];
const origText = new WeakMap(); // text node -> English
const origAttr = new WeakMap(); // element -> {attr: English}
const lookup = (en) => {
  const k = en.replace(/\s+/g, ' ').trim(); if (!k) return null;
  const v = DICTS[lang][k]; if (v == null) return null;
  return en.match(/^\s*/)[0] + v + en.match(/\s*$/)[0];
};
const skipped = (el) => !!el?.closest?.('[data-i18n-skip], script, style');

function doText(node) {
  if (skipped(node.parentElement)) return;
  let en = origText.get(node);
  // the app replaced the text since we last translated it: the new text is the English source
  if (en == null || (node.data !== en && node.data !== (lookup(en) ?? en))) { en = node.data; origText.set(node, en); }
  const out = lang === 'en' ? en : (lookup(en) ?? en);
  if (node.data !== out) node.data = out;
}
function doAttrs(el) {
  if (skipped(el)) return;
  let o = origAttr.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const cur = el.getAttribute(a);
    if (!o) { o = {}; origAttr.set(el, o); }
    if (o[a] == null || (cur !== o[a] && cur !== (lookup(o[a]) ?? o[a]))) o[a] = cur;
    const out = lang === 'en' ? o[a] : (lookup(o[a]) ?? o[a]);
    if (cur !== out) el.setAttribute(a, out);
  }
}
function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1) return;
  if (skipped(root)) return;
  doAttrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.hasAttribute('data-i18n-skip') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = it.nextNode(); n; n = it.nextNode()) (n.nodeType === 3 ? doText(n) : doAttrs(n));
}

let observer = null;
function observe() {
  observer = new MutationObserver((muts) => {
    observer.disconnect();
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
    }
    observer.takeRecords();
    start();
  });
  start();
}
function start() { observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS }); }

/** Translate the page now and keep translating anything added later. */
export function initI18n() {
  document.documentElement.lang = lang;
  walk(document.body);
  observe();
}

/** Switch language. Text built with t() is refreshed by the caller (re-render). */
export function setLang(l) {
  if (!(l in DICTS)) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  document.documentElement.lang = l;
  observer?.disconnect();
  walk(document.body);
  if (observer) start();
}
