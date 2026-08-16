/**
 * Загрузка `.env`.
 *
 * Живёт отдельным модулем, потому что нужна и демону синхронизации, и CLI.
 * Пока она была только в демоне, CLI не видел `MC_ADMIN_TOKEN` и сообщал
 * «нужен вход» при заполненном файле — путаница на ровном месте.
 *
 * Тянуть dotenv ради разбора «ключ=значение» не стоит.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function loadEnv(file) {
  if (!existsSync(file)) return;

  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    // Кавычки вокруг значения — частая привычка; токен с ними не совпадёт
    // ни с чем, и ошибка будет выглядеть как «неверный ключ».
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

    // Уже заданное окружение важнее файла: так можно переопределить на один запуск.
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
