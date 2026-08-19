/**
 * Сравнение геометрии макета с геометрией прода.
 *
 * Работает потому, что обе стороны уже названы по одной логике: в вёрстке
 * секции имеют устойчивые id (`#hero`, `#courses`), а в макете лежат инстансы
 * организмов с теми же именами (`Hero`, `Courses`). Гадать по координатам или
 * похожести картинок не требуется.
 *
 * Внутренности секции разбираются только там, где габариты разошлись: сама по
 * себе «секция не той высоты» невыполнима как задача, нужен виновник. Слои и
 * узлы DOM сопоставляются по именам — см. node-match.js.
 */

import { findCulprit, explainCulprits } from './node-match.js';
import { judgeSize, explainVerdict, BLIND_TOLERANCE } from './noise.js';

/** Порог, с которого расхождение габаритов попадает в отчёт. */
const SIZE_TOLERANCE = 2;
/** Порог для позиции по вертикали: сдвиг секции — самый заметный симптом. */
const OFFSET_TOLERANCE = 2;

/** Скрипт, снимающий геометрию организмов со страницы макета. */
export function emitFigmaLayoutScript({ pageName, frameName, ignore, part = 1, parts = 1, only = [] }) {
  return `const PAGE_NAME = ${JSON.stringify(pageName)};
const FRAME_NAME = ${JSON.stringify(frameName)};
const IGNORE = ${JSON.stringify(ignore ?? [])};
// Съёмка частями: ответ Figma MCP обрезается на 20 КБ, а пятиуровневый
// слепок страницы весит больше. Части склеиваются по sections.
const PART = ${part};
const PARTS = ${parts};
// Вглубь разбираются только названные секции. Остальные снимаются одним
// уровнем: разбор нужен там, где расхождение уже найдено, а полный
// пятиуровневый слепок всей страницы в 20 КБ ответа всё равно не помещается.
const ONLY = ${JSON.stringify(only ?? [])};

const page = figma.root.children.find((p) => p.name === PAGE_NAME);
if (!page) return { error: 'Нет страницы ' + PAGE_NAME, pages: figma.root.children.map((p) => p.name) };
await figma.setCurrentPageAsync(page);

const frame = page.children.find((n) => n.name === FRAME_NAME)
  || page.children.find((n) => 'children' in n && n.children.length > 3);
if (!frame) return { error: 'Нет кадра ' + FRAME_NAME, top: page.children.map((n) => n.name) };

const round = (n) => Math.round(n * 10) / 10;

// Внутренности нужны, чтобы правка называла виновника, а не только секцию:
// «Footer выше на 78» бесполезно, «причина в Inner» — выполнимо.
// Пять уровней, а не три: карточки лежат на четвёртом-пятом (кадр → секция →
// container → grid → row → card), и без них расхождение нельзя разобрать до
// причины — а именно карточки и дают накопленное округление. Глубина слепка
// прода поднята симметрично (см. src/snapshot/layout.js).
const MAX_DEPTH = 5;
const MAX_KIDS = 12;
// Декоративные сетки держат десятки одинаковых штрихов («v», «h»): в DOM им
// ничего не соответствует, а дерево они раздувают втрое.
// Декоративные сетки держат десятки одинаковых штрихов («v», «h»): в DOM им
// ничего не соответствует, а дерево они раздувают втрое. Штрихи отсеиваются
// только по имени целиком: раньше шаблон съедал экранирование, класс
// превращался в диапазон, и декором считался ЛЮБОЙ слой на «h» или «v» —
// hero__inner, h4-wrap, visual молча пропадали из слепка, и разобрать
// расхождение до причины было нечем.
const DECOR = /^(deco|fade)|^[vh][0-9]*$/i;

const walk = (node, depth) => {
  if (depth > MAX_DEPTH || !('children' in node) || !node.children.length) return undefined;
  const kids = node.children.filter((c) => c.visible !== false && !DECOR.test(c.name));
  return kids.slice(0, MAX_KIDS).map((c) => ({
    // Имена текстовых слоёв в Figma — это целые абзацы, и на пяти уровнях
    // вложенности они раздувают ответ так, что он не проходит через MCP.
    // Сопоставлению с DOM хватает начала: классы короткие.
    name: c.name.slice(0, 40),
    w: round(c.width),
    h: round(c.height),
    inner: walk(c, depth + 1),
  }));
};

const all = frame.children.filter((n) => !IGNORE.includes(n.name));
const size = Math.ceil(all.length / PARTS);
const sections = all
  .slice((PART - 1) * size, PART * size)
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
    inner: walk(n, ONLY.length && !ONLY.includes(n.name) ? MAX_DEPTH : 1),
  }))
  // Порядок в дереве Figma не обязан совпадать с визуальным: Header часто лежит
  // последним, чтобы быть поверх. Сравнивать нужно по координате, а не по индексу.
  .sort((a, b) => a.y - b.y || a.x - b.x);

return {
  page: page.name,
  frame: frame.name,
  part: PART,
  parts: PARTS,
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
      // Разбор внутренностей превращает «секция не той высоты» в адресную
      // правку. Молча пропустить его нельзя — без него шаг невыполним.
      const culprits = findCulprit(inFigma, section, tolerance);
      // Он же отвечает на второй вопрос: это дефект макета или накопленное
      // округление Figma. Правка нужна только в первом случае.
      const verdict = judgeSize(inFigma, section);

      // Внутренности не разобрать (слепок кончился раньше) — решаем по
      // страховочному порогу, он выше обычного.
      if (!verdict.known && Math.abs(dw) <= BLIND_TOLERANCE && Math.abs(dh) <= BLIND_TOLERANCE) {
        matched.push({ prod: section.key, figma: figmaName, prodTop: section.absoluteTop, figmaTop: inFigma.y, delta: dh });
        continue;
      }

      findings.push({
        kind: verdict.noise ? 'округление' : 'размер',
        prod: section.key,
        figma: figmaName,
        nodeId: inFigma.id,
        culprits,
        causes: verdict.causes,
        worstInside: verdict.worst,
        because: explainVerdict(verdict, dh) ?? explainCulprits(culprits, dh),
        onProd: `${section.size.w}×${section.size.h}`,
        inFigma: `${inFigma.w}×${inFigma.h}`,
        // Знак от макета к проду: «макет нужно подрасти на N».
        delta: `${dw >= 0 ? '+' : ''}${Math.round(dw * 10) / 10} × ${dh >= 0 ? '+' : ''}${Math.round(dh * 10) / 10}`,
        bordered: Boolean(section.bordered),
      });
    }

    // Сдвиг по вертикали внутри страницы: секция может быть верного размера,
    // но стоять не на своём месте. Сравниваются расстояния от предыдущей
    // секции, а не абсолютные координаты: иначе сдвиг верхнего блока
    // «сдвинул» бы все нижние и дал бы лавину ложных находок.
    const prevProd = matched.at(-1);
    if (prevProd) {
      // Округляем сразу: вычитание координат с десятыми копит хвосты вида
      // 852.9000000000001, и они утекают в отчёт для человека.
      const round = (n) => Math.round(n * 10) / 10;
      const gapOnProd = round(section.absoluteTop - prevProd.prodTop);
      const gapInFigma = round(inFigma.y - prevProd.figmaTop);
      const drift = Math.round((gapInFigma - gapOnProd) * 10) / 10;
      // Сдвиг, равный расхождению высоты предыдущей секции, — это её эхо, а не
      // отдельная находка: секция стоит там, куда её поставил сосед сверху.
      // Без этого отсечения каждая правка высоты дублировалась «смещением» с
      // тем же числом, и список раздувался вдвое.
      const echo = prevProd.delta != null && Math.abs(drift - prevProd.delta) <= 0.5;
      if (Math.abs(drift) > OFFSET_TOLERANCE && !echo) {
        findings.push({
          kind: 'смещение',
          prod: section.key,
          figma: figmaName,
          nodeId: inFigma.id,
          after: prevProd.figma,
          onProd: gapOnProd,
          inFigma: gapInFigma,
          delta: drift,
        });
      }
    }

    matched.push({ prod: section.key, figma: figmaName, prodTop: section.absoluteTop, figmaTop: inFigma.y, delta: dh });
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
