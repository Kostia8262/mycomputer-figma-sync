import { chromium } from 'playwright';
import { loadEnv } from '../src/env.js';
await loadEnv('new URL("../.env", import.meta.url).pathname');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['mca_admin_token', process.env.MC_ADMIN_TOKEN]);
const p = await ctx.newPage();
await p.goto('https://mycomputer.education/admin.html', { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(1400);
await p.evaluate(() => showTab('admins')); await p.waitForTimeout(800);
await p.waitForSelector('#adminsBody button[onclick^="openStaffProfile"]', { timeout: 20000 });
await p.evaluate(() => document.querySelector('#adminsBody button[onclick^="openStaffProfile"]').click());
await p.waitForTimeout(1600);
const r = await p.evaluate(() => {
  const n = v => Math.round(v * 10) / 10;
  const root = document.getElementById('staffProfileTab');
  const cards = Array.from(root.querySelectorAll('.card'));
  return cards.map(c => {
    const cr = c.getBoundingClientRect(), cs = getComputedStyle(c);
    return { w: n(cr.width), h: n(cr.height), pad: cs.padding, gap: cs.gap, radius: cs.borderRadius,
      head: (c.querySelector('h3,h4,.card-title,strong') || {}).textContent || '',
      kids: Array.from(c.children).map(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return { tag: e.tagName, cls: (e.className||'').toString().slice(0,22), w: n(r.width), h: n(r.height), fs: s.fontSize,
                 txt: (e.textContent||'').trim().replace(/\s+/g,' ').slice(0, 40) }; }) };
  });
});
console.log(JSON.stringify(r, null, 1));
await b.close();
