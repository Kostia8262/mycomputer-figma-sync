/**
 * Превращает результат сверки в план правок для макета.
 *
 * Порядок не косметический: правка нижнего уровня меняет всё, что на неё
 * ссылается. Примитив заводится раньше семантики, семантика — раньше стилей,
 * стили — раньше компонентов. Если делать наоборот, придётся возвращаться.
 */

const STAGES = [
  { id: 'primitives', title: 'Примитивы', hint: 'сырые значения, на них ссылается всё остальное' },
  { id: 'semantic', title: 'Семантика', hint: 'смысловые переменные, ссылаются на примитивы' },
  { id: 'styles', title: 'Стили', hint: 'текстовые и эффект-стили' },
  { id: 'components', title: 'Компоненты', hint: 'то, что собрано из стилей и переменных' },
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
 * @param {object} targetResult запись из state/figma-check.json
 * @param {object} target описание таргета из design-map.json
 */
export function buildEditsPlan(targetResult, target) {
  const steps = [];

  for (const item of targetResult.missing) {
    const { collection, name } = splitPath(item.expectedAt);
    steps.push({
      stage: stageFor(collection),
      action: 'создать',
      title: `Создать переменную ${name}`,
      collection,
      name,
      value: item.value,
      // Если такой цвет уже лежит в примитивах, правка сводится к алиасу —
      // заводить второй примитив с тем же значением нельзя, это и есть дрейф.
      how: item.fix ?? `Значение ${item.value}. Проверить, нет ли готового примитива с этим цветом — если есть, сослаться на него, а не заводить новый.`,
      source: `${item.css} в ${target.tokenSource}`,
      note: item.note,
    });
  }

  for (const item of targetResult.mismatched) {
    const { collection, name } = splitPath(`${item.collection ?? 'Semantic'}/${item.figma}`);
    steps.push({
      stage: stageFor(collection),
      action: 'изменить',
      title: `Обновить ${name}`,
      collection,
      name,
      value: item.inCode,
      how: `В макете сейчас ${item.inFigma}, на проде ${item.inCode}. Прод — эталон.`,
      source: `${item.css} в ${target.tokenSource}`,
    });
  }

  const stages = STAGES.map((stage) => ({
    ...stage,
    steps: steps.filter((s) => s.stage === stage.id),
  })).filter((stage) => stage.steps.length > 0);

  // Сквозная нумерация именно после сортировки по этапам — номер должен
  // совпадать с порядком выполнения, иначе он бесполезен.
  let n = 0;
  for (const stage of stages) {
    for (const step of stage.steps) step.n = ++n;
  }

  return { target: target.id, title: target.title, figmaFileKey: target.figmaFileKey, total: n, stages };
}
