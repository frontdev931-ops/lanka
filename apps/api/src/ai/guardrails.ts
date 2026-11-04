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

// A currency word or sign anywhere in the free text of the model: every sum of a reply is written by the code from the price list (see
// composePriceReply), so the text of the model carries none (this closes any way round, a sum in words of "гривень" included)
const CURRENCY = /(грн|₴|uah|usd|\$|€|грив|гривен|долар|dollar|євро|евро|руб)/i;

// null when the free text of the model is acceptable
export function replyProblem(reply: string): string | null {
  if (CURRENCY.test(reply)) return 'amount_in_free_text';
  return BAD_REPLY.some((re) => re.test(reply)) ? 'medical_or_dosage' : null;
}
export const replyViolates = (reply: string): boolean => replyProblem(reply) !== null;

// The state of the price of a service as the code knows it (see KbService.factsFor)
export type PriceState = 'KNOWN' | 'FREE' | 'CONFLICT' | 'GONE' | 'UNKNOWN';
export interface PriceItem {
  id: string;
  // The short reference the model uses in the prompt and in its answer ("S12"): easier to copy without a slip than a 25-character id, and valid only
  // for the services of this clinic
  ref: string;
  title: string;
  category: string | null;
  state: PriceState;
  amount: number | null;
  // How close the service is to the words of the patient (see KbService.rankServices); a service far below the best match is not named
  score?: number;
}
// A service that scores below this share of the best match is a coincidence of one word ("Огляд терапевта" for "лікування"), not an answer
const WEAK_SHARE = 0.3;

const MONEY_FORMAT = new Intl.NumberFormat('uk-UA', { useGrouping: false });
const UNCLEAR: Record<'uk' | 'ru', string> = {
  uk: 'вартість потрібно уточнити в адміністратора',
  ru: 'стоимость нужно уточнить у администратора',
};
const FREE_WORD: Record<'uk' | 'ru', string> = { uk: 'безкоштовно', ru: 'бесплатно' };

// The model chooses services by id; the code checks that every id is one of the services found for THIS clinic for this answer, then writes the
// lines itself: the exact title and the exact sum from the database (an unknown, conflicting or vanished price is never a number and never a zero).
// The model words the introduction and the closing; the code adds the notice about a preliminary cost in the language of the dialogue.
export function composePriceReply(parts: { intro: string; after: string | null; ids: unknown }, items: PriceItem[], lang: 'uk' | 'ru'): { reply: string; dropped: number } | { problem: string } {
  const free = replyProblem(`${parts.intro}\n${parts.after ?? ''}`);
  if (free) return { problem: free };
  const ids = parts.ids === undefined || parts.ids === null ? [] : parts.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return { problem: 'bad_service_ids' };
  const chosen: PriceItem[] = [];
  for (const id of new Set((ids as string[]).map((x) => x.trim().replace(/^\[|\]$/g, '').toUpperCase()))) {
    const ref = id.trim().replace(/^\[|\]$/g, '').toUpperCase();
    const item = items.find((x) => x.ref === ref);
    if (!item) return { problem: 'unknown_service_id' }; // a reference that is not in the list of this clinic for this answer (unknown or invented)
    chosen.push(item);
  }
  // services that are only a coincidence of one word with the question are left out (the best match and everything close to it stay)
  const top = Math.max(0, ...items.map((x) => x.score ?? 0));
  const strong = top > 0 ? chosen.filter((x) => (x.score ?? 0) >= top * WEAK_SHARE) : [...chosen];
  const dropped = chosen.length - strong.length;
  chosen.length = 0;
  chosen.push(...strong);
  // the same title in two groups is told apart by the group
  const dup = new Set(chosen.map((x) => x.title).filter((t, i, a) => a.indexOf(t) !== i));
  const lines = chosen.map((x) => {
    const name = dup.has(x.title) && x.category ? `${x.title} (${x.category})` : x.title;
    if (x.state === 'FREE') return `- ${name}: ${FREE_WORD[lang]}`;
    if (x.state === 'KNOWN' && x.amount !== null) return `- ${name}: ${MONEY_FORMAT.format(x.amount)} грн`;
    return `- ${name}: ${UNCLEAR[lang]}`;
  });
  const priced = chosen.some((x) => x.state === 'KNOWN' || x.state === 'FREE');
  const intro = stripNotice(parts.intro);
  const after = parts.after ? stripNotice(parts.after) : '';
  const block = lines.length ? `${lines.join('\n')}${priced ? `\n\n${PRICE_NOTICE[lang]}` : ''}` : '';
  return { reply: [intro, block, after].filter((x) => x.trim()).join('\n\n'), dropped };
}

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
  // The services whose prices the answer gives: ids from the list of the clinic (the code writes the lines), and what follows the lines
  prices: unknown;
  after: string | null;
}

export function parseModelJson(raw: string): ModelReply | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { intent?: unknown; reply?: unknown; summary?: unknown; service?: unknown; options?: unknown; prices?: unknown; after?: unknown };
    if (typeof j.intent !== 'string' || typeof j.reply !== 'string' || !j.reply.trim()) return null;
    const options = Array.isArray(j.options)
      ? j.options.filter((o): o is ModelOption => !!o && typeof (o as ModelOption).date === 'string' && typeof (o as ModelOption).time === 'string').map((o) => ({ date: o.date, time: o.time, ...(typeof o.doctor === 'string' && o.doctor.trim() ? { doctor: o.doctor.trim() } : {}) }))
      : [];
    return { intent: j.intent, reply: j.reply.trim().slice(0, 900), summary: typeof j.summary === 'string' && j.summary.trim() ? j.summary.trim().slice(0, 300) : null, service: typeof j.service === 'string' && j.service.trim() ? j.service.trim().slice(0, 80) : null, options, prices: j.prices, after: typeof j.after === 'string' && j.after.trim() ? j.after.trim().slice(0, 500) : null };
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
// The notice the model wrote itself, in either language, up to "the administrator will clarify"
const NOTICE_ANY = /(?:Вартість попередня|Попередня вартість|Стоимость предварительная|Предварительная стоимость)[^\n]*?(?:уточнить\s+адміністратор|уточнит\s+администратор)\w*\.?/gi;
// Removes a notice about the preliminary cost that the model wrote itself (the code adds its own, in the right language)
export function stripNotice(text: string): string {
  return text.replace(NOTICE_ANY, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
