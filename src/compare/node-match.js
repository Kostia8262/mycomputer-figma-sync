/**
 * Сопоставление слоёв макета с узлами DOM внутри секции.
 *
 * Без этого правка звучит как «Footer выше на 78 px» — верно, но невыполнимо:
 * непонятно, что именно внутри выросло. С ним — «причина в Inner: 1032 против
 * 1111.5», и работа становится точечной.
 *
 * Работает потому, что слои названы по своим же BEM-классам:
 *   Figma «Pay Section» → pay-section → DOM `.footer__pay-section`
 *   Figma «Inner»       → inner       → DOM `.footer__inner`
 *   Figma «Container»   → container   → DOM `.container`
 */

/** «Pay Section» → «pay-section». */
export function normalizeLayerName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * `.footer__pay-section[2]` → `pay-section`.
 * Берётся первый класс: остальные обычно модификаторы (`.card.card--featured`).
 */
export function normalizeDomKey(key) {
  const withoutIndex = key.replace(/\[\d+\]$/, '');
  const first = withoutIndex.split('.').filter(Boolean)[0] ?? withoutIndex;
  const bare = first.replace(/^#/, '');
  const bem = bare.split('__');
  return (bem.length > 1 ? bem[bem.length - 1] : bare).toLowerCase();
}

/**
 * Ключи, под которыми узел можно найти с другой стороны.
 *
 * Одно имя не годится: в этом файле слои названы полными BEM-классами
 * (hero__inner), а модуль изначально писался под короткие (Inner). Из-за
 * рассинхрона пары не находились почти нигде — сверка знала, что секция не той
 * высоты, но не могла назвать виновника, и каждая правка приходила без адреса.
 * Поэтому сравниваются наборы ключей, а совпадением считается пересечение.
 */
export function matchKeys(raw) {
  const bare = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\[\d+\]$/, '')
    .replace(/^[#.]/, '')
    .split('.')
    .filter(Boolean)[0] ?? '';

  const keys = new Set();
  const add = (value) => {
    const clean = value.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    if (clean) keys.add(clean.replace(/_/g, ''));
  };

  add(bare);
  // BEM-хвост: hero__inner → inner. Так слой макета «Inner» встречается с
  // классом вёрстки, и наоборот.
  const bem = bare.split('__');
  if (bem.length > 1) add(bem[bem.length - 1]);
  // Обёртки макета эмулируют margin, которого в auto-layout нет: под ними
  // лежит ровно тот узел, что и в DOM.
  add(bare.replace(/-wrap$/, ''));
  // Последнее слово: «Stat Card» в макете и .stats__card в вёрстке — одно и то же,
  // но блок назван в единственном числе против множественного. Ключ широкий,
  // но сопоставление идёт внутри одного родителя и с учётом кратности.
  const words = bare.split(/[-\s]+/).filter(Boolean);
  if (words.length > 1) add(words[words.length - 1]);

  return keys;
}

/** Есть ли общий ключ у слоя макета и узла DOM. */
export function sameNode(layerName, domKey) {
  const a = matchKeys(layerName);
  for (const key of matchKeys(domKey)) if (a.has(key)) return true;
  return false;
}

/**
 * Технические слои макета, которым в DOM ничего не соответствует.
 * Спейсеры эмулируют margin, которого в auto-layout нет, и считать их
 * пропажей — значит каждый раз выдавать несуществующую правку.
 */
const TECHNICAL = /^(spacer|gap|divider-space|placeholder)[-\d]*$/;

export function isTechnicalLayer(name) {
  return TECHNICAL.test(normalizeLayerName(name));
}

/**
 * Ищет внутри секции самый глубокий узел, объясняющий расхождение высоты.
 *
 * Возвращается именно самый глубокий подходящий: если и Container, и его
 * ребёнок Inner расходятся на одну и ту же величину, виноват ребёнок, а
 * Container просто передаёт разницу наверх.
 *
 * @param {object} figmaNode  узел макета с { name, h, inner: [...] }
 * @param {object} domNode    узел прода с { key, size, children }
 * @param {number} tolerance  порог, ниже которого расхождение не считается
 */
export function findCulprit(figmaNode, domNode, tolerance = 2) {
  const results = [];

  const walk = (figma, dom, depth, path) => {
    if (!figma?.inner?.length || !dom?.children?.length) return;

    const domByKey = new Map();
    for (const child of dom.children) {
      const key = normalizeDomKey(child.key);
      if (!domByKey.has(key)) domByKey.set(key, child);
    }

    for (const layer of figma.inner) {
      if (isTechnicalLayer(layer.name)) continue;

      const match = domByKey.get(normalizeLayerName(layer.name));
      if (!match) {
        results.push({
          kind: 'слой без пары',
          path: [...path, layer.name].join(' › '),
          inFigma: `${layer.w}×${layer.h}`,
          depth,
        });
        continue;
      }

      const delta = Math.round((match.size.h - layer.h) * 10) / 10;
      if (Math.abs(delta) > tolerance) {
        results.push({
          kind: 'высота',
          path: [...path, layer.name].join(' › '),
          domKey: match.key,
          inFigma: layer.h,
          onProd: match.size.h,
          delta,
          depth,
        });
      }

      walk(layer, match, depth + 1, [...path, layer.name]);
    }
  };

  walk(figmaNode, domNode, 1, []);

  // Самый глубокий — самый конкретный: родитель лишь передаёт разницу наверх.
  results.sort((a, b) => b.depth - a.depth || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  return results;
}

/** Короткое человеческое объяснение для карточки правки. */
export function explainCulprits(culprits, sectionDelta, limit = 2) {
  if (!culprits.length) return null;

  const sized = culprits.filter((c) => c.kind === 'высота');
  const best = sized[0];

  if (best && Math.abs(Math.abs(best.delta) - Math.abs(sectionDelta)) < Math.abs(sectionDelta) * 0.4) {
    // Дельта ребёнка совпала с дельтой секции — вся разница пришла оттуда.
    return `Причина: «${best.path}» — в макете ${best.inFigma}, на проде ${best.onProd} (${best.delta > 0 ? '+' : ''}${best.delta}).`;
  }

  const parts = sized.slice(0, limit).map((c) => `«${c.path}» ${c.inFigma} → ${c.onProd}`);
  const orphans = culprits.filter((c) => c.kind === 'слой без пары').slice(0, limit);
  if (orphans.length) parts.push(`без пары на проде: ${orphans.map((o) => `«${o.path}»`).join(', ')}`);

  return parts.length ? `Где именно: ${parts.join('; ')}.` : null;
}
