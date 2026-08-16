/**
 * Сравнение геометрии макета с геометрией прода.
 *
 * Работает потому, что обе стороны уже названы по одной логике: в вёрстке
 * секции имеют устойчивые id (`#hero`, `#courses`), а в макете лежат инстансы
 * организмов с теми же именами (`Hero`, `Courses`). Гадать по координатам или
 * похожести картинок не требуется.
 *
 * Сюда не попадает пиксельное сравнение внутренностей секции — только её
 * габариты и порядок. Этого достаточно, чтобы поймать «элемент уехал», и
 * достаточно мало, чтобы отчёт оставался читаемым.
 */

/** Порог, с которого расхождение габаритов попадает в отчёт. */
const SIZE_TOLERANCE = 2;
/** Порог для позиции по вертикали: сдвиг секции — самый заметный симптом. */
const OFFSET_TOLERANCE = 2;

/** Скрипт, снимающий геометрию организмов со страницы макета. */
export function emitFigmaLayoutScript({ pageName, frameName, ignore }) {
  return `const PAGE_NAME = ${JSON.stringify(pageName)};
const FRAME_NAME = ${JSON.stringify(frameName)};
const IGNORE = ${JSON.stringify(ignore ?? [])};

const page = figma.root.children.find((p) => p.name === PAGE_NAME);
if (!page) return { error: 'Нет страницы ' + PAGE_NAME, pages: figma.root.children.map((p) => p.name) };
await figma.setCurrentPageAsync(page);

const frame = page.children.find((n) => n.name === FRAME_NAME)
  || page.children.find((n) => 'children' in n && n.children.length > 3);
if (!frame) return { error: 'Нет кадра ' + FRAME_NAME, top: page.children.map((n) => n.name) };

const round = (n) => Math.round(n * 10) / 10;

const sections = frame.children
  .filter((n) => !IGNORE.includes(n.name))
  .map((n) => ({
    name: n.name,
    type: n.type,
    // id обязателен: без него правка звучит как «найдите Footer где-то в файле».
    // С ним она открывается по прямой ссылке.
    id: n.id,
    x: round(n.x),
    y: round(n.y),
    w: round(n.width),
    h: round(n.height),
  }))
  // Порядок в дереве Figma не обязан совпадать с визуальным: Header часто лежит
  // последним, чтобы быть поверх. Сравнивать нужно по координате, а не по индексу.
  .sort((a, b) => a.y - b.y || a.x - b.x);

return {
  page: page.name,
  frame: frame.name,
  frameSize: { w: round(frame.width), h: round(frame.height) },
  sections,
};`;
}

/**
 * Сопоставляет слепок прода с геометрией макета.
 *
 * @param {object} prodViewport один брейкпоинт из state/layout/<target>.json
 * @param {object} figmaLayout результат emitFigmaLayoutScript
 * @param {Record<string,string>} sectionMap `#hero` → `Hero`
 */
export function compareLayoutToFigma(prodViewport, figmaLayout, sectionMap) {
  const figmaByName = new Map(figmaLayout.sections.map((s) => [s.name, s]));
  const findings = [];
  const matched = [];

  // Прод — эталон, поэтому обход идёт по его секциям: то, чего нет в макете,
  // это пробел макета, а не лишнее на сайте.
  for (const section of prodViewport.sections) {
    const figmaName = sectionMap[section.key];
    if (!figmaName) {
      findings.push({ kind: 'нет в карте', prod: section.key, hint: 'добавьте секцию в layout.sectionMap' });
      continue;
    }

    const inFigma = figmaByName.get(figmaName);
    if (!inFigma) {
      findings.push({ kind: 'нет в макете', prod: section.key, figma: figmaName, prodSize: `${section.size.w}×${section.size.h}` });
      continue;
    }

    const dw = inFigma.w - section.size.w;
    const dh = inFigma.h - section.size.h;
    const tolerance = section.bordered ? SIZE_TOLERANCE + 1.5 : SIZE_TOLERANCE;

    if (Math.abs(dw) > tolerance || Math.abs(dh) > tolerance) {
      findings.push({
        kind: 'размер',
        prod: section.key,
        figma: figmaName,
        nodeId: inFigma.id,
        onProd: `${section.size.w}×${section.size.h}`,
        inFigma: `${inFigma.w}×${inFigma.h}`,
        // Знак от макета к проду: «макет нужно подрасти на N».
        delta: `${dw >= 0 ? '+' : ''}${Math.round(dw * 10) / 10} × ${dh >= 0 ? '+' : ''}${Math.round(dh * 10) / 10}`,
        bordered: Boolean(section.bordered),
      });
    }

    matched.push({ prod: section.key, figma: figmaName, prodTop: section.absoluteTop, figmaTop: inFigma.y });
  }

  for (const section of figmaLayout.sections) {
    const usedNames = new Set(Object.values(sectionMap));
    if (!usedNames.has(section.name)) {
      findings.push({ kind: 'только в макете', figma: section.name, size: `${section.w}×${section.h}` });
    }
  }

  // Порядок секций сравнивается отдельно: перестановка блоков не меняет их
  // габаритов и иначе прошла бы незамеченной.
  const prodOrder = matched.slice().sort((a, b) => a.prodTop - b.prodTop).map((m) => m.figma);
  const figmaOrder = matched.slice().sort((a, b) => a.figmaTop - b.figmaTop).map((m) => m.figma);
  for (let i = 0; i < prodOrder.length; i += 1) {
    if (prodOrder[i] !== figmaOrder[i]) {
      findings.push({ kind: 'порядок', position: i + 1, onProd: prodOrder[i], inFigma: figmaOrder[i] });
      break;
    }
  }

  const heightDelta = figmaLayout.frameSize.h - prodViewport.documentHeight;

  return {
    checked: matched.length,
    totalHeight: {
      onProd: prodViewport.documentHeight,
      inFigma: figmaLayout.frameSize.h,
      delta: Math.round(heightDelta * 10) / 10,
    },
    findings,
  };
}
