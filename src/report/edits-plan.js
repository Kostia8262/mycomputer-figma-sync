/**
 * Превращает результаты сверки в план правок для макета.
 *
 * Источников два и оба обязательны: токены (`state/figma-check.json`) и
 * геометрия (`state/layout` против `state/figma-layout`). План, собранный
 * только из токенов, выглядит завершённым, хотя пропускает всё, что съехало.
 *
 * Каждый шаг обязан быть выполнимым без возврата к агенту: адрес узла,
 * значение, scopes, и чем именно расхождение вызвано на проде.
 */

const STAGES = [
  { id: 'primitives', title: 'Примитивы', hint: 'сырые значения, на них ссылается всё остальное' },
  { id: 'semantic', title: 'Семантика', hint: 'смысловые переменные, ссылаются на примитивы' },
  { id: 'styles', title: 'Стили', hint: 'текстовые и эффект-стили' },
  { id: 'organisms', title: 'Организмы', hint: 'секции страниц: размеры и порядок' },
];

/** Semantic/color/primary-soft → { collection: 'Semantic', name: 'color/primary-soft' } */
function splitPath(expectedAt) {
  const slash = expectedAt.indexOf('/');
  return { collection: expectedAt.slice(0, slash), name: expectedAt.slice(slash + 1) };
}

function stageFor(collection) {
  if (collection === 'Primitives') return 'primitives';
  if (collection === 'Semantic') return 'semantic';
  return 'styles';
}

/**
 * Подбирает scopes по роли переменной.
 *
 * Значение по умолчанию — ALL_SCOPES — засоряет каждый пикер свойств, поэтому
 * оставлять выбор исполнителю нельзя: правка без scopes технически выполнима,
 * но вредна.
 */
function scopesFor(collection, name) {
  if (collection === 'Radius') return ['CORNER_RADIUS'];

  const lower = name.toLowerCase();
  if (/(^|\/)text(\/|$)|text-|\/text$|ink/.test(lower)) return ['TEXT_FILL'];
  if (/border|stroke/.test(lower)) return ['STROKE_COLOR'];
  if (/\/bg$|-bg$|surface|canvas|shell\/bg/.test(lower)) return ['FRAME_FILL', 'SHAPE_FILL'];
  if (/solid|brand|primary|success|danger|warning|info/.test(lower)) {
    return ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL'];
  }
  return ['FRAME_FILL', 'SHAPE_FILL'];
}

/** Крупнейшие дети секции на проде — чтобы было видно, где искать разницу. */
function insidesOf(prodSection, limit = 4) {
  if (!prodSection?.children?.length) return [];
  return prodSection.children
    .slice()
    .sort((a, b) => b.size.h - a.size.h)
    .slice(0, limit)
    .map((child) => `${child.key} ${child.size.w}×${child.size.h}`);
}

function tokenSteps(targetResult, target) {
  const steps = [];

  for (const item of targetResult.missing) {
    const { collection, name } = splitPath(item.expectedAt);
    const scopes = scopesFor(collection, name);
    steps.push({
      stage: stageFor(collection),
      action: 'создать',
      title: `Создать переменную ${name}`,
      address: `Коллекция «${collection}» → ${name}`,
      value: item.value,
      how: item.fix
        ? `${item.fix} Scopes: ${scopes.join(', ')}.`
        : `Значение ${item.value}. Сначала проверить, нет ли примитива с этим цветом — если есть, сослаться на него, а не заводить второй. Scopes: ${scopes.join(', ')}.`,
      source: `${item.css} в ${target.tokenSource}`,
      verify: `${name} уйдёт из missing`,
      note: item.note,
    });
  }

  for (const item of targetResult.mismatched) {
    const collection = item.collection ?? 'Semantic';
    steps.push({
      stage: stageFor(collection),
      action: 'изменить',
      title: `Обновить ${item.figma}`,
      address: `Коллекция «${collection}» → ${item.figma}`,
      value: item.inCode,
      how: `В макете сейчас ${item.inFigma}, на проде ${item.inCode}. Прод — эталон, значение меняем в макете.`,
      source: `${item.css} в ${target.tokenSource}`,
      verify: `${item.figma} уйдёт из расхождений`,
    });
  }

  return steps;
}

/**
 * @param {object} layoutFindings результат compareLayoutToFigma по брейкпоинтам:
 *   [{ viewport, width, page, frame, result }]
 * @param {object} prodByViewport слепок прода, чтобы объяснить причину расхождения
 */
function layoutSteps(layoutFindings, prodByViewport, target) {
  const steps = [];

  for (const entry of layoutFindings) {
    const prodSections = prodByViewport[entry.viewport]?.sections ?? [];

    for (const finding of entry.result.findings) {
      if (finding.kind === 'размер') {
        const prodSection = prodSections.find((s) => s.key === finding.prod);
        const insides = insidesOf(prodSection);
        const grow = finding.delta.includes('-');

        steps.push({
          stage: 'organisms',
          action: 'изменить',
          title: `${finding.figma} — высота не совпадает (${entry.viewport} ${entry.width})`,
          address: `Страница «${entry.page}» → кадр «${entry.frame}» → слой «${finding.figma}»${finding.nodeId ? ` (id ${finding.nodeId})` : ''}`,
          value: `нужно ${finding.onProd}`,
          how:
            `На проде ${finding.onProd}, в макете ${finding.inFigma}. Разница ${finding.delta} — ` +
            `макет надо ${grow ? 'увеличить' : 'уменьшить'} до продового размера.` +
            (finding.bordered
              ? ' У секции есть границы: расхождение до 1.5 px — артефакт headless-рендеринга, не дефект.'
              : '') +
            (insides.length ? ` Внутри секции на проде: ${insides.join(', ')}.` : ''),
          source: `${finding.prod} @ ${entry.width}px`,
          verify: `${finding.figma} / ${entry.viewport} уйдёт из расхождений`,
        });
        continue;
      }

      if (finding.kind === 'порядок') {
        steps.push({
          stage: 'organisms',
          action: 'изменить',
          title: `Порядок секций расходится (${entry.viewport} ${entry.width})`,
          address: `Страница «${entry.page}» → кадр «${entry.frame}»`,
          how: `На позиции ${finding.position} прод ожидает «${finding.onProd}», а в макете стоит «${finding.inFigma}». Переставить по порядку прода.`,
          source: `порядок секций на проде при ширине ${entry.width}`,
          verify: 'порядок совпадёт',
        });
        continue;
      }

      if (finding.kind === 'нет в макете') {
        steps.push({
          stage: 'organisms',
          action: 'создать',
          title: `Секция «${finding.figma}» есть на проде, но её нет в макете (${entry.viewport})`,
          address: `Страница «${entry.page}» → кадр «${entry.frame}»`,
          value: finding.prodSize,
          how: `На проде секция ${finding.prod} размером ${finding.prodSize}. Собрать организм из существующих молекул и атомов, новый компонент заводить только если подходящего нет.`,
          source: `${finding.prod} при ширине ${entry.width}`,
          verify: 'секция появится как совпавшая',
        });
        continue;
      }

      if (finding.kind === 'только в макете') {
        steps.push({
          stage: 'organisms',
          action: 'решить',
          title: `«${finding.figma}» есть в макете, но не найдена на проде (${entry.viewport})`,
          address: `Страница «${entry.page}» → кадр «${entry.frame}» → «${finding.figma}»`,
          how: 'Либо секция удалена с прода и её надо убрать из макета, либо она не попала в карту сопоставления. Требует решения человека — агент такое сам не удаляет.',
          source: `сверка при ширине ${entry.width}`,
          verify: '—',
        });
      }
    }
  }

  return steps;
}

export function buildEditsPlan({ tokenResult, layoutFindings = [], prodByViewport = {}, target }) {
  const steps = [
    ...(tokenResult ? tokenSteps(tokenResult, target) : []),
    ...layoutSteps(layoutFindings, prodByViewport, target),
  ];

  const stages = STAGES.map((stage) => ({
    ...stage,
    steps: steps.filter((s) => s.stage === stage.id),
  })).filter((stage) => stage.steps.length > 0);

  // Нумерация после раскладки по этапам: номер обязан совпадать с порядком
  // выполнения, иначе он только мешает.
  let n = 0;
  for (const stage of stages) {
    for (const step of stage.steps) step.n = ++n;
  }

  return { target: target.id, title: target.title, figmaFileKey: target.figmaFileKey, total: n, stages };
}
