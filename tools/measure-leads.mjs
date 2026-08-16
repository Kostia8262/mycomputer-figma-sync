/**
 * Разовый замер вкладки «Заявки» админки: геометрия базового экрана и всех
 * состояний (групповой выбор, поиск, модалки, глобальный поиск) на трёх
 * ширинах макета — Desktop 1440 / Compact 900 / Mobile 390.
 *
 * Нужен для сверки колонки кадров «Заявки» в Figma с продом. Отдельно от
 * `src/snapshot/layout.js`, потому что тот снимает секции верхнего уровня, а
 * здесь важны ширины колонок таблицы, поля модалок и элементы состояний.
 *
 * Замер после каждого действия делается отдельным проходом с паузой: в том же
 * тике layout ещё не пересчитан и размеры приходят нулями.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);

const TOKEN = process.env.MC_ADMIN_TOKEN;
if (!TOKEN) {
  console.error('Нет MC_ADMIN_TOKEN в .env — без него снимется форма логина.');
  process.exit(1);
}

const URL_ADMIN = 'https://mycomputer.education/admin.html';
const OUT = new URL('../state/leads-prod.json', import.meta.url).pathname;

const PROBE = `
(() => {
  const n = v => v == null ? null : Math.round(v * 10) / 10;
  const R = (sel, root) => {
    const e = (root || document).querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (cs.display === 'none') return { display: 'none' };
    return { w: n(r.width), h: n(r.height), x: n(r.left), y: n(r.top),
      pad: cs.padding, gap: cs.gap === 'normal' ? null : cs.gap,
      radius: cs.borderRadius, bg: cs.backgroundColor, fs: cs.fontSize, fw: cs.fontWeight,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor };
  };
  const ALL = (sel, root) => Array.from((root || document).querySelectorAll(sel)).map(e => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { w: n(r.width), h: n(r.height), x: n(r.left), y: n(r.top),
      txt: (e.textContent || '').trim().slice(0, 44), display: cs.display, fs: cs.fontSize, fw: cs.fontWeight };
  });

  return {
    shell: { topbar: R('.topbar'), appBody: R('.app-body'), sidebar: R('.sidebar'), main: R('.main') },
    topbarKids: ALL('.topbar > *'),
    topbarActions: ALL('.topbar .btn, .topbar .gs-wrap'),
    leadsTab: R('#leadsTab'),
    stats: R('#statsRow'),
    statTiles: ALL('#statsRow > *'),
    toolbar: R('#leadsTab .toolbar'),
    toolbarKids: ALL('#leadsTab .toolbar > *'),
    search: R('#searchInput'),
    searchWrap: R('#leadsTab .search-wrap'),
    statusFilter: R('#statusFilter'),
    courseFilter: R('#courseFilter'),
    newLeadBtn: R('#leadsTab .toolbar .btn'),
    bulkBar: R('#leadBulkBar'),
    bulkKids: ALL('#leadBulkBar > *'),
    tableWrap: R('#leadsTableWrap'),
    table: R('#leadsTable'),
    cols: ALL('#leadsTable thead th'),
    thead: R('#leadsTable thead tr'),
    rowCount: document.querySelectorAll('#leadsBody tr').length,
    row1: R('#leadsBody tr'),
    row1Cells: ALL('#leadsBody tr:first-child td'),
    badge: R('#leadsBody tr .badge'),
    rowBtns: ALL('#leadsBody tr:first-child .btn'),
    pager: R('#pager'),
    pagerKids: ALL('#pager > *'),
    hscroll: R('#leadsHScrollBar'),
    emptyCell: R('#leadsBody td[colspan]'),
    modalOverlay: R('#newLeadModal'),
    modalBox: R('#newLeadModal .modal-box'),
    modalHead: R('#newLeadModal h3'),
    modalBody: R('#newLeadModal .modal-body'),
    modalFooter: R('#newLeadModal .modal-footer'),
    modalGroups: ALL('#newLeadModal .modal-group'),
    modalLabels: ALL('#newLeadModal .modal-label'),
    modalInputs: ALL('#newLeadModal .modal-input'),
    modalFooterBtns: ALL('#newLeadModal .modal-footer .btn'),
    phoneRows: R('#nl_phoneRows'),
    phoneRow1: R('#nl_phoneRows > *'),
    phoneAdd: R('#newLeadModal .phone-add'),
    confirmBox: R('#confirmModal .modal-box'),
    confirmHead: R('#confirmModal h3'),
    confirmText: R('#confirmText'),
    confirmFooter: R('#confirmModal .modal-footer'),
    confirmBtns: ALL('#confirmModal .modal-footer .btn'),
    gsWrap: R('#gsWrap'),
    gsInput: R('#gsInput'),
    gsDropdown: R('#gsDropdown'),
    gsKids: ALL('#gsDropdown > *'),
  };
})()
`;

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'compact', width: 900, height: 800 },
  { key: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch();
const out = {};

for (const bp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', TOKEN]);
  const page = await ctx.newPage();
  await page.goto(URL_ADMIN, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('leads'); });
  await page.waitForTimeout(1000);

  const states = {};
  const snap = async (name) => { await page.waitForTimeout(400); states[name] = await page.evaluate(PROBE); };

  await snap('base');

  await page.evaluate(() => { const c = document.getElementById('leadSelectAll'); if (c) { c.checked = true; toggleAllLeadChecks(); } });
  await snap('bulk');
  await page.evaluate(() => { if (typeof clearLeadSelection === 'function') clearLeadSelection(); });

  const q = await page.evaluate(() => {
    const cell = document.querySelector('#leadsBody tr td:nth-child(3)');
    return cell ? (cell.textContent || '').trim().slice(0, 3) : 'а';
  });
  await page.evaluate((v) => { const i = document.getElementById('searchInput'); i.value = v; renderTable(); }, q);
  await snap('searchHit');

  await page.evaluate(() => { const i = document.getElementById('searchInput'); i.value = 'zzzzzq'; renderTable(); });
  await snap('searchEmpty');
  await page.evaluate(() => { const i = document.getElementById('searchInput'); i.value = ''; renderTable(); });

  await page.evaluate(() => openNewLeadModal());
  await snap('modalNew');
  await page.evaluate(() => closeNewLeadModal());

  // Фигурные скобки обязательны: uiConfirm возвращает промис, который резолвится
  // только по клику. Вернув его из evaluate, зависаешь до конца времён.
  await page.evaluate(() => { uiConfirm({ title: 'Видалити заявку?', text: 'Заявку #12 буде видалено назавжди. Цю дію не можна скасувати.' }); });
  await snap('confirm');
  await page.evaluate(() => _uiConfirmClose(false));

  const gq = await page.evaluate(() => {
    const l = (window.allLeads || [])[0];
    return l && l.child_name ? l.child_name.slice(0, 3) : 'ан';
  });
  await page.evaluate((v) => { const i = document.getElementById('gsInput'); i.value = v; globalSearch(v); }, gq);
  await snap('gsearchHit');

  await page.evaluate(() => { const i = document.getElementById('gsInput'); i.value = 'zzzzzq'; globalSearch('zzzzzq'); });
  await snap('gsearchEmpty');

  out[bp.key] = { viewport: bp, states };
  await ctx.close();
  console.error('снято:', bp.key);
}

await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error('записано:', OUT);
