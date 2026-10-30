import { clinicDate, localToUtc } from '../common/clinic-time';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

// The next moment after `after` that matches the schedule, in the clinic's local time. weekday: 1 Monday .. 7 Sunday; monthDay 1-28.
export function nextRun(s: { frequency: Frequency; hour: number; weekday: number; monthDay: number }, after: Date): Date {
  const start = new Date(`${clinicDate(after)}T00:00:00Z`);
  for (let i = 0; i < 40; i++) {
    const day = new Date(start.getTime() + i * 86_400_000);
    const weekday = day.getUTCDay() || 7;
    const ok = s.frequency === 'DAILY' || (s.frequency === 'WEEKLY' && weekday === s.weekday) || (s.frequency === 'MONTHLY' && day.getUTCDate() === s.monthDay);
    if (!ok) continue;
    const at = localToUtc(`${day.toISOString().slice(0, 10)} ${String(s.hour).padStart(2, '0')}:00:00`);
    if (at > after) return at;
  }
  // unreachable for valid input; a day later is a safe answer
  return new Date(after.getTime() + 86_400_000);
}
