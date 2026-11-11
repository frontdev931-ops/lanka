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
// ---- the AGENT's reading of the language (the working bot keeps detectLanguage / languageOf above, unchanged) ----
// More frequent words that differ between the two languages (a short message like "Боюсь боли у стоматолога" has no letter of either language and none of the words above)
const RU_MORE = /(?<![\p{L}])(боюсь|боли|больно|хорошо|сейчас|вечером|утром|после|нет|очень|если|надо|нужна|цена|цену|врача|понятно|пока|тоже|только|уже|будет|могу)(?![\p{L}])/iu;
const UK_MORE = /(?<![\p{L}])(боюся|болю|боляче|добре|зараз|дуже|якщо|треба|коштує|лікаря|вже|теж|поки|буде|можу)(?![\p{L}])/iu;
// Letter sequences of Russian spelling that Ukrainian spelling does not use (Ukrainian writes ії / іє / ія / ію, -ться): "консультации", "которые", "записаться — запишется".
// Evidence of the same kind as the letters ы э ъ ё, for a sentence that has none of them ("Расскажите о консультации").
const RU_SPELLING = /ии|ие|ия|ию|ые|ое|ее|яя|юю|тся/iu;
// The language of a text by the MAJORITY of its words: each word votes once (a letter or spelling of one language, or a word of the lists). One Ukrainian name, service title or
// address word inside a Russian sentence therefore does not make the sentence Ukrainian, and the reverse. null: no evidence or a tie.
// wordsOnly: a name or a contact answer ("Ірина Коваль", "Прізвище …, телефон …"), where letters and spelling say nothing: only the listed words count.
export function detectLanguageAgent(text: string, opts: { wordsOnly?: boolean } = {}): 'ru' | 'uk' | null {
  let ru = 0;
  let uk = 0;
  for (const w of text.split(/[^\p{L}'’ʼ-]+/u).filter(Boolean)) {
    const isUk = (!opts.wordsOnly && /[іїєґ]/i.test(w)) || UK_WORDS.test(w) || UK_MORE.test(w);
    const isRu = (!opts.wordsOnly && (/[ыэъё]/i.test(w) || RU_SPELLING.test(w))) || RU_WORDS.test(w) || RU_MORE.test(w);
    if (isUk && !isRu) uk++;
    else if (isRu && !isUk) ru++;
    else if (isUk && isRu) {
      // (a word with signs of both: a letter of the Ukrainian alphabet decides)
      if (/[іїєґ]/i.test(w)) uk++;
      else ru++;
    }
  }
  // the entries of the lists that are two words
  if (/(?<![\p{L}])будь\s+ласка(?![\p{L}])/iu.test(text)) uk++;
  return ru > uk ? 'ru' : uk > ru ? 'uk' : null;
}
// A text without the clinic's own stored names (service titles, the address): they stay as the clinic wrote them in any conversation and say nothing about the language of the
// prose around them
export function withoutStoredNames(text: string, names: (string | null | undefined)[]): string {
  let out = text;
  for (const n of [...new Set(names.filter((x): x is string => !!x && x.trim().length > 2))].sort((a, b) => b.length - a.length)) out = out.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')).join(' ');
  return out;
}
// A message that only gives contact data or a name (a phone number, "прізвище/имя …", or up to three capitalised words): it says nothing about the language of the conversation
const CONTACT_MARKS = /(?<![\p{L}])(?:прізвищ\p{L}*|фамили\p{L}*|ім['’ʼ]?я|имя|телефон\p{L}*|номер)(?![\p{L}])/iu;
function dataLike(text: string): boolean {
  const t = text.trim();
  if (/(?:\+?\d[\s().-]*){7,}/.test(t) || CONTACT_MARKS.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => /^\p{Lu}[\p{L}'’-]*[.,!]?$/u.test(w));
}
// An explicit request to talk in a language ("відповідайте російською", "ответьте по-украински", "можна українською?")
const ASK_RU = /(?<![\p{L}])(?:російською|російській\s+мові|по-російськи|по-русски|на\s+русском|русском\s+язык\p{L}*|на\s+русском)(?![\p{L}])/iu;
const ASK_UK = /(?<![\p{L}])(?:українською|українській\s+мові|по-українськи|по-украински|на\s+украинском|украинском\s+язык\p{L}*|на\s+українській)(?![\p{L}])/iu;
const ASK_CUE = /(?<![\p{L}])(?:будь\s+ласка|прошу|можна|можно|давайте|пишіть|пишите|відповідайте|відповідай|ответьте|отвечайте|говоріть|говорите|спілкуймося|общаемся|переключ\p{L}*|перейд\p{L}*|краще|лучше|зручніше|удобнее|розмовляйте|розмовляю|говорю|спілкуюсь|общаюсь)(?![\p{L}])/iu;
export function languageRequest(text: string): 'ru' | 'uk' | null {
  if (!ASK_CUE.test(text)) return null;
  const ru = ASK_RU.test(text);
  const uk = ASK_UK.test(text);
  return ru && !uk ? 'ru' : uk && !ru ? 'uk' : null;
}
// A message that ONLY asks for a language ("Пожалуйста, отвечайте по-русски.", "Можна українською?"): the request itself, words of politeness and nothing else. It is not an answer
// to whatever the agent asked before it. A message that also says something ("Отвечайте по-русски, хочу записаться на консультацию") is not this: it is processed as usual.
const REQUEST_FILLER = /(?<![\p{L}])(?:пожалуйста|будь|ласка|мне|мені|нам|со|мной|зі|мною|вы|ви|мы|ми|можете|только|тільки|если|якщо|добрый|добрий|день|здравствуйте|вітаю|привет|привіт|дальше|далі|теперь|тепер|дякую|спасибо|язык\p{L}*|мов\p{L}*)(?![\p{L}])/giu;
export function languageOnlyRequest(text: string): 'ru' | 'uk' | null {
  const lang = languageRequest(text);
  if (!lang) return null;
  const rest = [ASK_RU, ASK_UK, ASK_CUE].reduce((t, re) => t.replace(new RegExp(re.source, 'giu'), ' '), text).replace(REQUEST_FILLER, ' ');
  return (rest.match(/\p{L}{3,}/gu) ?? []).length === 0 ? lang : null;
}
// The language of a conversation, from the patient's texts (newest first). An explicit request for a language wins (the newest one); otherwise the newest message that clearly shows a
// language; a short or ambiguous message ("ок", "так", a name, a phone number, a date) shows none and keeps the language the conversation already has; Ukrainian when nothing shows one
export function languageOfAgent(textsNewestFirst: string[], storedNames: (string | null | undefined)[] = []): 'ru' | 'uk' {
  for (const t of textsNewestFirst) {
    const asked = languageRequest(t);
    if (asked) return asked;
  }
  for (const raw of textsNewestFirst) {
    // a service title or the address the patient repeats is the clinic's text, not the patient's language
    const t = withoutStoredNames(raw, storedNames);
    const l = detectLanguageAgent(t, { wordsOnly: dataLike(t) });
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

// "I am afraid of pain" is a fear, not a symptom: the fear word with the word of pain right after it is taken out before the topics are read. A real symptom in the same message
// ("боюся, у мене болить зуб") stays and goes to a person as before.
const FEAR_OF_PAIN = /(?<![\p{L}])(?:бо[юя]\p{L}*|страшно|страх\p{L}*|боязн\p{L}*|лякає\p{L}*|пугает\p{L}*|переживаю)[\s,]+(?:(?:що|что|чи|ли|буде|будет|буду|мені|мне|дуже|очень)\s+)*(?:болю|болі|боли|біль|боль|больно|боляче)(?![\p{L}])/giu;
export function incomingHandoff(text: string, pricesKnown = false, opts: { fearOfPain?: boolean } = {}): HandoffReason | null {
  // only the agent path reads "afraid of pain" as a fear (the working bot keeps its behaviour)
  if (opts.fearOfPain) text = text.replace(FEAR_OF_PAIN, ' ');
  for (const t of TOPICS) {
    if (!t.re.test(text)) continue;
    if (t.reason === 'price' && pricesKnown && !PRICE_ONLY_CASH.test(text)) continue;
    return t.reason;
  }
  return null;
}

// A sudden health problem WITHOUT a question about medicines, a diagnosis, prices or a complaint: the AI does not answer it, and it is not
// simply handed over either: the code offers the nearest time and marks the request as urgent (see ChatAssistantService)
export function isUrgentSymptom(text: string, pricesKnown = false, opts: { fearOfPain?: boolean } = {}): boolean {
  if (incomingHandoff(text, pricesKnown, opts) !== 'medical' || MEDICATION.test(text)) return false;
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
// opts.notice: the words of that notice (the agent passes its own, see AGENT_PRICE_NOTICE); the default is the working bot's PRICE_NOTICE.
export function composePriceReply(parts: { intro: string; after: string | null; ids: unknown }, items: PriceItem[], lang: 'uk' | 'ru', opts: { noticeOnlyForKnown?: boolean; tidy?: boolean; notice?: Record<'uk' | 'ru', string> } = {}): { reply: string; dropped: number } | { problem: string } {
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
  let intro = stripNotice(parts.intro);
  let after = parts.after ? stripNotice(parts.after) : '';
  let block = lines.length ? `${lines.join('\n')}${priced ? `\n\n${(opts.notice ?? PRICE_NOTICE)[lang]}` : ''}` : '';
  if (opts.tidy) {
    // the agent's text: the preliminary price is never called exact, a service type is not repeated before its own title, and a lead-in stays with its price lines
    const titles = items.map((x) => x.title);
    intro = dropTypePrefix(priced ? softenExact(intro) : intro, titles);
    after = dropTypePrefix(priced ? softenExact(after) : after, titles);
    if (block) {
      const moved = takeLeadIn(intro);
      intro = moved.rest;
      if (moved.lead) block = `${moved.lead}\n${block}`;
    } else {
      intro = intro.replace(/:\s*$/, '.');
    }
  }
  return { reply: [intro, block, after].filter((x) => x.trim()).join('\n\n'), dropped };
}

// ---- the tidy-up of the agent's text around the price lines (see composePriceReply, option tidy) ----

// A sentence that calls the (preliminary) price exact, final or guaranteed. A sentence that only says the administrator will clarify the exact sum is left alone.
const EXACT_PRICE = /(?<![\p{L}])(?:точн\p{L}*|остаточн\p{L}*|окончательн\p{L}*|фіксован\p{L}*|фиксированн\p{L}*|гарантован\p{L}*|гарантированн\p{L}*)\s+(?=(?:вартіст|ціну|ціна|ціни|ціною|сум[ауи]|суми|стоимост|цену|цена|цены|ценой|сумм)\p{L}*)/giu;
const EXACT_PRICE_TEST = new RegExp(EXACT_PRICE.source, 'iu');
const DEFERS = /(уточн|дізна|узна|підкаж|подскаж|скаж[ея]|сообщ|повідом|розрах|рассчита)/i;
export function softenExact(text: string): string {
  return text
    .split(/\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?…])\s+/)
        .map((sentence) => {
          if (!EXACT_PRICE_TEST.test(sentence) || DEFERS.test(sentence)) return sentence;
          const out = sentence.replace(EXACT_PRICE, '');
          return out.replace(/^(\s*)(\p{Ll})/u, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
        })
        .join(' '),
    )
    .join('\n');
}

// "Консультація «Тестова консультація»": the type word repeats a word of the title, so it is dropped (the title itself, quotes included, is never changed)
export function dropTypePrefix(text: string, titles: string[]): string {
  const stem = (w: string) => w.toLowerCase().slice(0, 6);
  return text.replace(/(?<![\p{L}])(\p{L}{5,})\s+(«([^»\n]{2,80})»)/gu, (m, word: string, quoted: string, title: string) => {
    if (!titles.includes(title)) return m;
    if (!title.split(/\s+/).some((w) => w.length >= 5 && stem(w) === stem(word))) return m;
    return quoted;
  });
}

// A lead-in to the price lines ("Вартість консультації:", "Консультація коштує:"): the last line of the text that ends with a colon and speaks about the price, wherever it
// stands. It is taken out of the text to stand right above the price lines (the last sentence of that line only; the sentences before it stay in the text).
const PRICE_WORD = /(вартіст|ціна|ціну|ціни|кошт|стоимост|цена|цену|цены|стоит)/i;
export function takeLeadIn(text: string): { rest: string; lead: string } {
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !(/:\s*$/.test(lines[i]) && PRICE_WORD.test(lines[i]))) i--;
  if (i < 0) return { rest: text, lead: '' };
  const line = lines[i].trimEnd();
  const cut = Math.max(line.lastIndexOf('. '), line.lastIndexOf('! '), line.lastIndexOf('? '), line.lastIndexOf('… '));
  const lead = cut >= 0 ? line.slice(cut + 2).trim() : line.trim();
  if (!PRICE_WORD.test(lead)) return { rest: text, lead: '' };
  const head = cut >= 0 ? line.slice(0, cut + 1).trim() : '';
  const rest = [...lines.slice(0, i), head, ...lines.slice(i + 1)].filter((x) => x.trim());
  return { rest: rest.join('\n\n'), lead };
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
// The agent's notice: the price is provisional and the total depends on what is actually done. It promises nothing about anyone naming an exact or final sum (the clinic's approved
// information does not say that an administrator can). The working bot keeps PRICE_NOTICE.
export const AGENT_PRICE_NOTICE: Record<'uk' | 'ru', string> = {
  uk: 'Вартість попередня. Підсумкова сума залежить від фактичного обсягу послуг.',
  ru: 'Стоимость предварительная. Итоговая сумма зависит от фактического объёма услуг.',
};
const AGENT_NOTICE_ANY = /(?:Вартість попередня|Стоимость предварительная)\.\s*(?:Підсумкова сума залежить|Итоговая сумма зависит)[^\n.]*\.?/gi;
// The notice the model wrote itself, in either language, up to "the administrator will clarify"
const NOTICE_ANY = /(?:Вартість попередня|Попередня вартість|Стоимость предварительная|Предварительная стоимость)[^\n]*?(?:уточнить\s+адміністратор|уточнит\s+администратор)\w*\.?/gi;
// Removes a notice about the preliminary cost that the model wrote itself (the code adds its own, in the right language)
export function stripNotice(text: string): string {
  return text.replace(NOTICE_ANY, '').replace(AGENT_NOTICE_ANY, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

// A DETERMINISTIC read of the patient's last message for an objection, whatever the model says about it: a price concern ("дорого", "слишком дорого", "не по кишені"),
// fear ("боюся", "страшно", "нервую"), hesitation ("подумаю", "не впевнений", "не готова") or a refusal ("не хочу записуватися", "не треба", "передумав").
// It is used only to HOLD BACK the code's own nudges (the soft offer, the price lines, a proposed time); it never closes a dialogue or answers by itself. Narrow on purpose:
// a neutral price question ("скільки коштує", "яка ціна") is not an objection, "недорого" and "дорогу" (a road) are not, and a message that asks to book ("хочу записатися",
// "запишіть") is not held back by a doubt in the same message, except an outright refusal. This is a list of Ukrainian and Russian phrases, not a proof.
export type Objection = 'price' | 'afford' | 'fear' | 'distrust' | 'hesitation' | 'refusal';
const L = '(?<![\\p{L}])';
const OBJ_REFUSAL = new RegExp(
  `${L}(?:не\\s+хочу\\s+(?:записув\\S*|записыв\\S*|записат\\S*|приход\\S*|приймат\\S*|ходит\\S*|ходити|лікув\\S*|лечит\\S*)|не\\s+буду\\s+(?:записув\\S*|записыв\\S*|записат\\S*)|не\\s+збираюс\\S*|не\\s+собираюс\\S*|відмовляюс\\S*|отказываюс\\S*|передумав\\S*|передумал\\S*|перехотів\\S*|расхотел\\S*)|^\\s*(?:ні|нет)?[,.!\\s]*(?:дякую|спасибо)?[,.!\\s]*не\\s+(?:треба|потрібно|надо|нужно)(?:[,.!\\s]*(?:дякую|спасибо))?[.!\\s]*$`,
  'iu',
);
const OBJ_PRICE = new RegExp(
  `${L}(?:дорого(?![\\p{L}])|дороговат\\S*|дорогуват\\S*|(?:занадто|надто|дуже|слишком|очень|страшенно)\\s+дорог\\S*|дорог(?:а|і|ий|ое|ая|ие|ое)\\s+(?:ціна|ціни|цін|лікування|послуг\\S*|цена|цены|цен|лечение|услуг\\S*)|(?:висок\\S*|высок\\S*)\\s+(?:ціна|ціни|цін\\S*|вартість|цена|цены|цен\\S*|стоимость)|не\\s+по\\s+(?:кишені|карману)|не\\s+по\\s+гаманц\\S*)`,
  'iu',
);
// the patient says they cannot afford the care now: no persuasion at all (a pause, see closesDialogue)
const OBJ_AFFORD = new RegExp(`${L}(?:не\\s+потягн\\S*|не\\s+потян\\S*|нема(?:є)?\\s+(?:зараз\\s+)?(?:грошей|коштів)|нет\\s+(?:сейчас\\s+)?денег|не\\s+можу\\s+собі\\s+дозволити|не\\s+могу\\s+себе\\s+позволить)`, 'iu');
// a bad earlier experience or distrust (the patient describes it; the model reads the rest)
const OBJ_DISTRUST = new RegExp(`${L}(?:(?:неприємн\\S*|поган\\S*|негатив\\S*|жахлив\\S*)\\s+досвід|(?:неприятн\\S*|плох\\S*|негатив\\S*|ужасн\\S*)\\s+опыт|не\\s+довіряю|не\\s+доверяю|обман(?:ули|ув|ули)|обманул\\S*)`, 'iu');
const OBJ_FEAR = new RegExp(`${L}(?:бою(?:ся|сь)|боятись|боїмось|страшно|лякає|лякаюсь|пугает|пугаюсь|боязно|нервую|нервничаю|хвилююсь|хвилююся|переживаю|страх(?![\\p{L}])|страху)`, 'iu');
const OBJ_HESITATION = new RegExp(
  `${L}(?:подумаю|подумаємо|подумаем|ще\\s+подумаю|еще\\s+подумаю|не\\s+впевнен\\S*|не\\s+уверен\\S*|сумніваюс\\S*|сомневаюс\\S*|ще\\s+не\\s+вирішил\\S*|еще\\s+не\\s+решил\\S*|не\\s+готов\\S*|не\\s+знаю[,\\s]+чи|не\\s+знаю[,\\s]+стоит\\s+ли|напишу\\s+(?:пізніше|позже)|зв['’]яжусь\\s+(?:пізніше|пізніш)|позвоню\\s+позже|порадит\\S*|порадь\\S*|посовет\\S*|не\\s+зараз|не\\s+сейчас)`,
  'iu',
);
// a pause rather than an uncertainty: "I will think", "I need to ask someone", "not now" (treated like a closing; an uncertainty ("I am not sure") is answered, not closed)
const PAUSE = new RegExp(`${L}(?:подума\\S*|порадит\\S*|порадь\\S*|посовет\\S*|не\\s+зараз|не\\s+сейчас|напишу\\s+(?:пізніше|позже)|зв['’]яжусь\\s+(?:пізніше|пізніш)|позвоню\\s+позже|(?:поки|пока)\\s+не\\s+готов\\S*|не\\s+готов\\S*)`, 'iu');
// the patient asks for times (not a plain request to book, see WANTS_BOOKING)
const ASKS_TIMES = new RegExp(`${L}(?:(?:покаж\\S*|підбер\\S*|подбер\\S*)\\s+(?:\\S+\\s+){0,2}(?:час\\S*|вікн\\S*|врем\\S*|окн\\S*|окошк\\S*)|(?:є|есть|які\\s+є|какие\\s+есть)\\s+(?:\\S+\\s+){0,2}(?:вільн\\S*|свободн\\S*))`, 'iu');
// a request to book, in the first person or as a request (a bare mention of "запис" in a doubt does not count)
const WANTS_BOOKING = new RegExp(`${L}(?:(?:хочу|хотів|хотіла|хотела|хотел|бажаю|можна|можно|давайте|прошу)\\s+(?:\\S+\\s+){0,2}(?:записат\\S*|записуват\\S*|записаться|на\\s+прийом|на\\s+приём)|запишіть|запишите|запиши(?:ть)?\\s+мене|запиши\\s+меня)`, 'iu');
export const wantsBooking = (text: string): boolean => WANTS_BOOKING.test(text.slice(0, 400));

// ---- stage 2: what each kind of objection allows (the decision rules live here, in code, not only in the prompt) ----

// A reading of the patient's message as a signal that THIS message moves toward a booking (a request to book, to see times, a wish about the day or time, "these do not suit").
// Used to tell information-seeking and "okay/thanks" from booking intent: times are looked up only with such a signal, or after an offer the patient accepts (see the draft service).
const BOOK_SIGNAL = new RegExp(`${L}(?:запиш\\S*|записат\\S*|записув\\S*|записыв\\S*|записаться|на\\s+прийом|на\\s+приём|(?:хочу|хотів|хотіла|хотела|хотел|можна|можно)\\s+на\\s+\\p{L}+)`, 'iu');
// An EXPLICIT signal that needs no context: a request to book or to see times. (A wish about the day or time of day, and "these do not suit", are NOT explicit: see slotRejection and
// the draft service, where they count only after the agent has offered times or asked about the time.)
export const bookingSignal = (text: string): boolean => WANTS_BOOKING.test(text) || ASKS_TIMES.test(text) || BOOK_SIGNAL.test(text);
const SLOT_REJECT = new RegExp(`${L}(?:не\\s+підходить|не\\s+підходять|не\\s+подходит|не\\s+подходят|не\\s+зручно|не\\s+удобно|інший\\s+час|другое\\s+время|інші\\s+час\\S*|другие\\s+врем\\S*)`, 'iu');
export const slotRejection = (text: string): boolean => SLOT_REJECT.test(text.slice(0, 400));
// An explicit factual question or request for information (address, phone, hours, duration, contents, "tell me ..."): used to keep the answers when the dialogue is closed
const FACT_ASK = /(\?|графік|график|адрес|телефон|режим\s+роботи|режим\s+работы|(?<![\p{L}])де(?![\p{L}])|(?<![\p{L}])где(?![\p{L}])|скільки|сколько|(?<![\p{L}])коли(?![\p{L}])|(?<![\p{L}])когда(?![\p{L}])|працю|работа|тривал|длит|що\s+входить|что\s+входит|скажіть|скажите|підкажіть|подскажите)/iu;
export const asksFact = (text: string): boolean => FACT_ASK.test(text.slice(0, 400));
// a short acceptance of what the agent has just offered ("так", "добре", "підберіть")
const ACCEPT = new RegExp(`^\\s*(?:так|да|ага|угу|давайте|добре|гаразд|хорошо|ок|окей|звісно|звичайно|конечно|будь\\s+ласка|пожалуйста|підбер\\S*|подбер\\S*)(?![\\p{L}])`, 'iu');
export const acceptsOffer = (text: string): boolean => ACCEPT.test(text);

// A refusal, a pause ("I will think", "I need to ask someone", "not now") and "I cannot afford it now" close the exchange: a short acknowledgement and nothing else
export const closesDialogue = (kind: Objection | null, text: string): boolean => kind === 'refusal' || kind === 'afford' || (kind === 'hesitation' && PAUSE.test(text.slice(0, 400)));

// Has the patient already said what the fear is about? A bare "страшно" / "боюсь стоматологів" has not (the words of the feeling and of "to the doctor" are not the reason); anything more has.
const FILLER = new Set(['я', 'мені', 'мне', 'дуже', 'очень', 'просто', 'трохи', 'немного', 'заздалегідь', 'заранее', 'йти', 'іти', 'ходити', 'идти', 'ходить', 'до', 'к', 'лікаря', 'лікарів', 'врача', 'врачей', 'стоматолога', 'стоматологів', 'стоматологу', 'стоматологам', 'стоматологи', 'зубного', 'зубному', 'лікар', 'лікарі', 'врач', 'врачу', 'врачам', 'лікарю', 'лікарям', 'зубному', 'це', 'это', 'але', 'но', 'і', 'и', 'вже', 'уже', 'знову', 'снова', 'щось', 'что', 'то', 'чого', 'чего', 'взагалі', 'вообще', 'ось', 'ну', 'так', 'та']);
const FEELING = /^(?:бо[юя]|страш|нервн|нерву|нервич|хвилю|переж|лякає|лякаю|пуга|боязн|страх)/;
export function concernExplained(text: string, kind: Objection): boolean {
  const words = (text.toLowerCase().match(/[\p{L}]+/gu) ?? []).filter((w) => !FILLER.has(w) && !FEELING.test(w));
  // a described earlier experience is "explained" once it has some length; a fear once a reason or an object is named
  return kind === 'distrust' ? (text.match(/[\p{L}]+/gu) ?? []).length >= 9 : words.length >= 1;
}
// One useful clarification is allowed for a fear or a distrust that is not yet explained (never for a price concern, a pause, a refusal or "cannot afford")
export const mayClarify = (kind: Objection | null, text: string): boolean => (kind === 'fear' || kind === 'distrust') && !concernExplained(text, kind);
export function objectionOf(text: string): Objection | null {
  const t = text.slice(0, 400);
  if (OBJ_REFUSAL.test(t)) return 'refusal';
  if (WANTS_BOOKING.test(t) || ASKS_TIMES.test(t)) return null;
  if (OBJ_AFFORD.test(t)) return 'afford';
  if (OBJ_PRICE.test(t)) return 'price';
  if (OBJ_DISTRUST.test(t)) return 'distrust';
  if (OBJ_FEAR.test(t)) return 'fear';
  if (OBJ_HESITATION.test(t)) return 'hesitation';
  return null;
}
// An EXPLICIT request for the price, as a question or a request ("скільки коштує", "яка точна ціна", "уточніть вартість"): the bare noun inside a complaint ("занадто висока ціна")
// is not one. An objection that also contains this still gets its price answer.
const PRICE_ASK = new RegExp(
  `${L}(?:скільки\\s+(?:це\\s+|воно\\s+|вона\\s+|саме\\s+|точно\\s+)?(?:кошт|буде\\s+кошт)|сколько\\s+(?:это\\s+|оно\\s+|именно\\s+|точно\\s+)?(?:стоит|будет\\s+стоить)|яка\\s+(?:точна\\s+|остаточна\\s+|саме\\s+)?(?:ціна|вартість)|какая\\s+(?:точная\\s+|окончательная\\s+|именно\\s+)?(?:цена|стоимость)|почім|по\\s+чому|по\\s+чём|(?:назвіть|уточніть|підкажіть|скажіть)\\s+(?:\\S+\\s+){0,2}(?:ціну|вартість)|(?:назовите|уточните|подскажите|скажите)\\s+(?:\\S+\\s+){0,2}(?:цену|стоимость)|скільки\\s+точно|сколько\\s+точно)`,
  'iu',
);
export const priceAsked = (text: string): boolean => PRICE_ASK.test(text);

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

// The patient says they do not know which service they need, or asks where to start (the code reads it only to choose the SAFE path: the model never picks a service from a described need)
const UNCLEAR_NEED = /(?<![\p{L}])(?:не\s+знаю[,\s]+(?:яка|яку|який|що|з\s+чого|на\s+що|куди|какая|какую|какой|что|с\s+чего|на\s+что|куда)|з\s+чого\s+(?:почати|розпочати)|с\s+чего\s+(?:начать|начинать)|що\s+(?:мені\s+)?(?:обрати|вибрати)|что\s+(?:мне\s+)?(?:выбрать|выбирать)|яку\s+послугу\s+(?:обрати|вибрати|мені)|какую\s+услугу\s+(?:выбрать|мне)|яка\s+послуга\s+(?:мені\s+)?(?:потрібна|підійде)|какая\s+услуга\s+(?:мне\s+)?(?:нужна|подойдет|подойдёт))/iu;
export const unclearNeed = (text: string): boolean => UNCLEAR_NEED.test(text.slice(0, 400));
// An approved description that NAMES its service as the first step ("для першого візиту", "якщо не знаєте, з чого почати"): the only thing the code treats as routing information
const FIRST_STEP = /(?<![\p{L}])(?:перш(?:ий|ого|им)\s+(?:крок|візит|візиту|прийом)|для\s+першого\s+візиту|з\s+чого\s+почати|якщо\s+(?:ви\s+)?не\s+знаєте|первый\s+(?:шаг|визит)|для\s+первого\s+визита|с\s+чего\s+начать|если\s+(?:вы\s+)?не\s+знаете)(?![\p{L}])/iu;
export const namesFirstStep = (description: string): boolean => FIRST_STEP.test(description);

// ---- clinic comparison and explicit "price only" requests (the code reads them only to choose the safe path; the words of the answer come from the model and the approved facts) ----

// "Why should I choose you", "how are you better than the others", "I am comparing clinics"
const COMPARE = /(?<![\p{L}])(?:чому\s+(?:мені\s+)?(?:обрати|вибрати|йти|ходити)\s+(?:до\s+)?(?:вашу|вас|саме\s+вас|вашої)|чому\s+саме\s+(?:ви|ваша|до\s+вас)|чому\s+до\s+вас|чим\s+ви\s+(?:кращі|краще|відрізня\p{L}*)|чому\s+ви\s+кращі|чим\s+ваша\s+клініка|чем\s+вы\s+(?:лучше|отличаетесь)|чем\s+ваша\s+клиника|почему\s+(?:мне\s+)?(?:выбрать|именно)\s+(?:вас|вашу|вы)|почему\s+к\s+вам|порівнюю\s+(?:кілька\s+)?клінік\p{L}*|порівнюємо\s+(?:кілька\s+)?клінік\p{L}*|вибираю\s+(?:між|клінік)\p{L}*|сравниваю\s+(?:несколько\s+)?клиник\p{L}*|выбираю\s+(?:между|клиник)\p{L}*)/iu;
export const comparisonAsk = (text: string): boolean => COMPARE.test(text.slice(0, 400));

// A clear request for the price only, without a booking ("лише ціна", "тільки вартість, записуватися поки не хочу", "мне только цену, без записи")
const PRICE_NOUN = /(?<![\p{L}])(?:ціна|ціну|ціни|цін|вартість|вартості|цена|цену|цены|стоимость|стоимости)(?![\p{L}])/iu;
const ONLY_PRICE = /(?<![\p{L}])(?:лише|тільки|только)\s+(?:\p{L}+\s+){0,1}(?:ціна|ціну|ціни|вартість|вартості|цена|цену|цены|стоимость|стоимости)(?![\p{L}])|цікавить\s+(?:мене\s+)?(?:лише|тільки)|интересует\s+(?:меня\s+)?только/iu;
const DECLINES_BOOKING = /(?<![\p{L}])(?:без\s+запису|без\s+записи|записуватися\s+(?:поки\s+)?не\s+хочу|записываться\s+(?:пока\s+)?не\s+хочу|(?:поки|пока)\s+не\s+(?:записуватимусь|записуюсь|записываюсь|запишусь)|не\s+(?:хочу|збираюсь|собираюсь)\s+(?:поки\s+)?(?:записув\p{L}*|записыв\p{L}*|записат\p{L}*))/iu;
const POSITIVE_BOOKING = /(?<![\p{L}])(?:запишіть|запишите|запиши(?:ть)?\s+мене|запиши\s+меня|підберіть|подберите)(?![\p{L}])/iu;
export const priceOnlyRequest = (text: string): boolean => {
  const t = text.slice(0, 400);
  return (ONLY_PRICE.test(t) || DECLINES_BOOKING.test(t)) && PRICE_NOUN.test(t) && !POSITIVE_BOOKING.test(t);
};
// The patient asks to book now (a negated "не хочу записуватися" is not such a request)
export const wantsToBookNow = (text: string): boolean => {
  const t = text.slice(0, 400);
  return (WANTS_BOOKING.test(t) || ASKS_TIMES.test(t) || POSITIVE_BOOKING.test(t)) && !DECLINES_BOOKING.test(t);
};
// Does the explicit "price only, no booking" preference still stand? The patient's messages are read from the newest back and the NEWEST intent wins: a price-only request keeps the
// preference, an explicit request to book (or a chosen time) ends it. A short "yes" ends it only when it answers the agent's own offer to find a time (isOffer reads the agent's
// message before it); factual questions in between change nothing. msgs: oldest first, the current message included.
export function priceOnlyStanding(msgs: { direction: string; text: string }[], isOffer: (agentText: string) => boolean): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.direction !== 'IN') continue;
    if (priceOnlyRequest(m.text)) return true;
    if (wantsToBookNow(m.text) || m.text.startsWith('Обрав час:')) return false;
    if (acceptsOffer(m.text)) {
      const before = msgs.slice(0, i).reverse().find((x) => x.direction === 'OUT');
      if (before && isOffer(before.text)) return false;
    }
  }
  return false;
}
// "Is this the final amount?", "will the price change?": a question about the STATUS of a price already given, and nothing else in the message (a request for the price itself,
// "яка остаточна ціна?", is a price question and keeps its own path)
const FINAL_WORD = '(?:остаточн\\p{L}*|окончательн\\p{L}*|фінальн\\p{L}*|финальн\\p{L}*|підсумков\\p{L}*|итогов\\p{L}*|точн\\p{L}*|фіксован\\p{L}*|фиксированн\\p{L}*)';
const SUM_WORD = '(?:сум[ауиі]|сумм[ауы]|ціна|ціну|ціни|цена|цену|цены|вартість|вартості|стоимость|стоимости)';
const FINAL_AMOUNT_Q = new RegExp(
  `(?<![\\p{L}])(?:${FINAL_WORD}\\s+(?:\\p{L}+\\s+)?${SUM_WORD}|${SUM_WORD}\\s+(?:\\p{L}+\\s+)?${FINAL_WORD}|(?:це|это)\\s+(?:вже\\s+|уже\\s+)?(?:остаточно|окончательно)|${SUM_WORD}\\s+(?:\\p{L}+\\s+)?(?:не\\s+)?(?:зміниться|изменится|може\\s+змінитися|может\\s+измениться))(?![\\p{L}])`,
  'iu',
);
export const finalAmountQuestion = (text: string): boolean => {
  const t = text.trim();
  return t.length <= 120 && (t.match(/\?/g) ?? []).length <= 1 && FINAL_AMOUNT_Q.test(t) && !PRICE_ASK.test(t) && !bookingSignal(t);
};
