/**
 * Сравнивает два слепка геометрии и говорит, что изменилось на проде.
 *
 * Это ответ на «я подвинул элемент — покажи, что именно»: сравниваются не
 * картинки, а числа, поэтому сдвиг на 4 px виден так же надёжно, как удаление
 * целой секции.
 */

/** Допуск для узлов с границами: headless рендерит 1px как 0.8px. */
const BORDER_TOLERANCE = 1.5;
/** Допуск для остальных: subpixel-раскладка текста даёт ±0.3 px между прогонами. */
const BASE_TOLERANCE = 0.5;

const toleranceFor = (node) => (node?.bordered ? BORDER_TOLERANCE : BASE_TOLERANCE);

/** Разворачивает дерево в плоскую карту «путь → узел». */
function flatten(nodes, prefix = '') {
  const map = new Map();
  const walk = (list, path) => {
    for (const node of list) {
      const full = path ? `${path} › ${node.key}` : node.key;
      map.set(full, node);
      if (node.children) walk(node.children, full);
    }
  };
  walk(nodes, prefix);
  return map;
}

function diffStyles(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before.styles ?? {}), ...Object.keys(after.styles ?? {})]);

  for (const key of keys) {
    const was = before.styles?.[key];
    const now = after.styles?.[key];
    if (was === now) continue;
    changes.push({ property: key, was: was ?? '—', now: now ?? '—' });
  }
  return changes;
}

/** Сравнивает один брейкпоинт. */
function diffViewport(before, after) {
  const oldNodes = flatten(before.sections);
  const newNodes = flatten(after.sections);
  const findings = [];

  for (const [path, node] of newNodes) {
    if (!oldNodes.has(path)) {
      findings.push({ kind: 'появился', path, size: node.size, text: node.text });
    }
  }
  for (const [path, node] of oldNodes) {
    if (!newNodes.has(path)) {
      findings.push({ kind: 'исчез', path, size: node.size, text: node.text });
    }
  }

  for (const [path, now] of newNodes) {
    const was = oldNodes.get(path);
    if (!was) continue;

    const tolerance = Math.max(toleranceFor(was), toleranceFor(now));

    const dw = now.size.w - was.size.w;
    const dh = now.size.h - was.size.h;
    if (Math.abs(dw) > tolerance || Math.abs(dh) > tolerance) {
      findings.push({
        kind: 'размер',
        path,
        was: `${was.size.w}×${was.size.h}`,
        now: `${now.size.w}×${now.size.h}`,
        delta: `${dw >= 0 ? '+' : ''}${Math.round(dw * 10) / 10} × ${dh >= 0 ? '+' : ''}${Math.round(dh * 10) / 10}`,
        bordered: Boolean(was.bordered || now.bordered),
      });
    }

    const dx = now.rel.x - was.rel.x;
    const dy = now.rel.y - was.rel.y;
    if (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance) {
      findings.push({
        kind: 'сдвиг',
        path,
        was: `(${was.rel.x}, ${was.rel.y})`,
        now: `(${now.rel.x}, ${now.rel.y})`,
        delta: `${dx >= 0 ? '+' : ''}${Math.round(dx * 10) / 10}, ${dy >= 0 ? '+' : ''}${Math.round(dy * 10) / 10}`,
      });
    }

    const styleChanges = diffStyles(was, now);
    if (styleChanges.length) findings.push({ kind: 'стили', path, changes: styleChanges });

    if (was.text !== now.text && (was.text || now.text)) {
      findings.push({ kind: 'текст', path, was: was.text ?? '—', now: now.text ?? '—' });
    }
  }

  return findings;
}

/**
 * @param {object} before предыдущий слепок (state/layout/<target>.json из git)
 * @param {object} after свежий слепок
 */
export function diffLayouts(before, after) {
  const byViewport = [];

  for (const view of after.viewports) {
    const previous = before.viewports.find((v) => v.viewport === view.viewport);
    if (!previous) {
      byViewport.push({ viewport: view.viewport, status: 'новый брейкпоинт', findings: [] });
      continue;
    }

    const findings = diffViewport(previous, view);
    const heightDelta = view.documentHeight - previous.documentHeight;

    byViewport.push({
      viewport: view.viewport,
      width: view.width,
      // Высота страницы — самый дешёвый датчик: если она изменилась, а точечных
      // находок нет, значит сместилось что-то, чего слепок не покрывает.
      documentHeight: { was: previous.documentHeight, now: view.documentHeight, delta: Math.round(heightDelta * 10) / 10 },
      findings,
    });
  }

  const total = byViewport.reduce((sum, v) => sum + v.findings.length, 0);
  return { url: after.url, total, viewports: byViewport };
}
