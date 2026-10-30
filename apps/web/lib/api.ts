import { readStoredLocale, translate } from './i18n';

// Все запросы идут на наш же адрес и проксируются на сервер (см. next.config.mjs).
// Сессия хранится в httpOnly-cookie: скрипты страницы токен не видят.
const BASE = '/backend';

// Язык читаем из хранилища при каждом запросе: дочерние компоненты запрашивают данные раньше, чем провайдер языка успевает обновиться
const langHeader = () => ({ 'Accept-Language': readStoredLocale() });

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init, headers: { ...langHeader(), ...init.headers } });
  } catch {
    throw new ApiError(translate('err.network'), 0);
  }
}

async function fail(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}));
  const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
  throw new ApiError(message ?? translate('err.generic'), res.status);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) await fail(res);
  return res.json();
}

// Загрузка файла (multipart): Content-Type выставляет браузер
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await send(path, { method: 'POST', body: form });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function logout() {
  await send('/auth/logout', { method: 'POST' }).catch(() => undefined);
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;

export async function download(path: string, filename: string) {
  const res = await send(path, {});
  if (!res.ok) throw new ApiError(translate('err.download'), res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Скачать файл, который сервер собирает по телу запроса (например, отчёт из конструктора)
export async function downloadPost(path: string, body: unknown, filename: string) {
  const res = await send(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) await fail(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Старое имя для CSV-отчётов
export const downloadCsv = download;
