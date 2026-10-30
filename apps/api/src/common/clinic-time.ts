// Время клиники. Cliniccards присылает время без смещения: это местное время клиники.
// В базе храним настоящие моменты времени (UTC), а дни и часы для отчётов считаем в поясе клиники.
// Пояс пока общий (в настройках Cliniccards у клиники Europe/Kyiv); для других поясов он станет настройкой клиники.
export const CLINIC_TZ = 'Europe/Kyiv';

// На сколько миллисекунд местное время в поясе tz опережает UTC в момент utcMs
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

// Местное время «2026-06-11 11:00:00» → момент времени
export function localToUtc(s: string, tz = CLINIC_TZ) {
  const [d, t = '00:00:00'] = s.trim().split(/[ T]/);
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se = 0] = t.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, da, h, mi, se);
  // Смещение зависит от самой даты (летнее время), поэтому уточняем его вторым проходом
  let guess = asUtc - tzOffset(asUtc, tz);
  guess = asUtc - tzOffset(guess, tz);
  return new Date(guess);
}

// Момент времени → «ГГГГ-ММ-ДД» и «ЧЧ:ММ» в поясе клиники
const local = (d: Date, tz: string) => new Date(d.getTime() + tzOffset(d.getTime(), tz)).toISOString();
export const clinicDate = (d: Date, tz = CLINIC_TZ) => local(d, tz).slice(0, 10);
export const clinicMonth = (d: Date, tz = CLINIC_TZ) => local(d, tz).slice(0, 7);
export const clinicHm = (d: Date | number, tz = CLINIC_TZ) => local(new Date(d), tz).slice(11, 16);
// Начало местного дня (полночь клиники) для момента d
export const startOfClinicDay = (d: Date, tz = CLINIC_TZ) => localToUtc(clinicDate(d, tz) + ' 00:00:00', tz);
