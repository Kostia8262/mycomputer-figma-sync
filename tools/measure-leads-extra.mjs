/**
 * Добор к `measure-leads.mjs`: состав контейнеров, где важен не только размер,
 * но и порядок и видимость детей — шапка, тулбар на переносе, тело модалки,
 * пустая строка таблицы.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const TOKEN = process.env.MC_ADMIN_TOKEN;
const OUT = new URL('../state/leads-prod-extra.json', import.meta.url).pathname;

const PROBE = `
(() => {
  const n = v => v == null ? null : Math.round(v * 10) / 10;
  const kids = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    return Array.from(root.children).map(e => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return { id: e.id || null, cls: (e.className || '').toString().slice(0, 30), tag: e.tagName,
        w: n(r.width), h: n(r.height), x: n(r.left), y: n(r.top), display: cs.display,
        txt: (e.textContent || '').trim().slice(0, 30) };
    });
  };
  const cs = (sel, props) => {
    const e = document.querySelector(sel); if (!e) return null;
    const s = getComputedStyle(e); const o = {};
    for (const p of props) o[p] = s[p];
    return o;
  };
  return {
    topbarRight: kids('.topbar-right'),
    topbarRightStyle: cs('.topbar-right', ['gap', 'display', 'width']),
    toolbar: kids('#leadsTab .toolbar'),
    toolbarStyle: cs('#leadsTab .toolbar', ['gap', 'flexWrap', 'rowGap', 'columnGap']),
    modalBody: kids('#newLeadModal .modal-body'),
    modalBodyStyle: cs('#newLeadModal .modal-body', ['display', 'gap', 'rowGap', 'flexDirection']),
    modalGroup1: kids('#newLeadModal .modal-group'),
    phoneRow: kids('#nl_phoneRows'),
    phoneRowKids: kids('#nl_phoneRows > *'),
    tableStyle: cs('#leadsTable', ['minWidth', 'width', 'tableLayout', 'fontSize']),
    emptyCellStyle: cs('#leadsBody td[colspan]', ['padding', 'height']),
    emptyDiv: kids('#leadsBody td[colspan]'),
    emptyInner: (() => {
      const e = document.querySelector('#leadsBody .empty'); if (!e) return null;
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return { w: n(r.width), h: n(r.height), pad: s.padding, color: s.color, fs: s.fontSize,
        kids: Array.from(e.children).map(k => { const kr = k.getBoundingClientRect();
          return { tag: k.tagName, w: n(kr.width), h: n(kr.height), txt: (k.textContent || '').trim().slice(0, 30) }; }) };
    })(),
    gsSection: cs('.gs-section', ['padding', 'fontSize', 'lineHeight', 'backgroundColor', 'letterSpacing', 'textTransform']),
    gsItem: cs('.gs-item', ['padding', 'gap', 'borderBottom']),
    gsItemKids: kids('.gs-item'),
    gsDropdownStyle: cs('#gsDropdown', ['border', 'borderRadius', 'width', 'minWidth', 'top', 'right', 'backgroundColor']),
    pagerStyle: cs('#pager', ['padding', 'borderTop', 'fontSize', 'justifyContent']),
    bulkStyle: cs('#leadBulkBar', ['padding', 'gap', 'border', 'borderRadius', 'backgroundColor', 'marginBottom']),
    statsStyle: cs('.stats', ['gap', 'gridTemplateColumns', 'marginBottom']),
    theadStyle: cs('#leadsTable th', ['padding', 'fontSize', 'height']),
  };
})()
`;

const browser = await chromium.launch();
const out = {};
for (const bp of [{ key: 'desktop', width: 1440, height: 900 }, { key: 'compact', width: 900, height: 800 }, { key: 'mobile', width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('leads'); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { openNewLeadModal(); });
  await page.evaluate(() => { const i = document.getElementById('gsInput'); if (i) { i.value = 'а'; } globalSearch('ан'); });
  await page.waitForTimeout(500);
  out[bp.key] = { filled: await page.evaluate(PROBE) };
  await page.evaluate(() => { closeNewLeadModal(); const i = document.getElementById('searchInput'); i.value = 'zzzzzq'; renderTable(); });
  await page.waitForTimeout(500);
  out[bp.key].empty = await page.evaluate(PROBE);
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error('записано:', OUT);
