/**
 * Разбор одной колонки таблицы вглубь: что лежит в ячейке и какого размера.
 * `measure-tab.mjs` даёт только первый уровень, а расхождения часто внутри —
 * кнопки в ячейке действий, чип токена, бейджи.
 *
 *   node tools/probe-cell.mjs admins 5   # вкладка и номер колонки
 */

import { chromium } from 'playwright';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const tab = process.argv[2];
const col = Number(process.argv[3]);

const browser = await chromium.launch();
for (const bp of [{ key: 'desktop', width: 1440, height: 900 }, { key: 'compact', width: 900, height: 800 }, { key: 'mobile', width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', process.env.MC_ADMIN_TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate((t) => showTab(t), tab);
  await page.waitForTimeout(1000);
  const res = await page.evaluate(([t, c]) => {
    const n = v => Math.round(v * 10) / 10;
    const walk = (el, depth) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const o = { tag: el.tagName, cls: (el.className || '').toString().slice(0, 24), w: n(r.width), h: n(r.height),
        fs: s.fontSize, pad: s.padding, gap: s.gap === 'normal' ? null : s.gap, radius: s.borderRadius,
        wrap: s.flexWrap, dir: s.flexDirection, txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26) };
      if (depth > 0 && el.children.length) o.kids = Array.from(el.children).map(k => walk(k, depth - 1));
      return o;
    };
    const rows = Array.from(document.querySelectorAll(`#${t}Tab tbody tr`)).slice(0, 2);
    return rows.map(r => r.children[c] ? walk(r.children[c], 2) : null);
  }, [tab, col]);
  console.log('███', bp.key, JSON.stringify(res, null, 1));
  await ctx.close();
}
await browser.close();
