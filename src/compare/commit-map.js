/**
 * Отображение коммита на экраны макета.
 *
 * Сравнение слепков отвечает «что изменилось». Коммит отвечает «где и почему»,
 * и не требует воспроизводить состояние, которое трудно поймать кликами:
 * тост, ошибку сервера, редкую ветку роли. Если строка тронула `.modal-header`,
 * правка адресуется в кадры с модалкой независимо от того, удалось ли эту
 * модалку открыть роботом.
 *
 * Индекс строить отдельно не нужно: слепки уже содержат ключи узлов
 * (`.footer__inner`, `#leadsTab`), то есть карта «селектор → экран» получается
 * из того, что уже снято.
 */

/** Классы и id, которые ничего не говорят о расположении. */
const NOISE = new Set([
  'active', 'show', 'hidden', 'open', 'is-active', 'disabled', 'selected',
  'btn', 'container', 'wrap', 'row', 'col', 'left', 'right', 'top', 'bottom',
]);

/**
 * Достаёт из diff селекторы, которых коснулись изменения.
 * Смотрим только добавленные и удалённые строки: контекст diff трогать нельзя,
 * иначе в выборку попадёт половина файла.
 */
export function selectorsFromDiff(diffText) {
  const touched = new Map();

  const bump = (kind, name, line) => {
    if (!name || NOISE.has(name) || name.length < 3) return;
    const key = `${kind}${name}`;
    const entry = touched.get(key) ?? { selector: key, hits: 0, samples: [] };
    entry.hits += 1;
    if (entry.samples.length < 2) entry.samples.push(line.trim().slice(0, 100));
    touched.set(key, entry);
  };

  let currentFile = null;
  const files = new Set();

  for (const line of diffText.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    if (currentFile) files.add(currentFile);

    // class="a b", className, CSS-селекторы .foo и #bar, id="baz"
    for (const m of line.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      for (const cls of m[1].split(/\s+/)) bump('.', cls, line);
    }
    for (const m of line.matchAll(/id\s*=\s*["'`]([\w-]+)["'`]/g)) bump('#', m[1], line);
    for (const m of line.matchAll(/(^|[\s,{>+~])\.([a-z][\w-]{2,})/gi)) bump('.', m[2], line);
    for (const m of line.matchAll(/(^|[\s,{>+~])#([a-z][\w-]{2,})/gi)) bump('#', m[2], line);
  }

  return { files: [...files], selectors: [...touched.values()].sort((a, b) => b.hits - a.hits) };
}

/**
 * Строит карту «селектор → экраны» из уже снятых слепков.
 *
 * @param {Array<{screen: string, figmaName: string, sections: Array}>} screens
 */
export function buildScreenIndex(screens) {
  const index = new Map();

  const walk = (node, screen) => {
    const key = node.key?.replace(/\[\d+\]$/, '');
    if (key) {
      const entry = index.get(key) ?? new Set();
      entry.add(screen);
      index.set(key, entry);
    }
    for (const child of node.children ?? []) walk(child, screen);
  };

  for (const screen of screens) {
    for (const section of screen.sections ?? []) {
      walk(section, screen.figmaName ?? screen.screen);
    }
  }
  return index;
}

/**
 * Сопоставляет затронутые селекторы с экранами.
 *
 * @returns {{matched: Array, unmatched: Array}} unmatched — то, чего нет ни в
 * одном слепке: либо новый элемент, либо экран, который агент ещё не снимал.
 * Прятать его нельзя, это и есть подсказка «сюда добавить сценарий».
 */
export function mapSelectorsToScreens(selectors, index) {
  const byScreen = new Map();
  const unmatched = [];

  for (const item of selectors) {
    const screens = index.get(item.selector);
    if (!screens || screens.size === 0) {
      unmatched.push(item);
      continue;
    }
    for (const screen of screens) {
      const entry = byScreen.get(screen) ?? { screen, selectors: [], weight: 0 };
      entry.selectors.push(item.selector);
      entry.weight += item.hits;
      byScreen.set(screen, entry);
    }
  }

  const matched = [...byScreen.values()].sort((a, b) => b.weight - a.weight);
  return { matched, unmatched };
}

/** Что именно поменялось — влияет на формулировку правки. */
export function classifyChange(diffText) {
  const kinds = new Set();
  const has = (re) => re.test(diffText);

  if (has(/^[+-].*(?:color|background|border-color|fill)\s*:/im)) kinds.add('цвет');
  if (has(/^[+-].*(?:font-size|line-height|font-weight|letter-spacing)\s*:/im)) kinds.add('типографика');
  if (has(/^[+-].*(?:padding|margin|gap|width|height|top|left|right|bottom)\s*:/im)) kinds.add('размеры и отступы');
  if (has(/^[+-].*(?:border-radius)\s*:/im)) kinds.add('радиусы');
  if (has(/^[+-].*(?:box-shadow)\s*:/im)) kinds.add('тени');
  if (has(/^[+-]\s*<[a-z]/im)) kinds.add('разметка');
  if (has(/^[+-].*(?:>[^<>]{4,}<)/m)) kinds.add('текст');

  return [...kinds];
}
