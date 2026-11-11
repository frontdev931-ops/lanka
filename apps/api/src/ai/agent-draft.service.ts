import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { clinicDate, clinicHm } from '../common/clinic-time';
import { readWorkHours } from '../clinic/work-hours';
import { PrismaService } from '../prisma/prisma.service';
import { CabinetBookingService } from '../booking/cabinet-booking.service';
import { KbItem } from '@prisma/client';
import { CabinetWish, ChoiceContext, Decision as DoctorDecision, DoctorChoiceService, RequestPatch, isNo, isYes, matchDoctors, speaksOfDoctor } from '../booking/doctor-choice.service';
import { KbService } from '../kb/kb.service';
import { AiService } from './ai.service';
import { AGENT_SYSTEM } from './agent-prompt';
import { decisionSchema } from './agent-schema';
import { ChatAssistantService, SlotOption } from './chat-assistant.service';
import { conversationLanguage } from './conversation-language';
import { contactReply, contactsOnly, formatHours, inventedContact } from './contacts';
import { Decision, DecisionContext, NextAction, resolveDecision } from './decision-contract';
import { AGENT_PRICE_NOTICE, languageOnlyRequest, HandoffReason, Objection, comparisonAsk, priceOnlyRequest, priceOnlyStanding, finalAmountQuestion, softenExact, wantsToBookNow, detectLanguageAgent, withoutStoredNames, namesFirstStep, unclearNeed, acceptsOffer, asksFact, bookingSignal, slotRejection, claimMatch, closesDialogue, mayClarify, composePriceReply, detectLanguage, handoffText, incomingHandoff, isPriceOnlyQuestion, isPriceQuestion, isUrgentSymptom, languageOf, objectionOf, priceAsked, stripNotice, timesOutsideWindows, wantsBooking, withoutTimeSolicitation } from './guardrails';
import { actionPromise, announcesPrice, mechanismMention, priceStatusDenied, superiorityClaim } from './agent-checks';
import { bookingStatusOf } from './booking-status';
import { autoServices, configuredAutoServiceIds } from '../automations/agent-auto-gate';
import { contactsOf, scrubMessages } from './contact-mask';
import { ANY_TIME, TimePreference, hm, offeredBefore, parseTimePreference, preferencePhrase } from './time-preference';

const HISTORY = 8;
const MAX_CLARIFY = 2;
// The generation limit of the agent's calls (the working bot keeps its own). Adaptive thinking spends part of it before the answer.
export const AGENT_MAX_TOKENS = 1500;
// How many days ahead the free times are looked for (the same window the schedule reads use); the words about "no windows" name exactly this range
export const SEARCH_DAYS = 7;

const hmMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const DAY_NAMES: Record<string, string> = { mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб', sun: 'нд' };
const todayText = () => {
  const [y, m, d] = clinicDate(new Date()).split('-').map(Number);
  const wd = DAY_NAMES[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}, зараз ${clinicHm(new Date())} за часом клініки`;
};

type Lang = 'uk' | 'ru';
// The words of the code in a draft. A hand-over is only OFFERED here: nothing says it already happened.
const TIME_LINE: Record<Lang, string> = { uk: 'Оберіть, будь ласка, зручний час із запропонованих нижче.', ru: 'Выберите, пожалуйста, удобное время из предложенных ниже.' };
// The words about the wish and about "no windows" are written by the code from checked data: the wish as the client said it, the range as it was searched
const TIME_LINE_PREF = (lang: Lang, phrase: string) => (lang === 'ru' ? `Учитываем ваше пожелание (${phrase}). Выберите, пожалуйста, удобное время из предложенных ниже.` : `Враховуємо ваше побажання (${phrase}). Оберіть, будь ласка, зручний час із запропонованих нижче.`);
// No window: said honestly (never "here are the options" when there are none), and a hand-over is only OFFERED as a question: nothing is promised that no action backs
const NO_WINDOWS = (lang: Lang, kind: 'preference' | 'nothingNew', phrase: string | null, days: number) =>
  lang === 'ru'
    ? kind === 'preference'
      ? `На ближайшие ${days} дней свободных окон ${phrase ?? 'на это время'} не нашлось. Передать ваш запрос администратору, чтобы он подобрал другое время?`
      : `На ближайшие ${days} дней других свободных окон, кроме уже предложенных, не нашлось. Передать ваш запрос администратору, чтобы он подобрал время?`
    : kind === 'preference'
      ? `На найближчі ${days} днів вільних вікон ${phrase ?? 'на цей час'} не знайшлося. Передати ваш запит адміністратору, щоб він підібрав інший час?`
      : `На найближчі ${days} днів інших вільних вікон, крім уже запропонованих, не знайшлося. Передати ваш запит адміністратору, щоб він підібрав час?`;
// The online booking of this service is not available: only that is said (never that the clinic does not provide the service, never "yes, you can book"), and the
// hand-over is an offer in the draft and a done thing in the text that goes out together with the hand-over request
const ONLINE_OFF = (lang: Lang, title: string | null) =>
  lang === 'ru' ? `Онлайн-запись${title ? ` на «${title}»` : ''} пока недоступна.` : `Онлайн-запис${title ? ` на «${title}»` : ''} наразі недоступний.`;
const ONLINE_OFF_OFFER = (lang: Lang) => (lang === 'ru' ? 'Если хотите, передадим ваш запрос администратору: он поможет с записью.' : 'Якщо хочете, передамо ваш запит адміністратору: він допоможе із записом.');
const ONLINE_OFF_DONE = (lang: Lang) => (lang === 'ru' ? 'Мы передали ваш запрос администратору клиники: он поможет с записью.' : 'Ми передали ваш запит адміністратору клініки: він допоможе із записом.');
// One soft next step after a direct answer about the price of a service that can be booked online (the code adds it, once per dialogue, never after a decline,
// during a booking, after a hand-over or after a visit)
export const SOFT_OFFER: Record<Lang, string> = { uk: 'Підібрати зручний час?', ru: 'Подобрать удобное время?' };
// The closing after a decline or "I will think": thanks, nothing else (no question, no offer to book). The model's own closing is used only when it keeps to that.
export const CLOSE_TEXT: Record<Lang, string> = { uk: 'Дякуємо за відповідь! Якщо з’являться запитання, пишіть нам.', ru: 'Спасибо за ответ! Если появятся вопросы, пишите нам.' };
const CLARIFY_SERVICE = (lang: Lang, names: string[]) =>
  lang === 'ru'
    ? `На какую услугу вы хотели бы записаться?${names.length ? ` Например: ${names.join(', ')}.` : ''}`
    : `На яку послугу ви хотіли б записатися?${names.length ? ` Наприклад: ${names.join(', ')}.` : ''}`;
// Stage 3 texts of the code: the question about a missing preference after rejected times, an unclear or distant date, the first step named by the clinic's own description
export const ASK_PREFERENCE: Record<Lang, string> = { uk: 'Підкажіть, будь ласка, коли вам було б зручно: який день чи час доби?', ru: 'Подскажите, пожалуйста, когда вам было бы удобно: какой день или время суток?' };
const DATE_UNCLEAR = (lang: Lang, kind: 'same_weekday' | 'past', other: string) =>
  lang === 'ru'
    ? kind === 'same_weekday' ? `Уточните, пожалуйста, про какую дату речь: сегодня или ${other}?` : 'Эта дата уже прошла. Подскажите, пожалуйста, другую дату.'
    : kind === 'same_weekday' ? `Уточніть, будь ласка, про яку дату йдеться: сьогодні чи ${other}?` : 'Ця дата вже минула. Підкажіть, будь ласка, іншу дату.';
const DATE_FAR = (lang: Lang, date: string, days: number, until: string) =>
  lang === 'ru'
    ? `Мы проверяем свободное время только на ближайшие ${days} дней (до ${until}), поэтому на ${date} посмотреть не можем. Передать ваш запрос администратору или назвать другой день?`
    : `Ми перевіряємо вільний час лише на найближчі ${days} днів (до ${until}), тож на ${date} подивитися не можемо. Передати ваш запит адміністратору чи назвати інший день?`;
// The first step the clinic's own approved description names, in plain words: "Start with «X»." plus what the description says about the service. The sentences that only say "this is the
// first step" are left out (the opening sentence already says it, nothing is told twice); nothing is added, nothing is claimed about suitability or benefits.
const FIRST_STEP_LINE = (lang: Lang, title: string, description: string) => {
  const rest = sentencesUpTo(description.replace(/\s*\n\s*/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter((x) => x.trim() && !namesFirstStep(x)).join(' '), 240);
  return `${lang === 'ru' ? `Начать можно с «${title}».` : `Почати можна з «${title}».`}${rest ? ` ${rest}` : ''}`;
};
// After ONE service clarification the patient still cannot name a service: the code offers the administrator's help as a QUESTION (nothing is handed over until the patient agrees)
export const HELP_OFFER: Record<Lang, string> = {
  uk: 'Якщо складно визначитися з послугою, з цим може допомогти адміністратор клініки. Передати ваше звернення?',
  ru: 'Если сложно определиться с услугой, с этим может помочь администратор клиники. Передать ваше обращение?',
};
// A comparison question whose criterion is known but the facts cannot answer it: an OFFER of the administrator's help, as a question (nothing is handed over until the patient agrees).
// It is never combined with the question about what matters to the patient: that one is asked only when the criterion is unknown.
export const COMPARE_HELP: Record<Lang, string> = {
  uk: 'Це краще уточнити в адміністратора клініки. Передати ваше звернення?',
  ru: 'Это лучше уточнить у администратора клиники. Передать ваше обращение?',
};
// "Price only", and the service is not known: the one question
export const WHICH_SERVICE_PRICE: Record<Lang, string> = { uk: 'Про яку послугу вам потрібна вартість?', ru: 'О какой услуге вам нужна стоимость?' };
// A message that only asks for a language: a short acknowledgement in that language (the pending question, when there is one, is said again after it)
export const LANGUAGE_ACK: Record<Lang, string> = { uk: 'Добре, продовжимо українською.', ru: 'Хорошо, продолжим на русском.' };
const TIMES_ABOVE: Record<Lang, string> = { uk: 'Час можна обрати із запропонованих вище.', ru: 'Время можно выбрать из предложенных выше.' };
// "Is this the final amount?" after a price of the price list: the status as the code knows it. Nothing is promised (no guaranteed total, no named extra fee or procedure).
export const FINAL_AMOUNT: Record<Lang, string> = {
  uk: 'Це попередня вартість за прайсом. Підсумкова сума залежить від фактичного обсягу послуг.',
  ru: 'Это предварительная стоимость по прайсу. Итоговая сумма зависит от фактического объёма услуг.',
};
// How the agent's price lines are rendered by the shared renderer: the notice only next to a named sum, the tidy-up of the lead-in, and the agent's own words of the notice
const AGENT_PRICE_OPTS = { noticeOnlyForKnown: true, tidy: true, notice: AGENT_PRICE_NOTICE };
// How far back the standing "price only" preference is looked up (the dialogue's own messages, texts only; nothing of it goes to the model). A BOUNDED lookup, not an indefinite
// memory: a request older than this many messages or days no longer holds.
const PREFERENCE_LOOKBACK = 200;
const PREFERENCE_DAYS = 30;
// The patient's wish taken into account, above a doctor's times (the first sentence of the cabinets' line TIME_LINE_PREF; the doctor's own line asks to choose)
const PREF_NOTE = (lang: Lang, phrase: string) => (lang === 'ru' ? `Учитываем ваше пожелание (${phrase}).` : `Враховуємо ваше побажання (${phrase}).`);
const dm = (date: string) => `${date.slice(8)}.${date.slice(5, 7)}`;
// A closing carries no question and no talk about booking: such sentences of the model's closing are dropped (a structural rule, not a list of refusals)
const BOOKING_TALK = /(запис|запиш|прийом|прием|візит|визит|підібра|подобра|підбер|подбер|вільн|свободн|вікн|окошк|окн)/i;
export function closingOnly(text: string): string {
  return text
    .split(/\n+/)
    .map((para) => para.split(/(?<=[.!?…])\s+/).filter((sentence) => !sentence.includes('?') && !BOOKING_TALK.test(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
// The model's text without its own questions and without sentences that name a service that cannot be offered (structural: a '?' or an exact title); lead-ins that lost their content go too
export function withoutQuestions(text: string, names: string[]): string {
  const lower = names.map((n) => n.toLowerCase());
  return text
    .split(/\n+/)
    .map((para) => (/^\s*-\s/.test(para) ? para : para.split(/(?<=[.!?…])\s+/).filter((sentence) => !sentence.includes('?') && !lower.some((n) => sentence.toLowerCase().includes(n))).join(' ').trim()))
    .filter(Boolean)
    // a lead-in with a colon stays only when the price lines follow it
    .filter((para, i, all) => !/:\s*$/.test(para) || /^\s*-\s/.test(all[i + 1] ?? ''))
    .join('\n');
}
// A closing that still answers: the model's sentences without questions and without an invitation or an offer (a structural rule on the sentence, not a list of refusals); facts about
// the clinic ("прийом триває 30 хвилин") stay even when they use the word "прийом" or "запис" as a noun
const INVITE = /(запиш|записат|записуй|підібра|подібра|подобра|підбер|подбер|запропон|оберіть|выберите|приходьте|приходите|чекаємо\s+вас|ждём\s+вас|ждем\s+вас|звертайтесь|обращайтесь|нагада|напомн)/i;
// The model's sentences without an invitation to book (a structural filter on the sentence); questions stay
export function dropInvitations(text: string): string {
  return text
    .split(/\n+/)
    .map((para) => para.split(/(?<=[.!?…])\s+/).filter((sentence) => !INVITE.test(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
// The model's sentences without an announcement of a price ("ось вартість", "ціну назвемо"): used when the reply will carry NO price line, so nothing absent is promised
export function dropPriceAnnouncements(text: string): string {
  return text
    .split(/\n+/)
    .map((para) => para.split(/(?<=[.!?…])\s+/).filter((sentence) => !announcesPrice(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
export function closingKeepFacts(text: string): string {
  return text
    .split(/\n+/)
    .map((para) => para.split(/(?<=[.!?…])\s+/).filter((sentence) => !sentence.includes('?') && !INVITE.test(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
// Whole sentences of an approved text, up to a length (never a cut in the middle of a sentence); empty when even the first sentence is longer
export function sentencesUpTo(text: string, max: number): string {
  const sentences = text.replace(/\s*\n\s*/g, ' ').trim().split(/(?<=[.!?…])\s+/);
  let out = '';
  for (const sentence of sentences) {
    if (!sentence.trim() || (out + ' ' + sentence).trim().length > max) break;
    out = (out + ' ' + sentence).trim();
  }
  return out;
}
export const AGENT_HANDOFF_TEXT: Record<Lang, string> = {
  uk: 'Це краще уточнити в адміністратора клініки. Якщо хочете, ми передамо йому ваше запитання.',
  ru: 'Это лучше уточнить у администратора клиники. Если хотите, мы передадим ему ваш вопрос.',
};
export const AGENT_FALLBACK_TEXT: Record<Lang, string> = {
  uk: 'Дякуємо за повідомлення! Щоб відповісти точно, нам потрібна допомога адміністратора клініки. Якщо хочете, ми передамо йому ваше запитання.',
  ru: 'Спасибо за сообщение! Чтобы ответить точно, нам нужна помощь администратора клиники. Если хотите, мы передадим ему ваш вопрос.',
};

// What the draft was made from. A draft is valid only while nothing of this has moved (see AgentDraftService.staleness).
export interface DraftBasis {
  lastMessageId: string;
  lastMessageAt: string;
  stateVersion: number;
  owner: 'BOT' | 'HUMAN';
  capturedAt: string;
}

export interface AgentDraft {
  agent: true;
  // READY: a usable draft (its action may still have been refused, see next.check). SAFE_FALLBACK: the model gave nothing usable (or a rule stopped it):
  // the text is a safe draft that only OFFERS a hand-over (it does not say it happened), and nothing else is done.
  status: 'READY' | 'SAFE_FALLBACK';
  // the fields the existing screen reads (a draft of the working bot has the same ones)
  intent: string;
  reply: string;
  handoff: boolean;
  reason: HandoffReason | string | null;
  summary: null;
  service: string | null;
  options: SlotOption[];
  // the contract
  content: { kind: string; prices: string[]; advantages: string[]; objection: string | null } | null;
  next: {
    // what the model asked for, and what stays after the code's rules
    proposed: NextAction | null;
    action: NextAction;
    service: string | null;
    reason: string | null;
    check: { ok: boolean; notes: string[]; rejected: string | null };
  };
  // A hand-over is a SUGGESTION to the administrator: no request is created by generating a draft
  handoffSuggestion: { reason: string } | null;
  basis: DraftBasis;
  stale: { stale: boolean; reasons: string[] };
  modelCalls: number;
  // why the first try(ies) were refused before the answer that stands (codes of the checks); empty when the first try passed
  retryReasons: string[];
  exec: DraftExec;
}

// What the approval needs to check and execute a draft, kept on the server with the draft (never taken from the browser). Internal: the screen gets a sanitised view.
export interface DraftExec {
  // the service the offered times are for
  serviceId: string | null;
  // the services whose price lines the text states, with the state of the price at that moment (compared again when the draft is approved)
  prices: { serviceId: string; title: string; state: string; amount: number | null }[];
  // the wish about the time the offered times follow
  pref: TimePreference | null;
  lang: Lang;
  // what the patient receives when the staff choose "hand over to the administrator": the price lines (if any) and the fixed words that are true after the hand-over
  handoffText: string;
  // a line for the staff request that a hand-over creates (the wished doctor, for example); never sent to the patient
  staffNote?: string;
  // doctors mode: the doctor decision this draft shows (saved on the booking request only when the draft is really sent), the doctors of the offered times
  // (their times are read again before the send), and the buttons of a question about the doctor
  doctorPatch?: RequestPatch;
  doctorIds?: string[];
  buttons?: { label: string; payload: string }[];
}

// For the LOCAL evaluation only: when the caller passes this object, every model answer is kept in it (the raw text, why it stopped, the exact problem).
// Nothing is stored anywhere else and production never passes it.
export interface DraftDiagnostics {
  attempts: { raw: string; stopReason: string | null; thinkingTokens: number | null; problem: string | null; detail: string | null }[];
}

interface Problem {
  code: string;
  // the exact word / reference / reason the check found (goes into the reminder of the retry)
  detail?: string;
}
interface Attempt {
  // the action the model asked for, before the rules of the contract settled it
  requested: NextAction;
  decision: Decision;
  notes: string[];
  reply: string;
  // the words of the model before the code assembled the reply (the assembly is redone when the times are shown)
  intro: string;
  after: string | null;
  // the services whose price lines are written (a price already given in this dialogue is not repeated unless it is asked again)
  priceRefs: string[];
  // for a hand-over: the price lines + the words that are true after the hand-over
  handoffExec?: string;
}

// The answer of the model must be ONE JSON object and nothing else. The only outer wrapping accepted is a single Markdown code block around the whole text.
// A truncated answer, an answer that is not exactly one object, a refusal: refused, never repaired, never read as the first of several objects.
export function parseDecisionText(text: string, stopReason: string | null): { raw: unknown } | Problem {
  if (stopReason === 'max_tokens') return { code: 'truncated' };
  if (stopReason === 'refusal') return { code: 'refusal' };
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return { code: 'not_json', detail: t.slice(0, 80) };
  try {
    const raw: unknown = JSON.parse(t);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { raw } : { code: 'not_json' };
  } catch (e) {
    return { code: 'json_parse_error', detail: (e as Error).message.slice(0, 120) };
  }
}

// An internal reference (S3) in the text the client will read. The whole final reply is checked, the lines written by the code included. A title that really
// contains such letters and digits ("Імплант S3 Pro") is masked first, so a real name is never touched; only a token that equals a reference of THIS request counts.
export function internalReferenceIn(reply: string, titles: string[], refs: string[]): string | null {
  let text = reply;
  for (const title of [...new Set(titles)].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(title).join(' ');
  const set = new Set(refs.map((r) => r.toUpperCase()));
  for (const m of text.matchAll(/(?<![\p{L}\d])S\d{1,3}(?![\p{L}\d])/giu)) if (set.has(m[0].toUpperCase())) return m[0];
  return null;
}

// The wishes the patient has already given about the day and the time are reused (the newest wins, per field); "any time" clears them. A wish is a wish, never a promise.
// Per field, the newest wish wins: a new time of day replaces the earlier time of day (they would contradict each other) but keeps the earlier day; a new day keeps the earlier
// time of day. (One reading for the cabinets' and the doctors' times.)
function wishedTime(msgs: { direction: string; text: string }[], lastText: string, todayClinic: string): TimePreference | null {
  const ownPref = ANY_TIME.test(lastText) ? null : parseTimePreference(lastText, todayClinic);
  let earlierPref: TimePreference | null = null;
  if (!ANY_TIME.test(lastText)) {
    for (const m of [...msgs.slice(0, -1)].reverse()) {
      if (m.direction !== 'IN' || m.text.startsWith('Обрав час:')) continue;
      const p0 = parseTimePreference(m.text, todayClinic);
      if (p0 && !p0.unclear && p0.farDays === undefined) {
        earlierPref = p0;
        break;
      }
    }
  }
  const base: TimePreference = { ...(earlierPref ?? {}) };
  if (ownPref && (ownPref.afterMin !== undefined || ownPref.beforeMin !== undefined)) {
    delete base.afterMin;
    delete base.afterKind;
    delete base.beforeMin;
    delete base.beforeKind;
  }
  return ownPref || earlierPref ? { ...base, ...(ownPref ?? {}) } : null;
}

// Doctors mode: the model's sentences about a doctor are not kept above the code's doctor decision (the code alone states who, whether, when). A sentence goes when it
// names a doctor of the clinic (or the one the patient named), or speaks about a doctor AND about his existence, availability or booking; every other sentence (an answer
// to another question) stays. Patterns, not understanding.
const DOCTOR_TALK = /(?<![\p{L}])(?:лікар\p{L}*|врач\p{L}*|доктор\p{L}*|стоматолог\p{L}*|фахів\p{L}*|специалист\p{L}*)(?![\p{L}])/iu;
const DOCTOR_CLAIM = /(?<![\p{L}])(?:не\s+(?:знаю|бачу|вижу|знайш\p{L}*|наш\p{L}*|можу|можем\p{L}*)|немає|нема|нет|отсутств\p{L}*|уточн\p{L}*|вільн\p{L}*|свободн\p{L}*|прийма\p{L}*|принима\p{L}*|працю\p{L}*|работа\p{L}*|розклад\p{L}*|расписан\p{L}*|доступн\p{L}*|записат\p{L}*|запиш\p{L}*|запис\p{L}*|обра\p{L}*|выбор\p{L}*|вибір\p{L}*|даних|данных|довідц\p{L}*|справк\p{L}*)(?![\p{L}])/iu;
export function withoutDoctorClaims(text: string, surnames: string[]): string {
  const stems = [...new Set(surnames.filter((x) => x.length >= 3).map((x) => x.toLowerCase().slice(0, Math.max(4, x.length - 2))))];
  return text
    .split(/\n+/)
    .map((para) => (/^\s*-\s/.test(para) ? para : para.split(/(?<=[.!?…])\s+/).filter((sentence) => {
      const low = sentence.toLowerCase();
      const names = stems.some((st) => new RegExp(`(?<![\\p{L}])${st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(low));
      return !names && !(DOCTOR_TALK.test(sentence) && DOCTOR_CLAIM.test(sentence));
    }).join(' ').trim()))
    .filter(Boolean)
    .join('\n\n');
}
// "до лікаря Прізвище": a doctor named in so many words (the reading of the old bot's cabinets path); used only to tell the patient that no such doctor was found
const NAMED_DOCTOR = /(?:^|[^\p{L}])(?:до|к)\s+(?:лікар(?:я|ю|і|ки)|лікарки|доктор(?:а|у)?|врач(?:а|у)?)\s+([\p{Lu}][\p{L}'’-]{2,})/u;
const UNKNOWN_DOCTOR = (lang: Lang, n: string) =>
  lang === 'ru' ? `Врача ${n} среди врачей клиники мы не нашли. Уточните, пожалуйста, фамилию врача или напишите, если вам подойдёт любой врач.` : `Лікаря ${n} серед лікарів клініки ми не знайшли. Уточніть, будь ласка, прізвище лікаря або напишіть, якщо вам підійде будь-який лікар.`;
// The reason of a hand-over in words for the staff request
const HANDOFF_REASON_UK: Record<string, string> = { time_preference_unavailable: 'немає вільних вікон за побажанням пацієнта в межах пошуку', online_booking_unavailable: 'онлайн-запис цієї послуги недоступний', needs_clarification: 'потрібне уточнення адміністратора', service_unknown: 'послугу не визначено', asked_for_person: 'пацієнт просить людину' };

// Doctors mode, a hand-over the model chose while a booking request is open: what the staff need, from the request itself (not from the patient's "yes, pass it on")
function bookingContextNote(r: { id: string; service: string | null; doctor: string | null; wishedDoctor: string | null }, pref: TimePreference | null, reason: string | null): string {
  return [
    `заявка на запис ${r.id}`,
    r.service ? `послуга: ${r.service}` : null,
    r.doctor ? `лікар: ${r.doctor}` : r.wishedDoctor ? `бажаний лікар: ${r.wishedDoctor}` : null,
    pref ? `побажання: ${preferencePhrase(pref, 'uk')}` : null,
    reason ? `причина: ${HANDOFF_REASON_UK[reason] ?? reason}` : null,
  ].filter(Boolean).join('; ');
}

// The times already offered in this dialogue WITH their doctor (doctors mode: "slot|date|time|#id" -> "date|time|id"): a time offered with one doctor does not hide the same
// time of another doctor
function offeredToDoctors(messages: { direction: string; buttons: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.direction !== 'OUT' || !Array.isArray(m.buttons)) continue;
    for (const b of m.buttons as { payload?: unknown }[]) {
      const p = typeof b?.payload === 'string' ? b.payload.split('|') : [];
      if (p[0] === 'slot' && p[1] && p[2] && p[3]?.startsWith('#')) out.add(`${p[1]}|${p[2]}|${p[3].slice(1)}`);
    }
  }
  return out;
}

// Was a price line of this service already written earlier in the dialogue (by a draft that staff sent)? Lines have the form "- <title>: ..."
function priceGivenBefore(messages: { direction: string; text: string }[], title: string): boolean {
  const line = new RegExp(`^- ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'mu');
  return messages.some((m) => m.direction === 'OUT' && line.test(m.text));
}

// The one service a question is clearly about (its match score is well above every other); none when it is not clear
function clearestServiceRef(items: { ref: string; score?: number }[]): string[] {
  const ranked = items.filter((x) => (x.score ?? 0) > 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return ranked.length && (ranked.length === 1 || (ranked[0].score ?? 0) >= (ranked[1].score ?? 0) * 1.5) ? [ranked[0].ref] : [];
}

// The reason of a refusal, in words for the model's next try
function reminderFor(p: Problem): string {
  const base = '\n\nПОПЕРЕДНЮ ВІДПОВІДЬ ВІДХИЛЕНО: ';
  const why: Record<string, string> = {
    truncated: 'відповідь обірвалася на ліміті довжини. Пиши коротше: "reply" — 1–3 речення, "after" порожній.',
    not_json: 'відповідь має бути ТІЛЬКИ одним JSON-об’єктом без тексту до і після.',
    json_parse_error: 'JSON не розібрався. Дай один коректний JSON-об’єкт; переноси рядків — як \\n.',
    refusal: 'ти відмовився відповідати. Дай чернетку за правилами.',
    risky_claim: `у тексті є слово-обіцянка «${p.detail ?? ''}» (знижка, гарантія, відсотки, «безболісно» тощо). Перепиши без нього; можна чесно сказати, що цього не гарантуєш.`,
    internal_reference_in_text: `у тексті з’явилося службове позначення «${p.detail ?? ''}». Називай послугу її назвою з довідки; позначки — лише в масивах.`,
    amount_in_free_text: 'у тексті є сума або валюта. Суми пише система: назви послугу в "prices".',
    time_outside_windows: 'у тексті є час (години й хвилини). Не називай жодного часу: ні вільного, ні з повідомлення пацієнта, ні годин роботи. Побажання щодо часу підтвердить код; для запису використай OFFER_TIME.',
    mechanism_in_text: `у тексті згадано, як влаштований сервіс («${p.detail ?? ''}»). Не пиши про систему чи рядки нижче, просто відповідай на запитання.`,
    action_promise: `у тексті обіцянка чи твердження про виконану дію («${p.detail ?? ''}»), а next.action інший. Можна лише запросити («якщо хочете, можу підказати, як записатися»); не кажи, що щось підібрано, записано чи передано.`,
    wrong_language: `відповідь написана не мовою пацієнта. Мова пацієнта — ${p.detail === 'ru' ? 'РОСІЙСЬКА' : 'УКРАЇНСЬКА'}: увесь текст у "reply" і "after" пиши ${p.detail === 'ru' ? 'російською' : 'українською'} (назви послуг і адресу залишай як у довідці, не перекладай; довідка й попередні відповіді іншою мовою — не приклад).`,
    price_status_denied: `у тексті сказано, що ціна остаточна, точна чи не попередня («${p.detail ?? ''}»). Ціни з прайсу попередні: підсумкова сума залежить від фактичного обсягу послуг. Перепиши без цього твердження й нічого не обіцяй про остаточну суму.`,
    price_not_shown: 'текст анонсує ціну, а рядка з ціною в цій відповіді не буде (див. СТАН РОЗМОВИ). Відповідай без згадки про те, що ціну названо чи буде названо.',
    price_question_unanswered: 'пацієнт питає про ціну, а в "prices" немає позначок. Додай позначки послуг (або HAND_OFF з кодом service_unknown, якщо такої послуги немає).',
    unknown_service_ref: 'позначка послуги не з довідки. Бери позначки лише з довідки вище.',
    bad_reason: 'next.reason має бути одним кодом із переліку (не слова й не речення).',
    clarify_limit: 'ліміт уточнень вичерпано: не став CLARIFY, дай відповідь або HAND_OFF.',
    question_after_objection: 'питання тут недоречне: пацієнт висловив сумнів, страх, паузу чи відмову (одне уточнення дозволене лише для страху чи недовіри, коли пацієнт ще не пояснив і ти його ще не ставив). Відповідай коротко й тепло, без питань і без пропозиції запису.',
    invented_contact: `у тексті є ${p.detail === 'phone' ? 'номер телефону' : 'адреса'}, якого немає в довідці клініки. Не вигадуй: скажи, що цього ти не знаєш і це уточнить адміністратор.`,
    superiority_claim: `в тексті порівняння з іншими чи перевага над ними («${p.detail ?? ''}»). Не стверджуй, що клініка краща, і нічого не кажи про інші клініки: називай лише перевірені факти про цю клініку з довідки.`,
    compare_question_not_needed: 'питання про критерій уже ставили: не повторюй його. Відповідай фактами зі довідки без питання або, якщо їх немає, HAND_OFF.',
    several_questions: 'у повідомленні кілька питань до пацієнта. Залиш одне, яке справді змінює наступний крок, або жодного.',
  };
  return `${base}${why[p.code] ?? `${p.code}. Дотримуйся формату й правил.`}`;
}

// The draft of the agent (Stage 1): a path behind Clinic.aiAgentMode that prepares a reply and a proposed next action through the decision contract and
// DOES NOTHING: no message is sent, no request, visit, conversation state or funnel event is written, no conversation is handed over.
// Everything it calls to read (facts, the free times of the cabinets read from Cliniccards, the dialogue state) was checked to be read-only; the
// only things it writes are the model-usage counters of AiService.complete (the cost of a model call, as for the working bot's draft).
@Injectable()
export class AgentDraftService {
  private readonly log = new Logger(AgentDraftService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private kb: KbService,
    private cabinets: CabinetBookingService,
    private assistant: ChatAssistantService,
    private choice: DoctorChoiceService,
  ) {}

  async generate(clinicId: string, channel: string, chatId: string, diagnostics?: DraftDiagnostics): Promise<AgentDraft> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiAgentMode: true, name: true, workHours: true, publicAddress: true, publicPhone: true, publicDirections: true, scheduleMode: true, aiRepliesPerChatDay: true, aiAgentAuto: true, agentAutoServiceId: true, agentAutoServiceIds: true, agentAutoServicesSet: true } });
    // the autonomous mode offers only its explicit set of services (AgentAutoGate's one rule; a configured set whose services all stopped counting offers none)
    const autoIds = clinic.aiAgentAuto ? configuredAutoServiceIds(clinic) : [];
    const autoOnly = autoIds.length ? (await autoServices(this.prisma, clinicId)).map((x) => x.id) : null;
    if (!clinic.aiAgentMode) throw new BadRequestException('agent_mode_off');
    // a message of ours that failed or whose result is unknown is not part of the dialogue (it must not hide the patient's last message, so a new draft can be made)
    const rows = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY });
    if (!rows.length) throw new BadRequestException('conversation_not_found');
    const msgs = rows.reverse();
    const last = msgs[msgs.length - 1];
    if (last.direction !== 'IN') throw new BadRequestException('nothing_to_answer');
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } } });
    const basis: DraftBasis = { lastMessageId: last.id, lastMessageAt: last.createdAt.toISOString(), stateVersion: state?.version ?? 0, owner: (state?.owner as 'BOT' | 'HUMAN' | undefined) ?? 'BOT', capturedAt: new Date().toISOString() };
    const lang: Lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
    const finish = async (d: Omit<AgentDraft, 'basis' | 'stale' | 'agent' | 'summary' | 'intent' | 'retryReasons' | 'exec'> & { retryReasons?: string[]; exec?: Partial<DraftExec> }): Promise<AgentDraft> => ({ agent: true, intent: 'info', summary: null, retryReasons: [], ...d, exec: { serviceId: null, prices: [], pref: null, lang, handoffText: handoffText(lang), ...(d.exec ?? {}) }, basis, stale: await this.staleness(clinicId, channel, chatId, basis) });
    // nothing usable from the model: a SAFE draft that only offers a hand-over (it never says the hand-over happened) and the reason code
    const fallback = (reason: string, calls = 0, retryReasons: string[] = []) =>
      finish({ retryReasons, status: 'SAFE_FALLBACK', reply: AGENT_FALLBACK_TEXT[lang], handoff: true, reason, service: null, options: [], content: null, next: { proposed: null, action: 'HAND_OFF', service: null, reason, check: { ok: false, notes: [], rejected: reason } }, handoffSuggestion: { reason }, modelCalls: calls });
    const suggestHandoff = (reason: string, calls = 0) =>
      finish({ status: 'READY', reply: AGENT_HANDOFF_TEXT[lang], handoff: true, reason, service: null, options: [], content: null, next: { proposed: 'HAND_OFF', action: 'HAND_OFF', service: null, reason, check: { ok: true, notes: [], rejected: null } }, handoffSuggestion: { reason }, modelCalls: calls });

    // Counted like the working bot: a very long day-long dialogue goes to a person
    const today = await this.prisma.chatMessage.count({ where: { clinicId, channel, chatId, direction: 'IN', createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today > clinic.aiRepliesPerChatDay) return suggestHandoff('long');

    const patientWords = msgs.filter((m) => m.direction === 'IN').slice(-3).map((m) => m.text).join(' ');
    const kb = await this.kb.factsFor(clinicId, new Date(), patientWords, last.text);
    // The classifiers run BEFORE the model, as for the working bot: urgent symptoms, health, discounts and complaints never reach it
    if (isUrgentSymptom(last.text, kb.pricesKnown, { fearOfPain: true })) return suggestHandoff('urgent');
    const topic = incomingHandoff(last.text, kb.pricesKnown, { fearOfPain: true });
    if (topic) return suggestHandoff(topic);
    // the patient's last message read by the CODE for an objection (a price concern, fear, hesitation, a refusal), whatever the model will say about it: it holds back the code's
    // own nudges (the soft offer, the price lines nobody asked for, a proposed time)
    const objection = objectionOf(last.text);
    // a comparison of clinics ("why you", "I am comparing") and a clear "price only" request: read by the code only to keep the nudges and the unrelated facts out of the answer
    const comparison = comparisonAsk(last.text);
    const bookNow = wantsToBookNow(last.text);
    // the preference does not expire with the number of messages: it is looked up in the dialogue itself (not in the short window that goes to the model) and the newest intent wins
    const priceOnlyPref = !bookNow && (await this.priceOnlyPreference(clinicId, channel, chatId));
    const kbHasContacts = !!kb.text?.includes('АДРЕСИ ТА КОНТАКТИ');

    const configured = !!clinic.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    const hoursText = configured ? formatHours(readWorkHours(clinic.workHours), lang) : null;
    // Address, phone, working hours: answered by the code from what the clinic entered (no model)
    // (the agent leaves out the working bot's closing "write to us to book": a booking is offered once, by its own rule)
    const contactData = { address: clinic.publicAddress, phone: clinic.publicPhone, directions: clinic.publicDirections, hours: hoursText, inKnowledgeBase: kbHasContacts };
    const direct = contactReply(last.text, lang, contactData, { invite: false });
    // in a message that closes the exchange, its "booking" words are a refusal: the contacts it asks for are still answered
    const directClosing = closesDialogue(objection, last.text) ? contactReply(last.text, lang, contactData, { invite: false, ignoreBooking: true }) : direct;
    // ...but only when contacts are ALL that was asked: a message that also asks a price, or has a second question, goes to the model (the contacts are in its
    // prompt), so no question is dropped
    if (direct && !objection && !isPriceQuestion(last.text) && contactsOnly(last.text)) {
      return finish({ status: 'READY', reply: direct, handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['answered_by_code'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
    }

    const open = await this.prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, status: 'NEW', kind: { in: ['BOOKING', 'RESCHEDULE'] } }, orderBy: { createdAt: 'desc' }, select: { service: true, slotAt: true, stage: true } });
    const stateService = state?.serviceId ? kb.items.find((x) => x.id === state.serviceId) ?? null : null;
    const knownItem = (open?.service ? kb.items.find((x) => x.title === open.service) : undefined) ?? stateService;
    // A doctor the patient named, in the cabinets mode (the times come from the cabinets, so they say nothing about that doctor). The SAME recognition and texts as the
    // old bot (DoctorChoiceService), read from the dialogue only: no write here. Before any time is offered the patient chooses: a doctor the clinic assigns, or the wish
    // to the administrator. During a booking step the open request carries the state (written by the booking flow) and the step asks the question.
    const wishState: CabinetWish | null = clinic.scheduleMode === 'CABINETS' ? await this.choice.cabinetWishState(clinicId, channel, chatId) : null;
    const inBookingStep = !!open?.slotAt && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage);
    const wishOpen = !!wishState && (wishState.state === 'NEW' || wishState.state === 'ASKED') && (!!wishState.wish || wishState.ambiguous.length > 0);
    const wishText = (w: CabinetWish) => (w.ambiguous.length ? this.choice.ambiguousQuestion(lang, w.ambiguous) : this.choice.wishQuestion(lang, w.wish!));
    const wishNote = (w: CabinetWish) => `бажаний лікар: ${w.wish ?? w.ambiguous.join(' / ')} (побажання, не підтверджено)`;
    const doctorHandoff = (w: CabinetWish) =>
      finish({ status: 'READY', reply: AGENT_HANDOFF_TEXT[lang], handoff: true, reason: 'needs_clarification', service: null, options: [], content: null, next: { proposed: 'HAND_OFF', action: 'HAND_OFF', service: null, reason: 'needs_clarification', check: { ok: true, notes: ['doctor_wish_admin'], rejected: null } }, handoffSuggestion: { reason: 'needs_clarification' }, modelCalls: 0, exec: { staffNote: wishNote(w) } });
    const wishQuestionReply = (w: CabinetWish, note: string) =>
      finish({ status: 'READY', reply: wishText(w), handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: [note], rejected: null } }, handoffSuggestion: null, modelCalls: 0, exec: { serviceId: knownItem?.id ?? null } });
    if (wishState) {
      // the patient wants that doctor: one hand-over through the existing mechanism (the request is made first, then "передали"), with the wish in the staff request
      if (wishState.state === 'ADMIN' && wishState.lastIsAnswer) return doctorHandoff(wishState);
      // asked twice and still no clear answer: a person decides (an offer of the hand-over is not repeated a third time)
      if (wishOpen && !inBookingStep && wishState.asked >= 2 && wishState.lastIsAnswer === false && !wishState.lastNames) return doctorHandoff(wishState);
      // a doctor the clinic assigns: the times of the cabinets now (the request is open for a booking; the wish is kept by the booking flow as a note when a time is chosen)
      if (wishState.state === 'ANY' && wishState.lastIsAnswer && !inBookingStep) {
        // the service of the dialogue, or the one the patient's words clearly name (the question was answered by the code, so the model never chose it)
        const svc = knownItem ?? kb.items.find((x) => x.ref === clearestServiceRef(kb.items)[0]) ?? null;
        if (svc) {
          const offer = await this.proposeTimes(clinicId, clinic.scheduleMode, svc.id, null, offeredBefore(msgs));
          if (offer.options.length) {
            return finish({ status: 'READY', reply: this.choice.cabinetOfferText(lang, clinic.aiAgentAuto), handoff: false, reason: null, service: svc.title, options: offer.options, content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'OFFER_TIME', action: 'OFFER_TIME', service: svc.title, reason: null, check: { ok: true, notes: ['doctor_wish_any'], rejected: null } }, handoffSuggestion: null, modelCalls: 0, exec: { serviceId: svc.id } });
          }
        }
      }
      // the newest message names a doctor (or answers "which of them") and the dialogue is about a booking: the question at once, by the code (no model call)
      // (the question "which of them" is asked only in such a dialogue, so the answer to it is one too)
      const lastOutText = [...msgs].reverse().find((m) => m.direction === 'OUT')?.text ?? '';
      const answeredWhich = /^(Уточніть, будь ласка, до якого лікаря:|Уточните, пожалуйста, к какому врачу:)/.test(lastOutText);
      const bookingTalk = bookingSignal(last.text) || wantsToBookNow(last.text) || !!open?.slotAt || answeredWhich || msgs.some((m) => m.direction === 'OUT' && Array.isArray(m.buttons) && m.buttons.length > 0);
      if (wishOpen && !inBookingStep && wishState.lastNames && bookingTalk) return wishQuestionReply(wishState, 'doctor_wish_question');
    }
    // Doctors mode: which doctor is decided by DoctorChoiceService, exactly as for the old bot (the wish, the continuation of treatment for a linked card, the doctor
    // for a first booking), with readOnly (no refresh of the doctors, nothing written). Its reply and buttons are the code's; the decision is saved on the request
    // only when this draft is really sent. Here: the patient answered a question about the doctor, was asked which doctor after "no", or names a doctor while a
    // booking request is open. (The model's own request for times is handled at OFFER_TIME below.)
    const byDoctors = clinic.scheduleMode === 'DOCTORS';
    const doctorReq = byDoctors ? await this.prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, status: 'NEW', kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } }) : null;
    const doctorCtx = async (svc: KbItem): Promise<ChoiceContext> => {
      const linked = (await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } }))?.patientId ?? null;
      // only messages that speak about a doctor are read for a wish (a bare surname in a contact answer is the patient's own name)
      const texts = msgs.filter((m) => m.direction === 'IN' && !m.text.startsWith('Обрав час:')).map((m) => m.text).reverse().filter((t) => speaksOfDoctor(t));
      // (auto: the agent itself asks the patient to confirm before any visit, so the decisions' texts say so)
      return { clinicId, patientId: linked, service: svc, texts, lang, request: doctorReq, auto: true, readOnly: true };
    };
    const serviceRow = async (id: string | null, title: string | null): Promise<KbItem | null> =>
      id ? await this.prisma.kbItem.findFirst({ where: { id, clinicId, kind: 'SERVICE', active: true } }) : title ? await this.choice.findService(clinicId, title) : null;
    // The doctor the patient named, read by the code BEFORE the model from the clinic's doctors (Cliniccards; the reference may not list them at all): one doctor, several
    // (who is meant is asked by the code), or none found. The model gets only that result (no list of the doctors, no history); its own sentences about doctors are not
    // kept above the code's doctor decision (withoutDoctorClaims).
    const activeDoctors = byDoctors ? await this.prisma.doctor.findMany({ where: { clinicId, active: true }, select: { externalId: true, lastName: true, firstName: true } }) : [];
    const doctorMsg = byDoctors ? [...msgs].reverse().find((m) => m.direction === 'IN' && !m.text.startsWith('Обрав час:') && speaksOfDoctor(m.text)) : undefined;
    const namedIds = doctorMsg ? matchDoctors(doctorMsg.text, activeDoctors) : [];
    const namedDoctors = activeDoctors.filter((d) => namedIds.includes(d.externalId)).map((d) => `${d.lastName} ${d.firstName}`.trim());
    const namedUnknown = doctorMsg && !namedIds.length ? (NAMED_DOCTOR.exec(doctorMsg.text)?.[1] ?? null) : null;
    const doctorSurnames = [...activeDoctors.map((d) => d.lastName), ...(namedUnknown ? [namedUnknown] : [])];
    if (byDoctors && !inBookingStep && namedUnknown && doctorMsg === last) {
      // never presented as found, and no other doctor is put in his place without the patient's word: one question
      return finish({ status: 'READY', reply: UNKNOWN_DOCTOR(lang, namedUnknown), handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['doctor_not_found'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
    }
    if (byDoctors && !inBookingStep) {
      const lastOutMsg = [...msgs].reverse().find((m) => m.direction === 'OUT');
      const docButtons = (Array.isArray(lastOutMsg?.buttons) ? (lastOutMsg!.buttons as { label?: unknown; payload?: unknown }[]) : []).filter((b): b is { label: string; payload: string } => typeof b.label === 'string' && typeof b.payload === 'string' && /^doc(pick|yes|no)\|/.test(b.payload));
      const svc = await serviceRow(doctorReq ? null : (state?.serviceId ?? null), doctorReq?.service ?? null);
      let dec: DoctorDecision | null = null;
      if (svc && docButtons.length && !last.text.includes('?')) {
        // the button the patient tapped (its label), or the words of the answer: "так"/"ні" to a proposed doctor, a name among the doctors listed
        let hit = docButtons.find((b) => b.label.trim().toLowerCase() === last.text.trim().toLowerCase());
        if (!hit && docButtons.some((b) => b.payload.startsWith('docyes|')) && (isYes(last.text) || isNo(last.text))) hit = docButtons.find((b) => b.payload.startsWith(isYes(last.text) ? 'docyes|' : 'docno|'));
        if (!hit) {
          const picks = docButtons.filter((b) => b.payload.startsWith('docpick|'));
          const named = matchDoctors(last.text, picks.map((b) => ({ externalId: b.payload.split('|')[1], lastName: b.label.split(/\s+/)[0] ?? b.label, firstName: b.label.split(/\s+/).slice(1).join(' ') })));
          if (named.length === 1) hit = picks.find((b) => b.payload === `docpick|${named[0]}`);
        }
        const [kind, id] = hit ? (hit.payload.slice(3).split('|') as ['pick' | 'yes' | 'no', string]) : [null, null];
        // a "yes"/"no" counts only for the proposal that is still open (a repeated tap after it was settled is not a second answer)
        const proposalOpen = doctorReq?.doctorState === 'PROPOSED' && doctorReq.pendingDoctorId === id;
        if (kind && (kind === 'pick' || proposalOpen)) dec = await this.choice.answer(await doctorCtx(svc), kind, id);
      } else if (svc && lastOutMsg && this.choice.isAskWho(lastOutMsg.text)) {
        dec = await this.choice.decide(await doctorCtx(svc));
      } else if (svc && doctorReq && speaksOfDoctor(last.text)) {
        dec = await this.choice.decide(await doctorCtx(svc));
      }
      // (no doctor settled by the rules above: the doctors who provide the service and have time, as at OFFER_TIME)
      if (svc && dec?.kind === 'NONE') dec = await this.choice.eligibleOffer(await doctorCtx(svc));
      if (svc && dec) return this.renderDoctor(dec, svc, '', msgs, lang, finish, 0, [], doctorReq?.doctor ?? null, wishedTime(msgs, last.text, clinicDate(new Date())));
    }
    // The price of the service the dialogue is about, asked and nothing else ("а скільки це коштує?"): answered by the code from the approved price list (the selected
    // service and its price as it is NOW), no model. A mixed message is not taken: its other questions go by their own rules (the classifiers above have already run).
    if (isPriceOnlyQuestion(last.text) || priceOnlyRequest(last.text)) {
      const target = (open?.service ? kb.items.find((x) => x.title === open.service) : undefined) ?? stateService;
      // "price only" and no service in sight (the message names none either): only the question which service
      if (!target && priceOnlyRequest(last.text) && kb.items.every((x) => (x.score ?? 0) === 0)) {
        return finish({ status: 'READY', reply: WHICH_SERVICE_PRICE[lang], handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['price_only_which_service'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
      }
      const composed = target ? composePriceReply({ intro: '', after: null, ids: [target.ref] }, kb.items, lang, AGENT_PRICE_OPTS) : null;
      if (target && composed && 'reply' in composed) {
        return finish({ status: 'READY', reply: composed.reply, handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [target.ref], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['answered_by_code'], rejected: null } }, handoffSuggestion: null, modelCalls: 0, exec: { prices: [{ serviceId: target.id, title: target.title, state: target.state, amount: target.amount }] } });
      }
    }
    // A message that ONLY asks for a language is not an answer to the pending question (the service clarification above all): the language is already applied (see conversationLanguage),
    // so the code acknowledges it and says the pending question again in that language. Nothing else changes: no service, time, consent or counter is touched, nothing is offered or
    // handed over, no model call. During a booking step the acknowledgement alone is sent here and the step itself is asked again by the existing resume of the autonomous path.
    // (Urgent and medical messages were decided above; a message that also says something else is not this and goes on as usual.)
    if (languageOnlyRequest(last.text)) {
      const before = [...msgs].reverse().find((m) => m.direction === 'OUT');
      const inStep = !!open && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage);
      let again = '';
      if (before && !inStep) {
        const known = [SOFT_OFFER, ASK_PREFERENCE, HELP_OFFER, COMPARE_HELP, WHICH_SERVICE_PRICE].find((x) => before.text.includes(x.uk) || before.text.includes(x.ru));
        const question = before.text.split(/(?<=[.!?…])\s+|\n+/).filter((x) => x.trim().endsWith('?')).pop() ?? '';
        if (Array.isArray(before.buttons) && before.buttons.length > 0) again = TIMES_ABOVE[lang];
        else if (known) again = known[lang];
        else if (/(На яку послугу|На какую услугу)/.test(before.text) || (question && (state?.clarifyCount ?? 0) >= 1 && !state?.serviceId && !open?.service)) {
          // the service question: in the patient's words when it is already in the requested language, else the code's own question from the services that can be booked online
          const same = question && detectLanguageAgent(withoutStoredNames(question, kb.items.map((x) => x.title))) === lang && !/(На яку послугу|На какую услугу)/.test(question);
          again = same ? question.trim() : CLARIFY_SERVICE(lang, (await this.eligibleServices(clinicId, clinic.scheduleMode, autoOnly)).map((x) => x.title));
        } else if (question && detectLanguageAgent(withoutStoredNames(question, kb.items.map((x) => x.title))) === lang) again = question.trim();
      }
      return finish({ status: 'READY', reply: [LANGUAGE_ACK[lang], again].filter((x) => x.trim()).join(' '), handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['language_request'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
    }
    // "Is this the final amount?" about a price the dialogue has just named: the code answers with the status it states next to every sum (provisional), no model. Only when every price
    // named so far is a known sum of the price list (a free service or a price still to be clarified is left to the model and its rules)
    if (finalAmountQuestion(last.text) && !objection && !comparison) {
      const named = kb.items.filter((x) => priceGivenBefore(msgs, x.title));
      if (named.length && named.every((x) => x.state === 'KNOWN' && x.amount !== null)) {
        return finish({ status: 'READY', reply: FINAL_AMOUNT[lang], handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['price_status_by_code'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
      }
    }
    // Stage 3 (finish): at most ONE service clarification when the patient cannot name a service. Agreement to the offer of the administrator's help is a hand-over (one request, decided by the
    // code, no model); a reply that still names no service gets the offer instead of a second question. The existing hand-over mechanism says "handed over" only after the request exists.
    const lastOut = [...msgs].reverse().find((m) => m.direction === 'OUT');
    if (lastOut && (lastOut.text.includes(HELP_OFFER.uk) || lastOut.text.includes(HELP_OFFER.ru)) && acceptsOffer(last.text)) return suggestHandoff('service_unknown');
    if (lastOut && (lastOut.text.includes(COMPARE_HELP.uk) || lastOut.text.includes(COMPARE_HELP.ru)) && acceptsOffer(last.text)) return suggestHandoff('needs_clarification');
    if (
      (state?.clarifyCount ?? 0) >= 1 && !state?.serviceId && !open?.service && !!lastOut?.text.includes('?') && !objection &&
      !isPriceQuestion(last.text) && !bookingSignal(last.text) && !(last.text.includes('?')) && kb.items.every((x) => (x.score ?? 0) === 0)
    ) {
      // (the approved first-step suggestion, when the clinic has one, was made on the first message and set the service, so this is reached only without it)
      return finish({ status: 'READY', reply: HELP_OFFER[lang], handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['help_offered_after_unclear'], rejected: null } }, handoffSuggestion: { reason: 'service_unknown' }, modelCalls: 0 });
    }
    // Stage 3: the patient does not know which service they need. The model never picks a service from a described need. Only a service whose OWN approved description names it as the first
    // step (and that passes the online-booking checks) is offered, in the clinic's words; with none, one clarification (the model's, within the existing limit) and then the staff path.
    // Information alone never starts a search for times: the offer is a question, the times come only after the patient accepts it.
    if (unclearNeed(last.text) && !objection && !state?.serviceId && !open?.service && !isPriceQuestion(last.text) && (last.text.match(/\?/g) ?? []).length <= 1) {
      const firstSteps = await this.eligibleServices(clinicId, clinic.scheduleMode, autoOnly, true);
      const sentSoft = msgs.some((m) => m.direction === 'OUT' && (m.text.includes(SOFT_OFFER.uk) || m.text.includes(SOFT_OFFER.ru)));
      if (firstSteps.length === 1) {
        const svc = firstSteps[0];
        const text = [FIRST_STEP_LINE(lang, svc.title, svc.text), sentSoft ? '' : SOFT_OFFER[lang]].filter((x) => x.trim()).join('\n\n');
        return finish({ status: 'READY', reply: text, handoff: false, reason: null, service: svc.title, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: svc.title, reason: null, check: { ok: true, notes: ['first_step_from_description'], rejected: null } }, handoffSuggestion: null, modelCalls: 0, exec: { serviceId: svc.id, prices: [] } });
      }
      if (firstSteps.length > 1 && (state?.clarifyCount ?? 0) < MAX_CLARIFY) {
        return finish({ status: 'READY', reply: CLARIFY_SERVICE(lang, firstSteps.map((x) => x.title)), handoff: false, reason: null, service: null, options: [], content: { kind: 'CLARIFY', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['first_step_choice'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
      }
      // no approved routing: after the existing limit of clarifications the staff path is the honest answer
      if ((state?.clarifyCount ?? 0) >= MAX_CLARIFY) return suggestHandoff('service_unknown');
    }
    // Stage 2: does THIS message move toward a booking? A request to book or to see times, a wish about the day or time, "these do not suit", the acceptance of the offer of times
    // the agent has just made, or the answer to its question about the service. "Okay", "thanks" and a question about the contents of a service are none of these: they are answered
    // and the times are not looked up.
    const prevOut = [...msgs].reverse().find((m) => m.direction === 'OUT');
    // The check applies where it matters: in a dialogue that has just had an objection (the last messages), or when the message is only "okay / thanks". Elsewhere the model's choice stands as before.
    const ACK_ONLY = /^\s*(?:ок|окей|добре|гаразд|дякую|дякуємо|спасибо|благодарю|зрозуміло|понятно|ясно|хорошо)(?:[\s,.!]+(?:ок|окей|добре|дякую|дякуємо|спасибо|зрозуміло|понятно|ясно|хорошо|вам|вас|велике|большое|за\s+(?:пояснення|відповідь|ответ|объяснение)))*[\s.!]*$/iu;
    // The signal is contextual. An explicit request to book or to see times counts by itself. A wish about the time of day ("ввечері"), "these do not suit" and a bare "yes" count only when the
    // preceding conversation makes them a booking continuation: the agent has just offered times (and the patient turns them down or states a preference), has just asked when it suits the
    // patient, has just offered to find a time ("Підібрати зручний час?"), or has just asked which service. After a price explanation, a description, an answer to an objection or any
    // other question the same words mean nothing about booking.
    const sentOffer = !!prevOut && (prevOut.text.includes(SOFT_OFFER.uk) || prevOut.text.includes(SOFT_OFFER.ru));
    const sentTimes = !!prevOut && Array.isArray(prevOut.buttons) && prevOut.buttons.length > 0;
    const askedTime = !!prevOut && !sentOffer && prevOut.text.includes('?') && /(коли|когда|зручн|удобн)/i.test(prevOut.text);
    const askedService = !!prevOut && /(На яку послугу|На какую услугу)/.test(prevOut.text);
    const todayClinic = clinicDate(new Date());
    const wishOfTime = !!parseTimePreference(last.text, todayClinic);
    const turnedDown = slotRejection(last.text);
    // ("a doctor the clinic assigns" after the doctor question is the go-ahead for the booking it interrupted)
    const explicitBooking = bookingSignal(last.text) || (sentOffer && acceptsOffer(last.text)) || askedService || (wishState?.state === 'ANY' && wishState.lastIsAnswer);
    const contextualBooking = ((sentTimes || askedTime) && (wishOfTime || turnedDown)) || (sentOffer && wishOfTime);
    const intentSignal = explicitBooking || contextualBooking;
    // the check applies in a dialogue that has just had an objection, for a bare "okay / thanks", and for a message whose only booking-like words are the context-dependent ones
    const enforceIntent = msgs.some((m) => m.direction === 'IN' && !!objectionOf(m.text)) || ACK_ONLY.test(last.text) || (!explicitBooking && (wishOfTime || turnedDown)) || unclearNeed(last.text) || comparison || priceOnlyPref;
    const bookingIntent = intentSignal && !priceOnlyPref;
    const closing = closesDialogue(objection, last.text);
    // The question about the criterion is not repeated. Whether the patient has ALREADY stated a criterion (briefly or at length) is left to the model; the code keeps only this protection.
    const compareAsked = comparison && msgs.slice(0, -1).some((m, i, a) => m.direction === 'OUT' && m.text.includes('?') && a.slice(0, i).some((x) => x.direction === 'IN' && comparisonAsk(x.text)));
    // One clarification per concern, read from what was really sent (see clarificationBlocked): not from "any question in the last eight messages"
    const clarifyBlocked = await this.clarificationBlocked(clinicId, channel, chatId, prevOut ?? null, objection);
    const askedRecently = clarifyBlocked;
    const clarifyOk = mayClarify(objection, last.text) && !askedRecently;
    const ctx: DecisionContext = {
      serviceRefs: kb.items.map((x) => x.ref),
      advantageRefs: [],
      objectionRefs: [],
      hasService: !!(state?.serviceId || open?.service),
      hasChosenTime: !!open?.slotAt && (open.stage === 'COLLECT' || open.stage === 'CONFIRM'),
      // an objection with only a noun of price in it ("занадто висока ціна") is not a request for a price; an explicit question still is
      priceQuestion: objection || comparison ? priceAsked(last.text) : isPriceQuestion(last.text), // ("важлива ціна" as a criterion is not a request for a price)
      objection: !!objection,
      bookingIntent,
      intentRequired: enforceIntent,
      clarifyCount: state?.clarifyCount ?? 0,
      maxClarify: MAX_CLARIFY,
    };
    // ONE rule about the price lines of this reply, used twice: it is told to the model (a line of the state below) and it filters what the model asked for (see priceRefs), so the
    // text and the rendering follow the same facts. none: no line (an objection without a request for the price). one: a comparison, only the service the dialogue is about or the one
    // the message clearly names. which: a comparison and no such service, no line (when the price is the criterion, the question which service). listed: the services the model lists.
    const compareOnly = comparison && !bookNow && !ctx.priceQuestion;
    const compareItem = compareOnly ? (knownItem ?? kb.items.find((x) => x.ref === clearestServiceRef(kb.items)[0]) ?? null) : null;
    const priceRule: 'none' | 'one' | 'which' | 'listed' = objection && !ctx.priceQuestion ? 'none' : compareOnly ? (compareItem ? 'one' : 'which') : 'listed';
    const alreadyNamed = priceRule === 'listed' && !ctx.priceQuestion ? kb.items.filter((x) => priceGivenBefore(msgs, x.title)).map((x) => x.title) : [];
    const priceLine =
      priceRule === 'none'
        ? 'ціни в цій відповіді: рядків із цінами НЕ буде (пацієнт про ціну не питає); не анонсуй і не обіцяй ціну'
        : priceRule === 'one'
          ? `ціни в цій відповіді: код покаже попередню ціну лише послуги «${compareItem!.title}» і лише якщо її позначка є в "prices" (додай її, якщо ціна — критерій пацієнта чи він про неї питає); інших цін не буде, не анонсуй їх і не перелічуй прайс; не додавай заспокоєнь про страх чи іншого, про що не питали`
          : priceRule === 'which'
            ? 'ціни в цій відповіді: послуга невідома, тому рядків із цінами НЕ буде; якщо критерій пацієнта — ціна, постав лише ОДНЕ питання, про яку послугу йдеться (не обирай послугу сам, не перелічуй прайс, не анонсуй ціну, не додавай заспокоєнь про страх)'
            : `ціни в цій відповіді: код покаже рядки з попередніми цінами послуг із "prices"${alreadyNamed.length ? `; ціну ${alreadyNamed.map((t) => `«${t}»`).join(', ')} уже називали — її рядка не буде (не анонсуй її знову)` : ''}`;
    const bookingStatus = await bookingStatusOf(this.prisma, clinicId, channel, chatId);
    // the soft offer counts only when it was REALLY sent (a draft, a rejected draft or a failed send is not in the dialogue)
    const softOfferSent = msgs.some((m) => m.direction === 'OUT' && (m.text.includes(SOFT_OFFER.uk) || m.text.includes(SOFT_OFFER.ru)));
    const stateLines = [
      `послуга: ${open?.service ?? stateService?.title ?? (state?.serviceId ? 'обрана раніше' : 'ще не названа')}`,
      `час обрано: ${ctx.hasChosenTime ? 'так' : 'ні'}`,
      `уточнюючих питань уже задано: ${ctx.clarifyCount} з ${MAX_CLARIFY}`,
      ...(offeredBefore(msgs).size ? ['пацієнту вже пропонували вільні вікна кнопками (повторювати ті самі не потрібно)'] : []),
      state?.owner === 'HUMAN' ? 'діалог веде співробітник (чернетка лише для нього)' : 'діалог веде бот',
      // the booking as the SYSTEM records it (a fact from the booking request, no contacts): what the model may say about it, and what it must not
      ...(bookingStatus?.kind === 'CONFIRMED' ? [`запис УЖЕ створено системою й підтверджено: ${bookingStatus.service ?? 'послуга'}, ${bookingStatus.date} о ${bookingStatus.time} (це достовірний факт із системи; не спростовуй його)`] : []),
      ...(bookingStatus?.kind === 'CANCELLED' ? [`запис ${bookingStatus.service ?? 'послуга'}, ${bookingStatus.date} о ${bookingStatus.time} СКАСОВАНО (достовірний факт із системи): не кажи, що він діє чи підтверджений; новий запис — лише якщо пацієнт сам про нього просить`] : []),
      ...(bookingStatus?.kind === 'UNKNOWN' ? [bookingStatus.cancel ? 'результат скасування запису ще невідомий: не називай запис ні скасованим, ні чинним' : bookingStatus.move ? 'результат перенесення запису ще невідомий: не називай ні старий, ні новий час підтвердженим' : 'результат створення запису ще невідомий: не називай запис створеним і не кажи, що його не створено'] : []),
      ...(state?.salesStage === 'DECLINED' ? ['пацієнт раніше відмовився чи відклав запис; нове ПРЯМЕ прохання записатися дійсне й виконується одразу'] : []),
      ...(closing ? [`останнє повідомлення пацієнта — ${objection === 'afford' ? 'зараз не може собі цього дозволити' : objection === 'hesitation' ? 'пауза (подумає, порадиться, не зараз)' : 'відмова'} (за кодом): коротко визнай і зупинись — content.kind ANSWER, next.action CLOSE; без питань, без пропозиції запису, без переконування й без згадки цін`] : []),
      ...(objection === 'price' ? ['останнє повідомлення пацієнта — сумнів щодо ціни (за кодом): content.kind HANDLE_DOUBT, next.action NONE; коротко визнай; якщо в довідці є склад послуги — можеш коротко його пояснити, якщо ні — достатньо короткого визнання; не питай про бюджет, не додавай суми, пропозиції запису й питання; якщо в цьому ж повідомленні є пряме питання (адреса, тривалість, точна ціна) — відповідай і на нього'] : []),
      ...(objection === 'hesitation' && !closing ? ['останнє повідомлення пацієнта — невпевненість (за кодом): коротка тепла відповідь за довідкою, content.kind HANDLE_DOUBT, next.action NONE, без питань і без пропозиції запису'] : []),
      ...(objection === 'fear' || objection === 'distrust'
        ? [`останнє повідомлення пацієнта — ${objection === 'fear' ? 'страх' : 'недовіра чи поганий досвід'} (за кодом): content.kind HANDLE_DOUBT, next.action NONE; визнай, не применшуючи; пояснюй лише за довідкою; жодних обіцянок безболісності, безпеки чи результату; без пропозиції запису; ${clarifyOk ? 'можна поставити ОДНЕ коротке уточнення (що саме турбує), лише якщо від відповіді залежить, що ти скажеш далі; якщо пацієнт уже пояснив — без питання' : 'питань більше не став (уточнення вже було або пацієнт уже пояснив)'}; якщо потрібен лікар чи адміністратор — можна запропонувати передачу (HAND_OFF)`]
        : []),
      ...(comparison && !bookNow
        ? [`останнє повідомлення пацієнта — порівняння клінік чи «чому ви» (за кодом): відповідай по суті, а не про себе: 2–3 найдоречніші перевірені факти зі довідки (про відому послугу чи турботу пацієнта, якщо вони є; інакше найкорисніші — склад консультації, відповіді на часті питання); не перелічуй усе підряд (ціни, адреси, години — лише якщо про них питають чи вони стосуються); нічого про інші клініки й жодного «кращі/найкращі/єдині»; без пропозиції записатися чи підібрати час. Критерій вибору розпізнавай за змістом, навіть коли він сказаний коротко («важлива ціна», «боюсь болю», «важно качество»): якщо пацієнт його вже пояснив, не питай, що для нього важливо; довге речення про інше критерієм не є. ${compareAsked ? 'Питання про критерій ти вже ставив: не повторюй його. ' : ''}Якщо немає ні відповідних фактів, ні зрозумілого критерію — постав ОДНЕ коротке питання «Що для вас найважливіше при виборі клініки?» і нічого більше (без пропозиції адміністратора в тому ж повідомленні). Якщо критерій зрозумілий, а фактів для відповіді немає — next.action HAND_OFF (reason needs_clarification): система запропонує адміністратора питанням і передасть діалог лише після згоди; сам нічого не обіцяй. Не згадуй довідку, дані чи те, що чогось не можеш вигадувати`]
        : []),
      priceLine,
      ...(byDoctors && namedDoctors.length === 1
        ? [`пацієнт назвав лікаря ${namedDoctors[0]} (за кодом: такий лікар Є серед лікарів клініки, навіть якщо його немає в довідці): чи він надає послугу, його вільний час і запис визначає й пише код; ти про цього лікаря нічого не стверджуй (не кажи, що його немає, що ти його не знаєш, що він вільний чи приймає), відповідай лише на інші питання пацієнта й, якщо пацієнт хоче записатися, постав next.action OFFER_TIME`]
        : byDoctors && namedDoctors.length > 1
          ? [`під слова пацієнта підходять кілька лікарів клініки (${namedDoctors.join(', ')}): якого саме, уточнить код; не обирай лікаря й нічого про них не стверджуй`]
          : byDoctors && doctorReq?.doctor
            ? [`лікар цієї заявки на запис: ${doctorReq.doctor} (визначив код); про інших лікарів нічого не стверджуй`]
            : []),
      ...(wishState && (wishState.wish || wishState.ambiguous.length)
        ? [`пацієнт назвав лікаря ${wishState.wish ?? wishState.ambiguous.join(' / ')} (за кодом): вільний час видно лише по кабінетах, тож він нічого не каже про цього лікаря; не обіцяй запис саме до нього, не кажи, що він приймає чи вільний; вибір (лікар, якого призначить клініка, чи побажання адміністратору) пропонує код`]
        : []),
      ...(priceOnlyPref ? ['пацієнт просив лише інформацію про ціну, без запису (за кодом; діє, доки він сам прямо не попросить записати): відповідай на його питання (ціну — через "prices"), без пропозиції записатися чи підібрати час, без питань про запис і без OFFER_TIME; код теж не додасть запрошення; послугу, яку не назвав, не вгадуй'] : []),
      ...(softOfferSent ? ['пропозицію підібрати зручний час уже надсилали: не повторюй її в кожній відповіді'] : []),
    ];
    // What the model gets is a CLEANED COPY of the dialogue: the contacts collected for the booking are not sent (see contact-mask.ts); the stored chat is unchanged
    const patientContacts = await contactsOf(this.prisma, clinicId, channel, chatId);
    const clean = scrubMessages(msgs.map((m) => ({ role: (m.direction === 'IN' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.text })), patientContacts);
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of clean) {
      const role = m.role;
      if (!turns.length && role === 'assistant') continue;
      if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += `\n${m.content}`;
      else turns.push({ role, content: m.content });
    }
    const contacts = [clinic.publicAddress && `адреса: ${clinic.publicAddress}`, clinic.publicDirections && `як дістатися: ${clinic.publicDirections}`, clinic.publicPhone && `телефон адміністратора: ${clinic.publicPhone}`].filter(Boolean).join('; ') || null;
    const refs = kb.items.map((x) => x.ref);
    const titles = kb.items.map((x) => x.title);
    const schema = decisionSchema(refs);

    const attempt = async (problem: Problem | null, billable: boolean): Promise<Attempt | Problem> => {
      const system = AGENT_SYSTEM({ clinic: clinic.name, today: todayText(), hours: hoursText, contacts, kbText: kb.text, state: stateLines, maxClarify: MAX_CLARIFY, lang, reminder: problem ? reminderFor(problem) : '' });
      const r = await this.ai.complete(clinicId, 'chat_draft', system, turns, AGENT_MAX_TOKENS, 'chat', billable, { schema, contacts: patientContacts });
      const record = diagnostics ? (diagnostics.attempts.push({ raw: r.text, stopReason: r.stopReason ?? null, thinkingTokens: r.thinkingTokens ?? null, problem: null, detail: null }), diagnostics.attempts[diagnostics.attempts.length - 1]) : null;
      const refuse = (p: Problem): Problem => {
        if (record) {
          record.problem = p.code;
          record.detail = p.detail ?? null;
        }
        return p;
      };
      const parsed = parseDecisionText(r.text, r.stopReason ?? null);
      if ('code' in parsed) return refuse(parsed);
      // A service chosen by the model from a DESCRIBED need (the patient neither named it nor asked to book it, or said they do not know which one) is not accepted unless the clinic's own
      // approved description names that service as a first step: the model's suitability judgement is not routing information. The reference is dropped before the contract settles the action.
      const routedNotes: string[] = [];
      const rawNext = (parsed.raw as { next?: { service?: unknown } } | null)?.next;
      if (rawNext && typeof rawNext.service === 'string' && !ctx.hasService) {
        const ref = rawNext.service.trim().replace(/^\[|\]$/g, '').toUpperCase();
        const item = kb.items.find((x) => x.ref === ref);
        if (item && (item.score ?? 0) === 0 && !msgs.some((m) => m.text.toLowerCase().includes(item.title.toLowerCase())) && (unclearNeed(last.text) || !bookingSignal(last.text))) {
          const routed = await this.eligibleServices(clinicId, clinic.scheduleMode, autoOnly, true);
          if (!routed.some((x) => x.id === item.id)) {
            rawNext.service = null;
            routedNotes.push('service_not_routed');
          }
        }
      }
      const resolved = resolveDecision(parsed.raw, ctx);
      if (resolved.ok) resolved.notes.push(...routedNotes);
      if (!resolved.ok) return refuse({ code: resolved.problem });
      const d = resolved.decision;
      // A refusal, a pause ("I will think", "I need to ask someone", "not now") and "I cannot afford it now" close the exchange whatever the model chose: thanks only, no persuasion. A patient who
      // also asks a price question keeps that answer (it is not closed). A hand-over stays a hand-over.
      if (closing && d.next.action !== 'CLOSE' && d.next.action !== 'HAND_OFF') {
        resolved.notes.push('closed_by_code');
        d.next.action = 'CLOSE';
        d.next.service = null;
        d.content.kind = 'ANSWER';
        d.content.advantages = [];
        d.content.objection = null;
      }
      const requested = ((parsed.raw as { next?: { action?: unknown } }).next?.action ?? d.next.action) as NextAction;
      // A comparison question: no invitation to book, no hand-over by the model on its own (an offer by the code instead), and a question only when it is allowed
      if (comparison && !bookNow) {
        if (d.next.action === 'HAND_OFF' && d.next.reason !== 'asked_for_person') {
          d.next.action = 'NONE';
          d.next.reason = null;
          d.content.kind = 'ANSWER';
          resolved.notes.push('handoff_offered_not_done');
          return { requested, decision: d, notes: resolved.notes, reply: COMPARE_HELP[lang], intro: COMPARE_HELP[lang], after: null, priceRefs: [] };
        }
        d.content.reply = dropInvitations(d.content.reply) || d.content.reply;
        if (d.content.after) d.content.after = dropInvitations(d.content.after) || null;
      }
      // A booking asked for with no known service: the text of the model is NOT used (the code asks the one question about the service), so its words are not checked
      if (requested === 'OFFER_TIME' && resolved.notes.includes('offer_without_service')) return { requested, decision: d, notes: resolved.notes, reply: '', intro: '', after: null, priceRefs: [] };
      const free = `${d.content.reply} ${d.content.after ?? ''}`;
      // A price already given in this dialogue is not repeated (after "expensive", for example), unless it is asked again; a changed service or an explicit
      // repeated question always gets its line
      const priceRefs = d.content.prices.filter((ref) => {
        const item = kb.items.find((x) => x.ref === ref);
        // the same rule the model was told (priceRule): after an objection the price list is not appended by itself (only an explicit request for the price gets it)
        if (priceRule === 'none') return false;
        // a comparison answer carries no price list by itself: only the price of the service the dialogue is about or the message clearly names (rendered by the code, provisional)
        if (priceRule === 'one' || priceRule === 'which') return !!item && !!compareItem && item.ref === compareItem.ref;
        return !item || ctx.priceQuestion || !priceGivenBefore(msgs, item.title);
      });
      // The price is the patient's criterion and no service is in sight: the one question which service, written by the code. No arbitrary service, no whole price list, nothing
      // about anything else. Neither sign decides alone: the patient's message speaks about the price AND the model read it as wanting one (it listed prices or announced them); a
      // price word the model did not take for the criterion ("ціна не головне") changes nothing.
      if (priceRule === 'which' && isPriceQuestion(last.text) && (d.content.prices.length > 0 || free.split(/(?<=[.!?…])\s+|\n+/).some((x) => announcesPrice(x)))) {
        resolved.notes.push('price_criterion_which_service');
        d.content.kind = 'ANSWER';
        d.next.action = 'NONE';
        d.next.service = null;
        return { requested, decision: d, notes: resolved.notes, reply: WHICH_SERVICE_PRICE[lang], intro: WHICH_SERVICE_PRICE[lang], after: null, priceRefs: [] };
      }
      // a hand-over speaks with the fixed words of the code (an offer, never "done"), not the model's; a price question keeps its direct answer ("the price is to be
      // clarified" or the sum) before the offer, from the model's references or, when it gave none, from the one service the question is clearly about
      if (d.next.action === 'HAND_OFF') {
        const ids = priceRefs.length ? priceRefs : ctx.priceQuestion ? clearestServiceRef(kb.items) : [];
        const lines = ids.length ? composePriceReply({ intro: '', after: null, ids }, kb.items, lang, AGENT_PRICE_OPTS) : null;
        const text = [lines && 'reply' in lines ? lines.reply : '', AGENT_HANDOFF_TEXT[lang]].filter((x) => x.trim()).join('\n\n');
        const execText = [lines && 'reply' in lines ? lines.reply : '', handoffText(lang)].filter((x) => x.trim()).join('\n\n');
        return { requested, decision: d, notes: resolved.notes, reply: text, intro: '', after: null, priceRefs: ids, handoffExec: execText };
      }
      // The reply carries no price line: a sentence that announces a price ("ось вартість", "ціну назвемо") would promise what is absent, so it goes; nothing left -> written again
      if (!priceRefs.length) {
        const kept = dropPriceAnnouncements(d.content.reply);
        if (!kept.trim()) {
          // (a sentence about the machinery, "the price will be in a line below", keeps its own, more exact reason)
          const how = mechanismMention(free);
          return refuse(how ? { code: 'mechanism_in_text', detail: how } : { code: 'price_not_shown' });
        }
        d.content.reply = kept;
        if (d.content.after) d.content.after = dropPriceAnnouncements(d.content.after) || null;
      }
      const composed = composePriceReply({ intro: d.content.reply, after: d.content.after, ids: priceRefs }, kb.items, lang, AGENT_PRICE_OPTS);
      if ('problem' in composed) return refuse({ code: composed.problem });
      // the price status is never denied, in any wording (next to a sum the lead-in "точна вартість" is already softened by the code, so the softened text is what is read)
      const pricedKnown = priceRefs.some((ref) => kb.items.find((x) => x.ref === ref)?.state === 'KNOWN');
      const said0 = `${d.content.reply} ${d.content.after ?? ''}`;
      const denied = priceStatusDenied(pricedKnown ? softenExact(said0) : said0);
      if (denied) return refuse({ code: 'price_status_denied', detail: denied });
      // the exact approved title of a service is not a promise; everything around it is checked in full
      const claim = claimMatch(free, titles);
      if (claim) return refuse({ code: 'risky_claim', detail: claim });
      // Stage 2: ONE useful clarification is allowed for a fear or a distrust that the patient has not explained yet (never after a price concern, a pause, a refusal or "cannot afford",
      // never a second one, never one that repeats an ignored question). Allowing it does not allow an offer: the nudges stay off (the soft offer needs no objection and no question).
      if (free.includes('?') && d.next.action !== 'CLOSE') {
        if (objection && !clarifyOk) return refuse({ code: 'question_after_objection' });
        if (!objection && d.content.kind === 'HANDLE_DOUBT' && askedRecently) return refuse({ code: 'question_after_objection' });
      }
      // an address or a phone number the clinic never entered is an invention: only "not known" can be said
      const invented = inventedContact(free, { address: !!clinic.publicAddress || !!clinic.publicDirections || kbHasContacts, phone: !!clinic.publicPhone || kbHasContacts });
      if (invented) return refuse({ code: 'invented_contact', detail: invented });
      // at most ONE question to the patient in a message (the code's own lines are not counted here; the soft offer is added only when the text has no question)
      if ((free.match(/\?/g) ?? []).length > 1) return refuse({ code: 'several_questions' });
      // no time at all in the model's text: not a free slot, not the client's wish (the code confirms it), not the clinic's hours (the code answers them)
      if (timesOutsideWindows(free, [])) return refuse({ code: 'time_outside_windows' });
      const mechanism = mechanismMention(free);
      if (mechanism) return refuse({ code: 'mechanism_in_text', detail: mechanism });
      // no claim of superiority, no remark about other clinics, whatever the question was
      const superior = superiorityClaim(free);
      if (superior) return refuse({ code: 'superiority_claim', detail: superior });
      if (comparison && !bookNow && free.includes('?') && compareAsked) return refuse({ code: 'compare_question_not_needed' });
      // the text must agree with the action: only OFFER_TIME may speak about the times, and no other action is promised or reported as done
      if (d.next.action !== 'OFFER_TIME') {
        const promise = actionPromise(free, bookingStatus?.kind === 'CONFIRMED');
        if (promise) return refuse({ code: 'action_promise', detail: promise });
      }
      // A changed form of a service title is a question of language quality, not of safety: it is NOT a reason to refuse (the evaluation flags it, see inflectedTitle)
      // the WHOLE final reply (the lines of the code included) must carry no internal reference
      const leak = internalReferenceIn(composed.reply, titles, refs);
      if (leak) return refuse({ code: 'internal_reference_in_text', detail: leak });
      // the language is checked on the first try only (a reply in the other language of the patient is better than none)
      // The language of the model's PROSE is validated on every try, against the one resolved language of the conversation (the clinic's stored names inside it are not prose). First
      // try: written again with the language named. Second try still wrong: the prose is NOT sent; the decision of the model stands and the reply is assembled from the code's own
      // lines in the resolved language (prices, times, the closing), see the end of generate.
      const said = detectLanguageAgent(withoutStoredNames(stripNotice(`${d.content.reply} ${d.content.after ?? ''}`), [...titles, clinic.publicAddress, clinic.publicDirections]));
      let proseDropped = false;
      if (said && said !== lang) {
        if (billable) return refuse({ code: 'wrong_language', detail: lang });
        if (record) record.problem = 'wrong_language';
        resolved.notes.push('wrong_language_prose_dropped');
        d.content.reply = '';
        d.content.after = null;
        proseDropped = true;
      }
      // a closing (a decline, "I will think"): thanks only, no question, no offer to book, no price lines
      if (d.next.action === 'CLOSE') {
        // Every explicit factual question is still answered (the code's own answer about the address, phone and hours; the model's statements; the price lines when the price was asked), then
        // the thanks: no question, no offer, no persuasion
        const factual = asksFact(last.text) || ctx.priceQuestion;
        const kept = factual ? closingKeepFacts(d.content.reply) : closingOnly(d.content.reply);
        const priceLines = ctx.priceQuestion && priceRefs.length ? composePriceReply({ intro: '', after: null, ids: priceRefs }, kb.items, lang, AGENT_PRICE_OPTS) : null;
        const parts = [factual ? directClosing : null, kept, priceLines && 'reply' in priceLines ? priceLines.reply : ''].filter((x): x is string => !!x && !!x.trim());
        const thanks = /(дяку|спасиб)/i.test(parts.join(' '));
        const closingText = factual ? [...parts, thanks ? '' : CLOSE_TEXT[lang]].filter((x) => x.trim()).join('\n\n') : kept || CLOSE_TEXT[lang];
        return { requested, decision: d, notes: resolved.notes, reply: closingText, intro: closingText, after: null, priceRefs: factual ? priceRefs.filter(() => !!priceLines) : [] };
      }
      if (proseDropped) {
        const lines = composePriceReply({ intro: '', after: null, ids: priceRefs }, kb.items, lang, AGENT_PRICE_OPTS);
        return { requested, decision: d, notes: resolved.notes, reply: 'reply' in lines ? lines.reply : '', intro: '', after: null, priceRefs };
      }
      return { requested, decision: d, notes: resolved.notes, reply: composed.reply, intro: d.content.reply, after: d.content.after, priceRefs };
    };

    let calls = 0;
    const retryReasons: string[] = [];
    let result: Attempt | Problem;
    try {
      calls++;
      result = await attempt(null, true);
      if ('code' in result) {
        // one repeat, with the exact reason of the refusal
        retryReasons.push(result.code);
        calls++;
        result = await attempt(result, false);
      }
    } catch (e) {
      // the allowance is used up or the model is not available: nothing usable, a person is suggested
      const code = (e as Error).message === 'ai_limit' ? 'ai_limit' : 'model';
      this.log.warn(`Agent draft: no model answer (${code}) (clinic ${clinicId})`);
      return fallback(code, calls, [...retryReasons, `error:${code}`]);
    }
    if ('code' in result && objection && !['truncated', 'not_json', 'json_parse_error', 'refusal'].includes(result.code)) {
      // The model twice wrote something the checks refused, in an ordinary (non-urgent) objection: a short grounded reply written by the code is better than notifying the staff. The
      // urgent and medical topics, a request for a person and every question that needs a person were routed before the model and never get here. No other model call is made.
      const grounded = await this.groundedObjectionReply({ clinicId, lang, objection, closing, ctx, lastText: last.text, direct: directClosing, target: (open?.service ? kb.items.find((x) => x.title === open.service) : undefined) ?? stateService, items: kb.items });
      if (grounded) {
        this.log.log(`Agent draft: grounded reply after refused tries (${result.code}) (clinic ${clinicId})`);
        retryReasons.push(result.code, 'grounded_fallback');
        const action: NextAction = closing ? 'CLOSE' : 'NONE';
        const dec: Decision = { content: { kind: closing ? 'ANSWER' : 'HANDLE_DOUBT', reply: grounded.reply, after: null, prices: grounded.priceRefs, advantages: [], objection: null }, next: { action, service: null, reason: null } };
        result = { requested: action, decision: dec, notes: ['grounded_fallback'], reply: grounded.reply, intro: grounded.reply, after: null, priceRefs: grounded.priceRefs };
      }
    }
    if ('code' in result) {
      this.log.log(`Agent draft rejected: ${result.code} (clinic ${clinicId})`);
      return fallback(result.code === 'truncated' || result.code === 'not_json' || result.code === 'json_parse_error' || result.code === 'refusal' ? 'model' : 'reply_check', calls, [...retryReasons, result.code]);
    }

    const { decision, notes, requested, intro, reply: composedReply, priceRefs, handoffExec } = result;
    if (notes.includes('wrong_language_prose_dropped')) retryReasons.push('wrong_language');
    const proposed = requested;
    // A booking was asked for but no service is known (none in the dialogue, none named): ONE question about the service, always written by the code from the list of services
    // that can really be booked (the model's own wording of it is never used); never "yes, we will find a time" without a service, and never a second question once the
    // limit of clarifications is used. It holds both when the model asked for times and when it wrote the question itself.
    const asksServiceItself = decision.content.kind === 'CLARIFY' && !ctx.hasService && !decision.next.service && wantsBooking(last.text);
    if ((requested === 'OFFER_TIME' && notes.includes('offer_without_service')) || asksServiceItself) {
      if (ctx.clarifyCount >= MAX_CLARIFY) return suggestHandoff('service_unknown', calls);
      const eligible = await this.eligibleServices(clinicId, clinic.scheduleMode, autoOnly);
      // the patient's other questions were answered in the model's text: that stays (its question and any service it names that cannot be booked online go)
      const keep = new Set(eligible.map((x) => x.title.toLowerCase()));
      const others = titles.filter((t) => !keep.has(t.toLowerCase()));
      const factual = asksServiceItself ? withoutQuestions(composedReply, others) : '';
      if (!eligible.length) {
        // nothing can be booked online: the staff path, as an OFFER (the text that goes out with a real hand-over says it is done only then)
        const off = ONLINE_OFF(lang, null);
        return finish({ status: 'READY', reply: [factual, off, ONLINE_OFF_OFFER(lang)].filter((x) => x.trim()).join('\n\n'), handoff: true, reason: 'online_booking_unavailable', service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed, action: 'HAND_OFF', service: null, reason: 'online_booking_unavailable', check: { ok: false, notes, rejected: 'no_eligible_service' } }, handoffSuggestion: { reason: 'online_booking_unavailable' }, modelCalls: calls, retryReasons, exec: { handoffText: [factual, off, ONLINE_OFF_DONE(lang)].filter((x) => x.trim()).join('\n\n') } });
      }
      const names = eligible.map((x) => x.title);
      return finish({ status: 'READY', reply: [factual, CLARIFY_SERVICE(lang, names)].filter((x) => x.trim()).join('\n\n'), handoff: false, reason: null, service: null, options: [], content: { kind: 'CLARIFY', prices: [], advantages: [], objection: null }, next: { proposed, action: 'NONE', service: null, reason: null, check: { ok: false, notes, rejected: 'offer_without_service' } }, handoffSuggestion: null, modelCalls: calls, retryReasons });
    }
    // A question about the preferred TIME is not a service clarification. Whoever wrote it (the model or the code), it is the code's ONE focused question (asked once per dialogue, see
    // ASK_PREFERENCE) or, when it was already asked, the search for the next times; it is never counted against the limit of service clarifications.
    const timeQuestionByModel = decision.content.kind === 'CLARIFY' && ctx.hasService && bookingIntent && !asksServiceItself;
    if (timeQuestionByModel) {
      decision.content.kind = 'ANSWER';
      decision.next.action = 'OFFER_TIME';
    }
    let action: NextAction = decision.next.action;
    // the contract's own rules may already have changed the action (a question and an action in one turn, an action without its condition)
    let rejected: string | null = requested !== action && !timeQuestionByModel ? (notes[notes.length - 1] ?? 'dropped_by_rules') : null;
    let options: SlotOption[] = [];
    let reply = composedReply;
    let handOffReason: string | null = null;
    // a hand-over made by the code (the online booking of the service is not available): its reason and the text that goes out with the hand-over request
    let forcedReason: string | null = null;
    let execText: string | undefined = handoffExec;
    let offeredServiceId: string | null = null;
    let offeredPref: TimePreference | null = null;
    const serviceItem = decision.next.service ? kb.items.find((x) => x.ref === decision.next.service) : undefined;
    // Doctors mode: the newest message names ONE doctor of the clinic and the model did not ask for times: the code still says what holds for that doctor (its own decision),
    // so a sentence of the model that denies or promises him is never the answer; the model's other sentences stay above it
    if (byDoctors && !inBookingStep && action === 'NONE' && namedDoctors.length >= 1 && doctorMsg === last) {
      // the service: the dialogue's, or the one the patient's words clearly name
      const svcN = await serviceRow(serviceItem?.id ?? state?.serviceId ?? kb.items.find((x) => x.title === open?.service)?.id ?? kb.items.find((x) => x.ref === clearestServiceRef(kb.items)[0])?.id ?? null, null);
      if (svcN) {
        const ctxN = await doctorCtx(svcN);
        let decN = await this.choice.decide(ctxN);
        if (decN.kind === 'NONE') decN = await this.choice.eligibleOffer(ctxN);
        return this.renderDoctor(decN, svcN, withoutDoctorClaims(composedReply, doctorSurnames), msgs, lang, finish, calls, retryReasons, doctorReq?.doctor ?? null, wishedTime(msgs, last.text, todayClinic));
      }
      // no service yet: the model's sentences about the doctor go; nothing else left -> the one question about the service (the code's own)
      const kept = withoutDoctorClaims(reply, doctorSurnames);
      if (kept !== reply) {
        notes.push('doctor_claims_dropped');
        reply = kept.trim() ? kept : CLARIFY_SERVICE(lang, (await this.eligibleServices(clinicId, clinic.scheduleMode, autoOnly)).map((x) => x.title));
      }
    }
    if (action === 'OFFER_TIME') {
      const serviceId = serviceItem?.id ?? state?.serviceId ?? kb.items.find((x) => x.title === open?.service)?.id ?? null;
      const pref = wishedTime(msgs, last.text, todayClinic);
      offeredServiceId = serviceId;
      offeredPref = pref;
      // the times are not looked up when the day cannot be read safely, lies beyond the search, or the patient turned the offered times down and gave no wish at all (one focused question)
      const askedPref = msgs.some((m) => m.direction === 'OUT' && (m.text.includes(ASK_PREFERENCE.uk) || m.text.includes(ASK_PREFERENCE.ru)));
      const week = new Date(Date.parse(`${todayClinic}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const until = new Date(Date.parse(`${todayClinic}T00:00:00Z`) + (SEARCH_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
      const special: { text: string; rejected: string; staff?: boolean } | null = pref?.unclear
        ? { text: DATE_UNCLEAR(lang, pref.unclear, dm(week)), rejected: pref.unclear === 'past' ? 'date_in_past' : 'date_unclear' }
        : pref?.farDays !== undefined && pref.date
          ? { text: DATE_FAR(lang, dm(pref.date), SEARCH_DAYS, dm(until)), rejected: 'date_out_of_range', staff: true }
          : sentTimes && turnedDown && !pref && !askedPref && !ANY_TIME.test(last.text) // "any time" is an answer: no question about the wish
            ? { text: ASK_PREFERENCE[lang], rejected: 'preference_needed' }
            : null;
      const composed = composePriceReply({ intro: withoutTimeSolicitation(timeQuestionByModel ? '' : intro), after: null, ids: priceRefs }, kb.items, lang, AGENT_PRICE_OPTS);
      // Doctors mode: the doctor before any time, by the same decisions as the old bot (readOnly); no preference and no doctor for a first booking: the doctors who
      // provide the service and have time. The patient's wish about the day and the time applies to that doctor's times (the cases above that need a question first
      // stay as they are). The model's own invitation to choose a time is left out (the code's line asks).
      const doctorSvc = byDoctors && !special ? await serviceRow(serviceId, null) : null;
      if (doctorSvc) {
        const ctxD = await doctorCtx(doctorSvc);
        let dec = await this.choice.decide(ctxD);
        if (dec.kind === 'NONE') dec = await this.choice.eligibleOffer(ctxD);
        return this.renderDoctor(dec, doctorSvc, withoutDoctorClaims(withoutTimeSolicitation(composedReply), doctorSurnames), msgs, lang, finish, calls, retryReasons, doctorReq?.doctor ?? null, pref);
      }
      if (wishOpen && !inBookingStep && wishState) {
        // a named doctor is not settled yet: no times (they would be the cabinets' times, not that doctor's); the answer to the question stays, the choice is asked
        rejected = 'doctor_wish_unresolved';
        action = 'NONE';
        reply = [('reply' in composed ? composed.reply : composedReply).trim(), wishText(wishState)].filter((x) => x.trim()).join('\n\n');
      } else if (special) {
        rejected = special.rejected;
        action = 'NONE';
        if (special.staff) handOffReason = 'time_preference_unavailable';
        reply = [('reply' in composed ? composed.reply : composedReply).trim(), special.text].filter((x) => x.trim()).join('\n\n');
      } else {
      const offer = await this.proposeTimes(clinicId, clinic.scheduleMode, serviceId, pref, offeredBefore(msgs));
      // ONE next step in the message: the code shows the times and asks to choose, so the model's own invitation to book (its closing, and any
      // sentence asking to choose or promising to find a time) is left out; the answer to the question and the price lines stay
      reply = 'reply' in composed ? composed.reply : composedReply;
      if (offer.options.length) {
        options = offer.options;
        reply = [reply, pref ? TIME_LINE_PREF(lang, preferencePhrase(pref, lang)) : TIME_LINE[lang]].filter((x) => x.trim()).join('\n\n');
      } else {
        // the times cannot be offered: the action is refused with the reason, and the WHOLE text follows the result (the model's own "here are the times" or
        // "yes, you can book" is dropped; the price lines the patient asked for stay)
        rejected = offer.reason;
        const lines = 'reply' in composed ? composePriceReply({ intro: '', after: null, ids: priceRefs }, kb.items, lang, AGENT_PRICE_OPTS) : null;
        const priceLines = lines && 'reply' in lines ? lines.reply : '';
        if (offer.reason === 'no_window_for_preference' || offer.reason === 'no_new_windows' || offer.reason === 'no_free_time') {
          // a wish that no window meets (or no NEW window) is said honestly instead of showing the same unsuitable times again; a person is only offered
          action = 'NONE';
          reply = [priceLines, NO_WINDOWS(lang, offer.reason === 'no_window_for_preference' ? 'preference' : 'nothingNew', pref ? preferencePhrase(pref, lang) : null, SEARCH_DAYS)].filter((x) => x.trim()).join('\n\n');
          handOffReason = 'time_preference_unavailable';
        } else {
          // the service cannot be booked online (not allowed, no length, gone from the price list, the schedule cannot be read): never "yes, you can book", never
          // another service in its place; the request goes to a person
          action = 'HAND_OFF';
          forcedReason = 'online_booking_unavailable';
          const off = ONLINE_OFF(lang, serviceItem?.title ?? null);
          reply = [priceLines, off, ONLINE_OFF_OFFER(lang)].filter((x) => x.trim()).join('\n\n');
          execText = [priceLines, off, ONLINE_OFF_DONE(lang)].filter((x) => x.trim()).join('\n\n');
        }
      }
      }
    } else if (action === 'NONE' && ctx.priceQuestion && priceRefs.length && (decision.content.kind === 'ANSWER' || decision.content.kind === 'EXPLAIN')) {
      // one soft next step after a direct answer about the price: only for a service that can be booked online, not after a decline or a hand-over, not during
      // a booking or after a visit, not while a person owns the dialogue, and once (the question is not repeated in every message)
      const busy = !!open && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage);
      const ended = ['DECLINED', 'HANDED', 'CLOSED'].includes(state?.salesStage ?? '') || state?.owner === 'HUMAN';
      // once per dialogue (really sent), never after a confirmed booking, and never next to another question of the same message
      if (!busy && !ended && !objection && !comparison && !priceOnlyPref && !softOfferSent && bookingStatus?.kind !== 'CONFIRMED' && !reply.includes('?') && clinic.scheduleMode === 'CABINETS') {
        let bookable = false;
        for (const ref of priceRefs) {
          const item = kb.items.find((x) => x.ref === ref);
          const svc = item ? await this.prisma.kbItem.findFirst({ where: { id: item.id, clinicId, kind: 'SERVICE', active: true }, select: { onlineBooking: true, durationMin: true, cabinetIds: true, missingInSourceAt: true } }) : null;
          if (svc && !(await this.cabinets.blockReason(clinicId, svc)).code) bookable = true;
        }
        if (bookable) reply = [reply, SOFT_OFFER[lang]].join('\n\n');
      }
    }
    // the final check over the whole reply, the lines of the code included
    const leak = internalReferenceIn(reply, titles, refs);
    if (leak) return fallback('reply_check', calls, [...retryReasons, 'internal_reference_in_text']);
    // The model's prose was dropped for its language and the code had nothing of its own to say (no price, no times, no closing): the existing safe text in the resolved language. It
    // only OFFERS the administrator's help; nothing is handed over and no action is claimed (a language failure alone is not a reason for a hand-over).
    if (!reply.trim() && notes.includes('wrong_language_prose_dropped')) {
      reply = AGENT_FALLBACK_TEXT[lang];
      decision.content.kind = 'ANSWER'; // (not a clarification of the service: it is not counted against that limit)
    }
    const suggestion = action === 'HAND_OFF' ? { reason: forcedReason ?? decision.next.reason ?? 'other' } : handOffReason ? { reason: handOffReason } : null;
    return finish({
      status: 'READY',
      reply,
      handoff: action === 'HAND_OFF',
      reason: action === 'HAND_OFF' ? (forcedReason ?? decision.next.reason ?? 'other') : null,
      service: serviceItem?.title ?? null,
      options,
      content: { kind: decision.content.kind, prices: decision.content.prices, advantages: decision.content.advantages, objection: decision.content.objection },
      next: { proposed, action, service: serviceItem?.title ?? null, reason: decision.next.reason, check: { ok: !rejected, notes, rejected } },
      handoffSuggestion: suggestion,
      modelCalls: calls,
      retryReasons,
      exec: { serviceId: offeredServiceId ?? serviceItem?.id ?? null, prices: priceRefs.flatMap((ref) => { const it = kb.items.find((x) => x.ref === ref); return it ? [{ serviceId: it.id, title: it.title, state: it.state, amount: it.amount }] : []; }), pref: offeredPref, ...(execText ? { handoffText: execText } : {}), ...(action === 'HAND_OFF' && byDoctors && doctorReq ? { staffNote: bookingContextNote(doctorReq, wishedTime(msgs, last.text, todayClinic), forcedReason ?? decision.next.reason ?? null) } : {}) },
    });
  }

  // Does the patient's explicit "price only, no booking" preference stand now? A targeted lookup of the dialogue's own recent messages (texts and directions only, a bounded number,
  // never sent to the model): the short window loaded for the model would lose the request after a few factual questions. See priceOnlyStanding for the order of events.
  private async priceOnlyPreference(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { clinicId, channel, chatId, createdAt: { gt: new Date(Date.now() - PREFERENCE_DAYS * 86_400_000) }, NOT: { direction: 'OUT', error: { not: null } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PREFERENCE_LOOKBACK,
      select: { direction: true, text: true },
    });
    return priceOnlyStanding(rows.reverse(), (t) => t.includes(SOFT_OFFER.uk) || t.includes(SOFT_OFFER.ru));
  }

  // A doctor decision of DoctorChoiceService as the agent's draft (nothing is written: the decision travels in `exec.doctorPatch` and is saved by the execution).
  // OFFER: that doctor's (or those doctors') times, read again without the times already offered; ASK: the question and its buttons; HANDOFF: a hand-over whose text is
  // the decision's own (it says "передали" and is sent only after the request exists) and whose staff note carries the doctor and the reason.
  private async renderDoctor(dec: DoctorDecision, svc: KbItem, intro: string, msgs: { direction: string; buttons: unknown }[], lang: Lang, finish: (d: Parameters<AgentDraftService['finishShape']>[0]) => Promise<AgentDraft>, calls: number, retryReasons: string[], requestDoctor: string | null = null, pref: TimePreference | null = null): Promise<AgentDraft> {
    const base = { status: 'READY' as const, service: svc.title, modelCalls: calls, retryReasons };
    if (dec.kind === 'OFFER') {
      const doctorIds = [...new Set(dec.options.map((o) => o.doctorId).filter((x): x is string => !!x))];
      // the same searched range as the cabinets' times; the wish narrows it, the doctor stays
      const times = await this.choice.timesFor(svc.clinicId, doctorIds, svc.durationMin ?? 30, lang, offeredToDoctors(msgs), pref, SEARCH_DAYS);
      if (times.length) {
        const options = times.map((o) => ({ label: o.label, date: o.date!, time: o.time!, doctorId: o.doctorId }));
        const wishLine = pref ? PREF_NOTE(lang, preferencePhrase(pref, lang)) : '';
        return finish({ ...base, reply: [intro, dec.reply, wishLine].filter((x) => x.trim()).join('\n\n'), handoff: false, reason: null, options, content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'OFFER_TIME', action: 'OFFER_TIME', service: svc.title, reason: null, check: { ok: true, notes: ['doctor_choice_offer'], rejected: null } }, handoffSuggestion: null, exec: { serviceId: svc.id, doctorPatch: dec.patch, doctorIds, pref } });
      }
      // nothing matches within the searched range: said as exactly that (never "the doctor has no time"), the existing next step is offered as a question; the doctor
      // the decision settled stays (saved with this message), no other doctor is put in his place
      const text = NO_WINDOWS(lang, pref ? 'preference' : 'nothingNew', pref ? preferencePhrase(pref, lang) : null, SEARCH_DAYS);
      return finish({ ...base, reply: [intro, text].filter((x) => x.trim()).join('\n\n'), handoff: false, reason: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'OFFER_TIME', action: 'NONE', service: svc.title, reason: null, check: { ok: false, notes: ['doctor_choice_offer'], rejected: pref ? 'no_window_for_preference' : 'no_new_windows' } }, handoffSuggestion: { reason: 'time_preference_unavailable' }, exec: { serviceId: svc.id, doctorPatch: dec.patch, doctorIds, pref } });
    }
    if (dec.kind === 'ASK') {
      return finish({ ...base, reply: [intro, dec.reply].filter((x) => x.trim()).join('\n\n'), handoff: false, reason: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: svc.title, reason: null, check: { ok: true, notes: ['doctor_choice_question'], rejected: null } }, handoffSuggestion: null, exec: { serviceId: svc.id, doctorPatch: dec.patch, buttons: dec.buttons.filter((b) => b.payload).map((b) => ({ label: b.label, payload: b.payload! })) } });
    }
    if (dec.kind === 'HANDOFF') {
      // the doctor of the decision, or the one the request already holds (a declined alternative keeps the patient's own doctor)
      const named = dec.patch.doctor ?? requestDoctor;
      const doctor = named ? `; лікар: ${named}` : '';
      return finish({ ...base, reply: AGENT_HANDOFF_TEXT[lang], handoff: true, reason: 'needs_clarification', options: [], content: null, next: { proposed: 'HAND_OFF', action: 'HAND_OFF', service: svc.title, reason: 'needs_clarification', check: { ok: true, notes: ['doctor_choice_handoff'], rejected: null } }, handoffSuggestion: { reason: 'needs_clarification' }, exec: { serviceId: svc.id, staffNote: `${dec.note}${doctor}`, handoffText: dec.reply } });
    }
    return finish({ ...base, reply: handoffText(lang), handoff: true, reason: 'needs_clarification', options: [], content: null, next: { proposed: 'HAND_OFF', action: 'HAND_OFF', service: svc.title, reason: 'needs_clarification', check: { ok: true, notes: ['doctor_choice_none'], rejected: null } }, handoffSuggestion: { reason: 'needs_clarification' }, exec: { serviceId: svc.id, staffNote: 'лікаря не визначено' } });
  }

  // (the shape of the argument of the draft's own `finish`, for renderDoctor)
  private finishShape(d: Omit<AgentDraft, 'basis' | 'stale' | 'agent' | 'summary' | 'intent' | 'retryReasons' | 'exec'> & { retryReasons?: string[]; exec?: Partial<DraftExec> }) {
    return d;
  }

  // The reply the code writes by itself for an ordinary objection when the model's own tries were refused: a short acknowledgement, plus ONE approved fact when it can be chosen reliably
  // (the description of the service the dialogue is about, for a price concern; the one approved FAQ entry about fear, for a fear or a distrust), plus the price lines when the price was
  // asked for a known service. Nothing is invented and nothing is promised; when nothing reliable exists, the reply is the acknowledgement and a statement (not a promise) that the
  // administrator can give details. null: the case needs the old safe path (a price asked with no known service).
  private async groundedObjectionReply(i: { clinicId: string; lang: Lang; objection: Objection; closing: boolean; ctx: DecisionContext; lastText: string; direct: string | null; target: { id: string; ref: string } | null | undefined; items: { ref: string; id: string }[] }): Promise<{ reply: string; priceRefs: string[] } | null> {
    const { lang, objection } = i;
    let priceLines = '';
    let priceRefs: string[] = [];
    if (i.ctx.priceQuestion) {
      if (!i.target) return null;
      const c = composePriceReply({ intro: '', after: null, ids: [i.target.ref] }, i.items as never, lang, AGENT_PRICE_OPTS);
      if (!('reply' in c)) return null;
      priceLines = c.reply;
      priceRefs = [i.target.ref];
    }
    const facts = asksFact(i.lastText) ? i.direct : null;
    if (i.closing) return { reply: [facts, priceLines, CLOSE_TEXT[lang]].filter((x): x is string => !!x && !!x.trim()).join('\n\n'), priceRefs };
    const ACK: Record<Lang, Record<string, string>> = {
      uk: { price: 'Розумію, що вартість важлива.', fear: 'Розумію, що це може хвилювати.', distrust: 'Дякуємо, що розповіли про це.', hesitation: 'Розумію, що рішення потрібно обдумати.' },
      ru: { price: 'Понимаем, что стоимость важна.', fear: 'Понимаем, что это может волновать.', distrust: 'Спасибо, что рассказали об этом.', hesitation: 'Понимаем, что решение нужно обдумать.' },
    };
    let fact = '';
    const trusted = [{ approvedAt: { not: null } }, { externalId: { not: null }, source: 'CLINICCARDS' }];
    if (objection === 'price' && i.target) {
      const row = await this.prisma.kbItem.findFirst({ where: { id: i.target.id, clinicId: i.clinicId, kind: 'SERVICE', active: true, OR: trusted }, select: { text: true } });
      fact = sentencesUpTo(row?.text ?? '', 220);
    } else if (objection === 'fear' || objection === 'distrust') {
      const faqs = (await this.prisma.kbItem.findMany({ where: { clinicId: i.clinicId, kind: 'FAQ', active: true, approvedAt: { not: null } }, select: { title: true, text: true } })).filter((f) => /(бою|страх|страшно|тривог|нервув|хвилю|тревог|нервнич|волну|боязн)/i.test(`${f.title} ${f.text}`));
      if (faqs.length === 1) fact = sentencesUpTo(faqs[0].text, 220);
    }
    const detail: Record<Lang, string> = { uk: 'Якщо захочете більше деталей, їх уточнить адміністратор клініки.', ru: 'Если захотите больше деталей, их уточнит администратор клиники.' };
    return { reply: [facts, ACK[lang][objection] ?? ACK[lang].hesitation, fact || detail[lang], priceLines].filter((x): x is string => !!x && !!x.trim()).join('\n\n'), priceRefs };
  }

  // Has the agent already put an objection-specific clarification to the patient that makes another one inappropriate NOW? Read from what was really SENT (a sent draft of kind HANDLE_DOUBT whose
  // text asks something), with the message that triggered it. Blocked when (1) that clarification is the agent's last message (an unanswered or just answered one is not followed by a second probe,
  // whatever the new message is), or (2) it answered a concern of the same kind as the current one and the patient has written at most three messages since (the same concern, still being
  // talked about). Anything else is a new episode: a different concern, or one that returns after the conversation has moved on. This is an approximation of "the same concern", not a reliable
  // episode detector; no state is added.
  private async clarificationBlocked(clinicId: string, channel: string, chatId: string, prevOut: { id: string; text: string } | null, kind: Objection | null): Promise<boolean> {
    const rows = await this.prisma.agentDraft.findMany({ where: { clinicId, channel, chatId, status: 'SENT' }, orderBy: { createdAt: 'desc' }, take: 8, select: { createdAt: true, basisMessageId: true, messageId: true, snapshot: true } });
    const found = rows.find((r) => {
      const snap = r.snapshot as { contentKind?: string | null; reply?: string } | null;
      return snap?.contentKind === 'HANDLE_DOUBT' && (snap.reply ?? '').includes('?');
    });
    if (!found) return false;
    const reply = (found.snapshot as { reply?: string }).reply ?? '';
    if (prevOut && (found.messageId === prevOut.id || prevOut.text === reply)) return true;
    const basis = await this.prisma.chatMessage.findFirst({ where: { id: found.basisMessageId, clinicId }, select: { text: true } });
    const sameKind = !!kind && !!basis && objectionOf(basis.text) === kind;
    if (!sameKind) return false;
    const since = await this.prisma.chatMessage.count({ where: { clinicId, channel, chatId, direction: 'IN', createdAt: { gt: found.createdAt } } });
    return since <= 3;
  }

  // The services the patient may be asked to choose from when a booking is wanted but no service is named: ALL the clinic's approved services (not only the ones that fit in the
  // prompt of this turn), kept when they pass the SAME checks the times use (online booking allowed, a length, still in the price list, the schedule readable; "no free time" does
  // not exclude a service), and only then cut to four for the message. An autonomous clinic lists only its one allowed service (any other would be refused when the agent acts).
  // Cheap fields are filtered in one query, the full check (settings, schedule) runs on the candidates until four are found. Read only.
  // `only`: the services of the clinic's autonomous set (null: no restriction, as in the draft mode)
  private async eligibleServices(clinicId: string, mode: string, only: string[] | null, firstStep = false): Promise<{ id: string; title: string; text: string }[]> {
    const trusted = [{ approvedAt: { not: null } }, { externalId: { not: null }, source: 'CLINICCARDS' }];
    const rows = await this.prisma.kbItem.findMany({
      where: { clinicId, kind: 'SERVICE', active: true, OR: trusted, ...(only ? { id: { in: only } } : {}), ...(mode === 'CABINETS' ? { onlineBooking: true, durationMin: { not: null }, missingInSourceAt: null } : {}) },
      orderBy: { title: 'asc' },
      select: { id: true, title: true, text: true, onlineBooking: true, durationMin: true, cabinetIds: true, missingInSourceAt: true },
    });
    const out: { id: string; title: string; text: string }[] = [];
    // firstStep: only the services whose own approved description names them as the first step (the routing information of the clinic); the title or the price alone never does
    for (const svc of firstStep ? rows.filter((r) => namesFirstStep(r.text ?? '')) : rows) {
      if (mode === 'CABINETS') {
        const r = await this.cabinets.blockReason(clinicId, svc);
        if (r.code && r.code !== 'no_free_time') continue;
      }
      out.push({ id: svc.id, title: svc.title, text: svc.text ?? '' });
      if (out.length >= 4) break;
    }
    return out;
  }

  // The price state of every service of the clinic NOW (read only): the approval compares it with what the draft stated
  async currentPriceStates(clinicId: string): Promise<Map<string, { title: string; state: string; amount: number | null }>> {
    const kb = await this.kb.factsFor(clinicId, new Date(), '', '');
    return new Map(kb.items.map((x) => [x.id, { title: x.title, state: x.state, amount: x.amount }]));
  }

  // The offered times of a stored draft looked up AGAIN (read only) with the same service and wish, and without the times the dialogue already offered.
  // The approval compares the result with what the staff member saw.
  async refreshOptions(clinicId: string, channel: string, chatId: string, exec: Pick<DraftExec, 'serviceId' | 'pref'> & Partial<Pick<DraftExec, 'doctorIds' | 'lang'>>): Promise<{ options: SlotOption[]; reason: string | null }> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true } });
    const msgs = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId }, orderBy: { createdAt: 'desc' }, take: HISTORY, select: { direction: true, buttons: true } });
    // doctors mode: the times of the SAME doctors again (never another doctor), the way they were offered
    if (clinic.scheduleMode === 'DOCTORS' && exec.doctorIds?.length) {
      const svc = exec.serviceId ? await this.prisma.kbItem.findFirst({ where: { id: exec.serviceId, clinicId }, select: { durationMin: true } }) : null;
      const opts = await this.choice.timesFor(clinicId, exec.doctorIds, svc?.durationMin ?? 30, exec.lang ?? 'uk', offeredToDoctors(msgs), exec.pref, SEARCH_DAYS);
      return { options: opts.map((o) => ({ label: o.label, date: o.date!, time: o.time!, doctorId: o.doctorId })), reason: opts.length ? null : 'no_new_windows' };
    }
    return this.proposeTimes(clinicId, clinic.scheduleMode, exec.serviceId, exec.pref, offeredBefore(msgs), true);
  }

  // The free times for a service, calculated and READ only: the cabinets' schedule read from Cliniccards (a GET), or the report of the free slots of the
  // clinic's own copy. The client's wish about the time is applied; times already offered in this dialogue are not offered again. Nothing is claimed,
  // written or held for the client.
  // force: the schedule is read from Cliniccards NOW (not from the one-minute cache): used when a stored draft is approved
  private async proposeTimes(clinicId: string, mode: string, serviceId: string | null, pref: TimePreference | null, exclude: Set<string>, force = false): Promise<{ options: SlotOption[]; reason: string | null }> {
    const none = (): { options: SlotOption[]; reason: string } => ({ options: [], reason: pref ? 'no_window_for_preference' : 'no_new_windows' });
    const label = (date: string, time: string): SlotOption => ({ label: `${date.slice(8)}.${date.slice(5, 7)}, ${time}`, date, time });
    if (mode === 'CABINETS') {
      if (!serviceId) return { options: [], reason: 'service_unknown' };
      const svc = await this.prisma.kbItem.findFirst({ where: { id: serviceId, clinicId, kind: 'SERVICE', active: true }, select: { onlineBooking: true, durationMin: true, cabinetIds: true, missingInSourceAt: true } });
      if (!svc) return { options: [], reason: 'service_unknown' };
      // the settings and the readable schedule first (the reasons the administrator sees)
      const r = await this.cabinets.blockReason(clinicId, svc);
      if (r.code && r.code !== 'no_free_time') return { options: [], reason: r.code };
      if (!pref && !exclude.size && !force) return r.code ? { options: [], reason: r.code } : { options: r.offers.map((o) => label(o.date, o.time)), reason: null };
      const wins = await this.cabinets.windows(clinicId, { minutes: svc.durationMin!, service: svc, days: SEARCH_DAYS, force });
      const days = new Set<string>();
      const out: SlotOption[] = [];
      const seenTimes = new Set<string>();
      for (const w of wins) {
        // a wish for one day: that day only, up to three different times of it; otherwise one time per day
        if (pref?.date && w.date !== pref.date) continue;
        if (!pref?.date && days.has(w.date)) continue;
        let from = Math.ceil(w.startMin / 30) * 30;
        if (pref?.afterMin !== undefined) from = Math.max(from, Math.ceil(pref.afterMin / 30) * 30);
        const to = pref?.beforeMin !== undefined ? Math.min(w.endMin, pref.beforeMin) : w.endMin;
        if (from + svc.durationMin! > to) continue;
        // a time already offered is not offered again: the next half hour of the same window comes instead
        while (from + svc.durationMin! <= to && exclude.has(`${w.date}|${hm(from)}`)) from += 30;
        if (from + svc.durationMin! > to) continue;
        if (pref?.date && seenTimes.has(`${w.date}|${hm(from)}`)) continue;
        seenTimes.add(`${w.date}|${hm(from)}`);
        days.add(w.date);
        out.push(label(w.date, hm(from)));
        if (out.length >= 3) break;
      }
      return out.length ? { options: out, reason: null } : none();
    }
    const all = await this.assistant.freshOptions(clinicId, null).catch(() => [] as SlotOption[]);
    const fit = all.filter((o) => {
      const t = hmMinutes(o.time);
      return (pref?.afterMin === undefined || t >= pref.afterMin) && (pref?.beforeMin === undefined || t < pref.beforeMin) && !exclude.has(`${o.date}|${o.time}`);
    });
    return fit.length ? { options: fit, reason: null } : all.length ? none() : { options: [], reason: 'no_free_time' };
  }

  // Is the draft still the answer to the dialogue as it stands? A new message, a staff reply, a hand-over to a person or a change of the dialogue
  // state since the draft was made makes it stale: it must not be used, and the approval step (a later stage) refuses it.
  async staleness(clinicId: string, channel: string, chatId: string, basis: DraftBasis): Promise<{ stale: boolean; reasons: string[] }> {
    const reasons = new Set<string>();
    const since = new Date(basis.lastMessageAt);
    const later = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId, OR: [{ createdAt: { gt: since } }, { createdAt: since, id: { gt: basis.lastMessageId } }], NOT: { direction: 'OUT', error: { not: null } } }, select: { direction: true, authorUserId: true } });
    for (const m of later) reasons.add(m.direction === 'IN' ? 'new_incoming_message' : m.authorUserId ? 'staff_replied' : 'new_outgoing_message');
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true } });
    if ((state?.version ?? 0) !== basis.stateVersion) reasons.add('state_changed');
    if (state?.owner === 'HUMAN' && basis.owner !== 'HUMAN') reasons.add('staff_took_over');
    if (await this.prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, kind: 'HANDOFF', status: 'NEW', createdAt: { gte: new Date(basis.capturedAt) } }, select: { id: true } })) reasons.add('handed_to_person');
    return { stale: reasons.size > 0, reasons: [...reasons] };
  }
}
