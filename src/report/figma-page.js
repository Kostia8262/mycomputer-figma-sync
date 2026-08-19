/**
 * Собирает скрипт, который заводит в макете страницу правок.
 *
 * Страница служебная и намеренно нейтральная по стилю: она не часть продукта,
 * поэтому не тянет на себя продуктовые токены и не притворяется экраном.
 * Пользователь отдаёт её агенту как инструкцию наравне с GitHub Issue, значит
 * главное здесь — читаемость и порядок выполнения, а не оформление.
 */

const FONT = 'Inter';

/** Экранирует строку для вставки в генерируемый скрипт. */
const q = (value) => JSON.stringify(String(value ?? ''));

/**
 * Короткий режим страницы правок.
 *
 * Скрипт уезжает в Figma одним куском, а у канала есть предел: план на полсотни
 * шагов с полными пояснениями в него уже не влезает. В коротком режиме от
 * пояснения остаётся первая фраза (в ней и лежит суть: «на проде так, в макете
 * этак»), а служебные строки «Источник» и «Проверка» опускаются — они нужны
 * агенту, а не человеку с макетом.
 */
function brief(step) {
  const first = String(step.how ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
  return { ...step, how: first, source: '', verify: '', note: '' };
}

export function emitEditsPageScript(plan, { pageName, checkedAt, sourceLabel, gaps = [], short = false }) {
  const stages = plan.stages.map((stage) => ({
    title: stage.title,
    hint: stage.hint,
    steps: stage.steps.map((raw) => short ? brief(raw) : raw).map((step) => ({
      n: step.n,
      title: step.title,
      // Адрес и способ проверки — то, что делает шаг выполнимым без возврата
      // к агенту: где лежит узел и как убедиться, что правка засчитана.
      address: step.address ?? '',
      how: step.how,
      source: step.source,
      verify: step.verify ?? '',
      note: step.note ?? '',
      value: step.value ?? '',
      action: step.action,
    })),
  }));

  return `const PAGE_NAME = ${q(pageName)};
const CHECKED_AT = ${q(checkedAt)};
const SOURCE = ${q(sourceLabel)};
const TOTAL = ${plan.total};
const TARGET_ID = ${q(plan.target)};
const GAPS = ${JSON.stringify(gaps)};
const STAGES = ${JSON.stringify(stages)};

await figma.loadFontAsync({ family: ${q(FONT)}, style: 'Regular' });
await figma.loadFontAsync({ family: ${q(FONT)}, style: 'Semi Bold' });
await figma.loadFontAsync({ family: ${q(FONT)}, style: 'Bold' });

const rgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
});
const solid = (hex) => [{ type: 'SOLID', color: rgb(hex) }];

const text = (content, { size = 14, style = 'Regular', color = '#1a1a2e', width } = {}) => {
  const node = figma.createText();
  node.fontName = { family: ${q(FONT)}, style };
  node.fontSize = size;
  node.characters = content;
  node.fills = solid(color);
  if (width) {
    // Порядок обязателен: сначала FIXED и resize, потом HEIGHT.
    // При WIDTH_AND_HEIGHT (умолчание) заданная ширина игнорируется и блок
    // вытягивается в одну строку.
    node.textAutoResize = 'NONE';
    node.resize(width, node.height);
    node.textAutoResize = 'HEIGHT';
  }
  return node;
};

// Страница переиспользуется, а не плодится: иначе после каждого деплоя
// в файле оседает ещё одна «Правки з прода».
let page = figma.root.children.find((p) => p.name === PAGE_NAME);
const reused = Boolean(page);
if (!page) {
  page = figma.createPage();
  page.name = PAGE_NAME;
}
await figma.setCurrentPageAsync(page);
for (const child of [...page.children]) child.remove();

const root = figma.createAutoLayout('VERTICAL', {
  name: 'Правки — ' + CHECKED_AT,
  itemSpacing: 28,
  paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40,
});
root.fills = solid('#ffffff');
root.x = 0;
root.y = 0;
page.appendChild(root);
root.counterAxisSizingMode = 'FIXED';
root.resize(880, root.height);

const header = figma.createAutoLayout('VERTICAL', { name: 'Шапка', itemSpacing: 6 });
header.fills = [];
root.appendChild(header);
header.layoutSizingHorizontal = 'FILL';

const title = text('🛠 Правки з прода', { size: 30, style: 'Bold' });
header.appendChild(title);

const subtitle = text(
  'Сверка макета с продакшеном · ' + CHECKED_AT + ' · правок: ' + TOTAL,
  { size: 14, color: '#6b6b80' },
);
header.appendChild(subtitle);

header.appendChild(text(
  'Продакшен — эталон. Все правки вносятся в макет, код не трогаем. Источник значений: ' + SOURCE,
  { size: 13, color: '#6b6b80', width: 800 },
));
// Команда проверки одна на всю страницу: в каждой карточке она бы утроила
// объём, ничего не добавив.
header.appendChild(text(
  'Проверить результат: node src/cli.js vsfigma --target ' + TARGET_ID + '  ·  node src/cli.js emit --target ' + TARGET_ID,
  { size: 12, color: '#9999aa', width: 800 },
));

// Пробелы печатаются рядом с правками, а не прячутся: список без этой пометки
// читается как «сверено всё», хотя часть сверки могла не выполняться.
if (GAPS.length) {
  const warn = figma.createAutoLayout('VERTICAL', { name: 'Не покрыто', itemSpacing: 4,
    paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14 });
  warn.fills = solid('#fef9e7');
  warn.cornerRadius = 10;
  root.appendChild(warn);
  warn.layoutSizingHorizontal = 'FILL';
  warn.appendChild(text('⚠ Сверено не всё', { size: 13, style: 'Semi Bold', color: '#b45309' }));
  for (const gap of GAPS) {
    warn.appendChild(text('· ' + gap, { size: 12, color: '#b45309', width: 780 }));
  }
}

const createdIds = [root.id];

STAGES.forEach((stage, stageIndex) => {
  const block = figma.createAutoLayout('VERTICAL', { name: stage.title, itemSpacing: 10 });
  block.fills = [];
  root.appendChild(block);
  block.layoutSizingHorizontal = 'FILL';

  const heading = text(
    String(stageIndex + 1).padStart(2, '0') + ' · ' + stage.title.toUpperCase(),
    { size: 16, style: 'Semi Bold' },
  );
  block.appendChild(heading);

  const hint = text(stage.hint, { size: 12, color: '#9999aa' });
  block.appendChild(hint);

  for (const step of stage.steps) {
    const card = figma.createAutoLayout('HORIZONTAL', {
      name: String(step.n) + '. ' + step.title,
      itemSpacing: 14,
      paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
    });
    card.fills = solid('#f8f7ff');
    card.cornerRadius = 12;
    card.counterAxisAlignItems = 'MIN';
    block.appendChild(card);
    card.layoutSizingHorizontal = 'FILL';

    const num = text(String(step.n), { size: 15, style: 'Bold', color: '#6c47ff' });
    card.appendChild(num);

    const body = figma.createAutoLayout('VERTICAL', { name: 'Описание', itemSpacing: 5 });
    body.fills = [];
    card.appendChild(body);
    body.layoutSizingHorizontal = 'FILL';

    body.appendChild(text(step.title, { size: 15, style: 'Semi Bold' }));
    if (step.address) body.appendChild(text('Где: ' + step.address, { size: 13, color: '#1a1a2e', width: 660 }));
    if (step.value) body.appendChild(text('Значение: ' + step.value, { size: 13, color: '#1a1a2e' }));
    body.appendChild(text(step.how, { size: 13, color: '#6b6b80', width: 660 }));
    if (step.note) body.appendChild(text('⚠ ' + step.note, { size: 12, color: '#b45309', width: 660 }));
    if (step.source) body.appendChild(text('Источник: ' + step.source, { size: 11, color: '#9999aa', width: 660 }));
    if (step.verify) body.appendChild(text('Проверка: ' + step.verify, { size: 11, color: '#9999aa', width: 660 }));

    createdIds.push(card.id);
  }
});

return { page: page.name, pageId: page.id, reused, steps: TOTAL, createdNodeIds: createdIds };`;
}
