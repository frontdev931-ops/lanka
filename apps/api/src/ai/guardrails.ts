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
  // health: symptoms, medicines, diagnoses: only a doctor or the administrator. The word "pain" (біль, боль) counts only as a WHOLE word: "більше" / "больше"
  // (more) and "найбільш" contain it and are not a complaint. The same for "швидко/швидкий" (fast; only "швидка допомога" / "викличте швидку" is an ambulance) and
  // "покров" ("кров" counts at the start of a word). Tablets ("таблетки від страху") stay a question about medicines.
  { reason: 'medical', re: /((?<![\p{L}])(?:біль|болі|болем|болями|болях|боль|боли|болью|болей)(?![\p{L}])|болить|болю|болят|болит|(?<![\p{L}])кров(?!ать|ля|ел)|кровит|кровь|температур|набряк|отек|отёк|опух|пухлин|флюс|антибіот|антибиот|таблетк|ліки|лекарств|препарат|дозуван|дозировк|алерг|вагітн|беремен|діагноз|диагноз|нестерпн|невыносим|(?<![\p{L}])швидк\p{L}*\s+допомог|(?<![\p{L}])викли\p{L}*\s+швидк|скорая|нагноє|гній|гной)/iu },
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
// opts.noticeOnlyForKnown: the notice about a preliminary cost goes with a line that names a sum (state KNOWN) and not with a free service (the working bot keeps its
// older rule: KNOWN or FREE). A line that says the price is to be clarified never needs it.
export function composePriceReply(parts: { intro: string; after: string | null; ids: unknown }, items: PriceItem[], lang: 'uk' | 'ru', opts: { noticeOnlyForKnown?: boolean } = {}): { reply: string; dropped: number } | { problem: string } {
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
  const priced = chosen.some((x) => x.state === 'KNOWN' || (!opts.noticeOnlyForKnown && x.state === 'FREE'));
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

// ---- the checks of the agent's draft (see .claude/docs/agent-administrator.md) ----

// The last message asks for a price (the plain price words only; a discount or an instalment is a hand-over topic, see incomingHandoff)
const PRICE_QUESTION = /(скільки\s+(?:це\s+|воно\s+|вона\s+)?кошт|сколько\s+(?:это\s+|оно\s+)?стоит|ціна|цена|цены|ціни|вартість|стоимость|прайс|почім|почем|по\s+чому)/i;
export const isPriceQuestion = (text: string): boolean => PRICE_QUESTION.test(text);

// A message that asks ONLY the price ("а скільки це коштує?", "яка ціна", "сколько это стоит"): nothing else is asked or said, so the code may answer it with the price of
// the service the dialogue is about. A mixed message ("сколько стоит и можно ли при беременности") does not match: its other questions go by their own rules.
const PRICE_ONLY = new RegExp(
  '^(?:(?:а|ну|і|и|та|слухайте|скажіть|підкажіть|скажите|подскажите|будь\\s+ласка|пожалуйста)[\\s,]+)*' +
    '(?:(?:скільки|сколько)\\s+(?:це\\s+|воно\\s+|вона\\s+|ця\\s+послуга\\s+|это\\s+|оно\\s+|эта\\s+услуга\\s+)?(?:коштує|коштуватиме|буде\\s+коштувати|стоит|будет\\s+стоить)' +
    '|(?:яка|какая)\\s+(?:там\\s+|це\\s+|это\\s+)?(?:ціна|вартість|цена|стоимость)(?:\\s+(?:цієї\\s+послуги|этой\\s+услуги|за\\s+це|за\\s+это))?' +
    '|(?:ціна|вартість|цена|стоимость))' +
    '(?:[\\s,]+(?:будь\\s+ласка|пожалуйста))?\\s*[?!.]*$',
  'iu',
);
export const isPriceOnlyQuestion = (text: string): boolean => PRICE_ONLY.test(text.trim());

// Words of a promise the model must never make on its own (a sentence that DENIES the promise is fine): a discount, an instalment, a gift, a guarantee, a result, "painless", a percentage.
// This is a list of risk words, NOT a proof: it does not catch every invented advantage. Advantages and prices reach a reply only through
// approved entries named by reference; this list is a second net for the free text, and staff read every draft.
const CLAIM_RISK: RegExp[] = [
  /\d+\s*%/,
  /(знижк|скидк|акці[яїйює]|акци[яиюй]|розстрочк|рассрочк|кредит|подарун|подарок|безкоштовн|бесплатн)/i,
  /(гарант)/i,
  /(без\s+болю|безболісн|безболезнен|не\s+боляче|не\s+больно)/i,
  /(стовідсотков|стопроцентн|назавжди|навсегда)/i,
];
// A risk word is not a promise when the sentence DENIES the promise: "ми не гарантуємо результат", "не можемо обіцяти знижку", "знижок немає", "без знижок".
// (Never for "без болю" / "не боляче": that is the promise itself.)
const NON_PROMISE = /(не\s+(?:гарантуємо|обіцяємо|можемо\s+(?:гарантувати|обіцяти)|гарантируем|обещаем|можем\s+(?:гарантировать|обещать))|(?<![\p{L}])(?:немає|нема|нет|нету)(?![\p{L}])|(?<![\p{L}])без\s+(?:знижок|скидок|акцій|акций))/iu;
const PAIN_PROMISE = /(без\s+болю|безболісн|безболезнен|не\s+боляче|не\s+больно)/i;
// the first risk word that stands as a promise, or null
export function claimMatch(text: string, approvedTitles: string[] = []): string | null {
  // The exact approved title of a service is not a promise ("Безкоштовна перевірка" is the name of a service); ONLY the title is set aside, the text around it is
  // scanned in full (so "безкоштовне лікування" next to it is still refused)
  let scanned = text;
  for (const title of [...new Set(approvedTitles)].filter(Boolean).sort((x, y) => y.length - x.length)) scanned = scanned.replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), ' ');
  for (const sentence of scanned.split(/(?<=[.!?…])\s+|\n+/)) {
    const denied = NON_PROMISE.test(sentence) && !PAIN_PROMISE.test(sentence.replace(/не\s+(?:гарантуємо|обіцяємо|можемо\s+(?:гарантувати|обіцяти)|гарантируем|обещаем|можем\s+(?:гарантировать|обещать))[^.!?…]*/i, ''));
    for (const re of CLAIM_RISK) {
      const m = re.exec(sentence);
      if (m && !denied) return m[0];
    }
  }
  return null;
}
export function claimProblem(text: string): 'risky_claim' | null {
  return claimMatch(text) ? 'risky_claim' : null;
}

// When the code itself shows the free times and asks the client to choose, a sentence of the model that asks the same ("shall I find a time?", "choose a
// convenient time") would be a second, competing next step. Such sentences are dropped from the model's text; its answer to the question stays.
const SOLICIT = /(підібра|підбер|підбир|подобра|подбер|подбир|оберіть|виберіть|выберите|выбер|назвіть|назовите|який\s+(?:вам\s+)?час|какое\s+(?:вам\s+)?время|зручн\S*\s+(?:для\s+вас\s+)?(?:час|день)|удобн\S*\s+(?:для\s+вас\s+)?(?:время|день)|запропонуємо|предложим)/i;
const TIME_WORD = /(час|времен|время|день|дату|дата|вікн|окошк|окн)/i;
export function withoutTimeSolicitation(text: string): string {
  return text
    .split(/\n+/)
    .map((para) => para.split(/(?<=[.!?…])\s+/).filter((sentence) => !(SOLICIT.test(sentence) && TIME_WORD.test(sentence))).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
