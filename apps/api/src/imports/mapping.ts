import { BadRequestException } from '@nestjs/common';
import { TaskResult } from '@prisma/client';
import { CHANNELS } from '../patients/patients.controller';

export type ImportType = 'PATIENT_EXTRA' | 'CONTACTS';
export type MatchBy = 'PHONE' | 'NAME' | 'EXTERNAL_ID';

export interface Mapping {
  type: ImportType;
  matchBy: MatchBy;
  matchColumn: string;
  // PATIENT_EXTRA: какие столбцы сохранить как дополнительные поля пациента и под каким названием
  fields?: { column: string; label?: string }[];
  // CONTACTS: столбцы с датой, результатом и заметкой
  dateColumn?: string;
  outcomeColumn?: string;
  noteColumn?: string;
  channel?: string;
  // PATIENT_EXTRA: перезаписывать ли уже заполненные значения (по умолчанию нет)
  overwrite?: boolean;
}

// Проверка настроек, пришедших с клиента: столбцы должны существовать в файле
export function validateMapping(raw: unknown, columns: string[]): Mapping {
  const bad = () => new BadRequestException('bad_mapping');
  if (!raw || typeof raw !== 'object') throw bad();
  const m = raw as Mapping;
  if (m.type !== 'PATIENT_EXTRA' && m.type !== 'CONTACTS') throw bad();
  if (!['PHONE', 'NAME', 'EXTERNAL_ID'].includes(m.matchBy)) throw bad();
  const has = (c: unknown): c is string => typeof c === 'string' && columns.includes(c);
  if (!has(m.matchColumn)) throw bad();

  if (m.type === 'PATIENT_EXTRA') {
    if (!Array.isArray(m.fields) || !m.fields.length || m.fields.length > 30) throw bad();
    const labels = new Set<string>();
    for (const f of m.fields) {
      if (!f || !has(f.column)) throw bad();
      const label = (f.label ?? f.column).trim();
      if (!label || label.length > 60 || labels.has(label.toLowerCase())) throw bad();
      labels.add(label.toLowerCase());
    }
  } else {
    if (!has(m.dateColumn)) throw bad();
    if (m.outcomeColumn !== undefined && m.outcomeColumn !== '' && !has(m.outcomeColumn)) throw bad();
    if (m.noteColumn !== undefined && m.noteColumn !== '' && !has(m.noteColumn)) throw bad();
    if (m.channel !== undefined && !CHANNELS.includes(m.channel)) throw bad();
  }
  return m;
}

// ---------- значения ----------

const OUTCOME_WORDS: [TaskResult, string[]][] = [
  ['BOOKED', ['записав', 'записан', 'записал', 'booked', 'запис']],
  ['DECLINED', ['відмов', 'отказ', 'declin', 'refus', 'не запис', 'не хоче', 'не хочет']],
  ['NO_ANSWER', ['не відпов', 'не отвеча', 'не ответ', 'недозвон', 'не дозвон', 'no answer', 'unreachable']],
  ['CALL_LATER', ['передзвон', 'перетелефон', 'перезвон', 'пізніше', 'позже', 'call later', 'later']],
];

// Результат контакта из свободного текста таблицы; если не узнали — null (текст всё равно попадёт в заметку)
export function parseOutcome(text: string): TaskResult | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  // «не відповів» содержит «відпов…», но не «запис…»: проверяем в порядке от более специфичных
  for (const key of ['NO_ANSWER', 'DECLINED', 'CALL_LATER', 'BOOKED'] as const) {
    const words = OUTCOME_WORDS.find(([k]) => k === key)![1];
    if (words.some((w) => t.includes(w))) return key;
  }
  return null;
}

// Даты из таблиц: 2026-10-28, 28.10.2026, 28/10/26, серийный номер Excel (46000)
export function parseDate(text: string): Date | null {
  const s = text.trim();
  if (!s) return null;
  let d: Date | null = null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)));
  else if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    d = new Date(Date.UTC(year, +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)));
    if (d.getUTCMonth() !== +m[2] - 1) return null; // 31.02 и подобное
  } else if (/^\d{5}$/.test(s)) {
    d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || d.getTime() > Date.now() + 86_400_000) return null; // контакт в будущем — скорее всего ошибка в данных
  return d;
}

// «Іваненко Олег» и «Олег Іваненко» — один и тот же ключ: слова без знаков препинания, по алфавиту
export function nameKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// Подсказки: какой столбец, вероятно, содержит телефон, ФИО, дату и т.д.
export function suggest(columns: string[]) {
  const find = (re: RegExp) => columns.find((c) => re.test(c));
  return {
    phone: find(/тел|phone|mobile|моб|номер|контакт/i),
    name: find(/піб|фіо|пацієнт|пациент|patient|name|ім'я|імя|имя/i),
    externalId: find(/^id$|код|id пацієнта|patient.?id/i),
    date: find(/дат|date|коли|когда/i),
    outcome: find(/результат|статус|result|outcome|status/i),
    note: find(/коментар|примітк|комментар|заметк|note|comment/i),
  };
}
