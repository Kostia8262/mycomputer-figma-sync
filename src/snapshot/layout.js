/**
 * Снимает геометрию живого сайта: положение, размеры и ключевые стили секций
 * и их содержимого на трёх брейкпоинтах.
 *
 * Брейкпоинты — те же, что режимы в макете (Desktop 1440 / Tablet 1024 /
 * Mobile 390), иначе сравнивать будет не с чем.
 *
 * Слепок обязан быть детерминированным: он ложится в git, и разница между
 * деплоями должна показывать реальные изменения, а не дрожание чисел. Отсюда
 * округление, стабильные ключи вместо индексов по порядку и отключение анимаций.
 */

import { chromium } from 'playwright';

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/** Сколько уровней вглубь секции снимать и сколько детей на уровне. */
const MAX_DEPTH = 3;
const MAX_CHILDREN = 24;

/**
 * Свойства, по которым имеет смысл ловить расхождение с макетом.
 * Всё подряд снимать нельзя — computed style это сотни строк на узел,
 * и слепок перестанет быть читаемым в diff.
 */
const TRACKED_STYLES = [
  'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
  'gridTemplateColumns', 'flexWrap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginBottom',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'borderRadius', 'boxShadow', 'opacity',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopColor', 'textAlign', 'textTransform',
];

/**
 * Код, выполняемый внутри страницы. Пишется как одна функция без внешних
 * ссылок — в контексте браузера ничего из модуля не видно.
 */
function extractInPage({ maxDepth, maxChildren, tracked }) {
  const round = (n) => Math.round(n * 10) / 10;

  /** Стабильный ключ узла: id, затем классы, затем позиция среди одинаковых. */
  const keyOf = (el) => {
    if (el.id) return `#${el.id}`;
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    const base = classes.length ? `.${classes.slice(0, 2).join('.')}` : el.tagName.toLowerCase();
    const siblings = el.parentElement ? [...el.parentElement.children].filter((s) => {
      const sc = typeof s.className === 'string' ? s.className.trim().split(/\s+/).filter(Boolean) : [];
      const sb = sc.length ? `.${sc.slice(0, 2).join('.')}` : s.tagName.toLowerCase();
      return sb === base;
    }) : [el];
    return siblings.length > 1 ? `${base}[${siblings.indexOf(el)}]` : base;
  };

  const stylesOf = (el) => {
    const computed = getComputedStyle(el);
    const out = {};
    for (const prop of tracked) {
      const value = computed[prop];
      if (value === undefined || value === '' || value === 'none' || value === 'normal') continue;
      if (value === '0px' || value === 'rgba(0, 0, 0, 0)') continue;
      out[prop] = value;
    }
    return out;
  };

  /** Псевдоэлементы не видны обходу DOM, а в них бывает значимый контент. */
  const pseudoOf = (el) => {
    const out = {};
    for (const which of ['::before', '::after']) {
      const computed = getComputedStyle(el, which);
      const content = computed.content;
      if (!content || content === 'none' || content === 'normal') continue;
      out[which] = {
        content,
        width: computed.width,
        height: computed.height,
        backgroundColor: computed.backgroundColor,
      };
    }
    return Object.keys(out).length ? out : undefined;
  };

  const hasBorder = (el) => {
    const c = getComputedStyle(el);
    return ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
      .some((p) => parseFloat(c[p]) > 0);
  };

  const describe = (el, parentRect, depth) => {
    const rect = el.getBoundingClientRect();
    const node = {
      key: keyOf(el),
      tag: el.tagName.toLowerCase(),
      // Относительная позиция устойчивее абсолютной: сдвиг верхней секции
      // иначе «сдвинул» бы всё, что ниже, и слепок утонул бы в ложных отличиях.
      rel: { x: round(rect.left - parentRect.left), y: round(rect.top - parentRect.top) },
      size: { w: round(rect.width), h: round(rect.height) },
      styles: stylesOf(el),
    };

    // Отметка нужна отчёту: у элементов с границами headless занижает размер
    // (1px рендерится как 0.8px), поэтому там применяется допуск.
    if (hasBorder(el)) node.bordered = true;

    const pseudo = pseudoOf(el);
    if (pseudo) node.pseudo = pseudo;

    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
    if (text) node.text = text.slice(0, 120);

    if (depth < maxDepth) {
      const kids = [...el.children].filter((child) => {
        const c = getComputedStyle(child);
        return c.display !== 'none' && c.visibility !== 'hidden';
      });
      if (kids.length) {
        node.children = kids.slice(0, maxChildren).map((child) => describe(child, rect, depth + 1));
        if (kids.length > maxChildren) node.truncatedChildren = kids.length - maxChildren;
      }
    }
    return node;
  };

  const sections = [...document.querySelectorAll('section[id], header, footer')];
  const pageRect = document.documentElement.getBoundingClientRect();

  return {
    documentHeight: round(document.documentElement.scrollHeight),
    sections: sections.map((section) => {
      const rect = section.getBoundingClientRect();
      const node = describe(section, pageRect, 1);
      // Абсолютная позиция от верха документа — для контекста в отчёте.
      node.absoluteTop = round(rect.top + window.scrollY);
      return node;
    }),
  };
}

/**
 * @param {string} url страница продакшена
 * @returns {Promise<object>} слепок геометрии по всем брейкпоинтам
 */
export async function collectLayout(url, { viewports = VIEWPORTS } = {}) {
  const browser = await chromium.launch();
  const captured = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        // Анимации сдвигают элементы в момент замера и делают слепок недетерминированным.
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important;}',
      });

      // Без этого замер попадает в момент, когда Inter ещё не подставился, и
      // текст мерится запасным шрифтом: логотип «менялся» на 3.5 px, а hero —
      // на 29 px между двумя прогонами подряд. Ложные находки в чистом виде.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);

      const data = await page.evaluate(extractInPage, {
        maxDepth: MAX_DEPTH,
        maxChildren: MAX_CHILDREN,
        tracked: TRACKED_STYLES,
      });

      captured.push({ viewport: viewport.name, width: viewport.width, ...data });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return {
    url,
    engine: 'chromium-headless',
    // Предупреждение живёт в самом слепке: правило легко забыть, а цена ошибки
    // уже была — «регрессия −4.2px» в FAQ оказалась артефактом рендеринга границ.
    caveat: 'headless рендерит border:1px как 0.8px — расхождения до 1.5px у bordered-узлов не считать дефектом',
    viewports: captured,
  };
}
