#!/usr/bin/env node
/**
 * Точка входа сторожа. Одинаково работает на macOS и Windows: пути только через
 * path.join, никаких shell-вызовов, никаких зашитых домашних каталогов.
 *
 *   npm run snapshot -- [--repo <путь>] [--out <папка>]
 *
 * Путь к репозиторию продакшена берётся, в порядке приоритета, из:
 *   1) флага --repo
 *   2) переменной окружения MC_REPO_PATH (её и стоит задать в .env на каждой машине)
 *   3) config.repo.localPathHint относительно домашнего каталога
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { collectTokens } from './snapshot/tokens.js';
import { makeClassifier, checkHexRgbPairs } from './snapshot/rules.js';
import { buildExpectations, emitFigmaScript } from './compare/emit-check.js';
import { buildEditsPlan } from './report/edits-plan.js';
import { emitEditsPageScript } from './report/figma-page.js';
import { buildIssueBody, buildIssueTitle } from './report/github-issue.js';
import { selectorsFromDiff, buildScreenIndex, mapSelectorsToScreens, classifyChange } from './compare/commit-map.js';
import { groupFrames, matchCommitToFrames, findMissingFrames, textsFromDiff, newContainersFromDiff } from './compare/frame-match.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { collectLayout, extractInPage, MAX_DEPTH, MAX_CHILDREN, TRACKED_STYLES } from './snapshot/layout.js';
import { collectText } from './snapshot/text.js';
import { collectAdminTabs } from './snapshot/admin-tabs.js';
import { loadEnv } from './env.js';
import { diffLayouts } from './compare/layout-diff.js';
import { emitFigmaLayoutScript, compareLayoutToFigma } from './compare/figma-layout.js';
import { emitFramesLayoutScript, compareScreenToFrame, compareTables } from './compare/figma-frames.js';
import { emitFigmaTextScript, compareTextsToFigma, expandFigmaText } from './compare/figma-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_DIR = path.join(ROOT, 'state', 'layout');
// Тексты платформонезависимы: «Ціни» на маке и на Windows пишутся одинаково,
// поэтому файл общий, в отличие от геометрии, разложенной по ОС.
const TEXT_DIR = path.join(ROOT, 'state', 'text');
const FIGMA_TEXT_DIR = path.join(ROOT, 'state', 'figma-text');
const PLATFORMS = ['darwin', 'win32', 'linux'];

/**
 * Слепки геометрии платформозависимы, поэтому у каждой машины свой файл.
 *
 * Один и тот же прод в headless Chrome меряется по-разному: на маке шрифт
 * резолвится в «system-ui», на Windows — в «BlinkMacSystemFont», метрики
 * расходятся, и высота главной отличается на 183 px при одинаковом коде.
 * Общий файл в git превращал бы каждую смену машины в сотни ложных правок.
 */
const layoutFile = (name) => path.join(LAYOUT_DIR, `${name}.${process.platform}.json`);

/**
 * Говорит вслух, когда сверка идёт не с той машины, где сводили макет.
 *
 * Проверено на одном и том же макете: маковский слепок главной даёт три
 * расхождения на desktop, виндовый — тринадцать, по 20–70 px. Это не дрейф
 * макета, а метрики шрифтов, и молча выдавать такое за работу нельзя.
 */
function platformWarnings(target, foreign) {
  const measuredOn = target?.layout?.measuredOn;
  const shooter = foreign ?? process.platform;
  if (!measuredOn || measuredOn === shooter) return [];

  return [
    `ВНИМАНИЕ: макет сводили по замерам с ${measuredOn}, а слепок снят на ${shooter}.`,
    '  Расхождения ниже — в основном разница метрик шрифтов. Сверять надо с той же ОС.',
  ];
}

/** Слепок своей машины, иначе чужой: сверка с макетом на нём всё равно полезнее пустоты. */
function findLayoutFile(name) {
  const own = layoutFile(name);
  if (existsSync(own)) return { file: own, foreign: null };

  for (const platform of PLATFORMS) {
    const other = path.join(LAYOUT_DIR, `${name}.${platform}.json`);
    if (existsSync(other)) return { file: other, foreign: platform };
  }
  return { file: null, foreign: null };
}

async function loadConfig() {
  const file = path.join(ROOT, 'config', 'design-map.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const next = argv[i + 1];
      args[item.slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++i];
    }
    else args._.push(item);
  }
  return args;
}

function resolveRepoPath(config, args) {
  const candidates = [
    args.repo,
    process.env.MC_REPO_PATH,
    path.join(os.homedir(), ...config.repo.localPathHint.split('/')),
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Репозиторий продакшена не найден. Проверены пути:\n  ${candidates.join('\n  ')}\n` +
        'Задайте MC_REPO_PATH в .env или передайте --repo <путь>.',
    );
  }
  return found;
}

/**
 * Собирает токены по каждому таргету: эталон сети и её сайты-сателлиты.
 *
 * Сравнивать всё подряд с одним эталоном нельзя — сети .education и .school это
 * два поколения дизайна, и кросс-сравнение выдаёт дрейф там, где его нет.
 */
async function snapshot(config, args) {
  const repo = resolveRepoPath(config, args);
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'state', 'snapshots');
  await mkdir(outDir, { recursive: true });

  const severityOf = makeClassifier(config.tokenRules);
  const pairs = config.tokenRules.mustMatchHexToRgb;
  const results = [];

  for (const target of config.targets) {
    const referenceCss = path.join(repo, ...target.tokenSource.split('/'));
    const reference = await collectTokens(referenceCss);
    // Путь внутри слепка — только относительный. Абсолютный делает файл вечно
    // изменённым: мак пишет /Users/kostiantyn/…, Windows — D:\Проекты\…, и
    // машины гоняют друг другу пустые коммиты, где меняется одна строка.
    reference.source = target.tokenSource;
    const referenceBroken = checkHexRgbPairs(Object.values(reference.byCategory).flat(), pairs);
    const satellites = [];

    for (const { site } of target.satellites) {
      const cssPath = path.join(repo, 'sites', site, 'css', 'style.css');
      if (!existsSync(cssPath)) {
        satellites.push({ site, status: 'нет файла стилей', differences: [], broken: [] });
        continue;
      }
      const snap = await collectTokens(cssPath);
      satellites.push({
        site,
        status: 'ok',
        differences: diffTokens(reference, snap).map((d) => ({ ...d, severity: severityOf(d) })),
        broken: checkHexRgbPairs(Object.values(snap.byCategory).flat(), pairs),
      });
    }

    results.push({ target: target.id, title: target.title, reference, referenceBroken, satellites });
  }

  const outFile = path.join(outDir, 'tokens.json');
  await writeFile(outFile, JSON.stringify({ targets: results }, null, 2) + '\n', 'utf8');
  report(results, outFile);
}

/** Сравнивает набор токенов сателлита с эталоном главного сайта. */
function diffTokens(reference, candidate) {
  const flatten = (snap) =>
    new Map(
      Object.values(snap.byCategory)
        .flat()
        .map((t) => [t.name, t.value]),
    );

  const ref = flatten(reference);
  const cand = flatten(candidate);
  const differences = [];

  for (const [name, value] of ref) {
    if (!cand.has(name)) differences.push({ name, kind: 'отсутствует', expected: value });
    else if (cand.get(name) !== value)
      differences.push({ name, kind: 'другое значение', expected: value, actual: cand.get(name) });
  }
  for (const name of cand.keys()) {
    if (!ref.has(name)) differences.push({ name, kind: 'лишний', actual: cand.get(name) });
  }
  return differences;
}

function report(results, outFile) {
  const warnsOf = (site) => site.differences.filter((d) => d.severity === 'warn');

  for (const { title, reference, referenceBroken, satellites } of results) {
    console.log(`\n${title}`);
    console.log(`  эталон ${reference.source} — ${reference.count} токенов`);
    for (const problem of referenceBroken) {
      console.log(`  ! в эталоне ${problem.hexName} ${problem.hex} ≠ ${problem.rgbName} ${problem.actualRgb}`);
    }

    const dirty = satellites.filter(
      (s) => s.status !== 'ok' || warnsOf(s).length > 0 || s.broken.length > 0,
    );
    if (satellites.length === 0) {
      console.log('  сателлитов нет');
    } else if (dirty.length === 0) {
      console.log(`  все ${satellites.length} сайтов чисты — отличия объясняются темой курса`);
    } else {
      console.log(`  требуют внимания ${dirty.length} из ${satellites.length}:`);
      for (const site of dirty) {
        if (site.status !== 'ok') {
          console.log(`    ${site.site.padEnd(11)} ${site.status}`);
          continue;
        }
        const themed = site.differences.length - warnsOf(site).length;
        const parts = [`${warnsOf(site).length} дрейф`];
        if (site.broken.length) parts.push(`${site.broken.length} рассинхрон hex/rgb`);
        if (themed) parts.push(`${themed} по теме — ок`);
        console.log(`    ${site.site.padEnd(11)} ${parts.join(', ')}`);
      }
    }
  }
  console.log(`\nСлепок записан: ${outFile}`);
}

/**
 * Печатает скрипт сверки для указанного таргета — его выполняет агент через
 * Figma MCP и возвращает расхождения.
 */
async function emit(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}». Есть: ${config.targets.map((t) => t.id).join(', ')}`);

  const snapshotFile = path.join(ROOT, 'state', 'snapshots', 'tokens.json');
  if (!existsSync(snapshotFile)) throw new Error('Сначала выполните npm run snapshot.');

  const saved = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const entry = saved.targets.find((t) => t.target === targetId);
  const { expectations, skipped, unmapped } = buildExpectations(entry.reference, target.naming);

  if (args.stats) {
    console.log(`${target.title} → ${target.figmaFileTitle} (${target.figmaFileKey})`);
    console.log(`  к проверке: ${expectations.length}`);
    console.log(`  пропущено (неразбираемое значение): ${skipped.length}`);
    for (const item of skipped) console.log(`    ${item.name} — ${item.why}`);
    console.log(`  без правила именования: ${unmapped.length}`);
    for (const item of unmapped) console.log(`    ${item.name} = ${item.value}`);
    return;
  }
  console.log(emitFigmaScript(expectations));
}

/**
 * Собирает план правок из ОБОИХ источников — токенов и геометрии — и печатает
 * скрипт, создающий страницу правок в макете.
 *
 * План только по токенам выглядит завершённым, пропуская всё, что съехало,
 * поэтому отсутствие данных по геометрии сообщается явно, а не молчанием.
 */
async function collectPlan(config, targetId) {
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  const checkFile = path.join(ROOT, 'state', 'figma-check.json');
  const { file: prodFile, foreign } = findLayoutFile(targetId);
  const figmaFile = path.join(ROOT, 'state', 'figma-layout', `${targetId}.json`);

  let tokenResult = null;
  let checkedAt = 'нет данных';
  if (existsSync(checkFile)) {
    const check = JSON.parse(await readFile(checkFile, 'utf8'));
    checkedAt = check.checkedAt;
    tokenResult = check.targets.find((t) => t.target === targetId) ?? null;
  }

  const layoutFindings = [];
  const prodByViewport = {};
  const gaps = [];

  if (!tokenResult) gaps.push('сверка токенов не выполнялась');
  // Слепок с другой машины годится, но молчать об этом нельзя: расхождения
  // в пределах пары пикселей на нём объясняются метриками шрифтов, а не продом.
  if (foreign) gaps.push(`слепок прода снят на ${foreign}, а не на этой машине`);
  for (const line of platformWarnings(target, foreign)) gaps.push(line.replace(/^ВНИМАНИЕ: /, ''));

  if (prodFile && existsSync(figmaFile) && target.layout) {
    const prod = JSON.parse(await readFile(prodFile, 'utf8'));
    const figma = JSON.parse(await readFile(figmaFile, 'utf8'));

    for (const view of prod.viewports) {
      prodByViewport[view.viewport] = view;
      const inFigma = figma.viewports[view.viewport];
      if (!inFigma) {
        // Секционная сверка — грубая; если вкладки уже сверены поблочно,
        // её отсутствие на брейкпоинте не пробел, а осознанный отказ.
        if (!existsSync(path.join(ROOT, 'state', `tabs-diff-${targetId}.json`))) {
          gaps.push(`геометрия макета на брейкпоинте ${view.viewport} не снята`);
        }
        continue;
      }
      layoutFindings.push({
        viewport: view.viewport,
        width: view.width,
        url: prod.url,
        page: inFigma.page,
        frame: inFigma.frame,
        result: compareLayoutToFigma(view, inFigma, target.layout.sectionMap),
      });
    }
  } else {
    if (!prodFile) gaps.push('слепок прода не снят');
    // Про секции молчим, если вкладки уже сверены поблочно: у админки это
    // строго более подробная проверка, и дублировать её пробелом значит
    // приучать пропускать список.
    if (!existsSync(figmaFile) && !existsSync(path.join(ROOT, 'state', `tabs-diff-${targetId}.json`))) {
      gaps.push('геометрия макета не снята');
    }
    if (!target.layout) gaps.push('в конфиге нет карты секций (targets[].layout)');
  }

  // Старый слепок макета (три уровня вместо пяти) не даёт разобрать причину и
  // отличить округление от дрейфа. Молчать об этом нельзя: весь список будет
  // выглядеть как набор настоящих правок.
  const shallow = layoutFindings.some((entry) => (entry.result.findings ?? [])
    .some((f) => f.kind === 'размер' && f.causes?.length === 1 && !f.causes[0].path.includes('›')));
  if (shallow) {
    gaps.push('слепок макета снят старой версией (три уровня): причины расхождений не разбираются — пересними vsfigma --emit <брейкпоинт> --part N --parts 2');
  }

  // Отнесённые к округлению расхождения из плана исключены, но исчезнуть
  // бесследно не должны: иначе через месяц кто-то снова начнёт их «чинить».
  const rounded = layoutFindings.flatMap((entry) =>
    (entry.result.findings ?? [])
      .filter((f) => f.kind === 'округление')
      .map((f) => `${f.figma} / ${entry.viewport} ${f.delta.split(' × ')[1] ?? f.delta}`));
  if (rounded.length) {
    gaps.push(
      `${rounded.length} расхождений отнесены к округлению Figma и правки не требуют ` +
      `(${rounded.slice(0, 4).join(', ')}${rounded.length > 4 ? ', …' : ''})`);
  }

  // Тексты сверяются здесь же: слепок прода лежит рядом со слепком геометрии,
  // и отдельный прогон только увеличил бы шанс, что план соберут без них.
  const textFindings = [];
  const prodTextFile = path.join(TEXT_DIR, `${targetId}.json`);
  const figmaTextFile = path.join(FIGMA_TEXT_DIR, `${targetId}.json`);
  if (existsSync(prodTextFile) && existsSync(figmaTextFile) && target.layout) {
    const prodText = JSON.parse(await readFile(prodTextFile, 'utf8'));
    const figmaText = JSON.parse(await readFile(figmaTextFile, 'utf8'));
    for (const view of prodText.viewports) {
      const inFigma = figmaText.viewports?.[view.viewport];
      if (!inFigma) {
        gaps.push(`тексты макета на брейкпоинте ${view.viewport} не сняты`);
        continue;
      }
      textFindings.push({
        viewport: view.viewport,
        width: view.width,
        page: inFigma.page,
        frame: inFigma.frame,
        result: compareTextsToFigma(view, inFigma, target.layout.sectionMap, { ignore: target.text?.ignore ?? [] }),
      });
    }
  } else if (target.layout) {
    if (!existsSync(prodTextFile)) gaps.push(`тексты прода не сняты (node src/cli.js text --target ${targetId})`);
    else gaps.push(`тексты макета не сняты (node src/cli.js vstext --target ${targetId} --emit desktop)`);
  }

  // Поблочная сверка вкладок — основной источник правок по экранам админки:
  // именно она видит плитки, тулбары и таблицы. Кладётся в план, если прогон
  // уже был; если нет — это пробел, а не тишина.
  const tabsDiffFile = path.join(ROOT, 'state', `tabs-diff-${targetId}.json`);
  let tabsDiff = [];
  if (existsSync(tabsDiffFile)) {
    const saved = JSON.parse(await readFile(tabsDiffFile, 'utf8'));
    tabsDiff = saved.screens ?? [];
    if (saved.checkedAt) checkedAt = saved.checkedAt;
  } else if (target.tabs) {
    gaps.push(`поблочная сверка вкладок не выполнялась (node src/cli.js vstabs --target ${targetId})`);
  }

  // Дата на странице — по самой свежей из проверок, а не только по токенам:
  // геометрию пересняли сегодня, а сверку переменных — позавчера, и страница
  // с позавчерашним числом читается как несвежая целиком.
  for (const file of [prodFile, prodTextFile, path.join(ROOT, 'state', `tabs-diff-${targetId}.json`)]) {
    if (!file || !existsSync(file)) continue;
    const stamp = (await stat(file)).mtime.toISOString().slice(0, 10);
    if (stamp > checkedAt) checkedAt = stamp;
  }

  const plan = buildEditsPlan({ tokenResult, layoutFindings, textFindings, prodByViewport, target, tabsDiff });
  if (args?.json) return { plan, gaps, checkedAt, target };
  return { plan, gaps, checkedAt, target };
}

/** Печатает скрипт, создающий страницу правок в макете. */
async function page(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const { plan, gaps, checkedAt, target } = await collectPlan(config, targetId);

  if (args.stats) {
    console.log(`${target.title} → ${target.figmaFileTitle} (${target.figmaFileKey})`);
    console.log(`  правок: ${plan.total}`);
    for (const stage of plan.stages) {
      console.log(`  ${stage.title}:`);
      for (const step of stage.steps) console.log(`    ${step.n}. ${step.title}`);
    }
    if (gaps.length) {
      console.log(`  НЕ ПОКРЫТО: ${gaps.join('; ')}`);
    }
    return;
  }

  console.log(
    emitEditsPageScript(plan, {
      pageName: config.conventions.editsPage,
      checkedAt,
      sourceLabel: target.tokenSource,
      gaps,
      short: Boolean(args.short),
    }),
  );
}

/** Снимает геометрию продакшена и кладёт слепок в state/layout/. */
async function layout(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  const url = args.url ?? target.reference.url;
  await mkdir(LAYOUT_DIR, { recursive: true });

  // Ключ хранится только в .env: в git он не поедет, а без него админка
  // отдаёт форму входа, и слепок вышел бы пустым.
  const auth = buildAuth(target);
  if (target.auth && !auth) {
    throw new Error(
      `Для «${targetId}» нужен вход. Задайте ${target.auth.env} в .env — ` +
        'значение берётся из localStorage браузера, где вы уже авторизованы.',
    );
  }

  // Брейкпоинты берём из таргета: у админки они свои (1440/900/390), и
  // сайтовая сетка снимала бы 1024, которого в её макете нет вовсе.
  const viewports = target.viewports?.list;
  console.log(`Снимаю ${url} на ${(viewports ?? [{ width: 1440 }, { width: 1024 }, { width: 390 }]).map((v) => v.width).join(' / ')}…`);
  const snap = await collectLayout(url, {
    ...(auth ? { auth } : {}),
    ...(target.sectionSelector ? { selector: target.sectionSelector } : {}),
    ...(viewports ? { viewports } : {}),
  });

  const outFile = layoutFile(targetId);
  await writeFile(outFile, JSON.stringify(snap, null, 2) + '\n', 'utf8');

  for (const view of snap.viewports) {
    const truncated = countTruncated(view.sections);
    const extra = truncated ? `, срезано детей: ${truncated}` : '';
    console.log(`  ${view.viewport.padEnd(8)} ${view.width}px — секций ${view.sections.length}, высота ${view.documentHeight}${extra}`);
  }
  console.log(`\nСлепок записан: ${outFile}`);
}

/** Снимает тексты продакшена и кладёт слепок в state/text/. */
async function text(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  const url = args.url ?? target.reference.url;
  await mkdir(TEXT_DIR, { recursive: true });

  const auth = buildAuth(target);
  if (target.auth && !auth) throw new Error(`Для «${targetId}» нужен вход: задайте ${target.auth.env} в .env`);

  const snap = await collectText(url, {
    ...(auth ? { auth } : {}),
    ...(target.sectionSelector ? { selector: target.sectionSelector } : {}),
    ...(target.viewports?.list ? { viewports: target.viewports.list } : {}),
    skipSections: target.text?.skipSections ?? [],
    ignore: target.text?.ignore ?? [],
  });

  const outFile = path.join(TEXT_DIR, `${targetId}.json`);
  await writeFile(outFile, JSON.stringify(snap, null, 1) + '\n', 'utf8');

  for (const view of snap.viewports) {
    const lines = view.sections.reduce((sum, s) => sum + s.lines.length, 0);
    console.log(`  ${view.viewport.padEnd(8)} ${view.width}px — секций ${view.sections.length}, строк ${lines}`);
  }
  console.log(`\nСлепок текстов записан: ${outFile}`);
}

/**
 * Сверяет тексты макета с текстами прода.
 *
 * `--emit <брейкпоинт>` печатает скрипт для Figma: его результат кладётся в
 * state/figma-text/<target>.json под ключ брейкпоинта — так же, как у геометрии.
 */
async function vstext(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target?.layout) throw new Error(`У таргета «${targetId}» нет секции layout в конфиге.`);

  if (args.emit) {
    const view = target.layout.pages[args.emit];
    if (!view) throw new Error(`Нет брейкпоинта «${args.emit}». Есть: ${Object.keys(target.layout.pages).join(', ')}.`);
    console.log(emitFigmaTextScript({
      pageName: view.page,
      frameName: view.frame,
      ignore: target.layout.ignoreInFigma,
      offset: Number(args.offset ?? 0),
      limit: Number(args.limit ?? 0),
    }));
    return;
  }

  // Выдача скрипта приходит порциями (ответ плагина ограничен 20 КБ), поэтому
  // состояние собирается дозаписью: порция за порцией, брейкпоинт за
  // брейкпоинтом. Порции одного брейкпоинта склеиваются по именам секций.
  if (args.import) {
    if (!args.viewport) throw new Error('Укажите брейкпоинт: --viewport desktop|tablet|mobile');
    const chunk = expandFigmaText(JSON.parse(await readFile(args.import, 'utf8')));
    await mkdir(FIGMA_TEXT_DIR, { recursive: true });

    const outFile = path.join(FIGMA_TEXT_DIR, `${targetId}.json`);
    const saved = existsSync(outFile)
      ? JSON.parse(await readFile(outFile, 'utf8'))
      : { fileKey: target.figmaFileKey, viewports: {} };

    const view = saved.viewports[args.viewport] ?? { page: chunk.page, frame: chunk.frame, sections: [] };
    const byName = new Map(view.sections.map((s) => [s.name, s]));
    for (const section of chunk.sections) byName.set(section.name, section);
    view.page = chunk.page;
    view.frame = chunk.frame;
    view.sections = [...byName.values()];
    saved.viewports[args.viewport] = view;
    saved.takenAt = new Date().toISOString().slice(0, 10);

    await writeFile(outFile, JSON.stringify(saved, null, 1) + '\n', 'utf8');
    const lines = view.sections.reduce((sum, sec) => sum + sec.lines.length, 0);
    console.log(`${args.viewport}: секций ${view.sections.length}, строк ${lines} → ${outFile}`);
    return;
  }

  const prodFile = path.join(TEXT_DIR, `${targetId}.json`);
  const figmaFile = path.join(FIGMA_TEXT_DIR, `${targetId}.json`);
  if (!existsSync(prodFile)) throw new Error(`Нет слепка текстов прода: ${prodFile} (node src/cli.js text --target ${targetId})`);
  if (!existsSync(figmaFile)) throw new Error(`Нет текстов макета: ${figmaFile} (node src/cli.js vstext --target ${targetId} --emit desktop)`);

  const prod = JSON.parse(await readFile(prodFile, 'utf8'));
  const figma = JSON.parse(await readFile(figmaFile, 'utf8'));

  for (const view of prod.viewports) {
    const inFigma = figma.viewports?.[view.viewport];
    if (!inFigma) {
      console.log(`\n${view.viewport} — тексты макета не сняты`);
      continue;
    }

    const result = compareTextsToFigma(view, inFigma, target.layout.sectionMap, {
      ignore: target.text?.ignore ?? [],
      checkOrder: Boolean(args.order),
    });
    console.log(`\n${view.viewport} ${view.width}px — сверено секций ${result.checked}, расхождений ${result.findings.length}`);

    for (const f of result.findings) {
      if (f.kind === 'текст') console.log(`  ${f.figma}: «${f.inFigma}» → «${f.onProd}»`);
      else if (f.kind === 'нет в макете') console.log(`  ${f.figma}: НЕТ в макете — «${f.onProd}» (${f.where})`);
      else if (f.kind === 'только в макете') console.log(`  ${f.figma}: лишнее в макете — «${f.inFigma}»`);
      else if (f.kind === 'порядок текста') console.log(`  ${f.figma}: порядок — «${f.onProd}» на проде идёт после «${f.after}»`);
      else if (f.kind === 'ещё расхождения') console.log(`  ${f.figma}: ещё ${f.count} расхождений (совпало строк: ${f.matched})`);
    }
  }
}

/** Собирает данные входа из .env по описанию в конфиге таргета. */
function buildAuth(target) {
  if (!target.auth) return null;
  const value = process.env[target.auth.env];
  if (!value) return null;

  const entries = { [target.auth.key]: value };
  // Второй ключ помнит выбранный сайт сети: без него слепок может сняться не с того.
  for (const [key, env] of Object.entries(target.auth.optional ?? {})) {
    if (process.env[env]) entries[key] = process.env[env];
  }
  return { localStorage: entries };
}

/** Срезанные дети должны быть видны: молчаливое усечение читается как полнота. */
function countTruncated(nodes) {
  let total = 0;
  const walk = (list) => {
    for (const node of list) {
      if (node.truncatedChildren) total += node.truncatedChildren;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return total;
}

/**
 * Снимает свежую геометрию и показывает, что изменилось с прошлого слепка.
 * Именно эта команда отвечает на «я подвинул элемент на проде».
 */
async function changes(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  // Здесь фолбэк на чужую платформу запрещён: сравнивать слепок мака со
  // свежим виндовым — значит выдать разницу метрик шрифтов за правку прода.
  const file = layoutFile(targetId);
  if (!existsSync(file)) throw new Error(`Нет прошлого слепка этой машины. Сначала: node src/cli.js layout --target ${targetId}`);

  const before = JSON.parse(await readFile(file, 'utf8'));
  const url = args.url ?? target.reference.url;
  console.log(`Снимаю ${url} и сравниваю с прошлым слепком…\n`);

  const after = await collectLayout(url);
  const result = diffLayouts(before, after);

  for (const view of result.viewports) {
    const h = view.documentHeight;
    const heightNote = h && h.delta !== 0 ? `, высота ${h.was} → ${h.now} (${h.delta > 0 ? '+' : ''}${h.delta})` : '';
    console.log(`${view.viewport} ${view.width}px — изменений: ${view.findings.length}${heightNote}`);

    for (const f of view.findings.slice(0, 12)) {
      if (f.kind === 'стили') {
        const list = f.changes.map((c) => `${c.property} ${c.was} → ${c.now}`).join('; ');
        console.log(`  стили  ${f.path}: ${list}`);
      } else if (f.kind === 'появился' || f.kind === 'исчез') {
        console.log(`  ${f.kind.padEnd(6)} ${f.path}`);
      } else {
        console.log(`  ${f.kind.padEnd(6)} ${f.path}: ${f.was} → ${f.now} [${f.delta ?? ''}]`);
      }
    }
    if (view.findings.length > 12) console.log(`  … и ещё ${view.findings.length - 12}`);
  }

  if (args.save) {
    await writeFile(file, JSON.stringify(after, null, 2) + '\n', 'utf8');
    console.log(`\nСлепок обновлён: ${file}`);
  } else {
    console.log('\nСлепок НЕ перезаписан. Чтобы принять новое состояние за базу: добавьте --save');
  }
}

/**
 * Сравнивает геометрию макета с геометрией прода.
 * `--emit <viewport>` печатает скрипт для снятия геометрии из Figma.
 */
async function vsfigma(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target?.layout) throw new Error(`У таргета «${targetId}» нет секции layout в конфиге.`);

  if (args.emit) {
    const view = target.layout.pages[args.emit];
    if (!view) throw new Error(`Нет брейкпоинта «${args.emit}». Есть: desktop, tablet, mobile.`);
    console.log(emitFigmaLayoutScript({ pageName: view.page, frameName: view.frame, ignore: target.layout.ignoreInFigma, part: Number(args.part ?? 1), parts: Number(args.parts ?? 1) }));
    return;
  }

  const { file: prodFile, foreign } = findLayoutFile(targetId);
  const figmaFile = path.join(ROOT, 'state', 'figma-layout', `${targetId}.json`);
  if (!prodFile) throw new Error(`Нет слепка прода: ${layoutFile(targetId)}`);
  if (!existsSync(figmaFile)) throw new Error(`Нет геометрии макета: ${figmaFile}`);
  if (foreign) console.log(`ВНИМАНИЕ: слепок снят на ${foreign} — расхождения до пары пикселей могут быть метриками шрифтов, а не продом.`);
  for (const line of platformWarnings(target, foreign)) console.log(line);

  const prod = JSON.parse(await readFile(prodFile, 'utf8'));
  const figma = JSON.parse(await readFile(figmaFile, 'utf8'));

  for (const view of prod.viewports) {
    const inFigma = figma.viewports[view.viewport];
    if (!inFigma) {
      console.log(`\n${view.viewport} — геометрии макета нет`);
      continue;
    }

    const result = compareLayoutToFigma(view, inFigma, target.layout.sectionMap);
    const h = result.totalHeight;
    const roundedHere = result.findings.filter((f) => f.kind === 'округление').length;
    console.log(`\n${view.viewport} ${view.width}px — сверено секций ${result.checked}, расхождений ${result.findings.length}` +
      (roundedHere ? ` (из них ${roundedHere} — округление Figma, правки не требуют)` : ''));
    console.log(`  высота: прод ${h.onProd}, макет ${h.inFigma} (${h.delta > 0 ? '+' : ''}${h.delta})`);

    for (const f of result.findings) {
      if (f.kind === 'размер') {
        console.log(`  ${f.figma.padEnd(14)} прод ${f.onProd.padEnd(12)} макет ${f.inFigma.padEnd(12)} [${f.delta}]${f.bordered ? ' bordered' : ''}${f.kind === 'округление' ? ' ← округление, не дефект' : ''}`);
      } else if (f.kind === 'смещение') {
        console.log(`  ${f.figma.padEnd(14)} отступ от «${f.after}»: прод ${f.onProd}, макет ${f.inFigma} [${f.delta > 0 ? '+' : ''}${f.delta}]`);
      } else if (f.kind === 'порядок') {
        console.log(`  порядок: на позиции ${f.position} прод ждёт ${f.onProd}, в макете ${f.inFigma}`);
      } else {
        console.log(`  ${f.kind}: ${f.figma ?? f.prod ?? ''} ${f.prodSize ?? f.size ?? ''} ${f.hint ?? ''}`);
      }
    }
  }
}

/** Печатает тот же план в виде готового тела GitHub Issue. */
async function issue(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const { plan, gaps, checkedAt, target } = await collectPlan(config, targetId);

  if (args.title) {
    console.log(buildIssueTitle(plan, checkedAt));
    return;
  }
  console.log(
    buildIssueBody(plan, {
      checkedAt,
      sourceLabel: target.tokenSource,
      figmaFileKey: target.figmaFileKey,
      figmaFileTitle: target.figmaFileTitle,
      gaps,
    }),
  );
}

/** Обходит вкладки админки и снимает геометрию каждой на всех брейкпоинтах. */
async function tabs(config, args) {
  const targetId = args.target ?? 'dashboard';
  const target = config.targets.find((t) => t.id === targetId);
  if (!target?.tabs) throw new Error(`У таргета «${targetId}» нет списка вкладок в конфиге.`);

  const auth = buildAuth(target);
  if (target.auth && !auth) throw new Error(`Нужен вход: задайте ${target.auth.env} в .env`);

  const url = args.url ?? target.reference.url;
  const list = target.tabs.list;
  const viewports = target.viewports.list;
  console.log(`Обхожу ${list.length} вкладок × ${viewports.length} брейкпоинта на ${url}\n`);

  const snap = await collectAdminTabs(url, list, extractInPage, {
    auth,
    selector: target.sectionSelector,
    viewports,
    // Глубина у админки своя: содержимое вкладки начинается на четвёртом
    // уровне (app-body → main → вкладка → блок), и при MAX_DEPTH=3 слепок
    // обрывался ровно перед тем, что и надо сверять.
    extractArgs: {
      maxDepth: target.layout?.maxDepth ?? MAX_DEPTH,
      maxChildren: MAX_CHILDREN,
      tracked: TRACKED_STYLES,
    },
    scenarios: target.scenarios?.list ?? [],
    onProgress: (viewport, tab, note) => console.log(`  ${viewport.padEnd(8)} ${tab.padEnd(30)} ${note}`),
  });

  await mkdir(LAYOUT_DIR, { recursive: true });
  const outFile = layoutFile(`${targetId}-tabs`);
  await writeFile(outFile, JSON.stringify(snap, null, 2) + '\n', 'utf8');

  const failed = snap.viewports.flatMap((v) => v.screens.filter((s) => s.status !== 'ok').map((s) => `${v.viewport}/${s.tab}: ${s.status}`));
  if (failed.length) {
    console.log(`\nНе снято ${failed.length}:`);
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log(`\nСлепок записан: ${outFile}`);
}

/** Обходит отдельные страницы сайта: курсы, статьи, юридические, сервисные. */
async function pages(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target?.pages) throw new Error(`У таргета «${targetId}» нет списка страниц.`);

  const origin = new URL(target.reference.url).origin;
  await mkdir(LAYOUT_DIR, { recursive: true });

  const captured = [];
  for (const item of target.pages.list) {
    const url = origin + item.path;
    try {
      const snap = await collectLayout(url, target.pages.selector ? { selector: target.pages.selector } : {});
      const heights = snap.viewports.map((v) => `${v.viewport} ${v.sections.length} секц.`).join(', ');
      console.log(`  ${item.id.padEnd(16)} ${heights}`);
      captured.push({ ...item, url, status: 'ok', viewports: snap.viewports });
    } catch (error) {
      // Страница может не существовать или требовать данных — это факт для
      // отчёта, а не повод ронять весь обход.
      console.log(`  ${item.id.padEnd(16)} НЕ СНЯТО: ${error.message.split('\n')[0].slice(0, 60)}`);
      captured.push({ ...item, url, status: error.message.split('\n')[0].slice(0, 120) });
    }
  }

  const outFile = layoutFile(`${targetId}-pages`);
  await writeFile(outFile, JSON.stringify({ origin, pages: captured }, null, 2) + '\n', 'utf8');
  const failed = captured.filter((p) => p.status !== 'ok').length;
  console.log(`\nСнято ${captured.length - failed} из ${captured.length}. Записано: ${outFile}`);
}

/**
 * По коммиту говорит, какие экраны макета он затронул.
 *   commit --sha <ref>   один коммит (по умолчанию HEAD)
 *   commit --since <ref> всё от указанного коммита до HEAD
 */
async function commit(config, args) {
  const repo = resolveRepoPath(config, args);
  const range = args.since ? `${args.since}..HEAD` : `${args.sha ?? 'HEAD'}~1..${args.sha ?? 'HEAD'}`;

  const { stdout: diff } = await run('git', ['diff', '--unified=0', range], { cwd: repo, maxBuffer: 20e6 });
  const { stdout: subject } = await run('git', ['log', '-1', '--format=%h %s', args.sha ?? 'HEAD'], { cwd: repo });

  const { files, selectors } = selectorsFromDiff(diff);
  const kinds = classifyChange(diff);

  // Индекс собирается из всех уже снятых слепков: чем больше экранов снято,
  // тем точнее адресация. Ненайденное — подсказка, что экран ещё не покрыт.
  // Индексу всё равно, на какой машине снят экран: он сопоставляет селекторы,
  // а не пиксели, поэтому чужой слепок здесь берётся без оговорок.
  const screens = [];
  for (const name of ['dashboard-tabs', 'education-pages', 'school-pages']) {
    const { file: full } = findLayoutFile(name);
    if (!full) continue;
    const data = JSON.parse(await readFile(full, 'utf8'));
    if (data.viewports) {
      for (const v of data.viewports) for (const s of v.screens ?? []) if (s.status === 'ok') screens.push(s);
    }
    if (data.pages) {
      for (const p of data.pages) {
        if (p.status !== 'ok') continue;
        for (const v of p.viewports ?? []) screens.push({ figmaName: `${p.figmaPage} · ${p.id}`, sections: v.sections });
      }
    }
  }
  for (const id of ['education', 'school']) {
    const { file: full } = findLayoutFile(id);
    if (!full) continue;
    const data = JSON.parse(await readFile(full, 'utf8'));
    for (const v of data.viewports ?? []) screens.push({ figmaName: `${id} · головна ${v.viewport}`, sections: v.sections });
  }

  const index = buildScreenIndex(screens);
  const { matched, unmatched } = mapSelectorsToScreens(selectors, index);

  console.log(`Коммит: ${subject.trim()}`);
  console.log(`Файлов затронуто: ${files.length}${kinds.length ? ` · характер: ${kinds.join(', ')}` : ''}`);
  console.log(`Селекторов в diff: ${selectors.length} · экранов в индексе: ${screens.length}\n`);

  if (!matched.length) console.log('Ни один снятый экран не сопоставился.');
  for (const item of matched.slice(0, 12)) {
    console.log(`  ${String(item.weight).padStart(3)}  ${item.screen}`);
    console.log(`       ${item.selectors.slice(0, 6).join(' ')}`);
  }

  if (unmatched.length) {
    console.log(`\nНе найдено ни на одном снятом экране (${unmatched.length}) — либо новые элементы, либо экран ещё не покрыт:`);
    for (const item of unmatched.slice(0, 10)) console.log(`  ${item.selector} (${item.hits})`);
  }
}

/**
 * Главная команда новой схемы: по коммиту говорит, какие кадры макета
 * доработать, а какие создать. Полная сверка всех кадров не нужна.
 */
async function frames(config, args) {
  const repo = resolveRepoPath(config, args);
  const targetId = args.target ?? 'education';
  const target = config.targets.find((t) => t.id === targetId);

  const range = args.since ? `${args.since}..HEAD` : `${args.sha ?? 'HEAD'}~1..${args.sha ?? 'HEAD'}`;
  const { stdout: diff } = await run('git', ['diff', '--unified=0', range], { cwd: repo, maxBuffer: 20e6 });
  const { stdout: subject } = await run('git', ['log', '-1', '--format=%h %s', args.sha ?? 'HEAD'], { cwd: repo });

  const catalogFile = path.join(ROOT, 'state', 'figma-frames', `${targetId}.json`);
  if (!existsSync(catalogFile)) throw new Error(`Нет каталога кадров: ${catalogFile}`);
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const groups = groupFrames(catalog.frames);

  const { files, selectors } = selectorsFromDiff(diff);
  const texts = textsFromDiff(diff);
  const kinds = classifyChange(diff);

  // Файлы этого таргета: коммит часто задевает всю сеть сайтов сразу,
  // и без фильтра сигнал размывается чужими путями.
  const own = files.filter((f) => f.startsWith(`sites/${target.reference.site}/`));
  const scope = own.length ? own : files;

  const matched = matchCommitToFrames({
    files: scope, selectors, texts, groups,
    pathMap: target.framePathMap ?? {},
    selectorMap: target.frameSelectorMap ?? {},
  });
  const { stdout: addedRaw } = await run('git', ['diff', '--diff-filter=A', '--name-only', range], { cwd: repo, maxBuffer: 20e6 });
  const addedFiles = addedRaw.split('\n').filter(Boolean).filter((f) => (own.length ? f.startsWith(`sites/${target.reference.site}/`) : true));
  const missing = findMissingFrames({
    addedFiles,
    changedFiles: scope,
    newContainers: newContainersFromDiff(diff),
    groups,
    pathMap: target.framePathMap ?? {},
  });

  console.log(`Коммит: ${subject.trim()}`);
  console.log(`Таргет: ${target.title} · файлов его: ${own.length} из ${files.length}`);
  if (kinds.length) console.log(`Характер правки: ${kinds.join(', ')}`);
  console.log('');

  if (args.plan || args.issue) {
    const plan = buildEditsPlan({
      target,
      frames: { commit: subject.trim().split(' ')[0], matched: matched.slice(0, 12), missing },
    });
    if (args.issue) {
      console.log(buildIssueBody(plan, { checkedAt: new Date().toISOString().slice(0, 10),
        sourceLabel: `коммит ${subject.trim()}`, figmaFileKey: target.figmaFileKey,
        figmaFileTitle: target.figmaFileTitle, gaps: [] }));
    } else {
      console.log(emitEditsPageScript(plan, { pageName: config.conventions.editsPage,
        checkedAt: new Date().toISOString().slice(0, 10),
        sourceLabel: `коммит ${subject.trim()}`, gaps: [] }));
    }
    return;
  }

  if (matched.length) {
    console.log('ДОРАБОТАТЬ существующие кадры:');
    for (const item of matched.slice(0, 8)) {
      console.log(`  ${item.page} → «${item.base}» (${item.frames.length} брейкпоинта, вес ${item.score})`);
      console.log(`      почему: ${item.reasons.slice(0, 3).join('; ')}`);
    }
  } else {
    console.log('Ни один существующий кадр не сопоставился.');
  }

  if (missing.length) {
    console.log('\nСОЗДАТЬ новые кадры:');
    for (const item of missing.slice(0, 8)) {
      console.log(`  [${item.kind}] «${item.suggestion}» — ${item.why}`);
      console.log(`      источник: ${item.source}`);
    }
  }
}

/**
 * Печатает скрипт, снимающий рабочую область кадров макета.
 *
 *   node src/cli.js emitframes --target dashboard
 *
 * Результат выполнения в Figma кладётся в state/figma-layout/<target>-frames.json —
 * оттуда его берёт `vstabs`.
 */
async function emitframes(config, args) {
  const targetId = args.target ?? 'dashboard';
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}»`);

  const pages = target.tabs?.figmaPages ?? ['5:8', '5:9'];
  const wanted = [
    ...(target.tabs?.list ?? []).map((t) => t.figmaName),
    ...(target.scenarios?.list ?? []).map((s) => s.figmaName),
  ].filter(Boolean);

  console.log(emitFramesLayoutScript({ pages, frames: [...new Set(wanted)] }));
}

/**
 * Сверяет слепок вкладок с рабочей областью кадров: состав блоков, их высоты и
 * позиции, а также колонки таблиц.
 *
 *   node src/cli.js vstabs --target dashboard
 */
async function vstabs(config, args) {
  const targetId = args.target ?? 'dashboard';
  const target = config.targets.find((t) => t.id === targetId);
  const prodFile = layoutFile(`${targetId}-tabs`);
  const figmaFile = path.join(ROOT, 'state', 'figma-layout', `${targetId}-frames.json`);

  if (!existsSync(prodFile)) throw new Error(`Нет слепка прода: сначала node src/cli.js tabs --target ${targetId}`);
  if (!existsSync(figmaFile)) throw new Error(`Нет геометрии макета: выполните node src/cli.js emitframes --target ${targetId} и сохраните результат в ${figmaFile}`);

  const prod = JSON.parse(await readFile(prodFile, 'utf8'));
  const design = JSON.parse(await readFile(figmaFile, 'utf8'));

  // Снимок из Figma приходит в компактном виде (b = [имя, y, высота, id]):
  // полный формат раздувал ответ плагина за предел одного вызова.
  const normalize = (f) => (f.blocks ? f : {
    frame: f.f,
    frameId: f.id,
    blocks: (f.b ?? []).map(([name, y, h, id]) => ({ name, y, h, id })),
    gaps: f.g ?? [],
  });
  const byName = new Map((design.frames ?? []).map(normalize).map((f) => [f.frame ?? f.f, f]));

  let compared = 0;
  let issues = 0;
  const collected = [];
  for (const viewport of prod.viewports) {
    console.log(`\n${viewport.viewport} ${viewport.width}px`);
    for (const screen of viewport.screens) {
      if (screen.status !== 'ok') continue;
      const frame = byName.get(screen.figmaName);
      if (!frame) {
        console.log(`  ${screen.figmaName.padEnd(46)} кадра в макете нет`);
        continue;
      }
      compared++;
      // Часть экранов в макете намеренно собрана контейнерами (у дашборда
      // «dash-sections» держит четыре продовых блока) — состав там не сойдётся
      // никогда, и жаловаться на него значит приучать пропускать отчёт.
      const grouped = (target.layout?.groupedBlocks?.frames ?? []).some((n) => screen.figmaName.startsWith(n));
      const groupedBlocks = target.layout?.groupedBlocks?.blocks ?? [];
      const findings = [...compareScreenToFrame(screen, frame), ...compareTables(screen, frame.tables)]
        .filter((f) => !(grouped && (f.kind === 'состав' || groupedBlocks.some((b) => (f.block ?? '').includes(b)))));
      if (!findings.length) continue;
      issues += findings.length;
      collected.push({ viewport: viewport.viewport, frame: screen.figmaName, findings });
      console.log(`  ${screen.figmaName}`);
      for (const f of findings.slice(0, 6)) {
        if (f.kind === 'состав') console.log(`     состав: ${f.note}`);
        else if (f.kind === 'колонка') console.log(`     колонка «${f.column}»: прод ${f.inProd}, макет ${f.inDesign}`);
        else console.log(`     ${f.kind} «${f.block ?? f.table}»: прод ${f.inProd}, макет ${f.inDesign} (${f.delta > 0 ? '+' : ''}${f.delta ?? ''})`);
      }
    }
  }
  // Результат ложится в файл: план правок собирается отдельной командой и
  // должен видеть ту же картину, а не пересчитывать её заново.
  const outFile = path.join(ROOT, 'state', `tabs-diff-${targetId}.json`);
  await writeFile(outFile, JSON.stringify({
    checkedAt: new Date().toISOString().slice(0, 10),
    comparedScreens: compared,
    totalFindings: issues,
    screens: collected,
  }, null, 1) + '\n', 'utf8');

  console.log(`\nСверено экранов: ${compared}, расхождений: ${issues}`);
  console.log(`Результат: ${outFile}`);
}

const COMMANDS = { snapshot, emit, page, layout, text, changes, vsfigma, vstext, issue, tabs, pages, commit, frames, emitframes, vstabs };

const args = parseArgs(process.argv.slice(2));
const command = COMMANDS[args._[0]];

if (!command) {
  console.error(`Неизвестная команда. Доступно: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

await loadEnv(path.join(ROOT, '.env'));

command(await loadConfig(), args).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
