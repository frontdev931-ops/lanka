// Boundaries of the AI assistant that the code checks, not only the model's instruction.
// 1) an incoming message with a dangerous topic never reaches the model: it goes straight to a person;
// 2) a finished reply is checked for what the assistant must not say.

import { MEDICATION, stemsOf } from './dental';

// Said only together with a request that is really created for the administrator; no time of the answer is promised
export const HANDOFF_TEXT = 'Передали ваше запитання адміністратору клініки.';
export const HANDOFF_TEXT_RU = 'Передали ваш вопрос администратору клиники.';

// The patient's language: і ї є ґ and Ukrainian words mean Ukrainian; ы э ъ ё and Russian words mean Russian; no signs means undetermined
const RU_WORDS = /(?<![\p{L}])(какие|какой|какая|какое|как|что|где|когда|есть|нужно|можно|окна|окон|окошк\p{L}*|сегодня|сколько|врач|записаться|запишите|запись|пожалуйста|спасибо|здравствуйте|привет|меня|мне|мой|моя|подскажите|свободн\p{L}*|ближайш\p{L}*|хотел\p{L}*|болит|чтобы|можете|ещё|лечение|во сколько)(?![\p{L}])/iu;
const UK_WORDS = /(?<![\p{L}])(які|який|яка|яке|що|де|коли|є|потрібно|можна|вікна|вікон|вікно|сьогодні|скільки|лікар|записатися|запишіть|будь ласка|дякую|вітаю|добрий|мені|мене|мій|моя|підкажіть|вільн\p{L}*|найближч\p{L}*|хотів|хотіла|болить|щоб|можете|ще|лікування|о котрій)(?![\p{L}])/iu;
export function detectLanguage(text: string): 'ru' | 'uk' | null {
  if (/[іїєґ]/i.test(text)) return 'uk';
  if (/[ыэъё]/i.test(text)) return 'ru';
  const ru = RU_WORDS.test(text);
  const uk = UK_WORDS.test(text);
  return ru && !uk ? 'ru' : uk && !ru ? 'uk' : null;
}
// The language of a conversation: from the newest message that shows one (texts are newest first); Ukrainian when none does
export function languageOf(textsNewestFirst: string[]): 'ru' | 'uk' {
  for (const t of textsNewestFirst) {
    const l = detectLanguage(t);
    if (l) return l;
  }
  return 'uk';
}
export function isRussian(patientText: string): boolean {
  return detectLanguage(patientText) === 'ru';
}

export function handoffText(lang: 'ru' | 'uk'): string {
  return lang === 'ru' ? HANDOFF_TEXT_RU : HANDOFF_TEXT;
}
export type HandoffReason = 'medical' | 'price' | 'complaint' | 'long' | 'reply_check' | 'model' | 'urgent';

const TOPICS: { reason: HandoffReason; re: RegExp }[] = [
  // health: symptoms, medicines, diagnoses: only a doctor or the administrator
  { reason: 'medical', re: /(біль|болить|болю|болят|боль|болит|кров|кровит|кровь|температур|набряк|отек|отёк|опух|пухлин|флюс|антибіот|антибиот|таблетк|ліки|лекарств|препарат|дозуван|дозировк|алерг|вагітн|беремен|діагноз|диагноз|нестерпн|невыносим|швидк|скорая|нагноє|гній|гной)/i },
  // money: we do not name prices, the administrator knows them
  { reason: 'price', re: /(скільки\s+кошт|сколько\s+стоит|ціна|цена|цены|ціни|вартість|стоимость|прайс|знижк|скидк|розстрочк|рассрочк|кредит)/i },
  // complaints and threats
  { reason: 'complaint', re: /(скарг|скарж|жалоб|жалу(?!йст)|пожалу(?!йст)|обман|поверніть\s+гроші|верните\s+деньги|прокурор|юрист|адвокат|суд[іуо]|поліці|полици|відгук\s+напишу|отзыв\s+напишу)/i },
];

// Discounts and instalments are never answered by the AI. A plain price question goes to the model only when the clinic has
// approved, recently confirmed prices (then the reply is checked against exactly those amounts).
const PRICE_ONLY_CASH = /(знижк|скидк|розстрочк|рассрочк|кредит|акці|акци)/i;

export function incomingHandoff(text: string, pricesKnown = false): HandoffReason | null {
  for (const t of TOPICS) {
    if (!t.re.test(text)) continue;
    if (t.reason === 'price' && pricesKnown && !PRICE_ONLY_CASH.test(text)) continue;
    return t.reason;
  }
  return null;
}

// A sudden health problem WITHOUT a question about medicines, a diagnosis, prices or a complaint: the AI does not answer it, and it is not
// simply handed over either: the code offers the nearest time and marks the request as urgent (see ChatAssistantService)
export function isUrgentSymptom(text: string, pricesKnown = false): boolean {
  if (incomingHandoff(text, pricesKnown) !== 'medical' || MEDICATION.test(text)) return false;
  return !TOPICS.some((t) => t.reason !== 'medical' && t.re.test(text) && !(t.reason === 'price' && pricesKnown && !PRICE_ONLY_CASH.test(text)));
}

// What a clinic reply must not contain: sums, dosages, medicines, diagnoses, treatment advice
const MONEY = /(\d[\d\s]*(?:[.,]\d+)?)\s*(грн|₴|uah|usd|\$|€|грив|гривен|долар)/gi;
const BAD_REPLY = [
  /\d+\s*(мг|mg|мл|ml|табл)/i,
  /(діагноз|диагноз|антибіот|антибиот|ібупрофен|ибупрофен|парацетамол|нурофен|анальгін|анальгин|полощіть|полоскайте|приймайте|принимайте|прийміть|прикладіть|приложите)/i,
];

// "from 1 500 UAH" is never said: the clinic's list has fixed prices, and a price is marked as preliminary by a separate sentence
const FROM_PRICE = /(?<![\p{L}])(від|от|from|начиная\s+с|починаючи\s+з)\s*\d[\d\s]*(?:[.,]\d+)?\s*(грн|₴|uah|грив)/iu;

// A sum named in a reply must belong to the service it is named for, not only exist somewhere in the price list. The service is found by
// the words of the reply around the sum (the title's significant words; best match only), then by the whole reply, then by the service
// the model reported. A sum that cannot be tied to a service, or is another service's price, is a violation.
export interface PricedService {
  title: string;
  category?: string | null;
  amount: number;
}
function servicesNamedIn(text: string, priced: PricedService[]): PricedService[] {
  const words = new Set(stemsOf(text));
  const scored = priced
    .map((p) => {
      const t = stemsOf(p.title);
      return { p, n: t.filter((x) => words.has(x)).length };
    })
    .filter((x) => x.n >= 1);
  const best = Math.max(0, ...scored.map((x) => x.n));
  return scored.filter((x) => x.n === best).map((x) => x.p);
}
function sumsMatchServices(reply: string, priced: PricedService[], hint?: string | null): boolean {
  const hinted = hint ? servicesNamedIn(hint, priced) : [];
  let from = 0;
  for (const m of reply.matchAll(MONEY)) {
    const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
    const end = (m.index ?? 0) + m[0].length;
    // the sentence that holds the sum: before it (where the name usually is), then the whole sentence, then the whole reply
    const sentStart = Math.max(reply.lastIndexOf('. ', m.index ?? 0) + 2, reply.lastIndexOf('\n', m.index ?? 0) + 1, 0);
    const windows = [reply.slice(Math.max(from, sentStart), m.index ?? 0), reply.slice(sentStart, end + 60), reply];
    from = end;
    let named: PricedService[] = [];
    for (const w of windows) {
      named = servicesNamedIn(w, priced);
      if (named.length) break;
    }
    if (![...named, ...hinted].some((p) => p.amount === n) ) return false;
    if (!named.length && !hinted.length) return false;
  }
  return true;
}

// allowedAmounts: the prices (UAH) of the clinic's own list that are known and current; any other amount in the reply is a violation.
// With `check` also the binding of the sum to the service named for it (see above).
export function replyProblem(reply: string, allowedAmounts: number[] = [], check?: { priced: PricedService[]; service?: string | null }): string | null {
  if (FROM_PRICE.test(reply)) return 'from_price';
  for (const m of reply.matchAll(MONEY)) {
    const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
    if (!/грн|₴|uah|грив/i.test(m[2]) || !allowedAmounts.includes(n)) return 'amount_not_in_list';
  }
  if (check && !sumsMatchServices(reply, check.priced, check.service)) return 'price_service_mismatch';
  return BAD_REPLY.some((re) => re.test(reply)) ? 'medical_or_dosage' : null;
}
export const replyViolates = (reply: string, allowedAmounts: number[] = [], check?: { priced: PricedService[]; service?: string | null }): boolean => replyProblem(reply, allowedAmounts, check) !== null;

// The model is asked to return JSON; anything that does not parse is treated as a hand-over to a person
export interface ModelOption {
  date: string;
  time: string;
  doctor?: string;
}
export interface ModelReply {
  intent: string;
  reply: string;
  summary: string | null;
  // The service the person wants, as they said it or as the clinic's reference names it
  service: string | null;
  options: ModelOption[];
}

export function parseModelJson(raw: string): ModelReply | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { intent?: unknown; reply?: unknown; summary?: unknown; service?: unknown; options?: unknown };
    if (typeof j.intent !== 'string' || typeof j.reply !== 'string' || !j.reply.trim()) return null;
    const options = Array.isArray(j.options)
      ? j.options.filter((o): o is ModelOption => !!o && typeof (o as ModelOption).date === 'string' && typeof (o as ModelOption).time === 'string').map((o) => ({ date: o.date, time: o.time, ...(typeof o.doctor === 'string' && o.doctor.trim() ? { doctor: o.doctor.trim() } : {}) }))
      : [];
    return { intent: j.intent, reply: j.reply.trim().slice(0, 900), summary: typeof j.summary === 'string' && j.summary.trim() ? j.summary.trim().slice(0, 300) : null, service: typeof j.service === 'string' && j.service.trim() ? j.service.trim().slice(0, 80) : null, options };
  } catch {
    return null;
  }
}

// A time in the reply (hh:mm) must lie inside one of the free windows that we calculated from the schedule ourselves.
// Windows come in minutes from the start of the day. Without windows no time may be named at all.
export function timesOutsideWindows(reply: string, windows: [number, number][]): boolean {
  for (const m of reply.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)) {
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (!windows.some(([a, b]) => t >= a && t <= b)) return true;
  }
  return false;
}

// Every reply that names a price says that the price is preliminary and that the administrator clarifies the exact sum and what the service
// includes. The model is told to write it; the code makes sure it is there, in the language of the conversation (whatever the model wrote).
export const PRICE_NOTICE: Record<'uk' | 'ru', string> = {
  uk: 'Вартість попередня — точну суму та що входить у послугу уточнить адміністратор.',
  ru: 'Стоимость предварительная — точную сумму и что входит в услугу уточнит администратор.',
};
const NAMES_PRICE = /\d[\d\s]*(?:[.,]\d+)?\s*(грн|₴|uah|грив)|безкоштовн|бесплатн/i;
const HAS_NOTICE = /(попередн|предварительн)/i;
export function withPriceNotice(reply: string, lang: 'uk' | 'ru'): string {
  if (!NAMES_PRICE.test(reply) || HAS_NOTICE.test(reply)) return reply;
  return `${reply.trim()}\n\n${PRICE_NOTICE[lang]}`;
}
