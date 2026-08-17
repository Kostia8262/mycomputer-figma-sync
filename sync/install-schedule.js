#!/usr/bin/env node
/**
 * Ставит ежедневную синхронизацию в планировщик текущей ОС.
 *
 *   node sync/install-schedule.js            # поставить на 10:00
 *   node sync/install-schedule.js --at 21:30 # своё время
 *   node sync/install-schedule.js --full     # снимать и страницы с экранами админки
 *   node sync/install-schedule.js --off      # снять
 *
 * macOS — launchd, Windows — Task Scheduler. Оба варианта переживают выключенную
 * машину: launchd выполняет пропущенный запуск при пробуждении, Task Scheduler —
 * через StartWhenAvailable.
 */

import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'sync', 'daily-sync.js');
const LABEL = 'com.mycomputer.figma-sync.daily';
const TASK_NAME = 'MyComputer Figma Sync';

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function parseArgs(argv) {
  const args = { at: '10:00', off: false, full: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--off') args.off = true;
    else if (argv[i] === '--full') args.full = true;
    else if (argv[i] === '--at') args.at = argv[++i];
  }
  const [hour, minute] = args.at.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Не понял время «${args.at}», нужно в формате ЧЧ:ММ`);
  }
  return { ...args, hour, minute };
}

const plistPath = () =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function plistBody(nodeBin, hour, minute, full) {
  const extra = full ? '\n    <string>--full</string>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${SCRIPT}</string>${extra}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${path.join(ROOT, 'sync', 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, 'sync', 'launchd.err.log')}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

async function installMac({ hour, minute, off, full }) {
  const target = plistPath();

  if (off) {
    await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    if (existsSync(target)) await unlink(target);
    return 'Задача снята.';
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, plistBody(process.execPath, hour, minute, full), 'utf8');

  // bootout перед bootstrap — иначе повторная установка падает с "already loaded".
  await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  const load = await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, target]);
  if (load.code !== 0) throw new Error(`launchctl: ${load.stderr || load.stdout}`);

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `launchd: ${LABEL} каждый день в ${time}${full ? ', полный набор слепков' : ''}`;
}

/**
 * Выполняет PowerShell-скрипт из временного файла. Через -Command не выйдет:
 * пути к репозиторию содержат кириллицу, а она гибнет в кодовой странице консоли.
 * BOM обязателен — без него Windows PowerShell 5.1 читает файл как ANSI.
 */
async function runPowerShell(script) {
  const file = path.join(os.tmpdir(), `${LABEL}.${process.pid}.ps1`);
  await writeFile(file, `﻿${script}`, 'utf8');
  try {
    return await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]);
  } finally {
    if (existsSync(file)) await unlink(file);
  }
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function installWindows({ hour, minute, off, full }) {
  if (off) {
    const result = await runPowerShell(
      `$ErrorActionPreference = 'Stop'\n` +
      `Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false\n`,
    );
    return result.code === 0 ? 'Задача снята.' : `Не удалось снять: ${result.stderr || result.stdout}`;
  }

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // schtasks /Create тут не годится: он не умеет StartWhenAvailable, а без него
  // пропущенный запуск (ноутбук был выключен или спал) просто теряется.
  //
  // Задача остаётся в контексте залогиненного пользователя намеренно: из сеанса
  // SYSTEM Credential Manager не отдаёт токен GitHub, и git push повисает на запросе.
  //
  // -At принимает объект даты, а не строку: разбор «10:00» зависит от локали системы.
  const result = await runPowerShell(
    `$ErrorActionPreference = 'Stop'\n` +
    `$action = New-ScheduledTaskAction -Execute ${psQuote(process.execPath)} ` +
      `-Argument ${psQuote(`"${SCRIPT}"${full ? ' --full' : ''}`)} -WorkingDirectory ${psQuote(ROOT)}\n` +
    `$trigger = New-ScheduledTaskTrigger -Daily ` +
      `-At ([datetime]::Today.AddHours(${hour}).AddMinutes(${minute}))\n` +
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries ` +
      `-DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew ` +
      `-ExecutionTimeLimit (New-TimeSpan -Hours 1)\n` +
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action ` +
      `-Trigger $trigger -Settings $settings -Force | Out-Null\n`,
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);

  return `Task Scheduler: «${TASK_NAME}» каждый день в ${time}, с догоняющим запуском${full ? ', полный набор слепков' : ''}`;
}

const args = parseArgs(process.argv.slice(2));
const install = process.platform === 'win32' ? installWindows : installMac;

console.log(await install(args));
