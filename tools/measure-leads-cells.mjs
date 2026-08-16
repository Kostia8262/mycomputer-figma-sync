/**
 * Содержимое ячеек строки таблицы «Заявки»: какие контролы стоят в колонках
 * Курс / Викладач / Розклад / Нотатки, их размеры и правила переноса текста.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const OUT = new URL('../state/leads-prod-cells.json', import.meta.url).pathname;

const browser = await chromium.launch();
const out = {};
for (const bp of [{ key: 'desktop', width: 1440, height: 900 }, { key: 'mobile', width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', process.env.MC_ADMIN_TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { showTab('leads'); });
  await page.waitForTimeout(900);
  out[bp.key] = await page.evaluate(() => {
    const n = v => Math.round(v * 10) / 10;
    const headers = Array.from(document.querySelectorAll('#leadsTable thead th')).map(t => t.textContent.trim());
    const rows = Array.from(document.querySelectorAll('#leadsBody tr')).slice(0, 4);
    return {
      headers,
      rowHeights: rows.map(r => n(r.getBoundingClientRect().height)),
      rows: rows.map(r => Array.from(r.children).map((td, i) => {
        const tdr = td.getBoundingClientRect(), tds = getComputedStyle(td);
        const kids = Array.from(td.querySelectorAll('*')).filter(e => e.parentElement === td).map(e => {
          const r = e.getBoundingClientRect(), s = getComputedStyle(e);
          return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 26),
            w: n(r.width), h: n(r.height), fs: s.fontSize, fw: s.fontWeight,
            white: s.whiteSpace, ov: s.textOverflow, pad: s.padding, radius: s.borderRadius,
            border: s.borderWidth + ' ' + s.borderColor, bg: s.backgroundColor, color: s.color,
            val: (e.tagName === 'SELECT' ? (e.selectedOptions[0] || {}).text : (e.value !== undefined ? e.value : e.textContent)) || '' };
        });
        return { col: i, header: headers[i], w: n(tdr.width), h: n(tdr.height), pad: tds.padding,
          text: td.textContent.trim().slice(0, 40), kids };
      })),
    };
  });
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error('записано:', OUT);
