import { conversationLanguage } from '../ai/conversation-language';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookingRequest, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { ChatAssistantService, SlotOption } from '../ai/chat-assistant.service';
import { languageOf } from '../ai/guardrails';
import { AvailabilityService } from '../booking/availability.service';
import { AutoBookingGate } from '../booking/auto-booking-gate';
import { BLOCK_TEXT, BookingBlock, CabinetBookingService } from '../booking/cabinet-booking.service';
import { BookingService } from '../booking/booking.service';
import { CabinetWish, DoctorChoiceService, RequestPatch, isNo, isYes, matchDoctors, serves } from '../booking/doctor-choice.service';

// a message that speaks about a doctor at all (a bare surname may be the patient's own name in a contact answer)
const DOCTOR_NOUN = /(?<![\p{L}])(?:лікар\p{L}*|врач\p{L}*|доктор\p{L}*|стоматолог\p{L}*)(?![\p{L}])/iu;
const TO_SURNAME = /(?:^|[^\p{L}])(?:до|к)\s+\p{Lu}[\p{L}'’-]{2,}/u;
const DOCTOR_WORD = { test: (t: string) => DOCTOR_NOUN.test(t) || TO_SURNAME.test(t) };
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { normalizePhone } from '../common/phone';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { slotPayload } from './channels';
import { FunnelEventsService } from '../funnel-events/funnel-events.service';
import { MessengerService, SendError } from './messenger.service';
import { RequestsService } from './requests.service';

// After the bot asks this many times for the name and the phone it stops and hands the request over with what it has
const MAX_ASKS = 6;
// A confirmation message that has been "being sent" this long is probably lost (the server stopped); only an explicit retry sends it again
const NOTICE_STUCK_MS = 5 * 60_000;
// A request still waiting for a name or a phone this long after its last change no longer holds the dialog
const COLLECT_STALE_MS = 6 * 3_600_000;
// A typed "yes" is taken as a repeat of a finished scenario for this long after the confirmation
const REPEAT_WINDOW_MS = 3 * 86_400_000;
const FREE_STATUSES = ['CANCELLED', 'MOVED', 'DID_NOT_COME'];
// A time offered by the agent can be chosen for this long after the offer was sent
const OFFER_TTL_MS = 24 * 3_600_000;

// What the staff member is asked to do next on the agent path (the booking steps after the patient chose a time). `key` describes the state the step was
// made for: when the request changes, the key changes and a step made earlier is stale.
export interface BookingSummary {
  service: string | null;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  // no card of this person exists in the system: the booking also creates one
  newCard: boolean;
  // booking by cabinets: the clinic assigns the doctor
  doctorNote: boolean;
  // what the patient will be told once the visit really exists
  preview: string;
}
export type AgentNote = 'slot_gone' | 'identity' | 'urgent' | 'no_length' | 'manual' | 'not_possible' | 'data_wrong';
export type AgentPlan =
  | { step: 'NONE' }
  | { step: 'NOTE'; key: string; requestId: string; note: AgentNote; detail?: string }
  | { step: 'ASK_DATA'; key: string; requestId: string; text: string; field: string; missing: string[]; asks: number }
  | { step: 'ASK_CONSENT'; key: string; requestId: string; consentKey: string; text: string; options: SlotOption[]; summary: BookingSummary }
  | { step: 'CREATE_VISIT'; key: string; requestId: string; consentKey: string; summary: BookingSummary };
export type ApprovedBooking =
  | { kind: 'DONE'; notice: string | null; visit: string | null }
  | { kind: 'ALREADY' }
  | { kind: 'REFUSED'; code: 'not_open' | 'consent_missing' | 'consent_changed' | 'write_disabled' | 'slot_unavailable' | 'identity_needed' | 'not_possible' | 'in_progress'; note?: string }
  | { kind: 'UNKNOWN' }
  | { kind: 'FAILED'; note: string };

export type Lang = 'uk' | 'ru';
export interface FlowCtx {
  clinicId: string;
  channel: string;
  chatId: string;
  patientId: string | null;
  contactName: string | null;
}
export interface ConfirmInput {
  date: string;
  time: string;
  service?: string;
  doctor?: string;
}

const REASON_UK: Record<string, string> = { CLIENT_CHOICE: 'побажання клієнта', CONTINUATION: 'продовження лікування', PRIMARY: 'лікар для первинного запису', SERVICE_MATCH: 'підходить за послугою', URGENT: 'термінове звернення' };
const fmtDate = (ymd: string) => ymd.split('-').reverse().join('.');
const titleCase = (w: string) => w.charAt(0).toLocaleUpperCase('uk') + w.slice(1).toLocaleLowerCase('uk');

// Words of an ordinary answer or question: text that holds one of them is a sentence, not a name
const NOT_A_NAME = new Set(['не', 'знаю', 'так', 'ні', 'да', 'нет', 'ок', 'окей', 'добре', 'привіт', 'привет', 'що', 'шо', 'як', 'коли', 'де', 'чи', 'чому', 'скільки', 'сколько', 'когда', 'что', 'как', 'почему', 'хочу', 'можна', 'можно', 'буду', 'потрібно', 'нужно', 'запишіть', 'запишите', 'будь', 'ласка', 'хотів', 'хотела', 'хотіла', 'хотел', 'є', 'есть', 'ціна', 'цена', 'коштує', 'дякую', 'спасибо']);
const NAME_WORD = /^[\p{L}][\p{L}'’ʼ-]{1,49}$/u;
const LAST_LABEL = /(?:прізвище|прізвищем|фамилия|фамилию|фамилией)\s*[:\-–—]?\s*([\p{L}][\p{L}'’ʼ-]{1,49})/iu;
const FIRST_LABEL = /(?:ім['’ʼ`]?я|імʼя|имя)\s*[:\-–—]?\s*([\p{L}][\p{L}'’ʼ-]{1,49})/iu;

// The phone out of free text ("097 123 45 67", "+38 (097) 123-45-67")
export function parsePhone(text: string): string | null {
  const m = /\+?\d[\d\s().-]{7,}\d/.exec(text);
  return m ? normalizePhone(m[0]) : null;
}

// Only explicitly labelled fields ("Прізвище Коваль, ім'я Ірина") tell the surname from the first name. Two bare words never do:
// their order cannot be trusted ("Наталія Бойко" and "Бойко Наталія" are both normal).
export function parseLabeledNames(text: string): { lastName?: string; firstName?: string } {
  const last = LAST_LABEL.exec(text)?.[1];
  const first = FIRST_LABEL.exec(text)?.[1];
  const ok = (w?: string) => (w && !NOT_A_NAME.has(w.toLowerCase()) ? titleCase(w) : undefined);
  return { ...(ok(last) ? { lastName: ok(last) } : {}), ...(ok(first) ? { firstName: ok(first) } : {}) };
}

// An answer to "your surname?" or "your first name?": exactly one word
export function singleNameWord(text: string): string | null {
  const t = text.replace(/\+?\d[\d\s().-]{7,}\d/, ' ').trim().replace(/[.,;!]+$/, '');
  return NAME_WORD.test(t) && !NOT_A_NAME.has(t.toLowerCase()) ? titleCase(t) : null;
}

// Two bare capitalised words in an answer ("Мене звати Ірина Коваль, мій номер …"): they are the name and the surname in SOME order, which the code does not guess. The
// words of the sentence around them and the phone are set aside; anything else (a question, a digit, three words, a lower-case pair) is not taken as a name.
const SENTENCE_WORDS = /(?<![\p{L}])(?:мене|меня|звати|зовут|звуть|мо[єе]|мій|мой|ім['’ʼ`]?я|имя|прізвище|фамилия|я|це|это|номер|телефон|тел|мобільний|мобильный|для|зв['’ʼ]язку|связи|будь|ласка|пожалуйста|добрий|день|доброго|привіт|здравствуйте|вітаю|дякую|ні|нет|так|да|але|но)(?![\p{L}])/giu;
export function namePair(text: string): [string, string] | null {
  if (text.includes('?')) return null;
  const rest = text.replace(/\+?\d[\d\s().-]{7,}\d/g, ' ').replace(SENTENCE_WORDS, ' ').replace(/[,.;:!()\-–—]/g, ' ');
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return null;
  if (!tokens.every((t) => NAME_WORD.test(t) && !NOT_A_NAME.has(t.toLowerCase()) && t.charAt(0) === t.charAt(0).toLocaleUpperCase('uk') && t.charAt(0) !== t.charAt(0).toLocaleLowerCase('uk'))) return null;
  return [titleCase(tokens[0]), titleCase(tokens[1])];
}

// A message after the consent question that is about the data themselves (a correction or "wrong"): a mention of the fields, "wrong", "change"
const DATA_TALK = /(невір|неправил|помилк|не\s+так|не\s+те(?![\p{L}])|не\s+той|не\s+мій|ошибк|неверн|не\s+тот|не\s+мой|виправ|исправ|поміняй|поменя|змін(?:іть|ити|а)|измен(?:ите|ить)|прізвищ|ім['’ʼ`]?я|фамил|имя|номер|телефон)/iu;

// "не Оксана, а Олександра": a capitalised word after "не" (no case folding: "не знаю" is not a name)
const NOT_A_GIVEN_NAME = /(?:^|[\s,;.!])[Нн]е\s+\p{Lu}\p{L}+/u;

const YES = /^\s*(так|да|yes|ок|окей|добре|гаразд|підтверджую|подтверждаю|згоден|согласен|угу|ага|звичайно|конечно)(?![\p{L}])/iu;
const NO = /^\s*(ні|нет|no|не\s+треба|не\s+надо|інший|другой|скасувати|отмена)(?![\p{L}])/iu;

// The whole message is only a "yes" ("так", "Да!", "ок."): nothing else asked, nothing else said
const BARE_YES = /^\s*(так|да|yes|ок|окей|добре|гаразд|підтверджую|подтверждаю|згоден|согласен|угу|ага|звичайно|конечно)[\s.!)]*$/iu;

const T = {
  uk: {
    askAll: 'Щоб оформити запис, напишіть, будь ласка, прізвище, ім’я та номер телефону. Можна одним повідомленням, наприклад: «Прізвище Коваль, ім’я Ірина, телефон 0971234567».',
    askNames: 'Дякуємо! Тепер, будь ласка, прізвище та ім’я. Можна так: «Прізвище Коваль, ім’я Ірина».',
    askOrder: (a: string, b: string) => `Уточніть, будь ласка: що з цього прізвище — «${a}» чи «${b}»? Напишіть лише прізвище.`,
    confirmWho: (name: string | null, phone: string | null) => `Дані для запису: ${[name, phone].filter(Boolean).join(', ')}.`,
    askLast: 'Підкажіть, будь ласка, ваше прізвище (одним словом).',
    askFirst: 'Дякуємо! Тепер, будь ласка, ваше ім’я (одним словом).',
    askPhone: 'Дякуємо! Підкажіть, будь ласка, номер телефону для зв’язку.',
    handed: (service: string | null, date: string, time: string) => `Дякуємо! Передали заявку на ${service ?? 'запис'} на ${date} о ${time} адміністратору. Очікуйте підтвердження запису.`,
    handedPlain: 'Дякуємо! Передали заявку адміністратору. Очікуйте підтвердження запису.',
    confirmAskCabinets: (service: string | null, date: string, time: string, address: string | null) => `Підтверджуєте запис${service ? ` на ${service}` : ''} ${date} о ${time}${address ? `, ${address}` : ''}? Конкретного лікаря призначає клініка. Натисніть кнопку або напишіть «так» чи «ні».`,
    clinicAssigns: 'Лікаря призначить клініка',
    wishNote: (n: string) => `Ваше побажання щодо лікаря ${n} передамо клініці, але запис саме до цього лікаря не гарантуємо.`,
    alreadyDone: 'Це повідомлення стосується запису, який уже оформлено, тому нового запису ми не створювали. Щоб записатися ще раз, напишіть про це, наприклад: «хочу записатися ще».',
    settingsChanged: 'Налаштування запису змінилися, тому попередній вибір більше не діє. Оберіть, будь ласка, час ще раз.',
    servicePaused: 'Цю послугу тимчасово не можна записати онлайн. Адміністратор зв’яжеться з вами.',
    confirmAsk: (service: string | null, date: string, time: string, doctor: string | null) => `Підтверджуєте запис${service ? ` на ${service}` : ''} ${date} о ${time}${doctor ? `, лікар ${doctor}` : ''}? Натисніть кнопку або напишіть «так» чи «ні».`,
    yes: 'Так, підтверджую',
    no: 'Ні, інший час',
    again: 'Гаразд. Оберіть, будь ласка, інший зручний час кнопкою нижче.',
    againNoTimes: 'Гаразд. Адміністратор підбере інший час і напише вам.',
    busy: 'На жаль, цей час уже зайнятий. Оберіть, будь ласка, інший зручний час кнопкою нижче.',
    busyNoOptions: 'На жаль, цей час уже зайнятий. Адміністратор підбере інший і напише вам. Очікуйте підтвердження запису.',
    head: 'Ваш запис підтверджено ✅',
    service: 'Послуга',
    date: 'Дата',
    time: 'Час',
    doctor: 'Лікар',
    clinic: 'Клініка',
    address: 'Адреса',
  },
  ru: {
    askAll: 'Чтобы оформить запись, напишите, пожалуйста, фамилию, имя и номер телефона. Можно одним сообщением, например: «Фамилия Ковалёв, имя Ирина, телефон 0971234567».',
    askNames: 'Спасибо! Теперь, пожалуйста, фамилию и имя. Можно так: «Фамилия Ковалёв, имя Ирина».',
    askOrder: (a: string, b: string) => `Уточните, пожалуйста: что из этого фамилия — «${a}» или «${b}»? Напишите только фамилию.`,
    confirmWho: (name: string | null, phone: string | null) => `Данные для записи: ${[name, phone].filter(Boolean).join(', ')}.`,
    askLast: 'Подскажите, пожалуйста, вашу фамилию (одним словом).',
    askFirst: 'Спасибо! Теперь, пожалуйста, ваше имя (одним словом).',
    askPhone: 'Спасибо! Подскажите, пожалуйста, номер телефона для связи.',
    handed: (service: string | null, date: string, time: string) => `Спасибо! Передали заявку на ${service ?? 'запись'} на ${date} в ${time} администратору. Ожидайте подтверждения записи.`,
    handedPlain: 'Спасибо! Передали заявку администратору. Ожидайте подтверждения записи.',
    confirmAskCabinets: (service: string | null, date: string, time: string, address: string | null) => `Подтверждаете запись${service ? ` на ${service}` : ''} ${date} в ${time}${address ? `, ${address}` : ''}? Конкретного врача назначает клиника. Нажмите кнопку или напишите «да» или «нет».`,
    clinicAssigns: 'Врача назначит клиника',
    wishNote: (n: string) => `Ваше пожелание о враче ${n} передадим клинике, но запись именно к этому врачу не гарантируем.`,
    alreadyDone: 'Это сообщение относится к записи, которая уже оформлена, поэтому новую запись мы не создавали. Чтобы записаться ещё раз, напишите об этом, например: «хочу записаться ещё».',
    settingsChanged: 'Настройки записи изменились, поэтому прежний выбор больше не действует. Выберите, пожалуйста, время ещё раз.',
    servicePaused: 'Эту услугу временно нельзя записать онлайн. Администратор свяжется с вами.',
    confirmAsk: (service: string | null, date: string, time: string, doctor: string | null) => `Подтверждаете запись${service ? ` на ${service}` : ''} ${date} в ${time}${doctor ? `, врач ${doctor}` : ''}? Нажмите кнопку или напишите «да» или «нет».`,
    yes: 'Да, подтверждаю',
    no: 'Нет, другое время',
    again: 'Хорошо. Выберите, пожалуйста, другое удобное время кнопкой ниже.',
    againNoTimes: 'Хорошо. Администратор подберёт другое время и напишет вам.',
    busy: 'К сожалению, это время уже занято. Выберите, пожалуйста, другое удобное время кнопкой ниже.',
    busyNoOptions: 'К сожалению, это время уже занято. Администратор подберёт другое и напишет вам. Ожидайте подтверждения записи.',
    head: 'Ваша запись подтверждена ✅',
    service: 'Услуга',
    date: 'Дата',
    time: 'Время',
    doctor: 'Врач',
    clinic: 'Клиника',
    address: 'Адрес',
  },
};

// The booking as it will be told to the client: only what is known, nothing added
export function confirmationText(lang: Lang, p: { service: string | null; startsAt: Date; doctor: string | null; clinic: string; address: string | null; doctorNote?: string }): string {
  const x = T[lang];
  const lines = [x.head];
  if (p.service) lines.push(`${x.service}: ${p.service}`);
  lines.push(`${x.date}: ${fmtDate(clinicDate(p.startsAt))}`, `${x.time}: ${clinicHm(p.startsAt)}`);
  if (p.doctor) lines.push(`${x.doctor}: ${p.doctor}`);
  // booking by cabinets: the sentence stands alone ("Лікаря призначить клініка"), not as the value of a "Doctor:" field
  else if (p.doctorNote) lines.push(p.doctorNote);
  lines.push(`${x.clinic}: ${p.clinic}`);
  if (p.address) lines.push(`${x.address}: ${p.address}`);
  return lines.join('\n');
}

// The booking scenario of the bot, the same for every channel: keeps what the person chose between messages, asks for the name and the phone,
// then either passes one complete request to the administrator (default mode) or books in Cliniccards itself (automatic mode, only where
// writing is switched on). Every step is claimed in the database, so a repeated webhook, a double click or a restart never repeats it.
@Injectable()
export class BookingFlowService {
  private readonly log = new Logger(BookingFlowService.name);

  constructor(
    private prisma: PrismaService,
    private requests: RequestsService,
    private messenger: MessengerService,
    private booking: BookingService,
    private assistant: ChatAssistantService,
    private reports: ReportsService,
    private sync: SyncService,
    private choice: DoctorChoiceService,
    private availability: AvailabilityService,
    private cabinets: CabinetBookingService,
    private gate: AutoBookingGate,
    private funnel: FunnelEventsService,
  ) {}

  // The agent's approval mode: nothing is sent to the patient and no visit is created without a staff member's explicit action
  async agentMode(clinicId: string): Promise<boolean> {
    return !!(await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiAgentMode: true } }))?.aiAgentMode;
  }

  private async lang(c: FlowCtx): Promise<Lang> {
    // the agent's clinics read the language the same way as the agent's own texts (so it does not change in the middle of a booking); the working bot keeps its old reading
    if (await this.agentMode(c.clinicId)) return conversationLanguage(this.prisma, c.clinicId, c.channel, c.chatId);
    const last = await this.prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'IN', NOT: [{ text: { startsWith: 'Обрав час:' } }, { text: { in: ['Так, підтверджую', 'Ні, інший час'] } }] }, orderBy: { createdAt: 'desc' }, take: 6, select: { text: true } });
    return languageOf(last.map((m) => m.text));
  }

  // The bot's own message: only when the clinic allowed sending and the person did not opt out
  private async say(c: FlowCtx, text: string, options: SlotOption[] = []): Promise<boolean> {
    // With the agent's approval mode on, the scenario never writes to the patient by itself: every such message is a step a staff member approves
    if (await this.agentMode(c.clinicId)) {
      this.log.log(`Booking flow message held for staff approval (clinic ${c.clinicId}, ${c.channel})`);
      return false;
    }
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { sendingEnabled: true } });
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId: c.clinicId, channel: c.channel, externalId: c.chatId }, select: { optedOutAt: true, patientId: true } });
    if (!clinic.sendingEnabled || ch?.optedOutAt) return false;
    try {
      await this.messenger.send(c.clinicId, c.channel, c.chatId, text, options);
    } catch (e) {
      this.log.warn(`Booking flow message not sent: ${(e as Error).message}`);
      return false;
    }
    await this.prisma.chatMessage.create({
      data: {
        clinicId: c.clinicId,
        patientId: ch?.patientId ?? c.patientId,
        channel: c.channel,
        chatId: c.chatId,
        direction: 'OUT',
        text,
        // a scripted message of the booking flow: not a model reply (it must not use up the AI's daily allowance) and not a person (it must not pause the AI)
        byAi: false,
        ...(options.length ? { buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) } : {}),
      },
    });
    // the send succeeded (a failed one returned above): times were really shown to the client
    if (options.some((o) => o.date && o.time)) await this.funnel.record(c.clinicId, { channel: c.channel, chatId: c.chatId, kind: 'TIME_OFFERED', refKey: await this.funnel.offerKey(c.clinicId, c.channel, c.chatId, options), linked: !!(ch?.patientId ?? c.patientId) });
    return true;
  }

  // ---- 1. the person chose a time ----

  async onSlotChosen(c: FlowCtx, slot: { date: string; time: string; doctor?: string | null }, label: string): Promise<void> {
    const slotAt = localToUtc(`${slot.date} ${slot.time}:00`);
    // The same button pressed again after this time was already confirmed: nothing to book or tell again
    const done = await this.prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, slotAt, confirmedAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
    if (done) return;
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    // The same button pressed again after the request was already passed on: nothing to do
    if (open?.stage === 'READY' && open.slotAt?.getTime() === slotAt.getTime()) return;
    // Agent mode: a time counts only when it is on a message that was really SENT as the current offer of this request, and the place is still free
    const agent = await this.agentMode(c.clinicId);
    if (agent && !(await this.agentSlotAccepted(c, open, slot, slotAt))) return;
    // A button from before a change of the setting: the doctors and the cabinets are different worlds, so the old choice is dropped and new times are offered
    // A button from before a service vanished from the price list: no new time is stored on the request, however old the button is
    if (open?.service && (await this.choice.findService(c.clinicId, open.service))?.missingInSourceAt) {
      await this.say(c, T[await this.lang(c)].servicePaused);
      return;
    }
    const cm = await this.clinicMode(c.clinicId);
    const stored = open?.scheduleMode ?? null;
    const withDoctor = !!slot.doctor?.startsWith('#');
    const stale = (stored && stored !== cm.scheduleMode) || (cm.scheduleMode === 'CABINETS' && withDoctor) || (cm.scheduleMode === 'DOCTORS' && stored === 'CABINETS');
    if (stale && open) {
      await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { doctorId: null, doctor: null, doctorReason: null, doctorState: null, pendingDoctorId: null, scheduleMode: null, slotAt: null, stage: 'NONE', autoState: null } });
      const options = await this.freshFor(c, { doctorId: null, doctor: null, service: open.service });
      const x = T[await this.lang(c)];
      await this.say(c, options.length ? x.settingsChanged : x.handedPlain, options);
      return;
    }
    const prev = (open?.summary ?? '').replace(/^Обрано час:[^.]*\.\s*/, '');
    const row = await this.requests.upsert(
      c.clinicId,
      { channel: c.channel, chatId: c.chatId, patientId: c.patientId, contactName: c.contactName, kind: (open?.kind as 'BOOKING' | 'RESCHEDULE' | 'CANCEL') ?? 'BOOKING', summary: `Обрано час: ${label}. ${prev}`.trim(), ...(agent ? { service: (await this.offeredService(c)) ?? open?.service ?? null } : {}) },
      false,
      // the staff is told when the request is complete, not at every step
      true,
    );
    // The button may carry the doctor as an id of Cliniccards ("#501"); only a doctor the clinic really has is stored, by id and by name.
    // A tap without a doctor never wipes the doctor of the request.
    let doctorPatch: Prisma.BookingRequestUpdateInput = {};
    if (cm.scheduleMode === 'DOCTORS' && slot.doctor?.startsWith('#')) {
      const d = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: slot.doctor.slice(1) } } });
      if (d) {
        doctorPatch = { doctorId: d.externalId, doctor: `${d.lastName} ${d.firstName}`.trim(), doctorReason: open?.doctorReason ?? 'CLIENT_CHOICE' };
        if (open?.doctorId !== d.externalId) await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: null, action: 'booking_request.doctor', details: { request: row.id, doctorId: d.externalId, reason: open?.doctorReason ?? 'CLIENT_CHOICE' } } });
      }
    } else if (slot.doctor && cm.scheduleMode === 'DOCTORS' && !slot.doctor.startsWith('#')) doctorPatch = { doctor: slot.doctor };
    // a different time or doctor than before: the request is collected again, and the automatic mode asks the person's yes again
    // (a changed time or service also withdraws any earlier consent: it was given for something else)
    // Agent path, cabinets: a doctor the patient named before the time is kept on the request (settled: "a doctor the clinic assigns"; not settled: the step asks first)
    if (agent && cm.scheduleMode === 'CABINETS') Object.assign(doctorPatch, this.wishPatch(await this.choice.cabinetWishState(c.clinicId, c.channel, c.chatId)) ?? {});
    await this.prisma.bookingRequest.update({ where: { id: row.id }, data: { slotAt, ...doctorPatch, scheduleMode: cm.scheduleMode, stage: 'COLLECT', autoState: null, autoNote: null, asks: 0, consentKey: null, consentAt: null, consentMessageId: null } });
    await this.advance(c, row.id);
  }


  // The scenario is finished (the bot booked the visit, or the request went to the administrator) and the person answers it again: a repeated "yes" typed
  // or a button of the old confirmation. Nothing is started, booked, offered or sent again; one short neutral line says so. It does not claim that the earlier
  // visit is still valid (it may have been cancelled or deleted in Cliniccards): only what the bot did not do now.
  private async finishedRepeat(c: FlowCtx, text: string | null, requestId?: string | null): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    // a request that is still being collected or waits for the answer owns the dialogue
    if (open && open.stage !== 'READY') return false;
    let last: { confirmedAt: Date | null; stage: string; updatedAt: Date; id: string } | null;
    if (requestId) {
      // the button of a request of this chat (never of another chat or clinic)
      last = await this.prisma.bookingRequest.findFirst({ where: { id: requestId, clinicId: c.clinicId, channel: c.channel, chatId: c.chatId }, select: { id: true, confirmedAt: true, stage: true, updatedAt: true } });
      if (!last || (!last.confirmedAt && last.stage !== 'READY')) return false;
    } else {
      if (text === null || !BARE_YES.test(text)) return false;
      last = open ?? (await this.prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, kind: { in: ['BOOKING', 'RESCHEDULE'] }, confirmedAt: { gt: new Date(Date.now() - REPEAT_WINDOW_MS) } }, orderBy: { confirmedAt: 'desc' }, select: { id: true, confirmedAt: true, stage: true, updatedAt: true } }));
      if (!last) return false;
      // Only while the finished scenario is the last thing in the dialogue: after any answer of the AI or of a person a "yes" belongs to that talk
      const since = last.confirmedAt ?? last.updatedAt;
      const later = await this.prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'OUT', createdAt: { gt: since }, OR: [{ byAi: true }, { authorUserId: { not: null } }] }, select: { id: true } });
      if (later) return false;
    }
    // a request that is only just closed (the first click is still being worked on) is absorbed without a word
    if (!last.confirmedAt && Date.now() - last.updatedAt.getTime() < 60_000) return true;
    const x = T[await this.lang(c)];
    const lastOut = await this.prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'OUT' }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    // the same line is not repeated to a person who taps again and again
    if (lastOut?.text !== x.alreadyDone) await this.say(c, x.alreadyDone);
    this.log.log(`Booking flow ignored a repeated answer of a finished scenario (clinic ${c.clinicId}, ${c.channel})`);
    return true;
  }

  // ---- 2. later messages while the data is being collected ----

  // Returns true only when the message was taken as an answer AND the bot replied to it (otherwise the message goes on to the AI, never into silence)
  async onText(c: FlowCtx, text: string): Promise<boolean> {
    if (await this.finishedRepeat(c, text)) return true;
    let open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    const agent = await this.agentMode(c.clinicId);
    // Agent path, cabinets, a time already chosen: a doctor named now (while the contacts are given, or after the summary) is not dropped. The wish and its state go onto
    // the request and every earlier consent is withdrawn (it was given without it); the data already given stay. The step asks the doctor question before anything else.
    if (agent && open?.kind === 'BOOKING' && open.slotAt && open.scheduleMode === 'CABINETS' && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage) && !open.confirmedAt) {
      const ws = await this.choice.cabinetWishState(c.clinicId, c.channel, c.chatId);
      const wp = this.wishPatch(ws);
      if (wp && (wp.wishedDoctor !== open.wishedDoctor || wp.doctorState !== open.doctorState)) {
        await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { ...wp, stage: 'COLLECT', consentKey: null, consentAt: null, consentMessageId: null, ...(wp.doctorState === 'ANY_DOCTOR' ? { asks: 0 } : {}) } });
        this.log.log(`Agent booking: the doctor wish changed during the booking (${wp.doctorState}; clinic ${c.clinicId}, ${c.channel})`);
        // the wish goes to the administrator: the agent's draft makes the one hand-over (the booking request and its data stay for the staff)
        if (wp.doctorState === 'WISH_ADMIN') return false;
        open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
        // a message that only named the doctor or answered the question is taken (the step asks next); one that also gives data goes on below
        if (!parsePhone(text) && !parseLabeledNames(text).lastName && !parseLabeledNames(text).firstName) return true;
      } else if (ws && (ws.lastNames || ws.lastIsAnswer) && open.doctorState === 'WISH_ASKED') {
        // the same question still open (an unclear answer): taken, the step asks again (a limited number of times)
        if (!text.includes('?')) return true;
      }
    }
    // Agent path, doctors mode, a time already chosen: another doctor named now. The time belongs to the doctor it was offered with, so it is released (with the consent);
    // the contacts already given stay; the agent's draft settles the new doctor with DoctorChoiceService and offers that doctor's times.
    if (agent && open?.kind === 'BOOKING' && open.slotAt && open.scheduleMode === 'DOCTORS' && ['COLLECT', 'CONFIRM', 'CONSENT'].includes(open.stage) && !open.confirmedAt && DOCTOR_WORD.test(text)) {
      const named = matchDoctors(text, await this.prisma.doctor.findMany({ where: { clinicId: c.clinicId, active: true }, select: { externalId: true, lastName: true, firstName: true } }));
      if (named.length && !(named.length === 1 && named[0] === open.doctorId)) {
        await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { slotAt: null, stage: 'NONE', autoState: null, autoNote: null, consentKey: null, consentAt: null, consentMessageId: null, doctorId: null, doctor: null, doctorReason: null, doctorState: null, pendingDoctorId: null } });
        this.log.log(`Agent booking: another doctor was named during the booking (clinic ${c.clinicId}, ${c.channel})`);
        return false;
      }
    }
    // A named doctor with no separate schedule: the person says "any doctor" in words (the old bot; the agent path is above)
    if (!agent && open?.doctorState === 'WISH_ASKED' && !text.includes('?') && /(будь-?який|любой|все одно|всё равно|без різниці|без разницы)/i.test(text)) return this.onDoctorAnswer(c, 'any', null);
    // A proposed doctor waits for the person's "yes" or "no"
    if (!agent && open?.doctorState === 'PROPOSED' && open.stage !== 'CONFIRM' && !text.includes('?')) {
      if (isYes(text)) return this.onDoctorAnswer(c, 'yes', open.pendingDoctorId);
      if (isNo(text)) return this.onDoctorAnswer(c, 'no', open.pendingDoctorId);
    }
    if (!open || (open.stage !== 'COLLECT' && open.stage !== 'CONFIRM')) return false;
    // A forgotten question from long ago does not hold the dialog
    if (Date.now() - open.updatedAt.getTime() > COLLECT_STALE_MS) return this.skipCollect(c, 'stale');
    if (open.stage === 'CONFIRM') {
      // Agent mode: a correction of the data (or "the data are wrong") after the summary is never a "yes" to the old summary
      if ((await this.agentMode(c.clinicId)) && (await this.agentCorrection(c, open, text))) return true;
      const yes = YES.test(text);
      const no = NO.test(text);
      if (yes !== no) return this.onConfirmAnswer(c, yes, open.id);
      if (text.includes('?') || open.asks >= MAX_ASKS || (await this.agentMode(c.clinicId))) return this.skipCollect(c, 'question');
      const claim = await this.prisma.bookingRequest.updateMany({ where: { id: open.id, stage: 'CONFIRM', asks: open.asks }, data: { asks: open.asks + 1 } });
      if (!claim.count) return true;
      await this.askConfirm(c, open.id);
      return true;
    }
    const phone = parsePhone(text);
    const labeled = parseLabeledNames(text);
    const patch: Prisma.BookingRequestUpdateInput = {};
    if (phone) patch.phone = phone;
    if (labeled.lastName) patch.lastName = labeled.lastName;
    if (labeled.firstName) patch.firstName = labeled.firstName;
    if (labeled.lastName && labeled.firstName) patch.fullName = `${labeled.lastName} ${labeled.firstName}`;
    if (!labeled.lastName && !labeled.firstName) {
      // an answer to "your surname?" / "your first name?" is one word; anything else is never guessed (the order of words proves nothing)
      const word = singleNameWord(text);
      const candidate = open.fullName && !open.lastName && !open.firstName ? open.fullName.split(' ') : null;
      if (word && open.askField === 'lastName' && !open.lastName) patch.lastName = word;
      else if (word && open.askField === 'firstName' && !open.firstName) patch.firstName = word;
      else if (word && open.askField === 'order' && candidate?.length === 2) {
        // the answer to "which of the two is the surname?": it must be one of the two words
        const [a, b] = candidate;
        if (word.toLowerCase() === a.toLowerCase()) Object.assign(patch, { lastName: a, firstName: b, fullName: `${a} ${b}` });
        else if (word.toLowerCase() === b.toLowerCase()) Object.assign(patch, { lastName: b, firstName: a, fullName: `${b} ${a}` });
      } else if (!word && !open.lastName && !open.firstName) {
        // a name and a surname in one phrase, no labels: kept as a PAIR, the order is asked about (never guessed)
        const pair = namePair(text);
        if (pair) patch.fullName = `${pair[0]} ${pair[1]}`;
      }
    }
    if (!Object.keys(patch).length) {
      // a question is for the AI; anything else is asked again a few times, then the request goes on as it is
      if (text.includes('?')) return this.skipCollect(c, 'question');
      if (open.asks >= MAX_ASKS) {
        await this.complete(c, open.id, true);
        return false;
      }
      return this.advance(c, open.id);
    }
    await this.prisma.bookingRequest.update({ where: { id: open.id }, data: patch });
    return this.advance(c, open.id);
  }

  private skipCollect(c: FlowCtx, reason: string): false {
    this.log.log(`Booking flow did not take the message: ${reason} (clinic ${c.clinicId}, ${c.channel})`);
    return false;
  }

  // Asks for what is missing, or completes the request when everything is known. Returns true when the bot sent a message.
  // A person with a card needs nothing but a phone missing from the card; for anyone else the surname, the first name and the phone are
  // asked for: all at once the first time (labelled fields), then one at a time in the order surname, first name, phone.
  private async advance(c: FlowCtx, id: string): Promise<boolean> {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, include: { patient: { select: { fullName: true, phone: true } } } });
    if (r.stage === 'READY') return false;
    // Agent mode: what to ask next is a step the staff approves (see agentPlan); the answer is stored, nothing is sent here
    if (await this.agentMode(c.clinicId)) return true;
    const known = !!r.patient?.fullName;
    const missing: ('lastName' | 'firstName' | 'phone')[] = [
      ...(known || r.lastName ? [] : (['lastName'] as const)),
      ...(known || r.firstName ? [] : (['firstName'] as const)),
      ...(r.phone || normalizePhone(r.patient?.phone) ? [] : (['phone'] as const)),
    ];
    if (!missing.length) {
      await this.complete(c, id, false);
      return true;
    }
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { sendingEnabled: true } });
    // The bot cannot ask (sending is off) or already asked enough: the administrator gets what there is
    if (!clinic.sendingEnabled || r.asks >= MAX_ASKS) {
      await this.complete(c, id, true);
      return false;
    }
    const x = T[await this.lang(c)];
    const q = this.dataQuestion(r, x)!;
    // asks is raised first: a repeated delivery of the same event does not ask twice in a row
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, asks: r.asks, stage: 'COLLECT' }, data: { asks: r.asks + 1, askField: q.field } });
    if (!claim.count) return true;
    const sentOk = await this.say(c, q.text);
    if (!sentOk) this.log.log(`Booking flow could not ask for the data: message not sent (clinic ${c.clinicId}, ${c.channel})`);
    return sentOk;
  }

  // ---- the answer to a question about the doctor (a button, or "так"/"ні") ----

  // docpick: the person chose one of the doctors named; docyes/docno: the answer to a proposed doctor. A repeated answer does nothing twice.
  async onDoctorAnswer(c: FlowCtx, kind: 'pick' | 'yes' | 'no' | 'any' | 'wish', doctorId: string | null): Promise<boolean> {
    // Agent path: the answer is read by the agent's draft (the same DoctorChoiceService.answer) and its result is saved only when that draft is really sent
    if (await this.agentMode(c.clinicId)) return false;
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    if (!open) return false;
    if (kind === 'any' || kind === 'wish') {
      // the answer to "any doctor or a wish for the administrator?": only the first answer counts
      const claim = await this.prisma.bookingRequest.updateMany({ where: { id: open.id, doctorState: 'WISH_ASKED' }, data: { doctorState: null } });
      if (!claim.count) return true;
    } else if (kind === 'pick') {
      if (open.doctorState === 'AGREED' && open.doctorId === doctorId) return true; // the same button again
    } else {
      // the claim: only the first answer to a proposal counts
      const claim = await this.prisma.bookingRequest.updateMany({ where: { id: open.id, doctorState: 'PROPOSED' }, data: { doctorState: null } });
      if (!claim.count) return true;
    }
    const lang = await this.lang(c);
    const service = await this.choice.findService(c.clinicId, open.service);
    const texts = (await this.prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, take: 6, select: { text: true } })).map((m) => m.text);
    if (!service) {
      await this.say(c, T[lang].handedPlain);
      return true;
    }
    const dec = await this.choice.answer({ clinicId: c.clinicId, patientId: c.patientId, service, texts, lang, request: open, auto: await this.autoMode(c.clinicId, c) }, kind, doctorId);
    if (dec.kind === 'NONE') return true;
    await this.prisma.bookingRequest.update({ where: { id: open.id }, data: this.requests.patchData(dec.patch) });
    if (dec.patch.doctorId && dec.patch.doctorId !== open.doctorId) {
      await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: null, action: 'booking_request.doctor', details: { request: open.id, doctorId: dec.patch.doctorId, reason: dec.patch.doctorReason ?? open.doctorReason ?? null } } });
    }
    const opts = (list: { label: string; date?: string; time?: string; doctorId?: string; payload?: string }[]) => list.map((b) => ({ label: b.label, date: b.date ?? '', time: b.time ?? '', ...(b.doctorId ? { doctorId: b.doctorId } : {}), ...(b.payload ? { payload: b.payload } : {}) }));
    if (dec.kind === 'ASK') await this.say(c, dec.reply, opts(dec.buttons));
    else if (dec.kind === 'OFFER') await this.say(c, dec.reply, opts(dec.options));
    else {
      // a person takes it: the doctor and why are on the request, no booking is promised
      const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id: open.id } });
      await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { summary: `${r.summary}; ${r.doctor ? `бажаний лікар: ${r.doctor}; ` : ''}${dec.note}`.slice(0, 500) } });
      await this.requests.notify(c.clinicId, open.id, false);
      await this.funnel.record(c.clinicId, { channel: c.channel, chatId: c.chatId, kind: 'HANDED_OFF', refKey: open.id, reason: dec.code ?? 'doctor_choice', linked: !!c.patientId });
      await this.say(c, dec.reply);
    }
    return true;
  }

  // ---- 3. complete: one full request for the administrator, or the automatic booking ----

  private async complete(c: FlowCtx, id: string, incomplete: boolean): Promise<void> {
    if (await this.agentMode(c.clinicId)) return;
    const pre = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    let note: string | undefined;
    // The automatic mode asks the person to confirm first, and only when everything needed for the booking is known: the length of the
    // visit (never guessed), a free place and a doctor (Cliniccards requires one). Otherwise a person completes the request.
    if (!incomplete && pre.slotAt && (await this.autoMode(c.clinicId, c))) {
      // A card with this phone exists and the chat is not tied to it: a phone alone proves nothing, so a person checks (no question to the client first)
      const cards = !pre.patientId && pre.phone ? await this.booking.matches(c.clinicId, pre.phone) : [];
      const duration = cards.length ? null : await this.durationFor(c.clinicId, pre.service);
      // a sudden health problem is a priority request for a person; the bot never books it by itself
      if (pre.urgent) note = 'термінове звернення: запис підтверджує адміністратор';
      else if (cards.length) note = 'є картка з таким телефоном, потрібно підтвердити особу';
      else if (duration === null) note = 'тривалість послуги невідома, запис потрібно внести вручну';
      else {
        const p = await this.placement(c, pre, duration);
        if (!p.ok && p.busy) return this.busy(c, id, 'вікно вже не вільне');
        if (!p.ok) note = `${p.note}, запис потрібно внести вручну`;
      }
      if (!note) {
        const claim = await this.prisma.bookingRequest.updateMany({ where: { id, stage: 'COLLECT' }, data: { stage: 'CONFIRM', asks: 0 } });
        if (claim.count) await this.askConfirm(c, id);
        return;
      }
    }
    const r = await this.finalize(c, id, note);
    if (!r) return;
    if (note) await this.prisma.bookingRequest.update({ where: { id }, data: { autoState: 'FAILED', autoNote: note } });
    await this.tellHandedOver(c, r.service, r.slotAt, id, note ? 'auto_not_possible' : 'booking_request');
  }

  // The request is complete: one summary for the staff, who are told once
  private async finalize(c: FlowCtx, id: string, note?: string) {
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, stage: { not: 'READY' } }, data: { stage: 'READY' } });
    if (!claim.count) return null;
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, include: { patient: { select: { fullName: true, phone: true } } } });
    const name = r.patient?.fullName ?? (r.lastName && r.firstName ? `прізвище ${r.lastName}, ім’я ${r.firstName}` : null);
    const phone = r.phone ?? r.patient?.phone ?? null;
    if (r.lastName && r.firstName && !r.fullName) await this.prisma.bookingRequest.update({ where: { id }, data: { fullName: `${r.lastName} ${r.firstName}` } });
    const when = r.slotAt ? `${fmtDate(clinicDate(r.slotAt))} ${clinicHm(r.slotAt)}` : null;
    const summary = [
      r.kind === 'RESCHEDULE' ? 'Перенесення' : 'Запис',
      r.service ? `послуга: ${r.service}` : null,
      when ? `час: ${when}` : null,
      r.doctor ? `лікар: ${r.doctor}${r.doctorReason ? ` (${REASON_UK[r.doctorReason] ?? r.doctorReason})` : ''}` : null,
      r.urgent ? 'ТЕРМІНОВО' : null,
      name ? `ПІБ: ${name}` : 'ПІБ не отримано',
      phone ? `тел.: ${phone}` : 'телефон не отримано',
      `канал: ${c.channel}`,
      note ? `автозапис не виконано: ${note}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    await this.prisma.bookingRequest.update({ where: { id }, data: { summary: summary.slice(0, 500) } });
    await this.requests.notify(c.clinicId, id, false);
    return r;
  }

  // The address the clinic gave (one approved location), when it is known
  private async addressOf(clinicId: string): Promise<string | null> {
    const places = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'LOCATION', active: true, approvedAt: { not: null } }, select: { title: true, text: true }, take: 2 });
    return places.length === 1 ? (places[0].text.trim() || places[0].title).split('\n')[0].slice(0, 200) : null;
  }

  private async clinicMode(clinicId: string) {
    return this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true, sharedDoctorId: true } });
  }

  // The automatic mode: the person confirms the booking in so many words before anything is written
  private async askConfirm(c: FlowCtx, id: string) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    const x = T[await this.lang(c)];
    // booking by cabinets: service, date, time and the address; the clinic assigns the doctor, which the person is told
    const text = r.scheduleMode === 'CABINETS' ? x.confirmAskCabinets(r.service, fmtDate(clinicDate(r.slotAt!)), clinicHm(r.slotAt!), await this.addressOf(c.clinicId)) : x.confirmAsk(r.service, fmtDate(clinicDate(r.slotAt!)), clinicHm(r.slotAt!), r.doctor);
    await this.say(c, text, [
      { label: x.yes, date: '', time: '', payload: `bookyes|${id}` },
      { label: x.no, date: '', time: '', payload: `bookno|${id}` },
    ]);
  }

  // The answer to the question above (a button or a typed "так"/"ні"). A repeated answer does nothing the second time.
  async onConfirmAnswer(c: FlowCtx, yes: boolean, requestId: string | null, key: string | null = null): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    if (!open || open.stage !== 'CONFIRM' || (requestId && open.id !== requestId)) return requestId ? this.finishedRepeat(c, null, requestId) : false;
    if (await this.agentMode(c.clinicId)) return this.agentConsent(c, open, yes, key);
    if (!yes) {
      const claim = await this.prisma.bookingRequest.updateMany({ where: { id: open.id, stage: 'CONFIRM' }, data: { stage: 'NONE', slotAt: null } });
      if (!claim.count) return true;
      const options = await this.freshFor(c, open);
      const x = T[await this.lang(c)];
      await this.say(c, options.length ? x.again : x.againNoTimes, options);
      return true;
    }
    const r = await this.finalize(c, open.id);
    if (!r) return true;
    // The client agreed to THIS time (the claim above lets only the first yes through); a repeated yes or button never gets here
    if (r.slotAt) await this.funnel.record(c.clinicId, { channel: c.channel, chatId: c.chatId, kind: 'CLIENT_CONFIRMED', refKey: `${open.id}:${r.slotAt.toISOString()}`, linked: !!(r.patientId ?? c.patientId) });
    if (r.slotAt && (await this.autoMode(c.clinicId, c))) await this.runAuto(c, open.id);
    else await this.tellHandedOver(c, r.service, r.slotAt, open.id, 'booking_request');
    return true;
  }

  private async tellHandedOver(c: FlowCtx, service: string | null, slotAt: Date | null, requestId: string, reason: string) {
    // the request really is with a person now (it exists and the staff were told)
    await this.funnel.record(c.clinicId, { channel: c.channel, chatId: c.chatId, kind: 'HANDED_OFF', refKey: requestId, reason, linked: !!c.patientId });
    const x = T[await this.lang(c)];
    await this.say(c, slotAt ? x.handed(service, fmtDate(clinicDate(slotAt)), clinicHm(slotAt)) : x.handedPlain);
  }

  // ---- 4. the automatic mode ----

  // The mode is on only where the clinic asked for it AND writing is allowed at all (service-wide switch and the clinic's own switch)
  private autoMode(clinicId: string, chat: { channel: string; chatId: string }): Promise<boolean> {
    return this.booking.autoModeFor(clinicId, chat);
  }

  private async handToAdmin(c: FlowCtx, id: string, note: string, code?: BookingBlock) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, select: { service: true, slotAt: true, summary: true } });
    await this.prisma.bookingRequest.update({ where: { id }, data: { autoState: 'FAILED', autoNote: note.slice(0, 300), ...(code ? { blockCode: code } : {}), summary: `${r.summary}; автозапис не виконано: ${note}`.slice(0, 500) } });
    await this.requests.notify(c.clinicId, id, false);
    // never "you are booked": the person is told that the administrator confirms
    await this.tellHandedOver(c, r.service, r.slotAt, id, code ?? 'auto_failed');
  }

  private async runAuto(c: FlowCtx, id: string): Promise<void> {
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, autoState: null }, data: { autoState: 'RUNNING' } });
    if (!claim.count) return;
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    const out = await this.createVisit(c, r, null);
    if (out.kind === 'DONE') return this.finishAuto(c, id, r, r.slotAt!, out.doctorName, out.externalVisitId, out.shared, null);
    if (out.kind === 'BUSY') return this.busy(c, id, out.note);
    await this.handToAdmin(c, id, out.note, out.code);
  }

  // The write itself, the same for the automatic mode (userId null) and for a visit a staff member approved (userId set): first everything that is only READ (the
  // service is allowed and has a length, the place is free by data read right now), only then the first write (the patient's card), so a refusal never leaves a
  // card behind. The visit goes through BookingService.book: one unique attempt key, a fresh re-check of the place, a read-back, a reconcile after a lost answer.
  private async createVisit(c: FlowCtx, r: BookingRequest, userId: string | null, again = false, keepPlace = false): Promise<
    | { kind: 'DONE'; externalVisitId: string | null; doctorName: string | null; shared?: { cabinetId: string; sharedDoctorId: string } }
    | { kind: 'BUSY'; note: string }
    | { kind: 'HAND'; why: 'identity' | 'duration' | 'placement' | 'data' | 'gate' | 'patient_busy' | 'unknown' | 'failed'; note: string; code?: BookingBlock }
  > {
    const id = r.id;
    const slotAt = r.slotAt!;
    try {
      const durationMin = await this.durationFor(c.clinicId, r.service);
      if (durationMin === null) return { kind: 'HAND', why: 'duration', note: 'тривалість послуги невідома' };
      // A repeat after an unknown result keeps the place of the first attempt: the visit that may exist occupies it, so a fresh search would pick another place
      // (and another attempt key). With the same place and key BookingService.book first looks in the clinic's system for the visit and only then does anything.
      const place = again && r.cabinetId ? await this.samePlace(c, r) : await this.placement(c, r, durationMin);
      if (!place.ok) return place.busy ? { kind: 'BUSY', note: 'вікно вже не вільне' } : { kind: 'HAND', why: 'placement', note: place.note ?? 'лікаря не визначено', code: place.code };
      // a visit made on the agent path (a staff member's action or the autonomous mode) remembers its place before the write (so that a check after a lost answer can find the same attempt)
      if (keepPlace && r.cabinetId !== place.cabinetId) await this.prisma.bookingRequest.update({ where: { id }, data: { cabinetId: place.cabinetId } });
      let patientId = r.patientId;
      if (!patientId) {
        const found = r.phone ? await this.booking.matches(c.clinicId, r.phone) : [];
        // A card with this phone exists: a phone alone does not prove who writes, a person checks it
        if (found.length) return { kind: 'HAND', why: 'identity', note: 'є картка з таким телефоном, потрібно підтвердити особу' };
        if (!r.lastName || !r.firstName || !r.phone) return { kind: 'HAND', why: 'data', note: 'немає прізвища, імені або телефону' };
        const created = await this.booking.createPatient(c.clinicId, userId, { lastName: r.lastName, firstName: r.firstName, phone: r.phone, channel: c.channel, origin: { channel: c.channel, chatId: c.chatId } });
        if (created.existing) return { kind: 'HAND', why: 'identity', note: 'картка пацієнта вже існує, потрібно підтвердити особу' };
        patientId = created.patientId;
        // the card is ours (just created for this chat): the chat can be tied to it
        await this.booking.linkChat(c.clinicId, patientId, c.channel, c.chatId);
        await this.prisma.bookingRequest.update({ where: { id }, data: { patientId } });
      }
      // the note of the visit: useful context, and never a claim that the shared account is a real doctor
      const note = place.shared ? `Запис створено ботом LANKA. Лікаря призначає клініка${r.wishedDoctor ? `. Побажання пацієнта: ${r.wishedDoctor}` : ''}`.slice(0, 400) : 'Запис створено ботом LANKA';
      const doBook = () => this.booking.book(c.clinicId, userId, { patientId: patientId!, startsAt: slotAt, durationMin, cabinetId: place.cabinetId, doctorId: place.doctorId, note, requestId: id, sharedAccount: place.shared, origin: { channel: c.channel, chatId: c.chatId } });
      let res;
      try {
        res = await doBook();
      } catch (e) {
        // The answer was lost (timeout): look whether the visit appeared before anything else; a repeated call does exactly that
        if (e instanceof ConflictException && e.message === 'booking_unknown') res = await doBook();
        else throw e;
      }
      return { kind: 'DONE', externalVisitId: res.externalVisitId, doctorName: place.doctorName, ...(place.shared ? { shared: { cabinetId: place.cabinetId, sharedDoctorId: place.doctorId } } : {}) };
    } catch (e) {
      const code = e instanceof Error ? e.message : 'failed';
      if (code === 'auto_booking_not_allowed_for_dialog') return { kind: 'HAND', why: 'gate', note: 'автозапис дозволено лише для тестового діалогу' };
      if (code === 'booking_slot_taken' || code === 'booking_slot_blocked') return { kind: 'BUSY', note: code };
      this.log.warn(`Visit not created for request ${id}: ${code}`);
      if (code === 'booking_unknown') return { kind: 'HAND', why: 'unknown', note: 'не вдалося перевірити, чи створено запис' };
      if (code === 'booking_patient_busy') return { kind: 'HAND', why: 'patient_busy', note: 'у пацієнта вже є запис на цей час' };
      return { kind: 'HAND', why: 'failed', note: 'запис у Cliniccards не створено' };
    }
  }

  // The place of an earlier, unfinished attempt (see createVisit)
  private async samePlace(c: FlowCtx, r: BookingRequest): Promise<{ ok: true; cabinetId: string; doctorId: string; doctorName: string | null; shared?: boolean } | { ok: false; busy: boolean; note?: string; code?: BookingBlock }> {
    const cm = await this.clinicMode(c.clinicId);
    if (cm.scheduleMode === 'CABINETS') return cm.sharedDoctorId ? { ok: true, cabinetId: r.cabinetId!, doctorId: cm.sharedDoctorId, doctorName: null, shared: true } : { ok: false, busy: false, note: BLOCK_TEXT.no_shared_account };
    return r.doctorId ? { ok: true, cabinetId: r.cabinetId!, doctorId: r.doctorId, doctorName: r.doctor } : { ok: false, busy: false, note: 'лікаря не визначено' };
  }

  // The visit exists in Cliniccards: only now is the client told, with the real time. `by` is the staff member who approved it (null: the automatic mode).
  private async finishAuto(c: FlowCtx, id: string, r: { service: string | null; doctor: string | null; doctorId: string | null; doctorReason: string | null; wishedDoctor?: string | null }, startsAt: Date, doctorName: string | null, externalVisitId: string | null, cabinets: { cabinetId: string; sharedDoctorId: string } | undefined, by: string | null) {
    const claim = await this.prisma.bookingRequest.updateMany({
      where: { id, confirmedAt: null },
      data: { status: 'DONE', handledAt: new Date(), ...(by ? { handledById: by } : {}), confirmedAt: new Date(), confirmedBy: by ? 'ADMIN' : 'AUTO', confirmSource: 'AUTO', confirmedStartsAt: startsAt, confirmedService: r.service, confirmedDoctor: cabinets ? null : (doctorName ?? r.doctor), externalVisitId, noticeStatus: 'PENDING', autoState: 'DONE', ...(cabinets ? { cabinetId: cabinets.cabinetId, scheduleMode: 'CABINETS' } : {}) },
    });
    if (!claim.count) return;
    await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: by, action: 'booking_request.confirmed', details: { request: id, by: by ? 'admin' : 'auto', ...(by ? { approvedAgentStep: true } : {}), visit: externalVisitId, at: startsAt.toISOString(), doctorId: r.doctorId, doctorReason: r.doctorReason, ...(cabinets ? { scheduleMode: 'CABINETS', cabinetId: cabinets.cabinetId, sharedAccount: cabinets.sharedDoctorId, wishedDoctor: r.wishedDoctor ?? null } : {}) } } });
    await this.deliver(c.clinicId, id, by);
  }

  // ---- 6. the agent path: the steps a staff member approves ----

  // The things the patient must agree to: the service, the time and how the doctor is chosen. A change of any of them needs a new "yes".
  private consentKeyOf(r: { service: string | null; slotAt: Date | null; scheduleMode: string | null; doctorId: string | null; lastName?: string | null; firstName?: string | null; phone?: string | null; wishedDoctor?: string | null; doctorState?: string | null }): string {
    // what the patient confirms: the service, the time, how the doctor is chosen, and the contacts the visit will be made for (shown in the question); a wished doctor and
    // its state too, when there is one (a consent given before the wish, or before it was settled, is not a consent to the booking with it)
    const wish = r.wishedDoctor || r.doctorState ? [r.wishedDoctor ?? '', r.doctorState ?? ''] : [];
    return createHash('sha256').update([r.service ?? '', r.slotAt?.toISOString() ?? '', r.scheduleMode ?? '', r.doctorId ?? '', r.lastName ?? '', r.firstName ?? '', r.phone ?? '', ...wish].join('|')).digest('hex').slice(0, 24);
  }

  // The next question about the contacts, the same in both modes. Already received phone and explicit names stay; only what is missing is asked: both names in one short
  // question when the phone is known, ONE short clarification when the patient gave a name and a surname as two bare words (their order is not guessed), one field when one is
  // missing.
  private dataQuestion(r: BookingRequest & { patient?: { fullName: string; phone: string | null } | null }, x: (typeof T)['uk'], resume = false): { field: string; text: string } | null {
    const missing = this.missingOf(r);
    if (!missing.length) return null;
    const cand = !r.lastName && !r.firstName && r.fullName?.split(' ').length === 2 ? r.fullName.split(' ') : null;
    if (cand && missing.includes('lastName') && missing.includes('firstName')) return { field: 'order', text: x.askOrder(cand[0], cand[1]) };
    // nothing is known yet: all of it is asked (the first time, and again when the question was interrupted by an answer of ours)
    if (missing.length === 3 && (r.asks === 0 || resume)) return { field: 'all', text: x.askAll };
    if (missing.length === 2 && missing[0] === 'lastName' && missing[1] === 'firstName' && r.askField !== 'names') return { field: 'names', text: x.askNames };
    const f = missing[0];
    return { field: f, text: f === 'lastName' ? x.askLast : f === 'firstName' ? x.askFirst : x.askPhone };
  }

  private missingOf(r: { lastName: string | null; firstName: string | null; phone: string | null; patient?: { fullName: string; phone: string | null } | null }): ('lastName' | 'firstName' | 'phone')[] {
    const known = !!r.patient?.fullName;
    return [...(known || r.lastName ? [] : (['lastName'] as const)), ...(known || r.firstName ? [] : (['firstName'] as const)), ...(r.phone || normalizePhone(r.patient?.phone) ? [] : (['phone'] as const))];
  }

  // The state a step is made for, from the request alone (no reads of other systems): a step whose key no longer matches is stale
  agentKeyOf(r: BookingRequest & { patient?: { fullName: string; phone: string | null } | null }): string {
    return [r.stage, r.slotAt?.toISOString() ?? '', r.service ?? '', this.missingOf(r).join('+'), r.asks, r.consentKey ?? '', r.consentAt ? 1 : 0, r.confirmedAt ? 1 : 0, r.autoNote === 'slot_gone' ? 'gone' : r.autoNote === 'data_disputed' ? 'disputed' : '', r.patientId ?? '', r.fullName ?? '', r.askField ?? '', r.doctorState ?? '', r.wishedDoctor ?? ''].join('|');
  }

  // After the summary of the data and the question "do you confirm?" the patient corrects the name or the phone, or says the data are wrong. The old consent and its
  // button stop working at once (the consent key holds the contacts and is cleared). What the code can take reliably is saved (a phone, labelled names, a name and a
  // surname as a pair whose order is asked); anything else ("це не мій номер", "не Оксана, а Олександра") is NOT guessed: the request is marked and the dialogue
  // goes to a person. Nothing is said to be corrected unless it was saved; the new summary is asked only after the save.
  private async agentCorrection(c: FlowCtx, open: BookingRequest, text: string): Promise<boolean> {
    if (text.includes('?')) return false;
    const yesNo = YES.test(text) !== NO.test(text);
    const phone = parsePhone(text);
    const labeled = parseLabeledNames(text);
    const pair = !labeled.lastName && !labeled.firstName ? namePair(text) : null;
    const phoneChanged = !!phone && phone !== open.phone;
    const lastChanged = !!labeled.lastName && labeled.lastName !== open.lastName;
    const firstChanged = !!labeled.firstName && labeled.firstName !== open.firstName;
    const pairChanged = !!pair && ![open.lastName, open.firstName].every((w) => w && pair.map((x) => x.toLowerCase()).includes(w.toLowerCase()));
    const talk = DATA_TALK.test(text) || NOT_A_GIVEN_NAME.test(text);
    // a lone name-like word that is not a yes or a no ("Шевчук") may be a correction of the name: it is not guessed either
    const lone = !yesNo && !phone && !talk && !!singleNameWord(text);
    const parsed = phoneChanged || lastChanged || firstChanged || pairChanged;
    if (!parsed && !talk && !lone) return false;
    // "yes, the same data again" and the like change nothing (the same phone or the same names repeated, no word of a correction)
    if (!parsed && yesNo && !talk) return false;
    const sameData = (!!phone && !phoneChanged) || (!!labeled.lastName && !lastChanged) || (!!labeled.firstName && !firstChanged);
    const strongWrong = /(невір|неправил|помилк|не\s+так|ошибк|неверн|не\s+тот|не\s+мой|не\s+мій|виправ|исправ|поміняй|поменя|змін|измен)/i.test(text);
    if (!parsed && sameData && !strongWrong && !NOT_A_GIVEN_NAME.test(text)) return false;
    const data: Prisma.BookingRequestUpdateInput = { consentKey: null, consentAt: null, consentMessageId: null, stage: 'COLLECT', asks: 0 };
    if (parsed && !(talk && DATA_TALK.test(text) && /(невір|неправил|помилк|не\s+так|ошибк|неверн|не\s+тот|не\s+мой|не\s+мій)/i.test(text) && !phoneChanged)) {
      if (phoneChanged) data.phone = phone;
      if (lastChanged) data.lastName = labeled.lastName;
      if (firstChanged) data.firstName = labeled.firstName;
      if ((lastChanged || firstChanged) && (labeled.lastName ?? open.lastName) && (labeled.firstName ?? open.firstName)) data.fullName = `${labeled.lastName ?? open.lastName} ${labeled.firstName ?? open.firstName}`;
      if (pairChanged && pair) Object.assign(data, { lastName: null, firstName: null, fullName: `${pair[0]} ${pair[1]}`, askField: null });
      data.autoNote = null;
    } else {
      data.autoNote = 'data_disputed';
    }
    await this.prisma.bookingRequest.update({ where: { id: open.id }, data });
    this.log.log(`Agent booking: the data were corrected or disputed after the summary (${data.autoNote === 'data_disputed' ? 'disputed' : 'saved'}; clinic ${c.clinicId}, ${c.channel})`);
    return true;
  }

  // A time the patient chose is accepted only from the offer that was really sent for this request (never from a draft that was not sent, an older offer, or
  // after a change of the service), and only while the place is still free. Nothing is sent to the patient here.
  private async agentSlotAccepted(c: FlowCtx, open: BookingRequest | null, slot: { date: string; time: string; doctor?: string | null }, slotAt: Date): Promise<boolean> {
    const refuse = (why: string) => {
      this.log.log(`Agent booking: a chosen time was not accepted (${why}; clinic ${c.clinicId}, ${c.channel})`);
      return false;
    };
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId } }, select: { offerMessageId: true, offeredAt: true, offerService: true } });
    if (!state?.offerMessageId || !state.offeredAt) return refuse('no_sent_offer');
    if (Date.now() - state.offeredAt.getTime() > OFFER_TTL_MS) return refuse('offer_too_old');
    const outs = await this.prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'OUT', error: null }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, buttons: true } });
    const payloadsOf = (b: unknown) => (Array.isArray(b) ? (b as { payload?: unknown }[]).map((x) => x.payload).filter((x): x is string => typeof x === 'string') : []);
    const latest = outs.find((m) => payloadsOf(m.buttons).some((x) => x.startsWith('slot|')));
    if (!latest || latest.id !== state.offerMessageId) return refuse('not_the_current_offer');
    const payload = `slot|${slot.date}|${slot.time}${slot.doctor ? `|${slot.doctor}` : ''}`;
    if (!payloadsOf(latest.buttons).includes(payload)) return refuse('not_on_the_offer');
    const service = state.offerService ?? open?.service ?? null;
    if (service) {
      const duration = await this.durationFor(c.clinicId, service);
      if (duration) {
        // (doctors mode: the button carries its doctor; the place is checked for THAT doctor)
        const slotDoctor = slot.doctor?.startsWith('#') ? { doctorId: slot.doctor.slice(1) } : {};
        const p = await this.placement(c, { ...(open ?? ({ clinicId: c.clinicId, service: null, doctorId: null, doctor: null, doctorReason: null } as unknown as BookingRequest)), service, slotAt, ...slotDoctor }, duration);
        if (!p.ok && p.busy) {
          if (open) await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { slotAt: null, stage: 'NONE', autoNote: 'slot_gone', consentKey: null, consentAt: null, consentMessageId: null } });
          return refuse('place_taken');
        }
      }
    }
    return true;
  }

  // The patient's answer to the question "do you confirm this booking?": only the answer to the question that was really sent, about what is still current
  private async agentConsent(c: FlowCtx, open: BookingRequest, yes: boolean, buttonKey: string | null = null): Promise<boolean> {
    const key = this.consentKeyOf(open);
    if (open.consentKey !== key || open.consentAt) return true; // the question was about something else, or it was answered already
    // a button carries the key of the question it belongs to: a button of an earlier question (the service, the time or the contacts changed since) does nothing
    if (buttonKey && !key.startsWith(buttonKey)) return true;
    if (!yes) {
      await this.prisma.bookingRequest.updateMany({ where: { id: open.id, stage: 'CONFIRM' }, data: { stage: 'NONE', slotAt: null, consentKey: null, consentAt: null, consentMessageId: null } });
      return true;
    }
    // only the first yes counts; a repeated one (or a second tap) finds the consent set
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id: open.id, stage: 'CONFIRM', consentKey: key, consentAt: null }, data: { consentAt: new Date(), stage: 'CONSENT' } });
    if (!claim.count) return true;
    if (open.slotAt) await this.funnel.record(c.clinicId, { channel: c.channel, chatId: c.chatId, kind: 'CLIENT_CONFIRMED', refKey: `${open.id}:${open.slotAt.toISOString()}`, linked: !!(open.patientId ?? c.patientId) });
    // the staff member is told: the visit waits for their explicit action
    await this.requests.notify(c.clinicId, open.id, false);
    return true;
  }

  private ctxOf(r: BookingRequest): FlowCtx {
    return { clinicId: r.clinicId, channel: r.channel, chatId: r.chatId, patientId: r.patientId, contactName: r.contactName };
  }

  // Agent path: the doctor decision of a draft that was REALLY sent (a question about the doctor, or that doctor's times) is saved on the booking request of the dialogue,
  // the way the old bot saves it with its reply (a silent request: the staff are told when it is complete). Called only by the execution of an approved/autonomous draft.
  async applyDoctorPatch(clinicId: string, channel: string, chatId: string, service: string | null, patch: RequestPatch): Promise<void> {
    const open = await this.requests.openFor(clinicId, channel, chatId);
    if (open?.confirmedAt || (open && open.kind !== 'BOOKING')) return;
    const row = open ?? (await this.requests.upsert(clinicId, { channel, chatId, patientId: (await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } }))?.patientId ?? null, kind: 'BOOKING', summary: 'Запис через агента', service }, false, true));
    await this.prisma.bookingRequest.update({ where: { id: row.id }, data: { ...this.requests.patchData(patch), scheduleMode: 'DOCTORS', ...(service ? { service: service.slice(0, 80) } : {}) } });
    if (patch.doctorId && patch.doctorId !== open?.doctorId) await this.prisma.auditLog.create({ data: { clinicId, userId: null, action: 'booking_request.doctor', details: { request: row.id, doctorId: patch.doctorId, reason: patch.doctorReason ?? null } } });
  }

  // The doctor wish of the dialogue as fields of the request (cabinets mode, agent path). null: no doctor was named.
  private wishPatch(ws: CabinetWish | null): { wishedDoctor: string | null; doctorState: 'WISH_ASKED' | 'ANY_DOCTOR' | 'WISH_ADMIN' } | null {
    if (!ws || (!ws.wish && !ws.ambiguous.length)) return null;
    const state = ws.state === 'ANY' ? 'ANY_DOCTOR' : ws.state === 'ADMIN' ? 'WISH_ADMIN' : 'WISH_ASKED';
    return { wishedDoctor: ws.wish ?? ws.ambiguous.join(' / '), doctorState: state };
  }

  // The next step of the booking for the open request of this dialogue, for a staff member to approve. Fresh checks (the place, the length of the service, who
  // the person is) are made here, so a step is never staged for something that cannot be done.
  // `resume`: the id of the answer the agent has just sent to a question the patient asked in the middle of the booking: the pending step is asked again once
  // (the rule "it was asked, wait for the answer" does not apply to it)
  async agentPlan(clinicId: string, requestId: string, resume?: string): Promise<AgentPlan> {
    const r = await this.prisma.bookingRequest.findFirst({ where: { id: requestId, clinicId, status: 'NEW' }, include: { patient: { select: { fullName: true, phone: true } } } });
    if (!r || r.confirmedAt || r.stage === 'READY') return { step: 'NONE' };
    const key = this.agentKeyOf(r);
    const note = (n: AgentNote, detail?: string): AgentPlan => ({ step: 'NOTE', key, requestId, note: n, ...(detail ? { detail } : {}) });
    if (!r.slotAt) return r.autoNote === 'slot_gone' ? note('slot_gone') : { step: 'NONE' };
    // the patient said the data are wrong and the code cannot take the correction reliably: a person's task
    if (r.autoNote === 'data_disputed') return note('data_wrong');
    const c = this.ctxOf(r);
    const x = T[await this.lang(c)];
    // Cabinets mode, a doctor the patient named: settled before anything else (before the data, the consent and the visit). The wish for the administrator is not a step
    // (the agent's draft makes the hand-over); an open question is asked by the code (the old bot's own text), not again while the patient has not answered, and a person
    // takes it after two unclear answers.
    if (r.scheduleMode === 'CABINETS' && r.doctorState === 'WISH_ADMIN') return { step: 'NONE' };
    if (r.scheduleMode === 'CABINETS' && r.doctorState === 'WISH_ASKED') {
      const ws = await this.choice.cabinetWishState(clinicId, r.channel, r.chatId);
      if (ws && (ws.wish || ws.ambiguous.length)) {
        if (ws.asked >= 2 && !ws.lastNames) return note('manual', `бажаний лікар: ${ws.wish ?? ws.ambiguous.join(' / ')}`);
        // a tap on an old button of the booking (the consent of before) is not an answer to this question: the question is not repeated for it
        const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: r.channel, chatId: r.chatId, NOT: [{ direction: 'OUT', error: { not: null } }, { direction: 'IN', text: { in: ['Так, підтверджую', 'Ні, інший час', 'Да, подтверждаю', 'Нет, другое время'] } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { direction: true } });
        if (last?.direction === 'OUT' && !resume) return { step: 'NONE' };
        const lang = await this.lang(c);
        const text = ws.ambiguous.length ? this.choice.ambiguousQuestion(lang, ws.ambiguous) : this.choice.wishQuestion(lang, ws.wish!);
        return { step: 'ASK_DATA', key, requestId, text, field: 'doctor', missing: [], asks: r.asks };
      }
    }
    const missing = this.missingOf(r);
    if (missing.length) {
      if (r.asks >= MAX_ASKS) return note('manual');
      // the question was asked and the patient has not written since: it is not asked again (only what is still missing is asked after an answer)
      if (r.asks > 0 && !resume) {
        const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: r.channel, chatId: r.chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { direction: true } });
        if (last?.direction === 'OUT') return { step: 'NONE' };
      }
      const q = this.dataQuestion(r, x, !!resume)!;
      return { step: 'ASK_DATA', key, requestId, text: q.text, field: q.field, missing, asks: r.asks };
    }
    if (r.urgent) return note('urgent');
    // a card with this phone exists and the chat is not tied to it: a phone alone proves nothing, nothing from the card is shown, a person checks it
    if (!r.patientId && r.phone && (await this.booking.matches(clinicId, r.phone)).length) return note('identity');
    const duration = await this.durationFor(clinicId, r.service);
    if (duration === null) return note('no_length');
    const p = await this.placement(c, r, duration);
    if (!p.ok) return p.busy ? note('slot_gone') : note('not_possible', p.note);
    const consentKey = this.consentKeyOf(r);
    const startsAt = r.slotAt;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } });
    const address = await this.addressOf(clinicId);
    const byCabinets = r.scheduleMode === 'CABINETS';
    const summary: BookingSummary = {
      service: r.service,
      date: fmtDate(clinicDate(startsAt)),
      time: clinicHm(startsAt),
      name: r.patient?.fullName ?? (r.lastName && r.firstName ? `${r.lastName} ${r.firstName}` : null),
      phone: r.phone ?? r.patient?.phone ?? null,
      newCard: !r.patientId,
      doctorNote: byCabinets,
      preview: confirmationText(await this.lang(c), { service: r.service, startsAt, doctor: byCabinets ? null : r.doctor, clinic: clinic.name, address, ...(byCabinets ? { doctorNote: x.clinicAssigns } : {}) }),
    };
    if (r.consentAt && r.consentKey === consentKey) return { step: 'CREATE_VISIT', key, requestId, consentKey, summary };
    // the question was sent and the patient has not answered yet: nothing to approve
    if (r.stage === 'CONFIRM' && r.consentKey === consentKey && !resume) return { step: 'NONE' };
    // the summary the patient confirms: the contacts the visit will be made for, then the service and the time
    const who = x.confirmWho(summary.name, summary.phone);
    const question = byCabinets ? x.confirmAskCabinets(r.service, summary.date, summary.time, address) : x.confirmAsk(r.service, summary.date, summary.time, r.doctor);
    // a doctor the patient wished, accepted as "assigned by the clinic": said once more as a wish, never as a booked doctor
    const wishLine = byCabinets && r.wishedDoctor && r.doctorState === 'ANY_DOCTOR' ? x.wishNote(r.wishedDoctor) : null;
    const text = [summary.name || summary.phone ? who : null, wishLine, question].filter(Boolean).join('\n');
    return {
      step: 'ASK_CONSENT',
      key,
      requestId,
      consentKey,
      text,
      options: [
        { label: x.yes, date: '', time: '', payload: `bookyes|${requestId}|${consentKey.slice(0, 10)}` },
        { label: x.no, date: '', time: '', payload: `bookno|${requestId}|${consentKey.slice(0, 10)}` },
      ],
      summary,
    };
  }

  // The data question was really sent: the counter and the field asked are saved (once: the counter is compared with the value the step was made for)
  async afterAskData(clinicId: string, requestId: string, asks: number, field: string) {
    await this.prisma.bookingRequest.updateMany({ where: { id: requestId, clinicId, asks }, data: { asks: asks + 1, askField: field } });
  }

  // The consent question was really sent: the request now waits for the patient's answer to THIS question (about this service and time)
  async afterConsentAsked(clinicId: string, requestId: string, consentKey: string, messageId: string) {
    await this.prisma.bookingRequest.updateMany({ where: { id: requestId, clinicId, status: 'NEW', confirmedAt: null, consentAt: null }, data: { stage: 'CONFIRM', asks: 0, consentKey, consentMessageId: messageId } });
  }

  private async offeredService(c: FlowCtx): Promise<string | null> {
    return (await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId } }, select: { offerService: true } }))?.offerService ?? null;
  }

  // The offer was really sent (its message exists): the dialogue remembers WHICH message offered the times and for which service; a time is accepted only from this
  // message. A new offer withdraws the choice, the consent and anything staged for the previous one.
  async bindOffer(clinicId: string, channel: string, chatId: string, service: string | null, messageId: string): Promise<void> {
    const where = { clinicId_channel_chatId: { clinicId, channel, chatId } };
    await this.prisma.conversationState.upsert({ where, create: { clinicId, channel, chatId, offerMessageId: messageId, offeredAt: new Date(), offerService: service }, update: { offerMessageId: messageId, offeredAt: new Date(), offerService: service } });
    const open = await this.requests.openFor(clinicId, channel, chatId);
    if (open && open.kind === 'BOOKING' && !open.confirmedAt && open.stage !== 'READY') {
      await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { ...(service ? { service: service.slice(0, 80) } : {}), slotAt: null, stage: 'NONE', autoState: null, autoNote: null, asks: 0, consentKey: null, consentAt: null, consentMessageId: null } });
    }
  }

  // The visit a staff member approved after the patient's consent (a separate, explicit action). The patient's consent and the staff approval are two different
  // things: both are required, neither replaces the other. Everything is checked again right now; the write is the ordinary BookingService.book.
  async bookApproved(clinicId: string, userId: string | null, requestId: string, expectedKey: string): Promise<ApprovedBooking> {
    const r = await this.prisma.bookingRequest.findFirst({ where: { id: requestId, clinicId } });
    if (!r) return { kind: 'REFUSED', code: 'not_open' };
    if (r.confirmedAt) return { kind: 'ALREADY' };
    if (r.status !== 'NEW' || !r.slotAt || !(await this.agentMode(clinicId))) return { kind: 'REFUSED', code: 'not_open' };
    const key = this.consentKeyOf(r);
    if (!r.consentAt || r.consentKey !== key) return { kind: 'REFUSED', code: r.consentKey && r.consentKey !== key ? 'consent_changed' : 'consent_missing' };
    if (key !== expectedKey) return { kind: 'REFUSED', code: 'consent_changed' };
    if (!(await this.booking.status(clinicId)).enabled) return { kind: 'REFUSED', code: 'write_disabled' };
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id: requestId, clinicId, confirmedAt: null, OR: [{ autoState: null }, { autoState: { in: ['FAILED', 'UNKNOWN'] } }] }, data: { autoState: 'RUNNING' } });
    if (!claim.count) {
      const now = await this.prisma.bookingRequest.findUnique({ where: { id: requestId } });
      return now?.confirmedAt ? { kind: 'ALREADY' } : { kind: 'REFUSED', code: 'in_progress' };
    }
    const c = this.ctxOf(r);
    const out = await this.createVisit(c, r, userId, r.autoState === 'UNKNOWN', true);
    const release = (data: Prisma.BookingRequestUpdateManyMutationInput = {}) => this.prisma.bookingRequest.updateMany({ where: { id: requestId, confirmedAt: null }, data: { autoState: null, ...data } });
    if (out.kind === 'DONE') {
      await this.finishAuto(c, requestId, r, r.slotAt, out.doctorName, out.externalVisitId, out.shared, userId);
      const done = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id: requestId } });
      return { kind: 'DONE', notice: done.noticeStatus, visit: done.externalVisitId };
    }
    if (out.kind === 'BUSY') {
      await release({ slotAt: null, stage: 'NONE', autoNote: 'slot_gone', consentKey: null, consentAt: null, consentMessageId: null });
      return { kind: 'REFUSED', code: 'slot_unavailable' };
    }
    if (out.why === 'unknown') {
      await this.prisma.bookingRequest.updateMany({ where: { id: requestId, confirmedAt: null }, data: { autoState: 'UNKNOWN', autoNote: out.note } });
      return { kind: 'UNKNOWN' };
    }
    if (out.why === 'identity') {
      await release({ autoNote: out.note.slice(0, 300) });
      return { kind: 'REFUSED', code: 'identity_needed' };
    }
    if (out.why === 'failed' || out.why === 'patient_busy') {
      await this.prisma.bookingRequest.updateMany({ where: { id: requestId, confirmedAt: null }, data: { autoState: 'FAILED', autoNote: out.note } });
      return { kind: 'FAILED', note: out.note };
    }
    await release({ autoNote: out.note.slice(0, 300) });
    return { kind: 'REFUSED', code: 'not_possible', note: out.note };
  }

  // Fresh times after the chosen one is gone or refused: of the SAME doctor when the request has one (never another without the person's yes),
  // otherwise from the schedule report as before
  private async freshFor(c: FlowCtx, r: { doctorId: string | null; doctor: string | null; service: string | null; slotAt?: Date | null }, taken = false): Promise<SlotOption[]> {
    // booking by cabinets: the nearest times of the cabinets for the service (read from Cliniccards now); a time found taken is not offered again
    if ((await this.clinicMode(c.clinicId)).scheduleMode === 'CABINETS') {
      const svc = await this.choice.findService(c.clinicId, r.service);
      if (!svc?.onlineBooking || !svc.durationMin) return [];
      try {
        const lang = await this.lang(c);
        const gone = taken && r.slotAt ? { date: clinicDate(r.slotAt), time: clinicHm(r.slotAt) } : null;
        const offers = (await this.cabinets.offers(c.clinicId, { minutes: svc.durationMin, service: svc }, 6)).filter((o) => !(gone && o.date === gone.date && o.time === gone.time)).slice(0, 3);
        return offers.map((o) => ({ label: `${o.date.slice(8)}.${o.date.slice(5, 7)}, ${o.time}`, date: o.date, time: o.time }));
      } catch {
        return [];
      }
    }
    if (r.doctorId) {
      const svc = await this.choice.findService(c.clinicId, r.service);
      const gone = taken && r.slotAt ? { date: clinicDate(r.slotAt), time: clinicHm(r.slotAt) } : undefined;
      const list = await this.choice.doctorOffers(c.clinicId, r.doctorId, svc?.durationMin ?? 30, await this.lang(c), gone);
      return list.map((b) => ({ label: b.label, date: b.date ?? '', time: b.time ?? '', ...(b.doctorId ? { doctorId: b.doctorId } : {}) }));
    }
    return this.assistant.freshOptions(c.clinicId, r.doctor).catch(() => [] as SlotOption[]);
  }

  // The chosen time is gone: fresh times are offered, the request stays open
  private async busy(c: FlowCtx, id: string, note: string) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, select: { doctor: true, doctorId: true, service: true, slotAt: true } });
    // the time was found taken in Cliniccards: it is not offered again even if our copy of the schedule still shows it free
    const options = await this.freshFor(c, r, true);
    await this.prisma.bookingRequest.update({ where: { id }, data: { stage: 'NONE', slotAt: null, autoState: null, autoNote: note.slice(0, 300) } });
    const x = T[await this.lang(c)];
    await this.say(c, options.length ? x.busy : x.busyNoOptions, options);
  }

  // Where and with whom the visit can be made. A request with a doctor of the clinic is checked against THAT doctor: he must provide the service
  // (or have treated the person with it before), have a real schedule (shifts in Cliniccards or the schedule kept in LANKA) and be free for
  // the whole visit, with a free cabinet. Without a doctor on the request the schedule report is used as before.
  private async placement(c: FlowCtx, r: BookingRequest, minutes: number): Promise<{ ok: true; cabinetId: string; doctorId: string; doctorName: string | null; shared?: boolean } | { ok: false; busy: boolean; note?: string; code?: BookingBlock }> {
    // Booking by cabinets: the service must be allowed, the shared account must be one Cliniccards lists, and a cabinet must be free for the
    // whole visit by the schedule read from Cliniccards right now (an unreadable schedule confirms nothing)
    const cm = await this.clinicMode(c.clinicId);
    // a position that vanished from the price list of Cliniccards: no new booking until an administrator decides (history and requests stay)
    const known = await this.choice.findService(c.clinicId, r.service);
    if (known?.missingInSourceAt) return { ok: false, busy: false, note: BLOCK_TEXT.service_missing_in_source, code: 'service_missing_in_source' };
    if (cm.scheduleMode === 'CABINETS') {
      const svc = known;
      if (!svc) return { ok: false, busy: false, note: 'послугу не визначено однозначно: під назву підходить кілька позицій або жодної' };
      if (!svc.onlineBooking) return { ok: false, busy: false, note: BLOCK_TEXT.service_not_allowed, code: 'service_not_allowed' };
      if (!svc.durationMin) return { ok: false, busy: false, note: BLOCK_TEXT.no_length, code: 'no_length' };
      const shared = cm.sharedDoctorId ? await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: cm.sharedDoctorId } } }) : null;
      if (!shared || !shared.active) return { ok: false, busy: false, note: BLOCK_TEXT.no_shared_account, code: 'no_shared_account' };
      try {
        const p = await this.cabinets.placeFor(c.clinicId, r.slotAt!, svc.durationMin, svc);
        if (!p) return { ok: false, busy: true };
        return { ok: true, cabinetId: p.cabinetId, doctorId: shared.externalId, doctorName: null, shared: true };
      } catch {
        return { ok: false, busy: false, note: BLOCK_TEXT.schedule_unreadable, code: 'schedule_unreadable' };
      }
    }
    if (r.doctorId) {
      const doc = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: r.doctorId } } });
      if (!doc || !doc.active) return { ok: false, busy: false, note: 'лікаря немає серед лікарів Cliniccards' };
      const svc = await this.choice.findService(c.clinicId, r.service);
      const kind = svc ? serves(doc, svc) : 'unknown';
      if (kind !== 'yes' && r.doctorReason !== 'CONTINUATION') return { ok: false, busy: false, note: kind === 'no' ? 'лікар не надає цю послугу' : 'не налаштовано, які послуги надає лікар' };
      if ((await this.availability.source(c.clinicId, doc.externalId)) === 'NONE') return { ok: false, busy: false, note: 'у лікаря немає надійного розкладу (ні змін у Cliniccards, ні розкладу в LANKA)' };
      const p = await this.availability.placeFor(c.clinicId, doc.externalId, r.slotAt!, minutes);
      if (!p) return { ok: false, busy: true };
      return { ok: true, cabinetId: p.cabinetId, doctorId: doc.externalId, doctorName: `${doc.lastName} ${doc.firstName}`.trim() };
    }
    const place = await this.place(c.clinicId, r.slotAt!, minutes, r.doctor);
    if (!place) return { ok: false, busy: true };
    if (!place.doctorId) return { ok: false, busy: false, note: 'лікаря не визначено (Cliniccards вимагає лікаря для запису), запис потрібно внести вручну' };
    return { ok: true, cabinetId: place.cabinetId, doctorId: place.doctorId, doctorName: place.doctorName };
  }

  // Where an EXISTING visit can be moved to: the same service, the same doctor (in the cabinets mode the same shared account) and the same length; the rules of a
  // booking (the service allowed and provided by the doctor, a real schedule, a free cabinet for the whole visit) with only the visit itself left out of the busy
  // times. Never another doctor. `busy`: the time is not free; otherwise `note` says why it cannot be done here.
  async movePlacement(clinicId: string, v: { externalId: string; doctorId: string | null; service: string | null; minutes: number }, startsAt: Date): Promise<{ ok: true; cabinetId: string } | { ok: false; busy: boolean; note: string }> {
    const cm = await this.clinicMode(clinicId);
    const svc = await this.choice.findService(clinicId, v.service);
    if (!svc || svc.missingInSourceAt) return { ok: false, busy: false, note: 'послугу візиту не визначено однозначно' };
    if (!v.doctorId) return { ok: false, busy: false, note: 'у візиті немає лікаря' };
    if (cm.scheduleMode === 'CABINETS') {
      if (!svc.onlineBooking) return { ok: false, busy: false, note: BLOCK_TEXT.service_not_allowed };
      if (v.doctorId !== cm.sharedDoctorId) return { ok: false, busy: false, note: 'візит не на спільному профілі клініки' };
      try {
        const p = await this.cabinets.placeFor(clinicId, startsAt, v.minutes, svc, v.externalId);
        return p ? { ok: true, cabinetId: p.cabinetId } : { ok: false, busy: true, note: 'час зайнятий' };
      } catch {
        return { ok: false, busy: false, note: BLOCK_TEXT.schedule_unreadable };
      }
    }
    const doc = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId, externalId: v.doctorId } } });
    if (!doc || !doc.active) return { ok: false, busy: false, note: 'лікаря немає серед лікарів Cliniccards' };
    if (serves(doc, svc) !== 'yes') return { ok: false, busy: false, note: 'лікар не надає цю послугу або це не налаштовано' };
    if ((await this.availability.source(clinicId, doc.externalId)) === 'NONE') return { ok: false, busy: false, note: 'у лікаря немає надійного розкладу' };
    const p = await this.availability.placeFor(clinicId, doc.externalId, startsAt, v.minutes, v.externalId);
    return p ? { ok: true, cabinetId: p.cabinetId } : { ok: false, busy: true, note: 'час зайнятий' };
  }

  // The length of the visit from the clinic's approved reference
  // null when the service is unknown or the reference has no length for it: the length is never guessed
  private async durationFor(clinicId: string, service: string | null): Promise<number | null> {
    if (!service) return null;
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null }, durationMin: { not: null } }, select: { title: true, durationMin: true } });
    const s = service.toLowerCase();
    const hit = rows.find((x) => x.title.toLowerCase() === s) ?? rows.find((x) => x.title.toLowerCase().includes(s) || s.includes(x.title.toLowerCase()));
    return hit?.durationMin ? Math.min(240, Math.max(15, hit.durationMin)) : null;
  }

  // A cabinet (and the doctor, if the clinic has shifts) that is free for the whole visit, from the same schedule the AI offered the time from
  private async place(clinicId: string, startsAt: Date, durationMin: number, doctor: string | null): Promise<{ cabinetId: string; doctorId?: string; doctorName: string | null } | null> {
    const rows = await this.reports.freeSlots(clinicId, 14);
    const day = clinicDate(startsAt);
    const hmMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    const start = hmMin(clinicHm(startsAt));
    const end = start + durationMin;
    const cabinets = await this.prisma.cabinet.findMany({ where: { clinicId }, select: { externalId: true, name: true } });
    const wanted = doctor?.toLowerCase() ?? null;
    const hasDoctors = rows.some((x) => x.doctor);
    for (const row of rows) {
      if (String(row.dayAt) !== day) continue;
      if (wanted && hasDoctors && !String(row.doctor ?? '').toLowerCase().startsWith(wanted)) continue;
      const free = String(row.windows ?? '').split(', ').some((w) => {
        const [a, b] = w.split('–');
        return !!a && !!b && hmMin(a) <= start && end <= hmMin(b);
      });
      if (!free) continue;
      const cabinet = cabinets.find((x) => x.name === row.cabinet);
      if (!cabinet) continue;
      const doctorName = row.doctor ? String(row.doctor) : null;
      const shift = doctorName ? await this.prisma.shift.findFirst({ where: { clinicId, doctorName }, select: { doctorId: true } }) : null;
      return { cabinetId: cabinet.externalId, doctorId: shift?.doctorId, doctorName };
    }
    return null;
  }

  // ---- 5. the administrator confirms ----

  // The visits of this person in Cliniccards on the day of the request (a read only; nothing is written here)
  async match(clinicId: string, id: string, onDay?: Date) {
    const r = await this.prisma.bookingRequest.findFirst({ where: { id, clinicId } });
    if (!r) throw new NotFoundException('request_not_found');
    const day = onDay ?? r.slotAt;
    if (!day) return { found: false as const, reason: 'no_time' as const, visits: [] };
    const norm = normalizePhone(r.phone);
    const patient = r.patientId
      ? await this.prisma.patient.findFirst({ where: { id: r.patientId, clinicId, removedAt: null }, select: { id: true, externalId: true } })
      : norm
        ? (await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, phoneNorm: norm }, select: { id: true, externalId: true }, take: 2 })).filter((_, _i, all) => all.length === 1)[0] ?? null
        : null;
    if (!patient) return { found: false as const, reason: 'no_patient' as const, visits: [] };
    type Hit = { externalId: string; date: string; time: string; doctor: string | null; service: string | null; status: string };
    let visits: Hit[] = [];
    let source: 'cliniccards' | 'local' = 'local';
    try {
      const connector = await this.sync.connectorForClinic(clinicId);
      if (connector) {
        const rows = await connector.fetchVisits({ from: new Date(day.getTime() - 14 * 3_600_000), to: new Date(day.getTime() + 38 * 3_600_000) });
        visits = rows
          .filter((v) => v.patientExternalId === patient.externalId && clinicDate(v.startsAt) === clinicDate(day) && !FREE_STATUSES.includes(v.status))
          .map((v) => ({ externalId: v.externalId, date: clinicDate(v.startsAt), time: clinicHm(v.startsAt), doctor: v.doctorName ?? null, service: v.serviceName ?? null, status: v.status }));
        source = 'cliniccards';
      }
    } catch {
      // Cliniccards cannot be read now: our last synced copy is used below
    }
    if (source === 'local') {
      const from = localToUtc(`${clinicDate(day)} 00:00:00`);
      const rows = await this.prisma.visit.findMany({ where: { clinicId, patientId: patient.id, startsAt: { gte: from, lt: new Date(from.getTime() + 86_400_000) }, status: { notIn: FREE_STATUSES } }, orderBy: { startsAt: 'asc' } });
      visits = rows.map((v) => ({ externalId: v.externalId, date: clinicDate(v.startsAt), time: clinicHm(v.startsAt), doctor: v.doctorName ?? null, service: v.serviceName ?? null, status: v.status }));
    }
    return { found: visits.length > 0, reason: visits.length ? null : ('no_visit' as const), source, visits };
  }

  // "Entered in Cliniccards": the administrator states the real booking. Nothing is written to Cliniccards. Repeats do not tell the client again.
  async confirmByAdmin(clinicId: string, userId: string, id: string, input: ConfirmInput) {
    const r = await this.prisma.bookingRequest.findFirst({ where: { id, clinicId, kind: { in: ['BOOKING', 'RESCHEDULE'] } } });
    if (!r) throw new NotFoundException('request_not_found');
    if (r.confirmedAt) return this.state(clinicId, id, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new BadRequestException('confirm_time_invalid');
    const startsAt = localToUtc(`${input.date} ${input.time}:00`);
    if (Number.isNaN(startsAt.getTime()) || clinicDate(startsAt) !== input.date || startsAt.getTime() < Date.now() - 12 * 3_600_000 || startsAt.getTime() > Date.now() + 400 * 86_400_000) throw new BadRequestException('confirm_time_invalid');
    const service = input.service?.trim().slice(0, 120) || r.service;
    const doctor = input.doctor?.trim().slice(0, 80) || r.doctor;
    // the real visit, when it can be found: the booking is then linked to it
    const m = await this.match(clinicId, id, startsAt).catch(() => null);
    const hit = m?.visits.find((v) => v.date === input.date && v.time === input.time) ?? null;
    const claim = await this.prisma.bookingRequest.updateMany({
      where: { id, clinicId, confirmedAt: null },
      data: { status: 'DONE', handledById: userId, handledAt: new Date(), confirmedAt: new Date(), confirmedBy: 'ADMIN', confirmSource: hit ? 'CLINICCARDS' : 'MANUAL', confirmedStartsAt: startsAt, confirmedService: service, confirmedDoctor: hit?.doctor ?? doctor, externalVisitId: hit?.externalId ?? null, noticeStatus: 'PENDING', noticeError: null },
    });
    if (!claim.count) return this.state(clinicId, id, true);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking_request.confirmed', details: { request: id, by: 'admin', source: hit ? 'cliniccards' : 'manual', at: startsAt.toISOString(), doctorId: r.doctorId, doctorReason: r.doctorReason } } });
    // No BOOKED event here, on purpose: the administrator's words, even with a visit of the same patient at the same time in the clinic's data, do not prove
    // that the visit belongs to THIS request. BOOKED is written where the visit is created for a request (BookingService.book, linked by BookingAttempt).
    await this.deliver(clinicId, id, userId);
    return this.state(clinicId, id, false);
  }

  // Safe retry of a message that was not delivered. A message that is still "being sent" is retried only on an explicit force.
  async retryNotice(clinicId: string, userId: string, id: string, force = false) {
    const r = await this.prisma.bookingRequest.findFirst({ where: { id, clinicId, confirmedAt: { not: null } } });
    if (!r) throw new NotFoundException('request_not_found');
    const stuck = r.noticeStatus === 'PENDING' && !!r.noticeAt && Date.now() - r.noticeAt.getTime() > NOTICE_STUCK_MS;
    const allowed = r.noticeStatus === 'FAILED' || r.noticeStatus === 'SKIPPED' || (stuck && force) || (r.noticeStatus === 'PENDING' && !r.noticeAt && force);
    if (!allowed) return this.state(clinicId, id, true);
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, clinicId, noticeStatus: r.noticeStatus }, data: { noticeStatus: 'PENDING', noticeError: null } });
    if (!claim.count) return this.state(clinicId, id, true);
    await this.deliver(clinicId, id, userId);
    return this.state(clinicId, id, false);
  }

  private async state(clinicId: string, id: string, already: boolean) {
    const r = await this.prisma.bookingRequest.findFirstOrThrow({ where: { id, clinicId } });
    return {
      alreadyConfirmed: already,
      status: r.status,
      confirmedBy: r.confirmedBy,
      confirmSource: r.confirmSource,
      confirmedStartsAt: r.confirmedStartsAt,
      noticeStatus: r.noticeStatus,
      noticeError: r.noticeError,
    };
  }

  // The message to the client about the confirmation, with the confirmed (actual) data. The message row is the claim: one per request.
  private async deliver(clinicId: string, id: string, userId: string | null): Promise<void> {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    const set = (noticeStatus: string, noticeError: string | null = null) => this.prisma.bookingRequest.update({ where: { id }, data: { noticeStatus, noticeError, noticeAt: new Date() } });
    if (!r.confirmedStartsAt) return void (await set('FAILED', 'no_time'));
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, sendingEnabled: true } });
    if (!clinic.sendingEnabled) return void (await set('SKIPPED', 'sending_off'));
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: r.channel, externalId: r.chatId }, select: { optedOutAt: true, patientId: true } });
    if (ch?.optedOutAt) return void (await set('SKIPPED', 'opted_out'));
    const lang = await this.lang({ clinicId, channel: r.channel, chatId: r.chatId, patientId: r.patientId, contactName: r.contactName });
    const address = await this.addressOf(clinicId);
    // booking by cabinets: the shared account is never shown as a doctor; the clinic assigns one
    const byCabinets = r.scheduleMode === 'CABINETS';
    const text = confirmationText(lang, { service: r.confirmedService, startsAt: r.confirmedStartsAt, doctor: byCabinets ? null : r.confirmedDoctor, clinic: clinic.name, address, ...(byCabinets ? { doctorNote: T[lang].clinicAssigns } : {}) });

    const key = `bookconfirm:${id}`;
    const where = { clinicId_channel_externalId: { clinicId, channel: r.channel, externalId: key } };
    const existing = await this.prisma.chatMessage.findUnique({ where });
    if (existing && existing.error === null) return void (await set('SENT'));
    try {
      if (!existing) await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? r.patientId, channel: r.channel, chatId: r.chatId, direction: 'OUT', text, authorUserId: null, byAi: false, externalId: key, error: 'pending' } });
      else await this.prisma.chatMessage.update({ where, data: { error: 'pending', text } });
    } catch (e) {
      // someone else claimed it a moment ago: that one sends it
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
    try {
      await this.messenger.send(clinicId, r.channel, r.chatId, text);
      await this.prisma.chatMessage.update({ where, data: { error: null } });
      await set('SENT');
    } catch (e) {
      const reason = e instanceof SendError ? e.reason : 'failed';
      const detail = e instanceof SendError && e.reason === 'failed' ? e.message : reason;
      await this.prisma.chatMessage.update({ where, data: { error: detail.slice(0, 200) } });
      await set('FAILED', detail.slice(0, 200));
    }
  }
}
