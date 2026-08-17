/**
 * Замер личного дела сотрудника (`#staffProfileTab`) — подэкран вкладки
 * «Співробітники», который открывается кликом по имени и потому не снимается
 * обычным `measure-tab.mjs`.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const OUT = new URL('../state/tab-staff-profile.json', import.meta.url).pathname;

const PROBE = `
(() => {
  const n = v => v == null ? null : Math.round(v * 10) / 10;
  const root = document.getElementById('staffProfileTab');
  const main = document.querySelector('.main');
  const mr = main.getBoundingClientRect();
  const rel = (e) => { const r = e.getBoundingClientRect();
    return { w: n(r.width), h: n(r.height), x: n(r.left - mr.left), y: n(r.top - mr.top) }; };
  const list = (sel) => Array.from(root.querySelectorAll(sel)).map(e => {
    const cs = getComputedStyle(e);
    return Object.assign(rel(e), { id: e.id || null, cls: (e.className || '').toString().slice(0, 30),
      txt: (e.textContent || '').trim().slice(0, 28), display: cs.display, pad: cs.padding, gap: cs.gap });
  });
  return {
    root: rel(root),
    blocks: Array.from(root.children).filter(e => getComputedStyle(e).display !== 'none').map(e => Object.assign(rel(e),
      { id: e.id || null, cls: (e.className || '').toString().slice(0, 30), mb: getComputedStyle(e).marginBottom,
        txt: (e.textContent || '').trim().slice(0, 30) })),
    cards: list('.card, .sp-card, .profile-card, section').map((c, i) => {
      const el = root.querySelectorAll('.card, .sp-card, .profile-card, section')[i];
      const cs = getComputedStyle(el);
      return Object.assign(c, { radius: cs.borderRadius, cardPad: cs.padding, gap: cs.gap,
        kids: Array.from(el.children).map(e => {
          const r = e.getBoundingClientRect(), s = getComputedStyle(e);
          return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 22), w: n(r.width), h: n(r.height),
            fs: s.fontSize, txt: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 42) };
        }) });
    }),
    fields: list('.modal-group, .form-row, .field').slice(0, 20),
    tables: Array.from(root.querySelectorAll('table')).map(t => ({
      box: rel(t), headers: Array.from(t.querySelectorAll('thead th')).map(h => ({ txt: h.textContent.trim().slice(0, 16), w: n(h.getBoundingClientRect().width) })),
      rows: t.querySelectorAll('tbody tr').length,
      rowH: t.querySelector('tbody tr') ? n(t.querySelector('tbody tr').getBoundingClientRect().height) : null })),
  };
})()
`;

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
  await page.evaluate(() => { showTab('admins'); });
  await page.waitForTimeout(900);
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('#adminsBody button[onclick^="openStaffProfile"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(1600);
  out[bp.key] = opened ? await page.evaluate(PROBE) : { error: 'не знайшов кнопку профілю' };
  await ctx.close();
  console.error('снято:', bp.key, opened ? '' : '(профиль не открылся)');
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) {
  if (v.error) { console.log(k, v.error); continue; }
  console.log(`\n███ ${k}  екран ${v.root.w}×${v.root.h}@${v.root.y}`);
  console.log(' блоки:', v.blocks.map(b => `${b.id || b.cls.split(' ')[0] || '·'} ${b.w}×${b.h}@${b.y} mb=${b.mb}`).join(' | '));
  console.log(' картки:', v.cards.slice(0, 8).map(c => `${c.cls.split(' ')[0]} ${c.w}×${c.h}@${c.y}`).join(' | '));
  for (const t of v.tables) console.log(` таблиця ${t.box.w}×${t.box.h}@${t.box.y}, рядків ${t.rows}, рядок ${t.rowH}, колонки ${t.headers.map(h => h.txt + '=' + h.w).join(' ')}`);
}
console.log('\nфайл:', OUT);
