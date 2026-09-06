/**
 * Снятие геометрии рабочей области кадров макета и сравнение её с продом.
 *
 * Существующий `figma-layout.js` снимает один кадр и сравнивает секции верхнего
 * уровня — этого хватало сайтам, где экран и есть страница. У админки экранов
 * два десятка на брейкпоинт, а расходятся они внутри `main`: ряд плиток, тулбар,
 * таблица. Поэтому здесь снимается состав `main` сразу по всем нужным кадрам.
 *
 * Имена блоков в макете и на проде разные («Stats Grid» против `#statsRow`),
 * сопоставлять их по названию бессмысленно. Зато порядок блоков совпадает —
 * оба идут сверху вниз одной колонкой, — поэтому сравнение идёт по позиции в
 * последовательности, а из макета выбрасываются спейсеры: они эмулируют
 * margin, которого в auto-layout нет, и своего аналога в DOM не имеют.
 */

/** Скрипт для `use_figma`: снимает `main` у каждого запрошенного кадра. */
export function emitFramesLayoutScript({ pages, frames }) {
  return `const PAGES = ${JSON.stringify(pages)};
const WANTED = ${JSON.stringify(frames)};

const round = (n) => Math.round(n * 10) / 10;
const out = [];

for (const pageId of PAGES) {
  const page = figma.root.children.find((p) => p.id === pageId);
  if (!page) continue;
  await page.loadAsync();

  for (const frame of page.children) {
    if (frame.type !== 'FRAME') continue;
    // Сверять надо по базовому имени, а не по префиксу: с префиксом «Заявки»
    // подтягивались и «Заявки · Модалка», и «Заявки · Пошук», и ответ разрастался
    // на все 266 кадров файла.
    const base = frame.name.replace(/\\s*[—–-]\\s*(Desktop|Compact|Mobile)\\s*\\d*\\s*$/i, '').trim();
    if (WANTED.length && !WANTED.includes(base)) continue;

    const main = frame.findOne((n) => n.name === 'main');
    if (!main) continue;

    // Спейсеры — это отступы, а не блоки: в DOM им ничего не соответствует.
    const blocks = main.children
      .filter((n) => n.visible !== false && n.layoutPositioning !== 'ABSOLUTE' && !/^spacer-/.test(n.name))
      .map((n) => ({ name: n.name, id: n.id, y: round(n.y), w: round(n.width), h: round(n.height) }));

    const gaps = main.children
      .filter((n) => /^spacer-/.test(n.name))
      .map((n) => round(n.height));

    out.push({
      page: page.name,
      frame: frame.name,
      frameId: frame.id,
      size: { w: round(frame.width), h: round(frame.height) },
      main: { w: round(main.width), h: round(main.height), padding: main.paddingTop },
      blocks,
      gaps,
    });
  }
}
return JSON.stringify({ capturedFrames: out.length, frames: out });`;
}

/**
 * Блоки вкладки на проде: `.app-body` → `.main` → контейнер вкладки → его дети.
 *
 * Отдельно возвращается padding `main`: на проде координата блока отсчитывается
 * от контейнера вкладки, а в макете — от кадра, где те же 24 (или 14) пикселя
 * уже включены. Без поправки каждый блок «съезжал» ровно на padding.
 */
export function prodBlocksOf(screen) {
  const body = (screen.sections ?? []).find((s) => s.key === '.app-body');
  if (!body) return null;
  const main = (body.children ?? []).find((n) => n.key === '.main');
  if (!main) return null;

  const padding = parseFloat(main.styles?.paddingTop ?? '0') || 0;
  const tabRoot = (main.children ?? []).find((n) => /Tab$/.test(n.key.replace('#', '')) || (n.children ?? []).length > 1)
    ?? main;

  // Панель подвкладки — обёртка, а не блок: на проде «Оплати» лежат внутри
  // #csubPayments, а в макете те же блоки идут в кадре плоско. Без разворота
  // вся подвкладка сравнивалась как один элемент, и её высота (тысячи пикселей)
  // выглядела расхождением.
  const PANE = /^#(csub|dashPane|gsub)/i;
  const flat = [];
  for (const child of tabRoot.children ?? []) {
    if (PANE.test(child.key) && (child.children ?? []).length) {
      // Координаты внутри панели отсчитываются от неё самой — поднимая их на
      // уровень вкладки, надо прибавить смещение самой панели.
      const shift = child.rel?.y ?? 0;
      for (const inner of child.children) flat.push({ ...inner, rel: { ...inner.rel, y: (inner.rel?.y ?? 0) + shift } });
    } else flat.push(child);
  }

  const blocks = flat.map((n) => ({
    key: n.key,
    y: n.rel?.y == null ? null : n.rel.y + padding,
    w: n.size?.w ?? null,
    h: n.size?.h ?? null,
    tables: n.tables ?? undefined,
  }));
  return Object.assign(blocks, { padding });
}

const TOLERANCE = { size: 2, gap: 2 };

/** Блок-список: высота зависит от числа строк и сверке не подлежит. */
const LIST = /table|wrap|grid|calendar|cards|body$/i;

/** Прибитые к окну полосы прокрутки в макете лежат абсолютом и в поток не входят. */
const FLOATING = /hscroll|scrollbar|sticky/i;

const norm = (s) => s.replace(/^[#.]/, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/**
 * Пары «блок прода → блок макета».
 *
 * Сначала по имени: `#dashAlerts` ↔ «dashAlerts», `#coursesGrid` ↔ «coursesGrid».
 * Что не совпало по имени — раскладывается по порядку: колонка одна, и порядок
 * сверху вниз у прода и макета общий. Без именной привязки один лишний блок
 * сдвигал всю цепочку, и дальше сравнивались чужие пары.
 */
function pairBlocks(prod, design) {
  const pairs = [];
  const usedDesign = new Set();
  const restProd = [];

  for (const p of prod) {
    const hit = design.findIndex((d, i) => !usedDesign.has(i) && norm(d.name) === norm(p.key));
    if (hit >= 0) { usedDesign.add(hit); pairs.push([p, design[hit]]); }
    else restProd.push(p);
  }
  const restDesign = design.filter((_, i) => !usedDesign.has(i));
  restProd.forEach((p, i) => { if (restDesign[i]) pairs.push([p, restDesign[i]]); });
  return pairs;
}

/**
 * Сравнивает один экран прода с одним кадром макета.
 * Возвращает список расхождений, готовый лечь в план правок.
 */
export function compareScreenToFrame(screen, frame) {
  const raw = prodBlocksOf(screen);
  if (!raw) return [{ kind: 'нет данных', note: 'в слепке прода нет .main — вкладка не открылась' }];
  // Пустая вкладка при непустом кадре — это всегда обрезанный слепок, а не
  // разъехавшийся макет: в проде у каждой вкладки есть хотя бы таблица.
  // Без этой развилки такой слепок читался как «в макете лишние блоки».
  if (!raw.length && frame.blocks.length) {
    return [{ kind: 'нет данных', note: 'вкладка в слепке пуста — слепок снят на меньшую глубину, пересними' }];
  }

  const findings = [];
  const prod = raw.filter((b) => !FLOATING.test(b.key));
  const design = frame.blocks.filter((b) => !FLOATING.test(b.name));

  if (prod.length !== design.length) {
    findings.push({
      kind: 'состав',
      note: `на проде блоков ${prod.length}, в макете ${design.length}`,
      prodKeys: prod.map((b) => b.key).join(', '),
      designKeys: design.map((b) => b.name).join(', '),
    });
  }

  for (const [p, d] of pairBlocks(prod, design)) {
    // Высоту блока-списка не сверяем: на проде там десятки строк, в макете
    // осознанно четыре-пять. Такие блоки сверяются по шапке, строке и колонкам —
    // это делает compareTables.
    const isList = Boolean(p.tables?.length) || LIST.test(p.key) || LIST.test(d.name);
    if (!isList && p.h != null && Math.abs(p.h - d.h) > TOLERANCE.size) {
      findings.push({
        kind: 'высота',
        block: d.name,
        nodeId: d.id,
        inProd: p.h,
        inDesign: d.h,
        delta: Math.round((p.h - d.h) * 10) / 10,
        prodKey: p.key,
      });
    }
    if (p.y != null && Math.abs(p.y - d.y) > TOLERANCE.gap) {
      findings.push({
        kind: 'позиция',
        block: d.name,
        nodeId: d.id,
        inProd: p.y,
        inDesign: d.y,
        delta: Math.round((p.y - d.y) * 10) / 10,
        prodKey: p.key,
      });
    }
  }
  return findings;
}

/**
 * Сравнение таблиц: ширины колонок, высота шапки и строки.
 * Считается отдельно от блоков — таблица в макете это компонент, и правится
 * он один раз на все экраны, где стоит.
 */
export function compareTables(screen, frameTables = []) {
  const prod = prodBlocksOf(screen) ?? [];
  const prodTables = prod.flatMap((b) => b.tables ?? []);
  if (!prodTables.length || !frameTables.length) return [];

  const findings = [];
  prodTables.forEach((table, i) => {
    const design = frameTables[i];
    if (!design) return;
    if (table.headHeight != null && design.headHeight != null && Math.abs(table.headHeight - design.headHeight) > 1) {
      findings.push({ kind: 'шапка таблицы', table: table.id, inProd: table.headHeight, inDesign: design.headHeight });
    }
    if (table.rowHeight != null && design.rowHeight != null && Math.abs(table.rowHeight - design.rowHeight) > 1) {
      findings.push({ kind: 'высота строки', table: table.id, inProd: table.rowHeight, inDesign: design.rowHeight });
    }
    (table.columns ?? []).forEach((col, ci) => {
      const dcol = (design.columns ?? [])[ci];
      if (!dcol) return;
      if (Math.abs(col.w - dcol.w) > 1.5) {
        findings.push({ kind: 'колонка', table: table.id, column: col.label || `#${ci}`, inProd: col.w, inDesign: dcol.w });
      }
    });
  });
  return findings;
}
