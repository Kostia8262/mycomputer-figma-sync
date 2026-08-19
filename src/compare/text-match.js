/**
 * Сопоставление текстов прода и макета.
 *
 * Отдельный модуль, потому что нормализация обязана быть ОДНА на обе стороны.
 * Стоит развести правила — и сверка начнёт врать в обе стороны сразу: «КУРСИ»
 * из макета (в вёрстке это `text-transform: uppercase`, а не текст) выглядел бы
 * как пропажа, а неразрывный пробел в телефоне — как правка.
 *
 * Что сознательно НЕ считается расхождением:
 *   — регистр: заглавные в макете чаще всего рисуют стиль, а не содержание;
 *   — вид тире и кавычек: – — ‒ − неразличимы на глаз и правятся редактором;
 *   — любые пробелы, включая неразрывные и узкие.
 *
 * Что считается: другое слово, другая цифра, лишний или недостающий пункт,
 * переставленные строки.
 */

/** ‐ ‑ ‒ – — ― − — на глаз одно и то же, в юникоде семь разных символов. */
const DASHES = /[\u2010-\u2015\u2212]/g;
const QUOTES = /[«»„“”"'’‘`]/g;
const SPACES = /[\s\u00a0\u2007\u202f\u2009]+/g;
/**
 * Эмодзи выбрасываются с обеих сторон.
 *
 * В вёрстке «⏱ 18 місяців» — это иконка внутри той же строки, а в макете
 * иконка нарисована вектором рядом с текстом. Сравнивать их как текст значит
 * требовать правки там, где всё верно.
 */
const EMOJI = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(EMOJI, ' ')
    .replace(DASHES, '-')
    .replace(QUOTES, '"')
    .replace(SPACES, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Расстояние Левенштейна с ранним выходом.
 *
 * Нужно только для пары «похоже, но не то же»: строки короткие (в слепке они
 * обрезаны), а до сравнения доходят лишь остатки, не совпавшие точно.
 */
function distance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 — совпадает целиком, 0 — ничего общего. */
export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  // Строки, различающиеся по длине втрое, похожими не бывают, а считать
  // расстояние между ними всё равно пришлось бы посимвольно.
  if (Math.min(a.length, b.length) / longest < 0.34) return 0;
  return 1 - distance(a, b) / longest;
}

/** Ниже этого две строки считаются разными пунктами, а не правкой одного. */
const SIMILAR_ENOUGH = 0.55;

/**
 * Сводит два списка строк.
 *
 * Порядок действий важен: сначала выбираются точные совпадения, и только
 * остаток парится по похожести. Если пустить похожесть первой, «Python (6-18
 * років)» притянет к себе «Roblox (6-14 років)» раньше, чем найдёт свою пару.
 *
 * @param {{t:string,where?:string}[]} prodLines строки со страницы
 * @param {{t:string,id?:string}[]} figmaLines строки из макета
 */
export function pairLines(prodLines, figmaLines) {
  // Второй ключ — без пробелов вовсе. Вёрстка нередко склеивает соседние
  // строчные узлы («<span>6–10</span><span>років</span>» даёт «6–10років»),
  // хотя на экране между ними отступ. В макете это один слой с пробелом, и
  // без запасного ключа каждая такая пара читалась бы как две правки.
  const key2 = (value) => normalize(value).replace(/ /g, '');
  const prod = prodLines.map((line, i) => ({ ...line, i, n: normalize(line.t), n2: key2(line.t) }));
  const figma = figmaLines.map((line, i) => ({ ...line, i, n: normalize(line.t), n2: key2(line.t) }));

  const freeFigma = new Map();
  for (const line of figma) {
    if (!freeFigma.has(line.n)) freeFigma.set(line.n, []);
    freeFigma.get(line.n).push(line);
  }

  const pairs = [];
  const restProd = [];

  for (const line of prod) {
    const bucket = freeFigma.get(line.n);
    if (bucket?.length) pairs.push({ prod: line, figma: bucket.shift(), exact: true });
    else restProd.push(line);
  }

  let restFigma = [...freeFigma.values()].flat().sort((a, b) => a.i - b.i);

  // Второй заход — по ключу без пробелов, до сравнения по похожести.
  const spaceless = new Map();
  for (const line of restFigma) {
    if (!spaceless.has(line.n2)) spaceless.set(line.n2, []);
    spaceless.get(line.n2).push(line);
  }
  const stillProd = [];
  for (const line of restProd) {
    const bucket = spaceless.get(line.n2);
    if (bucket?.length) {
      const match = bucket.shift();
      match.taken = true;
      pairs.push({ prod: line, figma: match, exact: true });
    } else stillProd.push(line);
  }
  restProd.length = 0;
  restProd.push(...stillProd);
  restFigma = restFigma.filter((line) => !line.taken);

  const changed = [];

  for (const line of restProd.slice()) {
    let best = null;
    let bestScore = SIMILAR_ENOUGH;
    for (const candidate of restFigma) {
      if (candidate.taken) continue;
      const score = similarity(line.n, candidate.n);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) continue;
    best.taken = true;
    line.taken = true;
    changed.push({ prod: line, figma: best, score: Math.round(bestScore * 100) / 100 });
    pairs.push({ prod: line, figma: best, exact: false });
  }

  // Порядок сверяется только по парам: строка, которой в макете нет вовсе,
  // не может «стоять не там», и мешать одно с другим значит удваивать шум.
  pairs.sort((a, b) => a.prod.i - b.prod.i);
  let reorder = null;
  for (let i = 1; i < pairs.length; i += 1) {
    if (pairs[i].figma.i < pairs[i - 1].figma.i) {
      reorder = {
        after: pairs[i - 1].prod.t,
        line: pairs[i].prod.t,
        nodeId: pairs[i].figma.id,
      };
      break;
    }
  }

  return {
    matched: pairs.length,
    changed,
    missingInFigma: restProd.filter((line) => !line.taken),
    onlyInFigma: restFigma.filter((line) => !line.taken),
    reorder,
  };
}
