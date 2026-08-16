/**
 * Снимает дизайн-токены с исходников сайта: разбирает блок `:root` в CSS
 * и раскладывает переменные по категориям, которые понимает Figma.
 *
 * Источник истины — код, а не макет. Всё, что здесь собрано, потом
 * сравнивается со стилями и переменными Figma-файла соответствующего таргета.
 *
 * Зависимостей нет — только стандартная библиотека Node.
 */

import { readFile } from 'node:fs/promises';

/** Категории, в которые раскладываются переменные. Порядок важен: первое совпадение выигрывает. */
const CATEGORIES = [
  { name: 'color',      test: (n, v) => /^--(color|dark)-/.test(n) || isColor(v) },
  { name: 'radius',     test: (n) => /^--r-/.test(n) },
  { name: 'shadow',     test: (n) => /^--sh-/.test(n) },
  { name: 'fontSize',   test: (n) => /^--fs-/.test(n) },
  { name: 'lineHeight', test: (n) => /^--lh-/.test(n) },
  { name: 'fontWeight', test: (n) => /^--fw-/.test(n) },
  { name: 'fontFamily', test: (n) => /^--font/.test(n) },
  { name: 'transition', test: (n) => /^--ts?$/.test(n) },
  { name: 'zIndex',     test: (n) => /^--z-/.test(n) },
];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isColor(value) {
  return HEX.test(value) || /^(rgb|hsl)a?\(/i.test(value);
}

function categorize(name, value) {
  const hit = CATEGORIES.find((c) => c.test(name, value));
  return hit ? hit.name : 'other';
}

/**
 * Вытаскивает объявления из всех блоков `:root` файла.
 *
 * Наивный «найти :root и читать до }» ломается о вложенные `rgba(...)` со
 * скобками и о несколько :root в одном файле (медиазапросы, тёмная тема),
 * поэтому блок ищется посимвольно по балансу фигурных скобок.
 */
function extractRootBlocks(css) {
  const blocks = [];
  const re = /:root\s*\{/g;
  let match;

  while ((match = re.exec(css)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;

    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

/** Убирает комментарии, чтобы закомментированные токены не попали в слепок. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDeclarations(block) {
  const out = [];
  // Значение может содержать `;` только внутри скобок или кавычек, чего в
  // CSS-переменных этого проекта не встречается — режем по `;` напрямую.
  for (const raw of block.split(';')) {
    const decl = raw.trim();
    if (!decl.startsWith('--')) continue;

    const colon = decl.indexOf(':');
    if (colon === -1) continue;

    const name = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim().replace(/\s+/g, ' ');
    if (name && value) out.push({ name, value });
  }
  return out;
}

/**
 * Раскрывает ссылки `var(--x)` внутри значений, чтобы сравнение с Figma шло по
 * конечным значениям: в макете лежит готовый цвет, а не ссылка на другой токен.
 * Циклы и незакрытые ссылки оставляются как есть.
 */
function resolveReferences(tokens) {
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  const VAR = /var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g;

  const resolve = (value, seen) => {
    return value.replace(VAR, (whole, ref, fallback) => {
      if (seen.has(ref)) return whole;
      const target = byName.get(ref);
      if (target === undefined) return fallback ? fallback.trim() : whole;
      return resolve(target, new Set([...seen, ref]));
    });
  };

  return tokens.map((t) => {
    const resolved = resolve(t.value, new Set([t.name]));
    return resolved === t.value ? t : { ...t, value: resolved, raw: t.value };
  });
}

/**
 * @param {string} cssPath путь к файлу со стилями сайта
 * @returns {Promise<{source: string, count: number, byCategory: Record<string, Array>}>}
 */
export async function collectTokens(cssPath) {
  const css = stripComments(await readFile(cssPath, 'utf8'));
  const declarations = extractRootBlocks(css).flatMap(parseDeclarations);

  // Позднее объявление побеждает — как и в самом CSS.
  const deduped = [...new Map(declarations.map((d) => [d.name, d])).values()];
  const resolved = resolveReferences(deduped);

  const byCategory = {};
  for (const token of resolved) {
    const category = categorize(token.name, token.value);
    (byCategory[category] ??= []).push(token);
  }
  for (const list of Object.values(byCategory)) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { source: cssPath, count: resolved.length, byCategory };
}
