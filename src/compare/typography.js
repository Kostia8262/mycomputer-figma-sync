/**
 * Сверка типографики и теней.
 *
 * Размеры шрифта в этом проекте двух видов, и путать их нельзя:
 *   `--fs-16: 16px`                      — одинаков на всех брейкпоинтах;
 *   `--fs-hero-title: clamp(28,3.8vw,46)` — свой на каждом.
 *
 * В макете это отражено режимами коллекции Typography (Desktop 1440 /
 * Tablet 1024 / Mobile 390), и проверка обязана идти по режимам: значение,
 * верное для десктопа, на мобильном будет неверным.
 *
 * Расчёт сходится с макетом точно: `clamp(28px, 3.8vw, 46px)` при 1024 даёт
 * 38.912, и ровно столько лежит в режиме Tablet.
 */

const CLAMP = /^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)$/i;
const PX = /^([\d.]+)px$/;

/** Ширины, соответствующие режимам коллекции Typography. */
export const MODE_WIDTHS = {
  'Desktop 1440': 1440,
  'Tablet 1024': 1024,
  'Mobile 390': 390,
};

/**
 * Вычисляет значение размера на конкретной ширине вьюпорта.
 * @returns {number|null} null, если значение не является ни px, ни clamp(vw)
 */
export function resolveFontSize(value, viewportWidth) {
  const plain = PX.exec(value.trim());
  if (plain) return Number(plain[1]);

  const clamp = CLAMP.exec(value.trim().replace(/\s+/g, ' '));
  if (!clamp) return null;

  const [, min, vw, max] = clamp.map(Number);
  const preferred = (vw * viewportWidth) / 100;
  return Math.min(Math.max(preferred, min), max);
}

/**
 * Строит ожидания по типографике: одна запись на переменную, значения по режимам.
 *
 * @param {Array<{name: string, value: string}>} tokens токены категории fontSize
 * @param {string} collection имя коллекции в макете (обычно Typography)
 */
export function buildTypographyExpectations(tokens, collection = 'Typography') {
  const expectations = [];
  const skipped = [];

  for (const { name, value } of tokens) {
    const figma = `fs/${name.replace(/^--fs-/, '')}`;
    const byMode = {};
    let usable = true;

    for (const [mode, width] of Object.entries(MODE_WIDTHS)) {
      const resolved = resolveFontSize(value, width);
      if (resolved === null) {
        usable = false;
        break;
      }
      byMode[mode] = Math.round(resolved * 1000) / 1000;
    }

    if (!usable) {
      skipped.push({ name, value, why: 'размер не в px и не clamp(px, vw, px)' });
      continue;
    }
    expectations.push({ css: name, collection, figma, kind: 'perMode', byMode });
  }

  return { expectations, skipped };
}

// Нулевое смещение пишется без единиц («0 1px 3px …»), поэтому px необязателен.
const LEN = String.raw`(-?[\d.]+)(?:px)?`;
const SHADOW = new RegExp(`^${LEN}\\s+${LEN}\\s+${LEN}(?:\\s+${LEN})?\\s+rgba?\\(([^)]+)\\)$`, 'i');

/**
 * Разбирает первую тень CSS-значения.
 *
 * Берётся только первая: в макете эффект-стиль тоже описан одним слоем
 * (`Shadow/md` = 0,4 blur 16), а вторая тень в CSS — добивка, которой в
 * стиле нет. Сравнивать список с одиночным слоем значило бы всегда врать.
 */
export function parseShadow(value) {
  const first = value.split(/,(?![^(]*\))/)[0].trim();
  const match = SHADOW.exec(first.replace(/\s+/g, ' '));
  if (!match) return null;

  const [, x, y, blur, , color] = match;
  const parts = color.split(',').map((p) => Number(p.trim()));
  if (parts.length < 3) return null;

  return {
    offset: { x: Number(x), y: Number(y) },
    radius: Number(blur),
    color: { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 },
  };
}

/** `--sh-md` → `Shadow/md`. */
export function buildShadowExpectations(tokens) {
  const expectations = [];
  const skipped = [];

  for (const { name, value } of tokens) {
    const shadow = parseShadow(value);
    if (!shadow) {
      skipped.push({ name, value, why: 'тень не разбирается (переменная внутри или нестандартный формат)' });
      continue;
    }
    expectations.push({
      css: name,
      styleName: `Shadow/${name.replace(/^--sh-/, '')}`,
      kind: 'shadow',
      ...shadow,
    });
  }
  return { expectations, skipped };
}
