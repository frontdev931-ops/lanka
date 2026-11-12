import { BadRequestException } from '@nestjs/common';
import { localToUtc } from '../common/clinic-time';

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// The longest period one may pick (the visit history is kept for 3 years)
const MAX_DAYS = 1100;

// A chosen period of whole clinic days, both ends included (?from=2026-11-01&to=2026-11-10). since: the clinic's midnight of `from`; end: the midnight
// after `to`; until: the end, but not later than now (nothing after now is counted as done); days: its length, for the texts that need a number.
export interface Period {
  from: string;
  to: string;
  since: Date;
  end: Date;
  until: Date;
  days: number;
}

const valid = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const nextDay = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

// Nothing given: null (the report uses its "last N days"). One end only, a wrong date, from after to, a start in the future or a too long period: 400.
export function parsePeriod(from?: string, to?: string, now = new Date()): Period | null {
  if (!from && !to) return null;
  if (!from || !to || !valid(from) || !valid(to) || from > to) throw new BadRequestException('bad_period');
  const since = localToUtc(`${from} 00:00:00`);
  const end = localToUtc(`${nextDay(to)} 00:00:00`);
  const days = Math.round((end.getTime() - since.getTime()) / DAY);
  if (since.getTime() > now.getTime() || days > MAX_DAYS) throw new BadRequestException('bad_period');
  return { from, to, since, end, until: new Date(Math.min(end.getTime(), now.getTime())), days };
}

// "01.11.2026" for the texts of a report
export const periodDate = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
