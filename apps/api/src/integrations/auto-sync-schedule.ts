import { CLINIC_TZ, clinicDate, localToUtc } from '../common/clinic-time';

// The time of the daily automatic Cliniccards load (used by AutoSyncService and by the status the Settings card shows)
export const AUTO_SYNC_HOUR = 3;

export const autoSyncEnabled = () => process.env.AUTO_SYNC !== 'off' && process.env.AUTO_SYNC_MINUTES !== '0';

// The clinic's time zone. One zone for all clinics for now (CLINIC_TZ); a clinic setting takes its place here when there is one.
export const clinicTimeZone = (_clinicId?: string) => CLINIC_TZ;

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const hh = String(AUTO_SYNC_HOUR).padStart(2, '0');

// Today's slot (the clinic day and its 03:00) and the next one still ahead
export function autoSyncSlot(now: Date, tz = CLINIC_TZ) {
  const day = clinicDate(now, tz);
  const at = localToUtc(`${day} ${hh}:00:00`, tz);
  const nextAt = now.getTime() < at.getTime() ? at : localToUtc(`${nextDay(day)} ${hh}:00:00`, tz);
  return { day, at, nextAt };
}
