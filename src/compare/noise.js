/**
 * Отделяет накопленное округление от настоящего дрейфа макета.
 *
 * Зачем это нужно. Figma квантует высоту текстового блока до целого пикселя
 * вверх: CSS `line-height: 1.7` при 16px даёт на проде 27.2, а в макете будет
 * 28 — и меньше уже не сделать. Ошибка систематическая и копится по вложенным
 * элементам: четыре карточки статистики дают секции +3.3, двадцать две ссылки
 * подвала — +17.6. Со стороны это выглядит как дрейф макета, хотя чинить там
 * нечего: правка «уменьшить секцию на 3 px» невыполнима и портит компоненты.
 *
 * Признак, по которому шум отличается от дефекта: у дефекта есть ОДНА крупная
 * причина (не тот gap, лишний паддинг, недостающие пункты списка), у шума —
 * много мелких, каждая в пределах кванта. Поэтому разбор идёт до листьев и
 * смотрит на самую крупную необъяснённую дельту, а не на сумму.
 *
 * Порог `NOISE_PER_NODE` = 1 px кванта Figma + 0.5 на занижение границ
 * headless-браузером (border:1px рендерится как 0.8px).
 */

import { sameNode, isTechnicalLayer } from './node-match.js';

/** Больше этого на один узел — уже не округление, а расхождение. */
export const NOISE_PER_NODE = 1.5;

/**
 * Допуск на случай, когда внутренности разобрать не удалось.
 *
 * Слепок ограничен глубиной, и у секции может не оказаться детей для сверки.
 * Тогда отличить шум от дефекта нечем, и остаётся страховочный порог: 2 px
 * базовых плюс квант. Он намеренно выше обычного — молчаливо пропустить
 * мелочь дешевле, чем каждый раз выдавать невыполнимую правку.
 */
export const BLIND_TOLERANCE = 3.5;

const round = (n) => Math.round(n * 10) / 10;

/**
 * Внешняя высота узла DOM — вместе с вертикальными полями.
 *
 * В auto-layout нет margin: то, что вёрстка задаёт полем, макет выражает
 * обёрткой с паддингом (badge-wrap = бейдж + 24 снизу). Сравнивать чистые
 * высоты значит каждый раз находить расхождение ровно в размер поля — и это
 * была главная причина, по которой разбор внутренностей выдавал чепуху.
 */
function outerH(dom) {
  const px = (v) => (v ? parseFloat(v) || 0 : 0);
  const st = dom.styles ?? {};
  return round((dom.size?.h ?? 0) + px(st.marginTop) + px(st.marginBottom));
}
/** Ниже этого расхождение неотличимо от погрешности округления слепка. */
const EPSILON = 0.05;

/**
 * Вклад детей в высоту родителя.
 *
 * Считается по геометрии, а не по `display`: дети группируются в ряды по
 * координате, внутри ряда высоту задаёт самый крупный, ряды складываются. Так
 * одинаково правильно считаются столбик (каждый в своём ряду), строка (один
 * ряд) и сетка 2×2 — на ней первая версия ошибалась вдвое, потому что
 * складывала все четыре карточки.
 */
function childrenContribution(matched) {
  const rows = [];
  for (const item of matched) {
    const top = item.dom.rel?.y ?? 0;
    const row = rows.find((r) => Math.abs(r.top - top) <= 1);
    if (row) row.deltas.push(item.delta);
    else rows.push({ top, deltas: [item.delta] });
  }
  return rows.reduce((sum, row) => {
    const worst = row.deltas.reduce((max, d) => (Math.abs(d) > Math.abs(max) ? d : max), 0);
    return sum + worst;
  }, 0);
}

/**
 * Рекурсивно объясняет расхождение высоты секции.
 *
 * @returns {{ delta: number, causes: Array }} дельта узла и листовые причины:
 *   `own: true` — виновата сама рамка узла (паддинг, gap, межстрочный шаг),
 *   `missing: true` — слоя макета нет на проде.
 */
function explain(figmaNode, domNode, causes, path) {
  const delta = round(outerH(domNode) - (figmaNode.h ?? 0));
  const here = [...path, figmaNode.name ?? domNode.key];

  const layers = (figmaNode.inner ?? [])
    .filter((l) => !isTechnicalLayer(l.name))
    // Обёртка с единственным ребёнком — это ребёнок плюс эмулированный
    // margin, то есть ровно внешняя высота узла DOM. Сравниваем их напрямую.
    .map((l) => {
      const kids = (l.inner ?? []).filter((k) => !isTechnicalLayer(k.name));
      return /-wrap$/i.test(l.name) && kids.length === 1
        ? { ...kids[0], h: l.h }
        : l;
    });
  if (!layers.length || !domNode.children?.length) {
    if (Math.abs(delta) > EPSILON) {
      causes.push({ path: here.join(' › '), delta, bordered: Boolean(domNode.bordered) });
    }
    return delta;
  }

  // Одноимённые узлы (четыре «Stat Card» подряд) сопоставляются по порядку, а не
  // все с первым: иначе три карточки из четырёх считались бы лишними в макете.
  const free = domNode.children.map((child) => ({ child, taken: false }));
  const take = (layerName) => {
    const slot = free.find((entry) => !entry.taken && sameNode(layerName, entry.child.key));
    if (slot) {
      slot.taken = true;
      return slot.child;
    }
    // Вёрстка тоже держит переходники (#reviewsTrack вокруг #reviewsGrid):
    // единственный ребёнок — это тот же узел, только под другим именем.
    const through = free.find((entry) => !entry.taken
      && entry.child.children?.length === 1
      && sameNode(layerName, entry.child.children[0].key));
    if (!through) return null;
    through.taken = true;
    return through.child.children[0];
  };

  const matched = [];
  // Слой без пары, у которого есть дети, — чаще всего группировка макета
  // («row» внутри сетки), которой в CSS-grid ничего не соответствует. Такой слой
  // прозрачен: сопоставляются его дети, а не он сам.
  const walkLayers = (list) => {
    for (const layer of list) {
      if (isTechnicalLayer(layer.name)) continue;
      const match = take(layer.name);
      if (match) {
        matched.push({ dom: match, delta: explain(layer, match, causes, here) });
        continue;
      }
      const kids = (layer.inner ?? []).filter((l) => !isTechnicalLayer(l.name));
      if (kids.length) { walkLayers(kids); continue; }
      causes.push({ path: [...here, layer.name].join(' › '), missing: true, inFigma: layer.h });
    }
  };
  walkLayers(layers);

  if (!matched.length) {
    if (Math.abs(delta) > EPSILON) {
      causes.push({ path: here.join(' › '), delta, bordered: Boolean(domNode.bordered) });
    }
    return delta;
  }

  // Сколько из дельты узла уже объяснили дети — остальное принадлежит самому
  // узлу: его паддингам, зазорам, межстрочному шагу.
  const fromChildren = childrenContribution(matched);

  const own = round(delta - fromChildren);
  if (Math.abs(own) > EPSILON) {
    causes.push({ path: here.join(' › '), delta: own, own: true, bordered: Boolean(domNode.bordered) });
  }
  return delta;
}

/**
 * Вердикт по одной находке «размер».
 *
 * @param {object} figmaNode секция макета { name, h, inner }
 * @param {object} domNode   секция прода { key, size, children }
 * @returns {{ known: boolean, noise: boolean, worst: number|null, causes: Array }}
 *   `known: false` — внутренности не разобрать, решать по BLIND_TOLERANCE.
 */
export function judgeSize(figmaNode, domNode) {
  const causes = [];
  explain(figmaNode, domNode, causes, []);

  if (!causes.length) return { known: false, noise: false, worst: null, causes };
  if (causes.some((c) => c.missing)) return { known: true, noise: false, worst: null, causes };

  const worst = causes.reduce((max, c) => Math.max(max, Math.abs(c.delta ?? 0)), 0);
  const limit = (cause) => (cause.bordered ? NOISE_PER_NODE + 0.5 : NOISE_PER_NODE);
  const noise = causes.every((c) => Math.abs(c.delta ?? 0) <= limit(c));

  return { known: true, noise, worst: round(worst), causes };
}

/** Человеческое объяснение: одна крупная причина или перечень мелких. */
export function explainVerdict(verdict, sectionDelta) {
  const { causes, noise } = verdict;
  if (!causes.length) return null;

  if (noise) {
    const n = causes.length;
    return `Это округление, а не дрейф: расхождение набралось из ${n} мелких (самое крупное ${verdict.worst} px), ` +
      'Figma округляет высоту текстового блока до целого пикселя вверх. Чинить нечего.';
  }

  const missing = causes.filter((c) => c.missing);
  if (missing.length) {
    return `В макете есть слои, которых нет на проде: ${missing.slice(0, 3).map((m) => `«${m.path}»`).join(', ')}.`;
  }

  const sorted = causes.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = sorted[0];

  // Единственная причина — сама секция: внутренностей в слепке нет.
  // Говорить «причина в Hero» про сам Hero бессмысленно — честнее сказать, что
  // разобрать не вышло и слепки надо переснять.
  if (causes.length === 1 && !top.path.includes('›')) {
    return 'Внутренности разобрать не удалось: в слепке нет детей этой секции. '
      + 'Пересними геометрию макета (vsfigma --emit <брейкпоинт> --part N --parts 2) и слепок прода.';
  }
  const share = Math.abs(sectionDelta) > 0 ? Math.abs(top.delta) / Math.abs(sectionDelta) : 0;

  if (share > 0.6) {
    return `Причина: «${top.path}»${top.own ? ' (собственные отступы или шаг)' : ''} — ` +
      `${top.delta > 0 ? 'в макете меньше' : 'в макете больше'} на ${Math.abs(top.delta)} px.`;
  }

  return `Где именно: ${sorted.slice(0, 3).map((c) => `«${c.path}» ${c.delta > 0 ? '+' : ''}${c.delta}`).join('; ')}.`;
}
