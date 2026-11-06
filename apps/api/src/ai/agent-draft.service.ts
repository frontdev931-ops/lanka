import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { clinicDate, clinicHm } from '../common/clinic-time';
import { readWorkHours } from '../clinic/work-hours';
import { PrismaService } from '../prisma/prisma.service';
import { CabinetBookingService } from '../booking/cabinet-booking.service';
import { KbService } from '../kb/kb.service';
import { AiService } from './ai.service';
import { AGENT_SYSTEM } from './agent-prompt';
import { decisionSchema } from './agent-schema';
import { ChatAssistantService, SlotOption } from './chat-assistant.service';
import { contactReply, formatHours } from './contacts';
import { Decision, DecisionContext, NextAction, resolveDecision } from './decision-contract';
import { HandoffReason, claimMatch, composePriceReply, detectLanguage, handoffText, incomingHandoff, isPriceOnlyQuestion, isPriceQuestion, isUrgentSymptom, languageOf, stripNotice, timesOutsideWindows, withoutTimeSolicitation } from './guardrails';
import { actionPromise, mechanismMention } from './agent-checks';
import { bookingStatusOf } from './booking-status';
import { contactsOf, scrubMessages } from './contact-mask';
import { TimePreference, hm, offeredBefore, parseTimePreference, preferencePhrase } from './time-preference';

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
    wrong_language: 'відповідь не мовою пацієнта. Пиши однією мовою — мовою пацієнта.',
    price_question_unanswered: 'пацієнт питає про ціну, а в "prices" немає позначок. Додай позначки послуг (або HAND_OFF з кодом service_unknown, якщо такої послуги немає).',
    unknown_service_ref: 'позначка послуги не з довідки. Бери позначки лише з довідки вище.',
    bad_reason: 'next.reason має бути одним кодом із переліку (не слова й не речення).',
    clarify_limit: 'ліміт уточнень вичерпано: не став CLARIFY, дай відповідь або HAND_OFF.',
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
  ) {}

  async generate(clinicId: string, channel: string, chatId: string, diagnostics?: DraftDiagnostics): Promise<AgentDraft> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiAgentMode: true, name: true, workHours: true, publicAddress: true, publicPhone: true, publicDirections: true, scheduleMode: true, aiRepliesPerChatDay: true } });
    if (!clinic.aiAgentMode) throw new BadRequestException('agent_mode_off');
    // a message of ours that failed or whose result is unknown is not part of the dialogue (it must not hide the patient's last message, so a new draft can be made)
    const rows = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY });
    if (!rows.length) throw new BadRequestException('conversation_not_found');
    const msgs = rows.reverse();
    const last = msgs[msgs.length - 1];
    if (last.direction !== 'IN') throw new BadRequestException('nothing_to_answer');
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } } });
    const basis: DraftBasis = { lastMessageId: last.id, lastMessageAt: last.createdAt.toISOString(), stateVersion: state?.version ?? 0, owner: (state?.owner as 'BOT' | 'HUMAN' | undefined) ?? 'BOT', capturedAt: new Date().toISOString() };
    const lang: Lang = languageOf(msgs.filter((m) => m.direction === 'IN').map((m) => m.text).reverse());
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
    if (isUrgentSymptom(last.text, kb.pricesKnown)) return suggestHandoff('urgent');
    const topic = incomingHandoff(last.text, kb.pricesKnown);
    if (topic) return suggestHandoff(topic);

    const configured = !!clinic.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    const hoursText = configured ? formatHours(readWorkHours(clinic.workHours), lang) : null;
    // Address, phone, working hours: answered by the code from what the clinic entered (no model)
    const direct = contactReply(last.text, lang, { address: clinic.publicAddress, phone: clinic.publicPhone, directions: clinic.publicDirections, hours: hoursText, inKnowledgeBase: !!kb.text?.includes('АДРЕСИ ТА КОНТАКТИ') });
    // ...but only when contacts are ALL that was asked: a message that also asks a price goes to the model (the contacts are in its prompt), so no question is dropped
    if (direct && !isPriceQuestion(last.text)) {
      return finish({ status: 'READY', reply: direct, handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['answered_by_code'], rejected: null } }, handoffSuggestion: null, modelCalls: 0 });
    }

    const open = await this.prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, status: 'NEW', kind: { in: ['BOOKING', 'RESCHEDULE'] } }, orderBy: { createdAt: 'desc' }, select: { service: true, slotAt: true, stage: true } });
    const stateService = state?.serviceId ? kb.items.find((x) => x.id === state.serviceId) ?? null : null;
    // The price of the service the dialogue is about, asked and nothing else ("а скільки це коштує?"): answered by the code from the approved price list (the selected
    // service and its price as it is NOW), no model. A mixed message is not taken: its other questions go by their own rules (the classifiers above have already run).
    if (isPriceOnlyQuestion(last.text)) {
      const target = (open?.service ? kb.items.find((x) => x.title === open.service) : undefined) ?? stateService;
      const composed = target ? composePriceReply({ intro: '', after: null, ids: [target.ref] }, kb.items, lang, { noticeOnlyForKnown: true }) : null;
      if (target && composed && 'reply' in composed) {
        return finish({ status: 'READY', reply: composed.reply, handoff: false, reason: null, service: null, options: [], content: { kind: 'ANSWER', prices: [target.ref], advantages: [], objection: null }, next: { proposed: 'NONE', action: 'NONE', service: null, reason: null, check: { ok: true, notes: ['answered_by_code'], rejected: null } }, handoffSuggestion: null, modelCalls: 0, exec: { prices: [{ serviceId: target.id, title: target.title, state: target.state, amount: target.amount }] } });
      }
    }
    const ctx: DecisionContext = {
      serviceRefs: kb.items.map((x) => x.ref),
      advantageRefs: [],
      objectionRefs: [],
      hasService: !!(state?.serviceId || open?.service),
      hasChosenTime: !!open?.slotAt && (open.stage === 'COLLECT' || open.stage === 'CONFIRM'),
      priceQuestion: isPriceQuestion(last.text),
      clarifyCount: state?.clarifyCount ?? 0,
      maxClarify: MAX_CLARIFY,
    };
    const bookingStatus = await bookingStatusOf(this.prisma, clinicId, channel, chatId);
    const stateLines = [
      `послуга: ${open?.service ?? stateService?.title ?? (state?.serviceId ? 'обрана раніше' : 'ще не названа')}`,
      `час обрано: ${ctx.hasChosenTime ? 'так' : 'ні'}`,
      `уточнюючих питань уже задано: ${ctx.clarifyCount} з ${MAX_CLARIFY}`,
      ...(offeredBefore(msgs).size ? ['пацієнту вже пропонували вільні вікна кнопками (повторювати ті самі не потрібно)'] : []),
      state?.owner === 'HUMAN' ? 'діалог веде співробітник (чернетка лише для нього)' : 'діалог веде бот',
      // the booking as the SYSTEM records it (a fact from the booking request, no contacts): what the model may say about it, and what it must not
      ...(bookingStatus?.kind === 'CONFIRMED' ? [`запис УЖЕ створено системою й підтверджено: ${bookingStatus.service ?? 'послуга'}, ${bookingStatus.date} о ${bookingStatus.time} (це достовірний факт із системи; не спростовуй його)`] : []),
      ...(bookingStatus?.kind === 'UNKNOWN' ? ['результат створення запису ще невідомий: не називай запис створеним і не кажи, що його не створено'] : []),
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
      const resolved = resolveDecision(parsed.raw, ctx);
      if (!resolved.ok) return refuse({ code: resolved.problem });
      const d = resolved.decision;
      const requested = ((parsed.raw as { next?: { action?: unknown } }).next?.action ?? d.next.action) as NextAction;
      const free = `${d.content.reply} ${d.content.after ?? ''}`;
      // A price already given in this dialogue is not repeated (after "expensive", for example), unless it is asked again; a changed service or an explicit
      // repeated question always gets its line
      const priceRefs = d.content.prices.filter((ref) => {
        const item = kb.items.find((x) => x.ref === ref);
        return !item || ctx.priceQuestion || !priceGivenBefore(msgs, item.title);
      });
      // a hand-over speaks with the fixed words of the code (an offer, never "done"), not the model's; a price question keeps its direct answer ("the price is to be
      // clarified" or the sum) before the offer, from the model's references or, when it gave none, from the one service the question is clearly about
      if (d.next.action === 'HAND_OFF') {
        const ids = priceRefs.length ? priceRefs : ctx.priceQuestion ? clearestServiceRef(kb.items) : [];
        const lines = ids.length ? composePriceReply({ intro: '', after: null, ids }, kb.items, lang, { noticeOnlyForKnown: true }) : null;
        const text = [lines && 'reply' in lines ? lines.reply : '', AGENT_HANDOFF_TEXT[lang]].filter((x) => x.trim()).join('\n\n');
        const execText = [lines && 'reply' in lines ? lines.reply : '', handoffText(lang)].filter((x) => x.trim()).join('\n\n');
        return { requested, decision: d, notes: resolved.notes, reply: text, intro: '', after: null, priceRefs: ids, handoffExec: execText };
      }
      const composed = composePriceReply({ intro: d.content.reply, after: d.content.after, ids: priceRefs }, kb.items, lang, { noticeOnlyForKnown: true });
      if ('problem' in composed) return refuse({ code: composed.problem });
      // the exact approved title of a service is not a promise; everything around it is checked in full
      const claim = claimMatch(free, titles);
      if (claim) return refuse({ code: 'risky_claim', detail: claim });
      // no time at all in the model's text: not a free slot, not the client's wish (the code confirms it), not the clinic's hours (the code answers them)
      if (timesOutsideWindows(free, [])) return refuse({ code: 'time_outside_windows' });
      const mechanism = mechanismMention(free);
      if (mechanism) return refuse({ code: 'mechanism_in_text', detail: mechanism });
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
      const said = detectLanguage(stripNotice(free));
      if (billable && said && said !== lang) return refuse({ code: 'wrong_language' });
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
    if ('code' in result) {
      this.log.log(`Agent draft rejected: ${result.code} (clinic ${clinicId})`);
      return fallback(result.code === 'truncated' || result.code === 'not_json' || result.code === 'json_parse_error' || result.code === 'refusal' ? 'model' : 'reply_check', calls, [...retryReasons, result.code]);
    }

    const { decision, notes, requested, intro, reply: composedReply, priceRefs, handoffExec } = result;
    const proposed = requested;
    let action: NextAction = decision.next.action;
    // the contract's own rules may already have changed the action (a question and an action in one turn, an action without its condition)
    let rejected: string | null = requested !== action ? (notes[notes.length - 1] ?? 'dropped_by_rules') : null;
    let options: SlotOption[] = [];
    let reply = composedReply;
    let handOffReason: string | null = null;
    // a hand-over made by the code (the online booking of the service is not available): its reason and the text that goes out with the hand-over request
    let forcedReason: string | null = null;
    let execText: string | undefined = handoffExec;
    let offeredServiceId: string | null = null;
    let offeredPref: TimePreference | null = null;
    const serviceItem = decision.next.service ? kb.items.find((x) => x.ref === decision.next.service) : undefined;
    if (action === 'OFFER_TIME') {
      const serviceId = serviceItem?.id ?? state?.serviceId ?? kb.items.find((x) => x.title === open?.service)?.id ?? null;
      const pref = parseTimePreference(last.text);
      offeredServiceId = serviceId;
      offeredPref = pref;
      const offer = await this.proposeTimes(clinicId, clinic.scheduleMode, serviceId, pref, offeredBefore(msgs));
      // ONE next step in the message: the code shows the times and asks to choose, so the model's own invitation to book (its closing, and any
      // sentence asking to choose or promising to find a time) is left out; the answer to the question and the price lines stay
      const composed = composePriceReply({ intro: withoutTimeSolicitation(intro), after: null, ids: priceRefs }, kb.items, lang, { noticeOnlyForKnown: true });
      reply = 'reply' in composed ? composed.reply : composedReply;
      if (offer.options.length) {
        options = offer.options;
        reply = [reply, pref ? TIME_LINE_PREF(lang, preferencePhrase(pref, lang)) : TIME_LINE[lang]].filter((x) => x.trim()).join('\n\n');
      } else {
        // the times cannot be offered: the action is refused with the reason, and the WHOLE text follows the result (the model's own "here are the times" or
        // "yes, you can book" is dropped; the price lines the patient asked for stay)
        rejected = offer.reason;
        const lines = 'reply' in composed ? composePriceReply({ intro: '', after: null, ids: priceRefs }, kb.items, lang, { noticeOnlyForKnown: true }) : null;
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
    } else if (action === 'NONE' && ctx.priceQuestion && priceRefs.length && (decision.content.kind === 'ANSWER' || decision.content.kind === 'EXPLAIN')) {
      // one soft next step after a direct answer about the price: only for a service that can be booked online, not after a decline or a hand-over, not during
      // a booking or after a visit, not while a person owns the dialogue, and once (the question is not repeated in every message)
      const busy = !!open && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage);
      const ended = ['DECLINED', 'HANDED', 'CLOSED'].includes(state?.salesStage ?? '') || state?.owner === 'HUMAN';
      const asked = msgs.some((m) => m.direction === 'OUT' && m.text.includes(SOFT_OFFER[lang]));
      if (!busy && !ended && !asked && clinic.scheduleMode === 'CABINETS') {
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
      exec: { serviceId: offeredServiceId ?? serviceItem?.id ?? null, prices: priceRefs.flatMap((ref) => { const it = kb.items.find((x) => x.ref === ref); return it ? [{ serviceId: it.id, title: it.title, state: it.state, amount: it.amount }] : []; }), pref: offeredPref, ...(execText ? { handoffText: execText } : {}) },
    });
  }

  // The price state of every service of the clinic NOW (read only): the approval compares it with what the draft stated
  async currentPriceStates(clinicId: string): Promise<Map<string, { title: string; state: string; amount: number | null }>> {
    const kb = await this.kb.factsFor(clinicId, new Date(), '', '');
    return new Map(kb.items.map((x) => [x.id, { title: x.title, state: x.state, amount: x.amount }]));
  }

  // The offered times of a stored draft looked up AGAIN (read only) with the same service and wish, and without the times the dialogue already offered.
  // The approval compares the result with what the staff member saw.
  async refreshOptions(clinicId: string, channel: string, chatId: string, exec: Pick<DraftExec, 'serviceId' | 'pref'>): Promise<{ options: SlotOption[]; reason: string | null }> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true } });
    const msgs = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId }, orderBy: { createdAt: 'desc' }, take: HISTORY, select: { direction: true, buttons: true } });
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
      for (const w of wins) {
        if (days.has(w.date)) continue;
        let from = Math.ceil(w.startMin / 30) * 30;
        if (pref?.afterMin !== undefined) from = Math.max(from, Math.ceil(pref.afterMin / 30) * 30);
        const to = pref?.beforeMin !== undefined ? Math.min(w.endMin, pref.beforeMin) : w.endMin;
        if (from + svc.durationMin! > to) continue;
        // a time already offered is not offered again: the next half hour of the same window comes instead
        while (from + svc.durationMin! <= to && exclude.has(`${w.date}|${hm(from)}`)) from += 30;
        if (from + svc.durationMin! > to) continue;
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
