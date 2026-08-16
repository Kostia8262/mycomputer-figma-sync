/**
 * Обход вкладок админки.
 *
 * Админка — SPA: все экраны живут на одном URL, переключаются кликом по
 * сайдбару. Поэтому обычный «зайти по адресу и снять» здесь не работает —
 * снимать надо после каждого переключения.
 *
 * Брейкпоинты у админки свои: 1440 / 900 / 390. Промежуточный называется
 * Compact, а не Tablet, и 1024 в макете нет вовсе — снимать по сайтовой
 * сетке значило бы сверять с несуществующими кадрами.
 */

import { chromium } from 'playwright';
import { applyScenario, resetState } from './scenarios.js';

export const ADMIN_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, figmaSuffix: 'Desktop 1440' },
  { name: 'compact', width: 900, height: 900, figmaSuffix: 'Compact 900' },
  { name: 'mobile', width: 390, height: 844, figmaSuffix: 'Mobile 390' },
];

/** Клик по пункту сайдбара с заданной подписью. */
async function openTab(page, label) {
  const clicked = await page.evaluate((wanted) => {
    const items = [...document.querySelectorAll('#sidebarEl .sidebar-item')];
    // Подпись содержит эмодзи, поэтому сравнение по вхождению, а не по равенству.
    const target = items.find((el) => el.textContent.replace(/\s+/g, ' ').includes(wanted));
    if (!target) return false;
    target.click();
    return true;
  }, label);

  if (!clicked) return { opened: false, reason: 'пункт меню не найден' };

  // Ждём, пока станет видимой хоть одна вкладка: данные подгружаются запросом,
  // и снимок сразу после клика поймал бы пустой контейнер.
  await page.waitForTimeout(1200);
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.main > [id$="Tab"]')].some((n) => n.offsetHeight > 0),
      { timeout: 8000 },
    );
  } catch {
    return { opened: false, reason: 'вкладка не отрисовалась' };
  }

  const active = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.main > [id$="Tab"]')].filter((n) => n.offsetHeight > 0);
    return visible.map((n) => n.id);
  });

  return { opened: true, activeTabIds: active };
}

/**
 * Проходит по вкладкам и снимает геометрию каждой.
 *
 * @param {string} url адрес админки
 * @param {Array<{label: string, figmaName: string}>} tabs что открывать
 * @param {Function} extract функция замера, выполняемая в странице
 * @param {object} options { auth, selector, viewports, extractArgs }
 */
export async function collectAdminTabs(url, tabs, extract, options = {}) {
  const {
    auth,
    selector = '.topbar, .app-body',
    viewports = ADMIN_VIEWPORTS,
    extractArgs = {},
    scenarios = [],
    onProgress,
  } = options;

  const browser = await chromium.launch();
  const captured = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });

      if (auth?.localStorage) {
        await context.addInitScript((entries) => {
          for (const [key, value] of Object.entries(entries)) {
            window.localStorage.setItem(key, value);
          }
        }, auth.localStorage);
      }

      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important;}',
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);

      const screens = [];
      for (const tab of tabs) {
        const result = await openTab(page, tab.label);
        if (!result.opened) {
          screens.push({ tab: tab.label, figmaName: tab.figmaName, status: result.reason });
          onProgress?.(viewport.name, tab.label, result.reason);
          continue;
        }

        const data = await page.evaluate(extract, { ...extractArgs, selector });
        screens.push({
          tab: tab.label,
          figmaName: `${tab.figmaName} — ${viewport.figmaSuffix}`,
          status: 'ok',
          activeTabIds: result.activeTabIds,
          ...data,
        });
        onProgress?.(viewport.name, tab.label, `секций ${data.sections.length}`);

        // Состояния поверх вкладки: модалки, поиск, подтверждения.
        for (const scenario of scenarios.filter((s) => s.tab === tab.label)) {
          const applied = await applyScenario(page, scenario.steps);
          if (!applied.ok) {
            screens.push({ tab: tab.label, scenario: scenario.id,
              figmaName: `${scenario.figmaName} — ${viewport.figmaSuffix}`,
              status: `шаг ${applied.failedAt}: ${applied.reason}` });
            onProgress?.(viewport.name, scenario.id, `не удалось: шаг ${applied.failedAt}`);
          } else {
            const stateData = await page.evaluate(extract, { ...extractArgs, selector });
            screens.push({ tab: tab.label, scenario: scenario.id,
              figmaName: `${scenario.figmaName} — ${viewport.figmaSuffix}`,
              status: 'ok', ...stateData });
            onProgress?.(viewport.name, scenario.id, `секций ${stateData.sections.length}`);
          }

          // Следующий сценарий не должен наследовать открытую модалку.
          // Переоткрытие вкладки её не убирает — оверлей живёт над всем
          // приложением, поэтому неснятое состояние требует перезагрузки.
          const clean = await resetState(page);
          if (clean) {
            await openTab(page, tab.label);
          } else {
            await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
            await page.addStyleTag({
              content: '*,*::before,*::after{animation:none!important;transition:none!important;}',
            });
            await openTab(page, tab.label);
          }
        }
      }

      captured.push({ viewport: viewport.name, width: viewport.width, screens });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return { url, selector, engine: 'chromium-headless', viewports: captured };
}
