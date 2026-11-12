// The period of the home page's figures: yesterday, the last 7, 30 or 90 days, or any range of whole days (both ends included).
// The dates are the browser's local days (the clinic and its staff are in one time zone); the server counts them in the clinic's zone.
export type Period = { kind: 'yesterday' } | { kind: 'days'; n: number } | { kind: 'range'; from: string; to: string };

export const PRESET_DAYS = [7, 30, 90] as const;
// the longest range the server accepts (the visit history is kept for 3 years)
export const MAX_RANGE_DAYS = 1100;
const DAY = 86_400_000;

// "YYYY-MM-DD" of a local day
export const localDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
export const today = () => localDay(new Date());
export const yesterday = () => localDay(new Date(Date.now() - DAY));
// "01.11.2026"
export const dayLabel = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

// The query of a report or of the payback for the period
export function periodQuery(p: Period): string {
  if (p.kind === 'days') return `days=${p.n}`;
  const { from, to } = p.kind === 'yesterday' ? { from: yesterday(), to: yesterday() } : p;
  return `from=${from}&to=${to}`;
}

// Why a range cannot be used, or null when it can
export function rangeProblem(from: string, to: string): 'empty' | 'order' | 'future' | 'long' | null {
  if (!from || !to) return 'empty';
  if (from > to) return 'order';
  if (from > today()) return 'future';
  if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > MAX_RANGE_DAYS) return 'long';
  return null;
}

// The saved choice ("yesterday" is kept as a choice, not as a date: tomorrow it means the next day)
export function readPeriod(raw: string | null): Period | null {
  try {
    const v = JSON.parse(raw ?? 'null') as Period | null;
    if (v?.kind === 'yesterday') return v;
    if (v?.kind === 'days' && (PRESET_DAYS as readonly number[]).includes(v.n)) return v;
    if (v?.kind === 'range' && typeof v.from === 'string' && typeof v.to === 'string' && !rangeProblem(v.from, v.to)) return v;
  } catch {
    // an older saved value (a plain number of days) or garbage
    const n = Number(raw);
    if ((PRESET_DAYS as readonly number[]).includes(n)) return { kind: 'days', n };
  }
  return null;
}
