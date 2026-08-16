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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadConfig() {
  const file = path.join(ROOT, 'config', 'design-map.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) args[item.slice(2)] = argv[++i];
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

const COMMANDS = { snapshot };

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
