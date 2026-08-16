/**
 * Разбор истории `admin.html` по вкладкам: какие разделы админки менялись за
 * период и насколько сильно. Коммит относится к вкладке по маркерам (id секции,
 * имена функций и префиксы классов), встреченным в изменённых строках.
 *
 * Нужен, чтобы понимать, какие экраны макета отстали от прода, не читая diff руками.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = process.env.MC_REPO_PATH || '/Users/kostiantyn/Projects/my-computer-new';
const FILE = 'sites/main/admin.html';
const SINCE = process.argv[2] || '2026-08-01';

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const TABS = {
  'Заявки': [/leadsTab/, /renderTable\b/, /allLeads/, /leadBulk/, /NewLeadModal/, /statusFilter/, /leadsTable/],
  'База клієнтів': [/clientsTab/, /renderClients/, /_allClients/, /clientModal/, /client-subtabs/, /csub-/, /clientsTable/],
  'Оплати': [/paymentsTab/, /renderPayments/, /payMonth/, /paymentsTable/, /\bpay[A-Z]/],
  'Відвідування': [/attendanceTab/, /renderAttendance/, /att-/, /attTable/],
  'Розклад': [/scheduleTab/, /renderSchedule/, /sched-/, /schedTable/],
  'Уроки учнів': [/lessonsTab/, /renderLessons/, /ltModal/, /lessonToken/, /LessonToken/],
  'Сертифікати': [/giftTab/, /renderGift/, /giftIssue/, /giftSlot/, /giftCamp/, /ageGroup/, /gift-/],
  'Свідоцтва': [/certificatesTab/, /renderCerts/, /_certs\b/, /cert-/, /certsTable/],
  'Мої подарункові': [/giftMineTab/, /renderGiftMine/],
  'Курси': [/coursesTab/, /renderCourses/, /courseModal/],
  'Програми': [/programsTab/, /renderPrograms/, /moduleModal/, /prog-/],
  'Модулі': [/modulesTab/, /renderModules/, /blockToggle/, /mod-/],
  'Статті': [/articlesTab/, /renderArticles/, /articleModal/, /art-/],
  'Відгуки': [/reviewsTab/, /renderReviews/, /reviewModal/, /rev-/],
  'SEO тексти': [/seoTab/, /renderSeo/, /seo-/],
  'Співробітники': [/staffTab/, /renderStaff/, /teacherProfile/, /staffTable/, /tp_/],
  'Контент сайту': [/cmsTab/, /cms-/, /savePricing/, /saveFaq/, /faqEditor/],
  'Дашборд': [/dashTab/, /dash-/, /renderDash/, /unit-/, /dkpi/, /rv-range/],
  'Оболонка (шапка, сайдбар, спільне)': [/topbar/, /sidebar/, /showTab\(/, /gs-(input|item|dropdown|wrap)/, /modal-(box|grid|footer|group)/, /\.toolbar/, /table-wrap/, /bulk-bar/, /sticky-hscroll/, /\.pager/, /TAB_ACCESS/],
};

const commits = git('log', `--since=${SINCE}`, '--format=%H\t%ad\t%s', '--date=short', '--', FILE)
  .trim().split('\n').filter(Boolean)
  .map(l => { const [hash, date, ...s] = l.split('\t'); return { hash, date, subject: s.join('\t') }; });

const perTab = {};
for (const key of Object.keys(TABS)) perTab[key] = { commits: [], lines: 0 };
const unmatched = [];

for (const c of commits) {
  let diff = '';
  try { diff = git('show', '--unified=0', '--format=', c.hash, '--', FILE); } catch { continue; }
  const changed = diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  c.lines = changed.length;
  const body = changed.join('\n');
  const hits = [];
  for (const [tab, markers] of Object.entries(TABS)) {
    const score = markers.reduce((acc, re) => acc + (body.match(new RegExp(re.source, 'g')) || []).length, 0);
    if (score > 0) hits.push({ tab, score });
  }
  hits.sort((a, b) => b.score - a.score);
  // Коммит засчитываем вкладкам, набравшим заметную долю совпадений: правки часто
  // задевают и раздел, и общую оболочку.
  const top = hits.filter(h => h.score >= Math.max(2, hits[0] ? hits[0].score * 0.25 : 0)).slice(0, 3);
  if (!top.length) { unmatched.push(c); continue; }
  for (const h of top) { perTab[h.tab].commits.push({ ...c, score: h.score }); perTab[h.tab].lines += c.lines; }
}

const summary = Object.entries(perTab)
  .map(([tab, v]) => ({ tab, commits: v.commits.length, lines: v.lines, subjects: v.commits.map(c => c.date + ' ' + c.subject) }))
  .filter(v => v.commits > 0)
  .sort((a, b) => b.lines - a.lines);

writeFileSync(new URL('../state/tab-changes.json', import.meta.url).pathname,
  JSON.stringify({ since: SINCE, total: commits.length, summary, unmatched: unmatched.map(c => c.date + ' ' + c.subject) }, null, 1));

console.log(`коммитов по ${FILE} с ${SINCE}: ${commits.length}`);
console.log('строк изменено всего:', commits.reduce((a, c) => a + (c.lines || 0), 0));
console.log('');
for (const s of summary) console.log(String(s.lines).padStart(6), 'стр.', String(s.commits).padStart(3), 'ком.', ' ', s.tab);
if (unmatched.length) console.log('\nбез классификации:', unmatched.length);
