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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { collectTokens } from './snapshot/tokens.js';
import { makeClassifier, checkHexRgbPairs } from './snapshot/rules.js';
import { buildExpectations, emitFigmaScript } from './compare/emit-check.js';
import { buildEditsPlan } from './report/edits-plan.js';
import { emitEditsPageScript } from './report/figma-page.js';
import { collectLayout } from './snapshot/layout.js';
import { diffLayouts } from './compare/layout-diff.js';
import { emitFigmaLayoutScript, compareLayoutToFigma } from './compare/figma-layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** Печатает скрипт, создающий страницу правок в макете таргета. */
async function page(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  const checkFile = path.join(ROOT, 'state', 'figma-check.json');
  if (!existsSync(checkFile)) throw new Error('Нет state/figma-check.json — сверка ещё не выполнялась.');

  const check = JSON.parse(await readFile(checkFile, 'utf8'));
  const result = check.targets.find((t) => t.target === targetId);
  if (!result) throw new Error(`В сверке нет данных по «${targetId}».`);

  const plan = buildEditsPlan(result, target);
  if (args.stats) {
    console.log(`${target.title} → ${target.figmaFileTitle} (${target.figmaFileKey})`);
    console.log(`  правок: ${plan.total}`);
    for (const stage of plan.stages) {
      console.log(`  ${stage.title}:`);
      for (const step of stage.steps) console.log(`    ${step.n}. ${step.title}`);
    }
    return;
  }

  console.log(
    emitEditsPageScript(plan, {
      pageName: config.conventions.editsPage,
      checkedAt: check.checkedAt,
      sourceLabel: target.tokenSource,
    }),
  );
}

/** Снимает геометрию продакшена и кладёт слепок в state/layout/. */
async function layout(config, args) {
  const targetId = args.target ?? config.targets[0].id;
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`Нет таргета «${targetId}».`);

  const url = args.url ?? target.reference.url;
  const outDir = path.join(ROOT, 'state', 'layout');
  await mkdir(outDir, { recursive: true });

  console.log(`Снимаю ${url} на ${['1440', '1024', '390'].join(' / ')}…`);
  const snap = await collectLayout(url);

  const outFile = path.join(outDir, `${targetId}.json`);
  await writeFile(outFile, JSON.stringify(snap, null, 2) + '\n', 'utf8');

  for (const view of snap.viewports) {
    const truncated = countTruncated(view.sections);
    const extra = truncated ? `, срезано детей: ${truncated}` : '';
    console.log(`  ${view.viewport.padEnd(8)} ${view.width}px — секций ${view.sections.length}, высота ${view.documentHeight}${extra}`);
  }
  console.log(`\nСлепок записан: ${outFile}`);
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

  const file = path.join(ROOT, 'state', 'layout', `${targetId}.json`);
  if (!existsSync(file)) throw new Error(`Нет прошлого слепка. Сначала: node src/cli.js layout --target ${targetId}`);

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
    console.log(emitFigmaLayoutScript({ pageName: view.page, frameName: view.frame, ignore: target.layout.ignoreInFigma }));
    return;
  }

  const prodFile = path.join(ROOT, 'state', 'layout', `${targetId}.json`);
  const figmaFile = path.join(ROOT, 'state', 'figma-layout', `${targetId}.json`);
  if (!existsSync(prodFile)) throw new Error(`Нет слепка прода: ${prodFile}`);
  if (!existsSync(figmaFile)) throw new Error(`Нет геометрии макета: ${figmaFile}`);

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
    console.log(`\n${view.viewport} ${view.width}px — сверено секций ${result.checked}, расхождений ${result.findings.length}`);
    console.log(`  высота: прод ${h.onProd}, макет ${h.inFigma} (${h.delta > 0 ? '+' : ''}${h.delta})`);

    for (const f of result.findings) {
      if (f.kind === 'размер') {
        console.log(`  ${f.figma.padEnd(14)} прод ${f.onProd.padEnd(12)} макет ${f.inFigma.padEnd(12)} [${f.delta}]${f.bordered ? ' bordered' : ''}`);
      } else if (f.kind === 'порядок') {
        console.log(`  порядок: на позиции ${f.position} прод ждёт ${f.onProd}, в макете ${f.inFigma}`);
      } else {
        console.log(`  ${f.kind}: ${f.figma ?? f.prod ?? ''} ${f.prodSize ?? f.size ?? ''} ${f.hint ?? ''}`);
      }
    }
  }
}

const COMMANDS = { snapshot, emit, page, layout, changes, vsfigma };

const args = parseArgs(process.argv.slice(2));
const command = COMMANDS[args._[0]];

if (!command) {
  console.error(`Неизвестная команда. Доступно: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

command(await loadConfig(), args).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
