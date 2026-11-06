// The client's wish about the time of a visit ("after 19:00", "in the morning", "in the evening"), read from the LAST message by code. The model does not see the
// free times, so the wish is applied where the times are chosen (the agent's draft). A wish is NOT a free slot and NOT the clinic's hours: the three are never mixed.
export interface TimePreference {
  afterMin?: number;
  beforeMin?: number;
  // how the wish was said (for the words the code writes back to the client)
  afterKind?: 'time' | 'evening' | 'afternoon';
  beforeKind?: 'time' | 'morning';
}

const HM = '(\\d{1,2})(?:[:.](\\d{2}))?';
const minutes = (h: string, m?: string) => Number(h) * 60 + Number(m ?? 0);

export function parseTimePreference(text: string): TimePreference | null {
  const pref: TimePreference = {};
  const after = new RegExp(`(?:після|после|пізніше|позже)\\s*(?:о\\s*)?${HM}`, 'iu').exec(text);
  if (after && Number(after[1]) <= 23) {
    pref.afterMin = minutes(after[1], after[2]);
    pref.afterKind = 'time';
  }
  const before = new RegExp(`(?:до|раніше|раньше|ранее)\\s*${HM}\\s*(?:год|час|ч\\b|:|$|[.,!?])`, 'iu').exec(text);
  if (before && Number(before[1]) <= 24 && before[0].match(/\d/)) {
    pref.beforeMin = minutes(before[1], before[2]);
    pref.beforeKind = 'time';
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
  return pref.afterMin !== undefined || pref.beforeMin !== undefined ? pref : null;
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
  if (pref.afterMin !== undefined) parts.push(pref.afterKind === 'evening' ? (ru ? 'вечером' : 'ввечері') : pref.afterKind === 'afternoon' ? (ru ? 'после обеда' : 'після обіду') : `${ru ? 'после' : 'після'} ${hm(pref.afterMin)}`);
  if (pref.beforeMin !== undefined) parts.push(pref.beforeKind === 'morning' ? (ru ? 'утром' : 'зранку') : `${ru ? 'до' : 'до'} ${hm(pref.beforeMin)}`);
  return parts.join(' ');
}
