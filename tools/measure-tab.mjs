/**
 * Универсальный замер вкладки админки на трёх ширинах макета.
 *
 * Снимает то, из чего собран любой экран панели: оболочку, ряд плиток, тулбар,
 * таблицу с ширинами колонок, пейджер, панель группового выбора — и всё это в
 * координатах относительно `main`, потому что именно так экраны собраны в Figma.
 *
 *   node tools/measure-tab.mjs admins            # вкладка (id без суффикса Tab)
 *   node tools/measure-tab.mjs payments --wait 1200
 *
 * Результат — state/tab-<id>.json, в консоль идёт короткая сводка.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const TOKEN = process.env.MC_ADMIN_TOKEN;
if (!TOKEN) { console.error('нет MC_ADMIN_TOKEN в .env'); process.exit(1); }

const tab = process.argv[2];
if (!tab) { console.error('укажи вкладку: node tools/measure-tab.mjs <tab>'); process.exit(1); }
const waitArg = process.argv.indexOf('--wait');
const EXTRA_WAIT = waitArg > -1 ? Number(process.argv[waitArg + 1]) : 900;

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'compact', width: 900, height: 800 },
  { key: 'mobile', width: 390, height: 844 },
];

const PROBE = (tabId) => `
(() => {
  const n = v => v == null ? null : Math.round(v * 10) / 10;
  const root = document.getElementById('${tabId}Tab') || document.querySelector('.main');
  const main = document.querySelector('.main');
  const mr = main.getBoundingClientRect();
  // Координаты внутри main: экраны в Figma собраны именно так
  const rel = (el) => { const r = el.getBoundingClientRect();
    return { w: n(r.width), h: n(r.height), x: n(r.left - mr.left), y: n(r.top - mr.top) }; };
  const one = (sel, ctx) => { const e = (ctx || root).querySelector(sel); if (!e) return null;
    const cs = getComputedStyle(e); if (cs.display === 'none') return { display: 'none' };
    return Object.assign(rel(e), { pad: cs.padding, gap: cs.gap === 'normal' ? null : cs.gap, radius: cs.borderRadius, fs: cs.fontSize }); };
  const many = (sel, ctx) => Array.from((ctx || root).querySelectorAll(sel)).map(e => {
    const cs = getComputedStyle(e);
    return Object.assign(rel(e), { txt: (e.textContent || '').trim().slice(0, 30), display: cs.display, fs: cs.fontSize });
  });

  const blocks = Array.from(root.children).map(e => {
    const cs = getComputedStyle(e);
    return Object.assign(rel(e), { id: e.id || null, cls: (e.className || '').toString().slice(0, 34),
      display: cs.display, mb: cs.marginBottom, txt: (e.textContent || '').trim().slice(0, 26) });
  }).filter(b => b.display !== 'none');

  const tables = Array.from(root.querySelectorAll('table')).map(t => ({
    id: t.id || null,
    box: rel(t),
    wrap: t.closest('.table-wrap') ? rel(t.closest('.table-wrap')) : null,
    headers: Array.from(t.querySelectorAll('thead th')).map(h => ({ w: n(h.getBoundingClientRect().width), txt: h.textContent.trim().slice(0, 18) })),
    rows: t.querySelectorAll('tbody tr').length,
    rowH: t.querySelector('tbody tr') ? n(t.querySelector('tbody tr').getBoundingClientRect().height) : null,
    headH: t.querySelector('thead tr') ? n(t.querySelector('thead tr').getBoundingClientRect().height) : null,
    // Содержимое первой строки: по нему видно, из чего собрана ячейка и
    // переносится ли текст — высота строки одна этого не показывает
    cells: Array.from((t.querySelector('tbody tr') || { children: [] }).children).map((td, i) => ({
      col: i,
      w: n(td.getBoundingClientRect().width),
      pad: getComputedStyle(td).padding,
      kids: Array.from(td.children).map(e => {
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 24),
          w: n(r.width), h: n(r.height), fs: s.fontSize, white: s.whiteSpace,
          txt: (e.value !== undefined ? e.value : e.textContent || '').trim().slice(0, 24) };
      }),
    })),
  }));

  return {
    shell: { topbar: one('.topbar', document), sidebar: one('.sidebar', document), main: one('.main', document),
             mainPad: getComputedStyle(main).padding },
    blocks,
    stats: one('.stats'), statTiles: many('.stats > *'),
    toolbar: one('.toolbar'), toolbarKids: many('.toolbar > *'),
    subtabs: one('.client-subtabs, .cms-subtabs, .segmented, .subtabs'),
    subtabKids: many('.client-subtabs > *, .cms-subtabs > *, .segmented > *, .subtabs > *'),
    bulk: one('.bulk-bar'), bulkKids: many('.bulk-bar > *'),
    tables,
    pager: one('.pager'), pagerKids: many('.pager > *'),
    cards: many('.card, .fin-card, .cms-section, .group-card').slice(0, 12),
  };
})()
`;

const browser = await chromium.launch();
const out = {};
for (const bp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate((t) => { showTab(t); }, tab);
  await page.waitForTimeout(EXTRA_WAIT);

  // Подвкладка: строка вызова, например --sub "showGiftSubTab('certs')"
  const subArg = process.argv.indexOf('--sub');
  if (subArg > -1) {
    await page.evaluate((code) => { eval(code); }, process.argv[subArg + 1]);
    await page.waitForTimeout(EXTRA_WAIT);
  }
  out[bp.key] = await page.evaluate(PROBE(tab));

  // Пустое состояние снимаем подменой строк в своём же браузере: на проде данные
  // есть, а кадр «Порожній стан» в макете сверять с чем-то надо.
  const emptyArg = process.argv.indexOf('--empty');
  if (emptyArg > -1) {
    const [bodyId, colspan, pad, text] = process.argv.slice(emptyArg + 1, emptyArg + 5);
    await page.evaluate(([id, cs, p, t]) => {
      const body = document.getElementById(id);
      if (body) body.innerHTML = `<tr><td colspan="${cs}"><div class="empty" style="padding:${p}">${t}</div></td></tr>`;
    }, [bodyId, colspan, pad, text]);
    await page.waitForTimeout(400);
    out[bp.key].empty = await page.evaluate(PROBE(tab));
  }
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
const file = new URL(`../state/tab-${tab}.json`, import.meta.url).pathname;
writeFileSync(file, JSON.stringify(out, null, 1));

const box = (o) => o ? (o.display === 'none' ? '—' : `${o.w}×${o.h}@${o.y}`) : '—';
for (const [k, v] of Object.entries(out)) {
  console.log(`\n███ ${k}  main ${box(v.shell.main)} pad ${v.shell.mainPad}`);
  console.log(' блоки:', v.blocks.map(b => `${b.id || b.cls.split(' ')[0] || '·'} ${b.w}×${b.h}@${b.y}`).join(' | '));
  if (v.stats) console.log(' плитки:', v.statTiles.map(t => `${t.w}×${t.h}`).join(' '));
  if (v.toolbar) console.log(' тулбар:', box(v.toolbar), '→', v.toolbarKids.map(t => `${t.w}×${t.h}@${t.x},${t.y}`).join(' '));
  if (v.subtabs) console.log(' підвкладки:', box(v.subtabs), '→', v.subtabKids.map(t => `${t.txt}=${t.w}`).join(' '));
  for (const t of v.tables) console.log(` таблиця ${t.id || ''}: ${t.box.w}×${t.box.h}@${t.box.y}, обгортка ${t.wrap ? t.wrap.w + '×' + t.wrap.h : '—'}, шапка ${t.headH}, рядок ${t.rowH}, рядків ${t.rows}\n   колонки: ${t.headers.map(h => h.txt + '=' + h.w).join('  ')}`);
  if (v.pager) console.log(' пейджер:', box(v.pager), v.pagerKids.map(p => p.txt).join(' | '));
}
console.log('\nфайл:', file);
