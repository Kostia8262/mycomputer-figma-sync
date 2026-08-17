/**
 * Замер оболочки админки — шапки и сайдбара, общих для всех вкладок.
 * Отдельно от `measure-tab.mjs`, потому что там всё меряется относительно `main`,
 * а здесь нужны абсолютные размеры самой рамки приложения.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const OUT = new URL('../state/shell.json', import.meta.url).pathname;

const PROBE = `
(() => {
  const n = v => v == null ? null : Math.round(v * 10) / 10;
  const box = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { w: n(r.width), h: n(r.height), x: n(r.left), y: n(r.top), pad: s.padding, gap: s.gap === 'normal' ? null : s.gap,
      radius: s.borderRadius, fs: s.fontSize, bg: s.backgroundColor, display: s.display }; };
  const kids = (sel) => { const root = document.querySelector(sel); if (!root) return null;
    return Array.from(root.children).map(e => Object.assign(box(e), { id: e.id || null,
      cls: (e.className || '').toString().slice(0, 26), txt: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 26) })); };
  const sidebar = document.querySelector('.sidebar');
  const items = Array.from(sidebar.querySelectorAll('.sidebar-item')).filter(e => getComputedStyle(e).display !== 'none');
  return {
    topbar: box(document.querySelector('.topbar')),
    topbarKids: kids('.topbar'),
    left: kids('.topbar-left'),
    right: kids('.topbar-right'),
    sidebar: box(sidebar),
    sidebarKids: kids('.sidebar-nav') || kids('.sidebar'),
    navItems: items.map(e => Object.assign(box(e), { txt: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 22) })),
    sections: Array.from(sidebar.querySelectorAll('.sidebar-section')).filter(e => getComputedStyle(e).display !== 'none')
      .map(e => Object.assign(box(e), { txt: (e.textContent || '').trim().slice(0, 20) })),
    siteSelect: (() => { const e = sidebar.querySelector('select, .site-select'); return e ? box(e) : null; })(),
    roleBadge: (() => { const e = document.querySelector('.role-badge, #roleBadge'); return e ? box(e) : null; })(),
    appBody: box(document.querySelector('.app-body')),
    main: box(document.querySelector('.main')),
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
  await page.waitForTimeout(1600);
  out[bp.key] = await page.evaluate(PROBE);
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) {
  console.log(`\n███ ${k}`);
  console.log(' topbar', v.topbar.w + '×' + v.topbar.h, 'pad', v.topbar.pad, '| left', v.left ? v.left.map(x => x.w + '×' + x.h).join(' ') : '—');
  console.log(' right:', v.right ? v.right.map(x => (x.id || x.cls.split(' ')[0] || '·') + ' ' + x.w + '×' + x.h).join(' | ') : '—');
  console.log(' sidebar', v.sidebar.w + '×' + v.sidebar.h, 'pad', v.sidebar.pad, '| роль', v.roleBadge ? v.roleBadge.w + '×' + v.roleBadge.h : '—');
  console.log(' пункти:', v.navItems.length, '| перший', v.navItems[0] ? v.navItems[0].w + '×' + v.navItems[0].h + '@' + v.navItems[0].y : '—',
    '| крок', v.navItems[1] ? (v.navItems[1].y - v.navItems[0].y) : '—');
  console.log(' секції:', v.sections.map(s => s.txt + ' ' + s.w + '×' + s.h + '@' + s.y).join(' | ') || '—');
  console.log(' селектор сайту:', v.siteSelect ? v.siteSelect.w + '×' + v.siteSelect.h + '@' + v.siteSelect.y : '—');
}
console.log('\nфайл:', OUT);
