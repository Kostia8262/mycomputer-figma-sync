#!/usr/bin/env node
/**
 * Ежедневная сверка обеих машин — MacBook и Windows-ноутбука.
 *
 * Раскладка намеренно несимметричная:
 *   claude-memory        — двусторонне, своим же sync-скриптом (он умеет чинить ссылки)
 *   mycomputer-figma-sync — двусторонне, но автокоммит только для state/
 *   my_computer_new      — ТОЛЬКО чтение: это продакшен, автопуш туда недопустим
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
const IS_WINDOWS = process.platform === 'win32';

const lines = [];

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

/** Состояние агента: тянем чужие правки, свои слепки коммитим и отдаём. */
async function syncSelf() {
  if (!existsSync(path.join(ROOT, '.git'))) {
    note('агент: пропуск, репозиторий ещё не инициализирован');
    return;
  }

  const pull = await git(['pull', '--rebase', '--autostash'], ROOT);
  if (pull.code !== 0) {
    note(`агент: ОШИБКА pull — ${pull.stderr}`);
    return;
  }

  // Автокоммитим только слепки. Недописанный код чужой машине не нужен,
  // а внезапный коммит посреди работы — худшее, что может сделать демон.
  const { stdout: dirty } = await git(['status', '--porcelain', '--', 'state'], ROOT);
  if (dirty) {
    await git(['add', 'state'], ROOT);
    await git(['commit', '-m', 'chore(state): ежедневный слепок'], ROOT);
    note('агент: слепки закоммичены');
  }

  const { stdout: ahead } = await git(['rev-list', '--count', '@{u}..HEAD'], ROOT);
  if (Number(ahead) > 0) {
    const push = await git(['push'], ROOT);
    note(push.code === 0 ? `агент: отправлено коммитов — ${ahead}` : `агент: ОШИБКА push — ${push.stderr}`);
  } else {
    note('агент: локальных изменений нет');
  }
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

await loadEnv();
note(`--- старт, ${os.hostname()} (${process.platform}) ---`);

await syncMemory();
await syncSelf();
await syncProduction();

note('--- готово ---');
await appendFile(LOG, lines.join('\n') + '\n', 'utf8');
