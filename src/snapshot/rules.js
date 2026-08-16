/**
 * Правила, отделяющие осознанное решение от дрейфа.
 *
 * Без них сторож бесполезен: сайт blender намеренно перекрашен в терракоту и
 * честно даёт 29 отличий от эталона, из которых на правку тянет ровно одно.
 * Утонув в таком шуме, отчёт перестают читать.
 */

/** `--color-primary*` → регулярка. Поддерживается только хвостовая `*`. */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function makeClassifier(tokenRules) {
  const themable = (tokenRules.themable ?? []).map(patternToRegExp);
  const isThemable = (name) => themable.some((re) => re.test(name));

  /**
   * @returns {'info'|'warn'} info — ожидаемое отличие темы, warn — дрейф на правку
   */
  return function severityOf(difference) {
    // Пропажа или появление токена — всегда дрейф: тема меняет значения,
    // а не состав системы. Появление `--fs-19` рядом с существующим `--fs-18`
    // это ровно тот случай, когда токен завели под один макет.
    if (difference.kind !== 'другое значение') return 'warn';
    return isThemable(difference.name) ? 'info' : 'warn';
  };
}

const HEX_FULL = /^#([0-9a-f]{6})$/i;

function hexToRgbTriple(hex) {
  const match = HEX_FULL.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function parseRgbTriple(value) {
  const parts = value.split(',').map((p) => Number(p.trim()));
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/**
 * Ловит рассинхрон между hex-токеном и его rgb-двойником.
 *
 * Проект держит цвет в двух видах — `--color-primary: #6C47FF` и
 * `--color-primary-rgb: 108,71,255` — потому что второй подставляется в
 * `rgba(var(--x-rgb), .12)` для теней. Правка одного без другого не ломает
 * сборку и не бросается в глаза, но красит тени в другой цвет.
 */
export function checkHexRgbPairs(tokens, pairs) {
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  const problems = [];

  for (const [hexName, rgbName] of pairs) {
    const hex = byName.get(hexName);
    const rgb = byName.get(rgbName);
    if (!hex || !rgb) continue;

    const fromHex = hexToRgbTriple(hex);
    const declared = parseRgbTriple(rgb);
    if (!fromHex || !declared) continue;

    if (fromHex.join(',') !== declared.join(',')) {
      problems.push({
        kind: 'рассинхрон hex и rgb',
        hexName,
        rgbName,
        hex,
        expectedRgb: fromHex.join(','),
        actualRgb: declared.join(','),
      });
    }
  }
  return problems;
}
