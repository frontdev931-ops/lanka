// The client's wish about the time of a visit ("after 19:00", "in the morning", "in the evening"), read from the LAST message by code. The model does not see the
// free times, so the wish is applied where the times are chosen (the agent's draft). A wish is NOT a free slot and NOT the clinic's hours: the three are never mixed.
export interface TimePreference {
  afterMin?: number;
  beforeMin?: number;
  // how the wish was said (for the words the code writes back to the client)
  // 'at': a named hour ("о 19", "на 19:00", "о шостій"): afterMin is that hour and beforeMin an hour later (a start within that hour)
  afterKind?: 'time' | 'evening' | 'afternoon' | 'at';
  beforeKind?: 'time' | 'morning' | 'at';
  // a day wish, read in the CLINIC's calendar (the `today` the caller passes): a date YYYY-MM-DD. A wish, never a promise.
  date?: string;
  // the day could not be read safely: 'same_weekday' (the weekday of today: today or next week?), 'past' (the date has passed)
  unclear?: 'same_weekday' | 'past';
  // the day is farther than the search reaches (days from today); the code says honestly that it did not look there
  farDays?: number;
}

const WEEKDAYS: [RegExp, number][] = [
  [/(?<![\p{L}])(?:понеділок|понеділка|понедельник|понедельника)(?![\p{L}])/iu, 1],
  [/(?<![\p{L}])(?:вівторок|вівторка|вторник|вторника)(?![\p{L}])/iu, 2],
  [/(?<![\p{L}])(?:середа|середу|середи|среда|среду|среды)(?![\p{L}])/iu, 3],
  [/(?<![\p{L}])(?:четвер|четверга|четверг)(?![\p{L}])/iu, 4],
  [/(?<![\p{L}])(?:п['’ʼ]?ятниця|п['’ʼ]?ятницю|п['’ʼ]?ятниці|пятница|пятницу|пятницы)(?![\p{L}])/iu, 5],
  [/(?<![\p{L}])(?:субота|суботу|суботи|суббота|субботу|субботы)(?![\p{L}])/iu, 6],
  [/(?<![\p{L}])(?:неділя|неділю|неділі|воскресенье|воскресенья)(?![\p{L}])/iu, 7],
];
const MONTHS: [RegExp, number][] = [
  [/січня|января/iu, 1], [/лютого|февраля/iu, 2], [/березня|марта/iu, 3], [/квітня|апреля/iu, 4], [/травня|мая/iu, 5], [/червня|июня/iu, 6],
  [/липня|июля/iu, 7], [/серпня|августа/iu, 8], [/вересня|сентября/iu, 9], [/жовтня|октября/iu, 10], [/листопада|ноября/iu, 11], [/грудня|декабря/iu, 12],
];
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
// "any time works": the earlier wishes of the dialogue no longer apply
export const ANY_TIME = /(?<![\p{L}])(?:будь-який|будь\s+який|любой|любое)\s+(?:час|день|время)|(?:не\s*важливо|неважливо|не\s*важно|неважно)/iu;

// The day wish, in the clinic's calendar: today / tomorrow / the day after, a weekday, or a date. Bounded: `farDays` is set when it lies beyond `reach` days.
function parseDay(text: string, today: string, reach: number): Pick<TimePreference, 'date' | 'unclear' | 'farDays'> | null {
  const dayOf = (date: string): Pick<TimePreference, 'date' | 'unclear' | 'farDays'> => {
    const d = diffDays(today, date);
    return d < 0 ? { unclear: 'past' } : d >= reach ? { date, farDays: d } : { date };
  };
  if (/(?<![\p{L}])(?:післязавтра|послезавтра)(?![\p{L}])/iu.test(text)) return dayOf(addDays(today, 2));
  if (/(?<![\p{L}])завтра(?![\p{L}])/iu.test(text)) return dayOf(addDays(today, 1));
  if (/(?<![\p{L}])(?:сьогодні|сегодня)(?![\p{L}])/iu.test(text)) return dayOf(today);
  const num = /(?<![\d:.])(\d{1,2})[./](\d{1,2})(?![\d:])/.exec(text);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 31 && Number(num[2]) >= 1 && Number(num[2]) <= 12) {
    const y = Number(today.slice(0, 4));
    const mk = (yy: number) => `${yy}-${String(num[2]).padStart(2, '0')}-${String(num[1]).padStart(2, '0')}`;
    const date = mk(y);
    return dayOf(diffDays(today, date) < -180 ? mk(y + 1) : date);
  }
  const named = /(?<![\d:.])(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu.exec(text);
  if (named) {
    const m = MONTHS.find(([re]) => re.test(named[2]))![1];
    const y = Number(today.slice(0, 4));
    const mk = (yy: number) => `${yy}-${String(m).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}`;
    return dayOf(diffDays(today, mk(y)) < -180 ? mk(y + 1) : mk(y));
  }
  for (const [re, wd] of WEEKDAYS) {
    if (!re.test(text)) continue;
    const todayWd = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const next = /(?<![\p{L}])(?:наступн\p{L}*|следующ\p{L}*)(?![\p{L}])/iu.test(text);
    let delta = (wd - todayWd + 7) % 7;
    if (delta === 0) {
      if (!next) return { unclear: 'same_weekday' };
      delta = 7;
    }
    return dayOf(addDays(today, delta));
  }
  return null;
}

const HM = '(\\d{1,2})(?:[:.](\\d{2}))?';
const minutes = (h: string, m?: string) => Number(h) * 60 + Number(m ?? 0);

// Hours said in words. Ukrainian: the genitive after "після/до" ("після шостої") and the locative after "о" ("о шостій"); Russian: the genitive after
// "после/до" ("после шести") and the accusative after "в" ("в шесть").
const UK_GEN = ['першої', 'другої', 'третьої', 'четвертої', "п['’ʼ]?ятої", 'шостої', "с[ьі]омої", 'восьмої', "дев['’ʼ]?ятої", 'десятої', 'одинадцятої', 'дванадцятої'];
const UK_LOC = ['першій', 'другій', 'третій', 'четвертій', "п['’ʼ]?ятій", 'шостій', "с[ьі]омій", 'восьмій', "дев['’ʼ]?ятій", 'десятій', 'одинадцятій', 'дванадцятій'];
const RU_GEN = ['часа', 'двух', 'тр[её]х', 'четыр[её]х', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти', 'одиннадцати', 'двенадцати'];
const RU_ACC = ['час', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать'];
const WORD_HOUR = (list: string[]) => `(${list.join('|')})`;
const hourOfWord = (w: string) => {
  for (const list of [UK_GEN, UK_LOC, RU_GEN, RU_ACC]) {
    const i = list.findIndex((x) => new RegExp(`^${x}$`, 'iu').test(w));
    if (i >= 0) return i + 1;
  }
  return null;
};
// A clock hour from a spoken one: "ранку/утра" keeps the morning, "вечора/дня/обіду" means the afternoon, and without a word a bare 1-7 is the
// afternoon (a clinic is not open at 6 in the morning: "після шостої" is 18:00). 8-12 stay as said.
function clockHour(h: number, text: string): number {
  if (/(?<![\p{L}])(?:ранку|утра|вранці|утром|зранку)(?![\p{L}])/iu.test(text)) return h === 12 ? 0 : h;
  if (/(?<![\p{L}])(?:вечора|вечера|дня|обіду|обеда)(?![\p{L}])/iu.test(text)) return h < 12 ? h + 12 : h;
  return h <= 7 ? h + 12 : h;
}

export function parseTimePreference(text: string, today?: string, reach = 7): TimePreference | null {
  // the echo of a tapped time button ("Обрав час: 12.11 14:30") is a CHOICE of an offered slot, not a wish
  if (/^\s*Обрав час:/.test(text)) return null;
  const pref: TimePreference = {};
  if (today) Object.assign(pref, parseDay(text, today, reach) ?? {});
  const after = new RegExp(`(?:після|после|пізніше|позже)\\s*(?:о\\s*)?${HM}`, 'iu').exec(text);
  if (after && Number(after[1]) <= 23) {
    pref.afterMin = minutes(String(clockHour(Number(after[1]), text)), after[2]);
    pref.afterKind = 'time';
  }
  const afterWord = new RegExp(`(?<![\\p{L}])(?:після|после|пізніше|позже)\\s+${WORD_HOUR([...UK_GEN, ...RU_GEN])}(?![\\p{L}])`, 'iu').exec(text);
  if (pref.afterMin === undefined && afterWord) {
    pref.afterMin = clockHour(hourOfWord(afterWord[1])!, text) * 60;
    pref.afterKind = 'time';
  }
  const before = new RegExp(`(?:до|раніше|раньше|ранее)\\s*${HM}\\s*(?:год|час|ч\\b|:|$|[.,!?])`, 'iu').exec(text);
  if (before && Number(before[1]) <= 24 && before[0].match(/\d/)) {
    pref.beforeMin = minutes(String(clockHour(Number(before[1]), text)), before[2]);
    pref.beforeKind = 'time';
  }
  const beforeWord = new RegExp(`(?<![\\p{L}])(?:до|раніше|раньше|ранее)\\s+${WORD_HOUR([...UK_GEN, ...RU_GEN])}(?![\\p{L}])`, 'iu').exec(text);
  if (pref.beforeMin === undefined && beforeWord) {
    pref.beforeMin = clockHour(hourOfWord(beforeWord[1])!, text) * 60;
    pref.beforeKind = 'time';
  }
  // A named hour: "о 19", "о 19:30", "на 19:00", "в 19 годині", "о шостій", "в шесть". "на"/"в" with a bare number count only with minutes or an hour word
  // ("на 2 зуби" is not a time). The start is wished within that hour. Only when no "after"/"before" was said.
  if (pref.afterMin === undefined && pref.beforeMin === undefined) {
    const atNum =
      // a number followed by another word ("о 3 зуби") is not a time; time words after it are fine
      new RegExp(`(?<![\\p{L}])(?:о|об)\\s+${HM}(?![\\d])(?!\\s*(?!(?:год\\p{L}*|ранку|вечора|дня|утра|вечера|час\\p{L}*|ч)(?![\\p{L}]))\\p{L})`, 'iu').exec(text) ??
      new RegExp(`(?<![\\p{L}])(?:на|в|во)\\s+(\\d{1,2})(?:[:.](\\d{2}))(?![\\d])`, 'iu').exec(text) ??
      new RegExp(`(?<![\\p{L}])(?:на|в|во|о)\\s+(\\d{1,2})()\\s*(?:год\\p{L}*|час\\p{L}*|ч)(?![\\p{L}])`, 'iu').exec(text);
    const atWord = new RegExp(`(?<![\\p{L}])(?:о|об|в)\\s+${WORD_HOUR([...UK_LOC, ...RU_ACC.slice(1)])}(?![\\p{L}])`, 'iu').exec(text);
    const h = atNum ? clockHour(Number(atNum[1]), text) : atWord ? clockHour(hourOfWord(atWord[1])!, text) : null;
    const m = atNum?.[2] ? Number(atNum[2]) : 0;
    if (h !== null && h >= 7 && h <= 21 && m < 60) {
      pref.afterMin = h * 60 + m;
      pref.afterKind = 'at';
      pref.beforeMin = h * 60 + m + 60;
      pref.beforeKind = 'at';
    }
  }
  if (pref.afterMin === undefined && /(?<![\p{L}])(?:ввечері|увечері|вечором|вечора|вечір|вечером|вечера|вечер)(?![\p{L}])/iu.test(text)) {
    pref.afterMin = 17 * 60;
    pref.afterKind = 'evening';
  }
  if (pref.afterMin === undefined && /(?:після\s+обіду|по\s+обіді|после\s+обеда)/iu.test(text)) {
    pref.afterMin = 13 * 60;
    pref.afterKind = 'afternoon';
  }
  if (pref.beforeMin === undefined && /(?<![\p{L}])(?:вранці|зранку|уранці|утром|с\s+утра)(?![\p{L}])/iu.test(text)) {
    pref.beforeMin = 12 * 60;
    pref.beforeKind = 'morning';
  }
  return pref.afterMin !== undefined || pref.beforeMin !== undefined || pref.date !== undefined || pref.unclear !== undefined ? pref : null;
}

// The times (date|time) that earlier outgoing messages of the dialogue offered as buttons: they are not offered again
export function offeredBefore(messages: { direction: string; buttons: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.direction !== 'OUT' || !Array.isArray(m.buttons)) continue;
    for (const b of m.buttons as { payload?: unknown }[]) {
      const p = typeof b?.payload === 'string' ? b.payload.split('|') : [];
      if (p[0] === 'slot' && p[1] && p[2]) out.add(`${p[1]}|${p[2]}`);
    }
  }
  return out;
}

export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// The wish in words, written by the code from what the client said ("після 19:00", "зранку"); it confirms a WISH, it never promises a slot
export function preferencePhrase(pref: TimePreference, lang: 'uk' | 'ru'): string {
  const ru = lang === 'ru';
  const parts: string[] = [];
  if (pref.afterKind === 'at' && pref.afterMin !== undefined) return [`${ru ? 'в' : 'о'} ${hm(pref.afterMin)}`, pref.date ? `${ru ? 'на' : 'на'} ${pref.date.slice(8)}.${pref.date.slice(5, 7)}` : ''].filter(Boolean).join(' ');
  if (pref.afterMin !== undefined) parts.push(pref.afterKind === 'evening' ? (ru ? 'вечером' : 'ввечері') : pref.afterKind === 'afternoon' ? (ru ? 'после обеда' : 'після обіду') : `${ru ? 'после' : 'після'} ${hm(pref.afterMin)}`);
  if (pref.date) parts.push(`${ru ? 'на' : 'на'} ${pref.date.slice(8)}.${pref.date.slice(5, 7)}`);
  if (pref.beforeMin !== undefined) parts.push(pref.beforeKind === 'morning' ? (ru ? 'утром' : 'зранку') : `${ru ? 'до' : 'до'} ${hm(pref.beforeMin)}`);
  return parts.join(' ');
}
