#!/usr/bin/env node
/**
 * Ежедневная сверка обеих машин — MacBook и Windows-ноутбука.
 *
 * Раскладка намеренно несимметричная:
 *   claude-memory        — двусторонне, своим же sync-скриптом (он умеет чинить ссылки)
 *   mycomputer-figma-sync — двусторонне, но автокоммит только для state/
 *   my_computer_new      — ТОЛЬКО чтение: это продакшен, автопуш туда недопустим
 *
 * Порядок шагов важен: прод подтягивается ДО снятия слепков (иначе слепок
 * токенов снимется со вчерашнего кода), а коммит и отправка — ПОСЛЕ, иначе
 * свежие слепки пролежали бы на машине до следующего дня.
 *
 *   node sync/daily-sync.js                 токены + геометрия трёх главных
 *   node sync/daily-sync.js --full          плюс страницы сайтов и экраны админки
 *   node sync/daily-sync.js --no-snapshots  только синхронизация репозиториев
 *
 * Работает без зависимостей на обеих ОС: git вызывается напрямую, без shell.
 */

import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'sync', 'daily-sync.log');
const CLI = path.join(ROOT, 'src', 'cli.js');
const IS_WINDOWS = process.platform === 'win32';

const lines = [];

/**
 * Что снимать каждый день. Токены дёшевы и не требуют браузера; геометрия
 * трёх главных — около минуты на каждую. Страницы сайтов и 60 экранов админки
 * добавляются флагом --full: в ежедневном фоне они съедали бы минут пятнадцать.
 */
const DAILY_SNAPSHOTS = [
  { title: 'токены', args: ['snapshot'] },
  { title: 'геометрия education', args: ['layout', '--target', 'education'] },
  { title: 'геометрия school', args: ['layout', '--target', 'school'] },
  { title: 'геометрия админки', args: ['layout', '--target', 'dashboard'] },
];

const FULL_SNAPSHOTS = [
  { title: 'страницы education', args: ['pages', '--target', 'education'] },
  { title: 'страницы school', args: ['pages', '--target', 'school'] },
  { title: 'экраны админки', args: ['tabs', '--target', 'dashboard'] },
];

function note(message) {
  const stamped = `${new Date().toISOString()}  ${message}`;
  lines.push(stamped);
  console.log(stamped);
}

/** Запускает команду без shell, чтобы пути с пробелами и кириллицей не ломались. */
function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

const git = (args, cwd) => run('git', args, cwd);

/** Загружает .env вручную — тянуть dotenv ради трёх строк не стоит. */
async function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;

  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (value && !process.env[key]) process.env[key] = value;
  }
}

async function isClean(repo) {
  const { stdout } = await git(['status', '--porcelain'], repo);
  return stdout === '';
}

/**
 * Память: у неё есть собственный sync-скрипт, который помимо git сверяет
 * симлинки на папки memory. Дублировать его логику здесь нельзя — расползётся.
 */
async function syncMemory() {
  const repo =
    process.env.MC_MEMORY_PATH || path.join(os.homedir(), 'claude-memory');

  if (!existsSync(repo)) {
    note(`память: пропуск, не найдено ${repo}`);
    return;
  }

  const result = IS_WINDOWS
    ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'sync.ps1')], repo)
    : await run('bash', [path.join(repo, 'sync.sh')], repo);

  note(result.code === 0 ? 'память: синхронизирована' : `память: ОШИБКА — ${result.stderr || result.stdout}`);
}

/** Тянем чужие правки. Отдаём отдельным шагом — после того, как снимем слепки. */
async function pullSelf() {
  if (!existsSync(path.join(ROOT, '.git'))) {
    note('агент: пропуск, репозиторий ещё не инициализирован');
    return false;
  }

  const pull = await git(['pull', '--rebase', '--autostash'], ROOT);
  if (pull.code !== 0) {
    note(`агент: ОШИБКА pull — ${pull.stderr}`);
    return false;
  }

  // Успешный шаг обязан оставить строку: лог, где видны только ошибки, не
  // отличить от лога, где половина шагов молча не выполнялась.
  note('агент: подтянут');
  return true;
}

/** Состояние агента: свои слепки коммитим и отдаём. */
async function pushSelf() {
  if (!existsSync(path.join(ROOT, '.git'))) return;

  // Автокоммитим только слепки. Недописанный код чужой машине не нужен,
  // а внезапный коммит посреди работы — худшее, что может сделать демон.
  const { stdout: dirty } = await git(['status', '--porcelain', '--', 'state'], ROOT);
  if (dirty) {
    await git(['add', 'state'], ROOT);
    await git(['commit', '-m', 'chore(state): ежедневный слепок'], ROOT);
    note('агент: слепки закоммичены');
  }

  const { stdout: ahead } = await git(['rev-list', '--count', '@{u}..HEAD'], ROOT);
  if (Number(ahead) === 0) {
    note('агент: локальных изменений нет');
    return;
  }

  // Между pullSelf в начале прогона и этой строкой проходят минуты съёмки, и
  // за это время ветку успевает подвинуть вторая машина или прогон
  // after-deploy в CI — с тех пор как прод будит агента после каждой выкатки,
  // это стало обычным делом. Одна попытка push означала бы «ОШИБКА push» в
  // логе и слепок, лежащий до завтра.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const push = await git(['push'], ROOT);
    if (push.code === 0) {
      note(`агент: отправлено коммитов — ${ahead}`);
      return;
    }

    note(`агент: push отклонён, свожу с веткой и повторяю (попытка ${attempt})`);
    // -X theirs: при rebase «theirs» — это свои коммиты, HEAD в тот момент
    // чужой. Состояние — снимок, а не история правок, поэтому при расхождении
    // верен самый свежий; чужие файлы, которых мы не трогали, остаются.
    const merge = await git(['pull', '--rebase', '--autostash', '-X', 'theirs'], ROOT);
    if (merge.code !== 0) {
      await git(['rebase', '--abort'], ROOT);
      note(`агент: ОШИБКА сведения — ${merge.stderr}`);
      return;
    }
  }

  note('агент: ОШИБКА push — три попытки подряд отклонены');
}

/** Продакшен: только подтянуть. Ничего не коммитим и не отправляем. */
async function syncProduction() {
  const repo = process.env.MC_REPO_PATH || path.join(os.homedir(), 'Projects', 'my-computer-new');
  if (!existsSync(repo)) {
    note(`прод: пропуск, не найдено ${repo}`);
    return;
  }

  const fetch = await git(['fetch', '--prune', 'origin'], repo);
  if (fetch.code !== 0) {
    note(`прод: ОШИБКА fetch — ${fetch.stderr}`);
    return;
  }

  if (!(await isClean(repo))) {
    note('прод: есть несохранённые правки — оставлено как есть, только fetch');
    return;
  }

  // --ff-only: если история разошлась, лучше остановиться и сказать,
  // чем молча создать merge-коммит в чужом репозитории.
  const pull = await git(['pull', '--ff-only'], repo);
  note(pull.code === 0 ? 'прод: обновлён' : `прод: не удалось перемотать — ${pull.stderr}`);
}

/**
 * Снимает слепки прода. Шаги независимы: упавший не роняет остальные — три
 * снятых слепка из четырёх полезнее, чем ни одного.
 */
async function takeSnapshots({ full }) {
  const steps = full ? [...DAILY_SNAPSHOTS, ...FULL_SNAPSHOTS] : DAILY_SNAPSHOTS;

  for (const step of steps) {
    const result = await run(process.execPath, [CLI, ...step.args], ROOT);
    if (result.code === 0) {
      note(`слепок «${step.title}»: снят`);
      continue;
    }

    // Причина обязана попасть в лог целиком: «не снялось» без объяснения
    // читается как случайность, хотя чаще это отсутствующий браузер или ключ.
    const reason = (result.stderr || result.stdout).split('\n')[0];
    note(`слепок «${step.title}»: ОШИБКА — ${reason}`);

    if (/Executable doesn't exist|playwright install/i.test(result.stderr)) {
      note('  браузер не установлен: npx playwright install chromium');
    }
  }
}

const args = process.argv.slice(2);
const full = args.includes('--full');
const withSnapshots = !args.includes('--no-snapshots');

await loadEnv();
note(`--- старт, ${os.hostname()} (${process.platform})${full ? ', полный набор' : ''} ---`);

await syncMemory();
const pulled = await pullSelf();
await syncProduction();

// Снимать имеет смысл только после успешного pull: иначе слепок ляжет поверх
// чужого, ещё не подтянутого, и rebase на следующем прогоне встанет на конфликте.
if (withSnapshots && pulled) await takeSnapshots({ full });
else if (withSnapshots) note('слепки: пропуск, репозиторий агента не синхронизирован');

await pushSelf();

note('--- готово ---');

// BOM обязателен: без него PowerShell 5.1 и Блокнот читают файл как ANSI, и
// весь русский текст в логе превращается в кракозябры. Ставим один раз, при
// создании файла — в середину дописать его уже нельзя.
const bom = existsSync(LOG) ? '' : '﻿';
await appendFile(LOG, bom + lines.join('\n') + '\n', 'utf8');
