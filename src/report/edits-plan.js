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
  // Тексты идут перед организмами не для красоты: недостающая строка меняет
  // высоту секции, и правка габаритов до правки слов гоняется за хвостом.
  { id: 'content', title: 'Тексты', hint: 'подписи, ссылки и заголовки: слова берутся с прода' },
  { id: 'organisms', title: 'Организмы', hint: 'секции страниц: размеры и порядок' },
  { id: 'frames', title: 'Экраны', hint: 'кадры макета, затронутые коммитом' },
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
      // «Округление» — расхождение, набранное из мелочей внутри секции: Figma
      // округляет высоту текстового блока до целого пикселя вверх, и на четырёх
      // карточках это даёт секции +3 px. Правки такое не требует и в план не
      // идёт — сводка попадает в примечания прогона (см. src/cli.js).
      if (finding.kind === 'округление') continue;

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
            (finding.because ? ` ${finding.because}` : insides.length ? ` Внутри секции на проде: ${insides.join(', ')}.` : ''),
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

/**
 * Шаги из адресации по коммиту: что доработать, что создать.
 * Идут последним этапом — это работа над экраном целиком, после того как
 * приведены в порядок токены и организмы, на которые экран опирается.
 */
function frameSteps({ commit, matched = [], missing = [] }) {
  const steps = [];

  for (const item of matched) {
    const bp = item.frames.map((f) => f.name.replace(/^.*[—–-]\s*/, '')).join(', ');
    steps.push({
      stage: 'frames', action: 'изменить',
      title: `Доработать «${item.base}»`,
      address: `Страница «${item.page}» → кадры: ${item.frames.length} шт. (${bp})`,
      how: `Коммит ${commit} затронул этот экран. Основание: ${item.reasons.slice(0, 3).join('; ')}. Свериться с продом и перенести изменения.`,
      source: `коммит ${commit}`,
      verify: `повторный прогон frames по этому коммиту не должен показывать «${item.base}»`,
    });
  }

  for (const item of missing) {
    steps.push({
      stage: 'frames', action: 'создать',
      title: `Создать кадр «${item.suggestion}»`,
      address: `Файл-источник: ${item.source}`,
      how: `${item.why}. Собрать экран из существующих организмов и молекул; новый компонент заводить только если подходящего нет.`,
      source: `коммит ${commit}`,
      verify: 'кадр появится в каталоге и уйдёт из списка «создать»',
    });
  }

  return steps;
}

/**
 * Правки из поблочной сверки вкладок (`vstabs`).
 *
 * Отличается от `layoutSteps` тем, что адресует конкретный узел макета: у
 * каждого расхождения есть id блока, поэтому правка открывается по прямой
 * ссылке, а не ищется глазами. Расхождения одного блока на трёх брейкпоинтах
 * сводятся в один шаг — правится он всё равно один раз, чаще всего в компоненте.
 */
function tabSteps(tabsDiff = []) {
  const byBlock = new Map();

  for (const screen of tabsDiff) {
    for (const finding of screen.findings ?? []) {
      if (finding.kind === 'состав' || finding.kind === 'нет данных') continue;
      const name = finding.block ?? finding.table ?? finding.column ?? '—';
      const key = `${name}|${finding.kind}`;
      const entry = byBlock.get(key) ?? { name, kind: finding.kind, where: [], nodeId: finding.nodeId, samples: [] };
      entry.where.push(`${screen.frame}`);
      entry.samples.push(`${finding.inProd} → ${finding.inDesign}`);
      entry.nodeId = entry.nodeId ?? finding.nodeId;
      byBlock.set(key, entry);
    }
  }

  return [...byBlock.values()].map((item) => ({
    stage: 'frames',
    action: 'изменить',
    title: `${item.kind === 'колонка' ? 'Колонка' : item.kind[0].toUpperCase() + item.kind.slice(1)} «${item.name}» не совпадает с продом`,
    address: item.nodeId ? `Узел ${item.nodeId} · кадры: ${item.where.slice(0, 3).join(', ')}` : `Кадры: ${item.where.slice(0, 3).join(', ')}`,
    how: `На проде ${item.samples[0].split(' → ')[0]}, в макете ${item.samples[0].split(' → ')[1]}. Экранов с этим расхождением: ${item.where.length}. Если блок — инстанс компонента, правится мастер, а не кадр.`,
    source: 'поблочная сверка вкладок (vstabs)',
    verify: 'повторный vstabs не должен показывать этот блок',
  }));
}

/**
 * Правки по текстам.
 *
 * Одно и то же слово расходится сразу на трёх брейкпоинтах — правится оно чаще
 * всего один раз (в компоненте), поэтому находки сводятся в один шаг со списком
 * кадров. Иначе план на ровном месте утраивается.
 */
function textSteps(textFindings = []) {
  const byLine = new Map();

  for (const entry of textFindings) {
    for (const finding of entry.result.findings) {
      const key = [finding.kind, finding.figma, finding.onProd ?? '', finding.inFigma ?? ''].join('|');
      const item = byLine.get(key) ?? { ...finding, viewports: [], pages: [], nodeIds: new Set() };
      item.viewports.push(entry.viewport);
      item.pages.push(`${entry.page} → ${entry.frame}`);
      if (finding.nodeId) item.nodeIds.add(finding.nodeId);
      byLine.set(key, item);
    }
  }

  const steps = [];
  for (const item of byLine.values()) {
    const where = `Кадры: ${item.viewports.join(', ')}`;
    const ids = [...item.nodeIds];
    const address = ids.length
      ? `${where} · узлы: ${ids.slice(0, 3).join(', ')}`
      : `${where} · секция «${item.figma}»${item.sectionId ? ` (id ${item.sectionId})` : ''}`;

    if (item.kind === 'текст') {
      steps.push({
        stage: 'content', action: 'изменить',
        title: `${item.figma}: «${item.inFigma}» → «${item.onProd}»`,
        address,
        value: item.onProd,
        how: `На проде «${item.onProd}», в макете «${item.inFigma}». Прод — эталон. Если слой внутри инстанса, правка ляжет оверрайдом — это нормально; но если строка приходит из мастер-компонента, менять надо его.`,
        source: `${item.prod} · ${item.where ?? 'текст секции'}`,
        verify: 'строка уйдёт из расхождений vstext',
      });
      continue;
    }

    if (item.kind === 'нет в макете') {
      steps.push({
        stage: 'content', action: 'создать',
        title: `${item.figma}: добавить «${item.onProd}»`,
        address,
        value: item.onProd,
        how: `На проде эта строка есть (${item.where ?? 'в секции'}), в макете её нет. ВНИМАНИЕ: добавить слой внутрь инстанса нельзя — Figma отвечает «Cannot move node. New parent is an instance». Если блок собран инстансами, строка заводится в мастер-компоненте.`,
        source: `${item.prod} · ${item.where ?? ''}`,
        verify: 'строка появится в макете и уйдёт из «нет в макете»',
      });
      continue;
    }

    if (item.kind === 'только в макете') {
      steps.push({
        stage: 'content', action: 'решить',
        title: `${item.figma}: «${item.inFigma}» есть в макете, но не на проде`,
        address,
        how: 'Либо текст убрали с прода и его пора убрать из макета, либо это подпись, которой в вёрстке соответствует картинка или псевдоэлемент. Требует решения человека — агент такое сам не удаляет.',
        source: item.prod,
        verify: '—',
      });
      continue;
    }

    if (item.kind === 'порядок текста') {
      steps.push({
        stage: 'content', action: 'изменить',
        title: `${item.figma}: переставить «${item.onProd}»`,
        address,
        how: `На проде «${item.onProd}» идёт после «${item.after}», в макете порядок другой. Внутри инстанса слои не двигаются — порядок правится переписыванием текстов по местам или в мастер-компоненте.`,
        source: item.prod,
        verify: 'порядок строк совпадёт',
      });
      continue;
    }

    if (item.kind === 'ещё расхождения') {
      steps.push({
        stage: 'content', action: 'решить',
        title: `${item.figma}: ещё ${item.count} расхождений в текстах`,
        address,
        how: `Совпало строк: ${item.matched}. Расхождений больше, чем помещается в план — секция разошлась с продом целиком. Смотреть полный список: node src/cli.js vstext.`,
        source: item.prod,
        verify: 'после правки секции список сократится',
      });
    }
  }

  return steps;
}

export function buildEditsPlan({ tokenResult, layoutFindings = [], textFindings = [], prodByViewport = {}, target, frames, tabsDiff }) {
  const steps = [
    ...(tokenResult ? tokenSteps(tokenResult, target) : []),
    ...textSteps(textFindings),
    ...layoutSteps(layoutFindings, prodByViewport, target),
    ...(frames ? frameSteps(frames) : []),
    ...tabSteps(tabsDiff),
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
