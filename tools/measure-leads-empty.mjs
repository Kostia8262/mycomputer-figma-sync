/**
 * Ширины колонок шапки таблицы «Заявки» в пустом состоянии: при одной ячейке
 * с colspan таблица ужимается до ширины контейнера, и шапка получает свои
 * ширины — их не видно в обычном (наполненном) замере.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const OUT = new URL('../state/leads-prod-empty.json', import.meta.url).pathname;
const browser = await chromium.launch();
const out = {};

for (const bp of [{ key: 'desktop', width: 1440, height: 900 }, { key: 'compact', width: 900, height: 800 }, { key: 'mobile', width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', process.env.MC_ADMIN_TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { showTab('leads'); });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const i = document.getElementById('searchInput'); i.value = 'zzzzzq'; renderTable(); });
  await page.waitForTimeout(500);
  out[bp.key] = await page.evaluate(() => {
    const n = v => Math.round(v * 10) / 10;
    const th = Array.from(document.querySelectorAll('#leadsTable thead th'));
    const wrap = document.querySelector('#leadsTableWrap').getBoundingClientRect();
    const tbl = document.querySelector('#leadsTable').getBoundingClientRect();
    const head = document.querySelector('#leadsTable thead tr').getBoundingClientRect();
    const cell = document.querySelector('#leadsBody td[colspan]').getBoundingClientRect();
    const pg = document.querySelector('#pager').getBoundingClientRect();
    const empty = document.querySelector('#leadsBody .empty');
    const svg = empty.querySelector('svg').getBoundingClientRect();
    const txt = empty.querySelector('div').getBoundingClientRect();
    return { cols: th.map(e => n(e.getBoundingClientRect().width)),
      wrap: [n(wrap.width), n(wrap.height)], table: [n(tbl.width), n(tbl.height)],
      thead: n(head.height), cell: [n(cell.width), n(cell.height)], pager: [n(pg.width), n(pg.height)],
      svg: [n(svg.width), n(svg.height)], txt: [n(txt.width), n(txt.height)],
      gapSvgTxt: n(txt.top - svg.bottom) };
  });
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(JSON.stringify(out, null, 1));
