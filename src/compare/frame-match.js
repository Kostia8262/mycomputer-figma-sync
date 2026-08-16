/**
 * Сопоставление коммита с кадрами макета.
 *
 * Смысл перехода: раньше агент сравнивал все кадры подряд, что нерентабельно
 * (в трёх файлах ~350 кадров, снимать умеет два десятка). Теперь отправная
 * точка — коммит: он говорит, какие кадры вообще затронуты, а снимаются и
 * сверяются только они.
 *
 * Три исхода на кадр:
 *   доработать — кадр есть в макете, изменение к нему относится;
 *   создать    — в макете такого кадра нет, а на проде состояние появилось;
 *   уточнить   — сигналов мало, решает человек.
 */

/** Нормализация для нечёткого сравнения: регистр, ё/є, дефисы. */
const norm = (s) =>
  s.toLowerCase()
    .replace(/[ёе]/g, 'е')
    .replace(/[іi]/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Слова, по которым нельзя опознать кадр. */
const STOP = new Set(['desktop', 'tablet', 'mobile', 'compact', 'сторінка', 'страница', '1440', '1024', '390', '900']);

function keywords(text) {
  return new Set(
    norm(text)
      .split(' ')
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

/**
 * Кадры одного экрана на разных брейкпоинтах — это один объект работы.
 * «Правила та умови — Desktop/Tablet/Mobile» правятся вместе, и показывать их
 * тремя отдельными задачами значит утроить список без пользы.
 */
export function groupFrames(catalog) {
  const groups = new Map();

  for (const frame of catalog) {
    const base = frame.name
      .replace(/\s*[—–-]\s*(Desktop|Tablet|Mobile|Compact)\s*\d*\s*$/i, '')
      .replace(/\s*\((Desktop|Tablet|Mobile)\)\s*$/i, '')
      .trim();

    const key = `${frame.page}|${base}`;
    const entry = groups.get(key) ?? { page: frame.page, base, frames: [] };
    entry.frames.push(frame);
    groups.set(key, entry);
  }
  return [...groups.values()];
}

/**
 * @param {object} input
 *   files      — пути изменённых файлов
 *   selectors  — селекторы из diff
 *   texts      — текстовые строки из diff (заголовки, подписи)
 *   groups     — сгруппированный каталог кадров
 *   pathMap    — прямые соответствия «кусок пути → имя кадра» из конфига
 *   screenIndex— карта «селектор → снятый экран» из слепков
 */
export function matchCommitToFrames({ files, selectors = [], texts = [], groups, pathMap = {}, screenIndex }) {
  const scored = new Map();

  const add = (group, weight, why) => {
    const key = `${group.page}|${group.base}`;
    const entry = scored.get(key) ?? { ...group, score: 0, reasons: [] };
    entry.score += weight;
    if (!entry.reasons.includes(why)) entry.reasons.push(why);
    scored.set(key, entry);
  };

  // 1. Путь файла — самый надёжный сигнал: docs/terms.html однозначно
  // указывает на кадр «Правила та умови», гадать не нужно.
  for (const file of files) {
    for (const [fragment, frameName] of Object.entries(pathMap)) {
      if (!file.includes(fragment)) continue;
      const group = groups.find((g) => norm(g.base) === norm(frameName));
      if (group) add(group, 10, `путь ${fragment}`);
    }
  }

  // 2. Селекторы, встреченные на уже снятых экранах.
  if (screenIndex) {
    for (const item of selectors) {
      const screens = screenIndex.get(item.selector);
      if (!screens) continue;
      for (const screen of screens) {
        const group = groups.find((g) => norm(screen).includes(norm(g.base)));
        if (group) add(group, 3 + item.hits, `селектор ${item.selector}`);
      }
    }
  }

  // 3. Тексты из diff против имён кадров. Имена содержательны
  // («Заявка — Error», «Оплата — WayForPay»), поэтому совпадение слова
  // это реальный сигнал, а не совпадение по случайности.
  const textWords = new Set();
  for (const line of texts) for (const w of keywords(line)) textWords.add(w);

  for (const group of groups) {
    const words = keywords(group.base);
    const common = [...words].filter((w) => textWords.has(w));
    if (common.length) add(group, 2 * common.length, `текст: ${common.slice(0, 3).join(', ')}`);
  }

  const matched = [...scored.values()].sort((a, b) => b.score - a.score);
  return matched;
}

/**
 * Ищет экраны, которых в макете нет.
 *
 * Первая версия искала редкие слова из diff — и на юридических страницах
 * захлебнулась: «послуги», «перiод», «пiдписки» это содержимое документа,
 * а не название экрана. Текст меняется постоянно и новым кадром не является.
 *
 * Надёжных признаков нового экрана два:
 *   1) в коммите появился новый файл страницы;
 *   2) в разметку добавлен контейнер верхнего уровня с новым id.
 * Оба означают «на проде появилось то, чего в макете никто не рисовал».
 */
export function findMissingFrames({ addedFiles = [], newContainers = [], groups, pathMap = {} }) {
  const known = new Set(groups.map((g) => norm(g.base)));
  const proposals = [];

  for (const file of addedFiles) {
    // Экраном может стать только страница. Серверные модули и скрипты
    // попадают в тот же список добавленных файлов, но кадра не требуют.
    if (!/\.(html?|ejs|hbs)$/i.test(file)) continue;
    // Если файл уже описан в карте и кадр под него есть — это не новый экран.
    const mapped = Object.entries(pathMap).find(([fragment]) => file.includes(fragment));
    if (mapped && known.has(norm(mapped[1]))) continue;

    proposals.push({
      kind: 'новая страница',
      source: file,
      suggestion: file.split('/').pop().replace(/\.\w+$/, ''),
      why: 'файл добавлен в этом коммите, кадра под него нет',
    });
  }

  for (const container of newContainers) {
    if (known.has(norm(container))) continue;
    proposals.push({
      kind: 'новый блок',
      source: container,
      suggestion: container,
      why: 'контейнер с таким id появился в разметке',
    });
  }

  return proposals;
}

/** Контейнеры верхнего уровня, добавленные в этом коммите. */
export function newContainersFromDiff(diffText) {
  const found = new Set();
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    // Интересуют только крупные блоки: section/main/article с id.
    for (const m of line.matchAll(/<(?:section|main|article|div)[^>]*\bid\s*=\s*["']([\w-]{3,})["']/gi)) {
      found.add(m[1]);
    }
  }
  return [...found];
}

/** Достаёт из diff видимые тексты: заголовки, подписи, содержимое тегов. */
export function textsFromDiff(diffText) {
  const out = [];
  for (const line of diffText.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    for (const m of line.matchAll(/>([^<>{}]{4,120})</g)) {
      const text = m[1].trim();
      if (text && !/^[\d\s.,:;+-]*$/.test(text)) out.push(text);
    }
  }
  return out;
}
