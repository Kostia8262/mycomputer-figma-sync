/**
 * Готовит проверку макета по слепку кода.
 *
 * План Figma у пользователя Professional — Variables REST API там закрыт, читать
 * переменные можно только скриптом внутри файла. Гонять оттуда все 250+ переменных
 * ради сверки расточительно, поэтому наружу уезжает список ожидаемых значений, а
 * обратно возвращаются только расхождения.
 *
 * Соответствие имён у этого проекта механическое, без эвристик:
 *   --color-primary → Semantic  color/primary
 *   --dark-border   → Semantic  dark/border
 *   --r-sm          → Radius    r/sm
 *   --sh-md         → EffectStyle Shadow/md
 */

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Приводит цвет любой записи к `#rrggbb` + alpha.
 * В коде один и тот же цвет встречается и как `#FFFFFF`, и как `rgba(255,255,255,.1)`,
 * а Figma отдаёт только каналы 0–1 — без общей формы сравнивать нечего.
 */
export function normalizeColor(value) {
  const input = value.trim().toLowerCase();

  const short = HEX3.exec(input);
  if (short) return { hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`, alpha: 1 };

  const full = HEX6.exec(input);
  if (full) return { hex: `#${full[1]}`, alpha: 1 };

  const rgb = RGB.exec(input);
  if (rgb) {
    const to = (n) => Math.round(Number(n)).toString(16).padStart(2, '0');
    return { hex: `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`, alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  }
  return null;
}

/** `--r-sm: 8px` → 8. Значения вроде `clamp(...)` осознанно пропускаются. */
function normalizeLength(value) {
  const match = /^(-?[\d.]+)px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Строит список «что проверить» по правилам именования таргета.
 *
 * Словарь у каждого макета свой и зашивать его в код нельзя: сайты называют цвет
 * `color/primary`, а дашборд — `brand/500`, и оба варианта правильные. Правила
 * живут в design-map.json, здесь только применяются: побеждает первое совпавшее,
 * поэтому частные правила в конфиге стоят выше общих.
 */
export function buildExpectations(reference, naming) {
  const rules = naming.rules.map((rule) => ({ ...rule, re: new RegExp(rule.match) }));
  const expectations = [];
  const skipped = [];
  const unmapped = [];

  for (const { name, value } of Object.values(reference.byCategory).flat()) {
    // `--color-primary-rgb` не отдельный токен, а вторая форма записи основного.
    // В макете ему нечему соответствовать — парность проверяет rules.js.
    if (name.endsWith('-rgb')) continue;

    const rule = rules.find((r) => r.re.test(name));
    if (!rule) {
      // Молчаливый пропуск опаснее пробела: отчёт выглядел бы полным, не будучи им.
      unmapped.push({ name, value });
      continue;
    }

    const figma = name.replace(rule.re, rule.name);

    if (rule.kind === 'color') {
      const color = normalizeColor(value);
      if (!color) {
        skipped.push({ name, value, why: 'цвет в неразбираемой форме' });
        continue;
      }
      expectations.push({ css: name, collection: rule.collection, figma, kind: 'color', ...color });
    } else {
      const length = normalizeLength(value);
      if (length === null) {
        skipped.push({ name, value, why: 'значение не в px' });
        continue;
      }
      expectations.push({ css: name, collection: rule.collection, figma, kind: 'number', value: length });
    }
  }
  return { expectations, skipped, unmapped };
}

/**
 * Собирает самодостаточный скрипт для `use_figma`.
 * Он выполняется внутри файла и возвращает только то, что разошлось или не найдено.
 */
export function emitFigmaScript(expectations) {
  return `const EXPECTED = ${JSON.stringify(expectations)};

const toHex = (c) => {
  const to = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
  return '#' + to(c.r) + to(c.g) + to(c.b);
};

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const index = new Map();
for (const collection of collections) {
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    index.set(collection.name + '|' + variable.name, { variable, collection });
  }
}

// Значение может быть алиасом на примитив — разворачиваем до конечного,
// иначе сравнивать будет не с чем.
const resolve = async (variable, collection) => {
  let current = variable;
  let modeId = collection.defaultModeId;
  for (let hop = 0; hop < 10; hop += 1) {
    const raw = current.valuesByMode[modeId];
    if (!raw || raw.type !== 'VARIABLE_ALIAS') return raw;
    current = await figma.variables.getVariableByIdAsync(raw.id);
    const owner = collections.find((c) => c.variableIds.includes(current.id));
    modeId = owner ? owner.defaultModeId : modeId;
  }
  return null;
};

const missing = [];
const mismatched = [];

for (const item of EXPECTED) {
  const found = index.get(item.collection + '|' + item.figma);
  if (!found) { missing.push({ css: item.css, expectedAt: item.collection + '/' + item.figma }); continue; }

  const value = await resolve(found.variable, found.collection);
  if (value === null || value === undefined) { missing.push({ css: item.css, expectedAt: item.collection + '/' + item.figma, why: 'значение не разрешилось' }); continue; }

  if (item.kind === 'color') {
    const hex = toHex(value);
    const alpha = value.a === undefined ? 1 : value.a;
    if (hex !== item.hex || Math.abs(alpha - item.alpha) > 0.02) {
      mismatched.push({ css: item.css, figma: item.collection + '/' + item.figma, inCode: item.hex + (item.alpha < 1 ? '/' + item.alpha : ''), inFigma: hex + (alpha < 1 ? '/' + alpha.toFixed(2) : '') });
    }
  } else if (Math.abs(Number(value) - item.value) > 0.01) {
    mismatched.push({ css: item.css, figma: item.collection + '/' + item.figma, inCode: item.value, inFigma: value });
  }
}

return { checked: EXPECTED.length, missing, mismatched };`;
}
