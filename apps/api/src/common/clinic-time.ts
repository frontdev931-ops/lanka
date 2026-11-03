// Clinic time. Cliniccards sends time without an offset: it is the clinic's local time.
// In the database we store real moments in time (UTC), and days and hours for reports are calculated in the clinic's zone.
// The zone is shared for now (in the clinic's Cliniccards settings it is Europe/Kyiv); for other zones it will become a clinic setting.
export const CLINIC_TZ = 'Europe/Kyiv';

// By how many milliseconds local time in zone tz is ahead of UTC at the moment utcMs
function tzOffset(utcMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const f = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(utcMs / 1000) * 1000;
}

// Local time "2026-06-11 11:00:00" → a moment in time
export function localToUtc(s: string, tz = CLINIC_TZ) {
  const [d, t = '00:00:00'] = s.trim().split(/[ T]/);
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se = 0] = t.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, da, h, mi, se);
  // The offset depends on the date itself (daylight saving time), so we refine it with a second pass
  let guess = asUtc - tzOffset(asUtc, tz);
  guess = asUtc - tzOffset(guess, tz);
  return new Date(guess);
}

// A moment in time → "YYYY-MM-DD" and "HH:MM" in the clinic's zone
const local = (d: Date, tz: string) => new Date(d.getTime() + tzOffset(d.getTime(), tz)).toISOString();
export const clinicDate = (d: Date, tz = CLINIC_TZ) => local(d, tz).slice(0, 10);
export const clinicMonth = (d: Date, tz = CLINIC_TZ) => local(d, tz).slice(0, 7);
export const clinicHm = (d: Date | number, tz = CLINIC_TZ) => local(new Date(d), tz).slice(11, 16);
// Start of the local day (the clinic's midnight) for the moment d
export const startOfClinicDay = (d: Date, tz = CLINIC_TZ) => localToUtc(clinicDate(d, tz) + ' 00:00:00', tz);
