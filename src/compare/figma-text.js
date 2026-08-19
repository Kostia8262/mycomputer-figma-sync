/**
 * Сверка текстов макета с текстами прода.
 *
 * Пара к figma-layout.js: там габариты, здесь слова. Секции сопоставляются той
 * же картой (`layout.sectionMap`), а внутри секции сравниваются плоские списки
 * строк — дерево у прода и макета устроено по-разному, и попытка сверять его
 * узел к узлу давала бы расхождения на каждой обёртке.
 *
 * Прод — эталон: то, чего нет в макете, это пробел макета.
 */

import { pairLines } from './text-match.js';

/**
 * Скрипт, снимающий тексты организмов со страницы макета.
 *
 * Выдача сознательно ужата до массивов и обрезанных id: ответ плагина
 * ограничен 20 КБ, а на главной около трёхсот строк текста. В обычном виде
 * (`{t, id}` с полными идентификаторами) выдача обрывалась на середине —
 * молча, и половина секций просто не доезжала до сверки.
 *
 * `offset`/`limit` режут страницу на порции по секциям: собирает их обратно
 * `vstext --import`.
 */
export function emitFigmaTextScript({ pageName, frameName, ignore, maxLines = 200, offset = 0, limit = 0 }) {
  return `const PAGE_NAME = ${JSON.stringify(pageName)};
const FRAME_NAME = ${JSON.stringify(frameName)};
const IGNORE = ${JSON.stringify(ignore ?? [])};
const MAX_LINES = ${maxLines};
const OFFSET = ${offset};
const LIMIT = ${limit || 0};

const page = figma.root.children.find((p) => p.name === PAGE_NAME);
if (!page) return { error: 'Нет страницы ' + PAGE_NAME, pages: figma.root.children.map((p) => p.name) };
await figma.setCurrentPageAsync(page);

const frame = page.children.find((n) => n.name === FRAME_NAME)
  || page.children.find((n) => 'children' in n && n.children.length > 3);
if (!frame) return { error: 'Нет кадра ' + FRAME_NAME, top: page.children.map((n) => n.name) };

// Скрытые слои лежат в файле наравне с видимыми (состояния, варианты, старые
// подписи). Их текст на экране не показан, и в сверку он попасть не должен.
const shown = (node, stopAt) => {
  for (let n = node; n && n !== stopAt; n = n.parent) if (n.visible === false) return false;
  return true;
};

const all = frame.children
  .filter((n) => !IGNORE.includes(n.name) && n.visible !== false)
  .sort((a, b) => a.y - b.y);
const slice = LIMIT ? all.slice(OFFSET, OFFSET + LIMIT) : all.slice(OFFSET);

const sections = slice
  .map((section) => {
    const prefix = 'I' + section.id + ';';
    const texts = 'findAllWithCriteria' in section
      ? section.findAllWithCriteria({ types: ['TEXT'] })
      : [];
    const lines = texts
      .filter((t) => shown(t, section) && t.absoluteBoundingBox && (t.characters || '').trim())
      // Порядок — визуальный, сверху вниз и слева направо: в дереве Figma
      // слои нередко лежат в порядке рисования, а не чтения.
      .sort((a, b) => {
        const ay = a.absoluteBoundingBox.y, by = b.absoluteBoundingBox.y;
        return Math.abs(ay - by) > 4 ? ay - by : a.absoluteBoundingBox.x - b.absoluteBoundingBox.x;
      })
      .slice(0, MAX_LINES)
      // Общая часть id выкидывается: у слоя внутри инстанса она занимает
      // больше места, чем сам текст. Полный id помечается «=».
      .map((t) => [
        t.characters.replace(/\\s+/g, ' ').trim().slice(0, 120),
        t.id.startsWith(prefix) ? t.id.slice(prefix.length) : '=' + t.id,
      ]);

    return { n: section.name, i: section.id, l: lines };
  })
  .filter((s) => s.l.length);

return { p: page.name, f: frame.name, offset: OFFSET, total: all.length, s: sections };`;
}

/**
 * Разворачивает ужатую выдачу скрипта обратно в человеческий вид.
 * Обратная операция к сокращению id в emitFigmaTextScript.
 */
export function expandFigmaText(chunk) {
  return {
    page: chunk.p ?? chunk.page,
    frame: chunk.f ?? chunk.frame,
    sections: (chunk.s ?? chunk.sections ?? []).map((section) => ({
      name: section.n ?? section.name,
      id: section.i ?? section.id,
      lines: (section.l ?? section.lines ?? []).map((line) => (
        Array.isArray(line)
          ? { t: line[0], id: line[1].startsWith('=') ? line[1].slice(1) : `I${section.i ?? section.id};${line[1]}` }
          : line
      )),
    })),
  };
}

/**
 * @param {object} prodViewport брейкпоинт из state/text/<target>.json
 * @param {object} figmaText результат emitFigmaTextScript
 * @param {Record<string,string>} sectionMap `#hero` → `Hero`
 * @param {{maxPerSection?: number}} options
 */
export function compareTextsToFigma(prodViewport, figmaText, sectionMap, {
  maxPerSection = 12,
  ignore = [],
  // Порядок строк по умолчанию не сверяется. В макете слои сортируются сверху
  // вниз, а в вёрстке порядок — по DOM: в любой секции с колонками (шаги
  // «01–04», плитки цифр) это расходится всегда и ни о чём не говорит.
  checkOrder = false,
} = {}) {
  const ignoreRe = ignore.map((pattern) => new RegExp(pattern, 'iu'));
  const keep = (line) => !ignoreRe.some((re) => re.test(line.t));
  const figmaByName = new Map(figmaText.sections.map((s) => [s.name, s]));
  const findings = [];
  let checked = 0;

  for (const section of prodViewport.sections) {
    const figmaName = sectionMap[section.key];
    // О секции, которой нет в карте или в макете, уже сказала сверка геометрии.
    // Повторять это здесь значит удваивать одну и ту же правку.
    if (!figmaName) continue;
    const inFigma = figmaByName.get(figmaName);
    if (!inFigma) continue;

    checked += 1;
    // Отсев применяется к обеим сторонам: если эмодзи и одиночные символы
    // выброшены только из прода, они возвращаются с другой стороны как
    // «лишнее в макете» — то же самое, вид сбоку.
    const result = pairLines(section.lines.filter(keep), inFigma.lines.filter(keep));
    const found = [];

    for (const item of result.changed) {
      found.push({
        kind: 'текст',
        prod: section.key,
        figma: figmaName,
        sectionId: inFigma.id,
        nodeId: item.figma.id,
        onProd: item.prod.t,
        inFigma: item.figma.t,
        where: item.prod.where,
        score: item.score,
      });
    }

    for (const item of result.missingInFigma) {
      found.push({
        kind: 'нет в макете',
        prod: section.key,
        figma: figmaName,
        sectionId: inFigma.id,
        onProd: item.t,
        where: item.where,
      });
    }

    for (const item of result.onlyInFigma) {
      found.push({
        kind: 'только в макете',
        prod: section.key,
        figma: figmaName,
        sectionId: inFigma.id,
        nodeId: item.id,
        inFigma: item.t,
      });
    }

    if (checkOrder && result.reorder) {
      found.push({
        kind: 'порядок текста',
        prod: section.key,
        figma: figmaName,
        sectionId: inFigma.id,
        nodeId: result.reorder.nodeId,
        onProd: result.reorder.line,
        after: result.reorder.after,
      });
    }

    // Секция, разошедшаяся целиком (в макете стоит рыба или блок собран
    // заново), даёт десятки строк. Отчёт от этого перестаёт читаться, поэтому
    // выводится начало списка и честно называется остаток.
    if (found.length > maxPerSection) {
      const rest = found.length - maxPerSection;
      findings.push(...found.slice(0, maxPerSection));
      findings.push({
        kind: 'ещё расхождения',
        prod: section.key,
        figma: figmaName,
        sectionId: inFigma.id,
        count: rest,
        matched: result.matched,
      });
    } else {
      findings.push(...found);
    }
  }

  return { checked, findings };
}
