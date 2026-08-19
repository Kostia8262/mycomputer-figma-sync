/**
 * Снимает ТЕКСТ живого сайта — то, чего сверка геометрии не видит в принципе.
 *
 * Геометрия ловит только последствия: в подвале макета не хватало двух ссылок,
 * и агент 17.08 сообщил «Footer ниже на 78 px», не назвав ни одной из них.
 * Правки же, не меняющие высоты, — «Roblox (7–14)» вместо «6–14», переставленный
 * пункт, старое название курса — не попадали в отчёт вообще.
 *
 * Собирается плоский список строк на секцию, а не дерево: сверять всё равно
 * приходится по содержимому, а дерево у прода и макета устроено по-разному.
 *
 * Слепок платформонезависим — текст один и тот же на маке и на Windows, поэтому
 * файл общий (в отличие от геометрии, разложенной по ОС).
 */

import { chromium } from 'playwright';
import { VIEWPORTS, LOCALE } from './layout.js';

/** Больше строк на секцию — это уже не сверка, а выгрузка контента. */
export const MAX_LINES = 200;
/** Той же длины обрезка, что у текста в слепке геометрии. */
export const MAX_LEN = 120;

const DEFAULT_SELECTOR = 'section[id], header, footer';

/**
 * Код, выполняемый внутри страницы: без внешних ссылок, всё нужное — аргументом.
 */
export function extractTextInPage({ selector, maxLines, maxLen, skipSections, ignore }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'PATH', 'OPTION']);
  /**
   * Теги, которые вообще бывают одним текстовым слоем.
   *
   * `div` в списке нет намеренно: он носит раскладку. Плитка «Академія в
   * цифрах» — это `div` с строчными детьми, и без такого разделения вся сетка
   * слипалась в одну строку длиной в секцию, хотя в макете это четыре слоя.
   */
  const TEXT_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'A', 'BUTTON', 'LABEL', 'SPAN',
    'STRONG', 'EM', 'B', 'I', 'SMALL', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE',
    'SUMMARY', 'DT', 'DD', 'CAPTION', 'LEGEND', 'TIME', 'Q',
  ]);
  // Флаг u обязателен: правила отсева пишутся через \p{...} (эмодзи, символы).
  const ignoreRe = (ignore ?? []).map((pattern) => new RegExp(pattern, 'iu'));
  const skip = new Set(skipSections ?? []);

  const keyOf = (el) => {
    if (el.id) return `#${el.id}`;
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return classes.length ? `.${classes[0]}` : el.tagName.toLowerCase();
  };

  /** Где искать строку на странице: ближайший осмысленный предок плюс сам тег. */
  const whereOf = (el, section) => {
    const chain = [];
    for (let node = el; node && node !== section; node = node.parentElement) {
      const key = keyOf(node);
      if (key.startsWith('#') || key.startsWith('.')) chain.unshift(key);
      if (chain.length >= 2) break;
    }
    chain.push(el.tagName.toLowerCase());
    return chain.join(' › ');
  };

  /**
   * Строка слепка = один текстовый слой макета.
   *
   * Поэтому обход не спускается в строчную разметку: `<h1>Школа <span>Python
   * та Roblox</span></h1>` в Figma лежит одним слоем, а по узлам DOM распался
   * бы на три обрывка, и сверка показала бы три пропажи на ровном месте.
   * Блок, у которого все дети строчные, берётся целиком через innerText —
   * он же отдаёт видимый текст, а не разметку.
   */
  const linesIn = (section) => {
    const out = [];

    const push = (text, el) => {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      if (ignoreRe.some((re) => re.test(value))) return;
      out.push({ t: value.slice(0, maxLen), where: whereOf(el, section) });
    };

    const visible = (el) => {
      if (SKIP_TAGS.has(el.tagName)) return false;
      const c = getComputedStyle(el);
      if (c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0') return false;
      // Спрятанные вкладки и слайды лежат в DOM целиком: без этой проверки в
      // слепок попадает содержимое всех четырёх вкладок курсов сразу.
      if (!el.getClientRects().length) return false;
      // Свёрнутый блок сохраняет прямоугольник нулевой высоты — по числу
      // прямоугольников он «видим», а на экране его нет.
      if (el.getBoundingClientRect().height < 1) return false;

      // Свёрнутая гармошка — отдельный случай: у самого текста размеры есть,
      // прячет его предок нулевой высоты с overflow:hidden. Ответы FAQ на
      // проде лежат в разметке целиком, а в макете нарисован свёрнутый вид,
      // и без этой проверки каждый ответ приходил правкой «добавить».
      for (let node = el.parentElement; node && node !== section; node = node.parentElement) {
        // Проверка по высоте предка, а не по overflow: гармошка FAQ свёрнута
        // через `grid-template-rows: 0fr`, и у внутреннего блока overflow как
        // раз видимый — ловится только нулевой высотой.
        if (node.getBoundingClientRect().height < 1) return false;
      }
      return true;
    };

    const walk = (el) => {
      if (out.length >= maxLines || !visible(el)) return;

      if (el.placeholder) push(el.placeholder, el);
      if (el.tagName === 'INPUT' && el.value) push(el.value, el);

      const kids = [...el.children].filter(visible);
      // Строго `inline` и на всю глубину: `inline-block`/`inline-flex` носят
      // карточки и кнопки, а проверка только прямых детей пропускала выпадающее
      // меню — оно слипалось в одну строку вместе со всеми пунктами.
      const inlineDeep = () => [...el.querySelectorAll('*')]
        .every((node) => !visible(node) || getComputedStyle(node).display === 'inline');

      if (!kids.length || (TEXT_TAGS.has(el.tagName) && inlineDeep())) {
        push(el.innerText || el.textContent, el);
        return;
      }

      const own = [...el.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join(' ');
      if (own.trim()) push(own, el);

      for (const child of kids) walk(child);
    };

    walk(section);
    return out;
  };

  const sections = [...document.querySelectorAll(selector)].filter((el) => {
    const c = getComputedStyle(el);
    return c.display !== 'none' && c.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
  });

  return {
    sections: sections
      .map((section) => ({ key: keyOf(section), lines: linesIn(section) }))
      .filter((section) => !skip.has(section.key) && section.lines.length),
  };
}

/**
 * @param {string} url страница продакшена
 * @returns {Promise<object>} тексты по всем брейкпоинтам
 */
export async function collectText(url, {
  viewports = VIEWPORTS,
  selector = DEFAULT_SELECTOR,
  skipSections = [],
  ignore = [],
  auth,
  locale = LOCALE,
} = {}) {
  const browser = await chromium.launch();
  const captured = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        // Язык — из конфига, а не из системы: см. LOCALE в layout.js.
        locale,
      });
      const page = await context.newPage();

      if (auth?.localStorage) {
        const origin = new URL(url).origin;
        await context.addInitScript((entries) => {
          for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
        }, auth.localStorage);
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

      // Прокрутка обязательна: счётчики в «Академія в цифрах» крутятся от нуля
      // и запускаются, только когда секция попала в кадр. Без этого слепок
      // уверял, что на проде «0 випускників», и правка звала переписать 5500.
      await page.evaluate(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((done) => setTimeout(done, 250));
        }
        // Наверх не возвращаемся: счётчику нужно доиграть, а текст от прокрутки
        // не зависит.
        await new Promise((done) => setTimeout(done, 1500));
      });
      // Часть текста подставляется скриптами (карточки курсов, счётчики):
      // без паузы слепок ловит разметку до наполнения.
      await page.waitForTimeout(1200);

      const data = await page.evaluate(extractTextInPage, {
        selector,
        maxLines: MAX_LINES,
        maxLen: MAX_LEN,
        skipSections,
        ignore,
      });

      captured.push({ viewport: viewport.name, width: viewport.width, ...data });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return {
    url,
    selector,
    takenAt: new Date().toISOString().slice(0, 10),
    caveat: 'регистр и вид тире не сверяются: в макете это стиль (text-transform), а не содержание',
    viewports: captured,
  };
}
