import { BadRequestException } from '@nestjs/common';

// Рабочие часы клиники по дням недели (1 — понедельник … 7 — воскресенье); null — выходной.
export type Hours = { from: string; to: string } | null;
export type WorkHours = Record<string, Hours>;

const DAYS = ['1', '2', '3', '4', '5', '6', '7'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Пока клиника не настроила часы, считаем, что работают каждый день с 9:00 до 20:00
export const DEFAULT_HOURS: WorkHours = Object.fromEntries(DAYS.map((d) => [d, { from: '09:00', to: '20:00' }]));

// Из базы: недостающие или испорченные дни заменяются значениями по умолчанию
export function readWorkHours(raw: unknown): WorkHours {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    DAYS.map((d) => {
      const v = src[d];
      if (v === null) return [d, null];
      if (v && typeof v === 'object' && HM.test(String((v as Hours)!.from)) && HM.test(String((v as Hours)!.to)) && (v as Hours)!.from < (v as Hours)!.to) {
        return [d, { from: (v as Hours)!.from, to: (v as Hours)!.to }];
      }
      return [d, DEFAULT_HOURS[d]];
    }),
  );
}

// Из запроса: любая ошибка — отказ, а не молчаливая замена
export function parseWorkHours(input: unknown): WorkHours {
  if (!input || typeof input !== 'object') throw new BadRequestException('bad_work_hours');
  const src = input as Record<string, unknown>;
  const out: WorkHours = {};
  for (const d of DAYS) {
    const v = src[d];
    if (v === null) {
      out[d] = null;
      continue;
    }
    const h = v as { from?: unknown; to?: unknown } | undefined;
    if (!h || typeof h !== 'object' || typeof h.from !== 'string' || typeof h.to !== 'string' || !HM.test(h.from) || !HM.test(h.to) || h.from >= h.to) {
      throw new BadRequestException('bad_work_hours');
    }
    out[d] = { from: h.from, to: h.to };
  }
  return out;
}
