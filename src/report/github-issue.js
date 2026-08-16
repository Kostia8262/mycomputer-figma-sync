/**
 * Тот же план правок, но в виде GitHub Issue.
 *
 * Дублирование со страницей в Figma намеренное: у них разные читатели.
 * Страница живёт рядом с макетом и удобна в работе, issue живёт рядом с
 * деплоями, держит историю и закрывается галочкой.
 *
 * Формат — чек-лист: строку можно отметить по мере выполнения, а номер
 * совпадает с номером карточки на странице макета, чтобы два списка
 * читались как один.
 */

/** Ссылка прямо на узел макета — без неё «слой Footer» надо искать руками. */
function figmaLink(fileKey, nodeId) {
  if (!fileKey || !nodeId) return null;
  return `https://www.figma.com/design/${fileKey}?node-id=${nodeId.replace(':', '-')}`;
}

/** Достаёт id узла из адреса вида «… (id 103:1310)». */
function nodeIdFrom(address) {
  const match = /\(id ([\dI:;-]+)\)/.exec(address ?? '');
  return match ? match[1] : null;
}

export function buildIssueBody(plan, { checkedAt, sourceLabel, figmaFileKey, figmaFileTitle, gaps = [] }) {
  const lines = [];

  lines.push(`**Файл макета:** [${figmaFileTitle}](https://www.figma.com/design/${figmaFileKey})`);
  lines.push(`**Сверено:** ${checkedAt} · **источник значений:** \`${sourceLabel}\``);
  lines.push('');
  lines.push('Продакшен — эталон: все правки вносятся в макет, код не трогаем.');
  lines.push('Тот же перечень лежит в макете на странице **🛠 Правки з прода**.');
  lines.push('');

  if (gaps.length) {
    lines.push('> [!WARNING]');
    lines.push('> **Сверено не всё:**');
    for (const gap of gaps) lines.push(`> - ${gap}`);
    lines.push('');
  }

  if (plan.total === 0) {
    lines.push('Расхождений не найдено.');
    return lines.join('\n');
  }

  for (const stage of plan.stages) {
    lines.push(`## ${stage.title}`);
    lines.push(`_${stage.hint}_`);
    lines.push('');

    for (const step of stage.steps) {
      const link = figmaLink(figmaFileKey, nodeIdFrom(step.address));
      const title = link ? `[${step.title}](${link})` : step.title;

      lines.push(`- [ ] **${step.n}. ${title}**`);
      if (step.address) lines.push(`  - Где: ${step.address}`);
      if (step.value) lines.push(`  - Значение: \`${step.value}\``);
      lines.push(`  - ${step.how}`);
      if (step.note) lines.push(`  - ⚠️ ${step.note}`);
      lines.push(`  - Источник: \`${step.source}\` · проверка: ${step.verify}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Проверить результат: \`node src/cli.js vsfigma --target ${plan.target}\` и \`node src/cli.js emit --target ${plan.target}\``);

  return lines.join('\n');
}

export function buildIssueTitle(plan, checkedAt) {
  const suffix = plan.total === 0 ? 'расхождений нет' : `правок: ${plan.total}`;
  return `Макет ↔ прод: ${plan.title} — ${suffix} (${checkedAt})`;
}
