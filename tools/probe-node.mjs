/**
 * Дерево произвольного узла вкладки на трёх ширинах: размеры, отступы, тексты.
 * Нужен там, где вкладка собрана не из таблиц, а из карточек и форм — курсы,
 * программы, контент, модули.
 *
 *   node tools/probe-node.mjs courses "#coursesGrid" 2
 *   node tools/probe-node.mjs content ".cms-section" 1 --sub "showCmsSection('faq')"
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';

await loadEnv(new URL('../.env', import.meta.url).pathname);
const [tab, selector, depthArg] = process.argv.slice(2);
const depth = Number(depthArg || 2);
const subIdx = process.argv.indexOf('--sub');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1].split(',') : ['desktop', 'compact', 'mobile'];

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'compact', width: 900, height: 800 },
  { key: 'mobile', width: 390, height: 844 },
].filter(v => only.includes(v.key));

const browser = await chromium.launch();
const out = {};
for (const bp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', process.env.MC_ADMIN_TOKEN]);
  const page = await ctx.newPage();
  await page.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.evaluate((t) => showTab(t), tab);
  await page.waitForTimeout(1200);
  if (subIdx > -1) { await page.evaluate((code) => { eval(code); }, process.argv[subIdx + 1]); await page.waitForTimeout(900); }
  out[bp.key] = await page.evaluate(([sel, d]) => {
    const n = v => Math.round(v * 10) / 10;
    const walk = (el, depth) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const o = { tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 28),
        w: n(r.width), h: n(r.height), x: n(r.left), y: n(r.top), pad: s.padding, gap: s.gap === 'normal' ? null : s.gap,
        radius: s.borderRadius, fs: s.fontSize, cols: s.gridTemplateColumns && s.gridTemplateColumns !== 'none' ? s.gridTemplateColumns : null,
        txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 34) };
      if (depth > 0 && el.children.length) o.kids = Array.from(el.children).slice(0, 12).map(k => walk(k, depth - 1));
      return o;
    };
    const root = document.querySelector(sel);
    return root ? walk(root, d) : { error: 'не знайдено ' + sel };
  }, [selector, depth]);
  await ctx.close();
  console.error('снято:', bp.key);
}
await browser.close();
const file = new URL(`../state/probe-${tab}.json`, import.meta.url).pathname;
writeFileSync(file, JSON.stringify(out, null, 1));

const short = (o, ind = '') => {
  if (!o || o.error) return ind + (o ? o.error : '—');
  const line = `${ind}${o.id ? '#' + o.id : (o.cls ? '.' + o.cls.split(' ')[0] : o.tag)} ${o.w}×${o.h}@${o.y}` +
    (o.gap ? ` gap ${o.gap}` : '') + (o.cols ? ` cols ${o.cols}` : '') + (o.pad !== '0px' ? ` pad ${o.pad}` : '') +
    (o.kids ? '' : `  «${o.txt}»`);
  return [line, ...(o.kids || []).map(k => short(k, ind + '   '))].join('\n');
};
for (const [k, v] of Object.entries(out)) console.log(`\n███ ${k}\n` + short(v));
console.log('\nфайл:', file);
