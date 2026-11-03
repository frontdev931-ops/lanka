import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookingRequest, Prisma } from '@prisma/client';
import { bookingWriteSupported } from '../ai/ai.service';
import { ChatAssistantService, SlotOption } from '../ai/chat-assistant.service';
import { languageOf } from '../ai/guardrails';
import { AvailabilityService } from '../booking/availability.service';
import { BookingService } from '../booking/booking.service';
import { DoctorChoiceService, isNo, isYes, serves } from '../booking/doctor-choice.service';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { normalizePhone } from '../common/phone';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { slotPayload } from './channels';
import { MessengerService, SendError } from './messenger.service';
import { RequestsService } from './requests.service';

// After the bot asks this many times for the name and the phone it stops and hands the request over with what it has
const MAX_ASKS = 6;
// A confirmation message that has been "being sent" this long is probably lost (the server stopped); only an explicit retry sends it again
const NOTICE_STUCK_MS = 5 * 60_000;
// A request still waiting for a name or a phone this long after its last change no longer holds the dialog
const COLLECT_STALE_MS = 6 * 3_600_000;
const FREE_STATUSES = ['CANCELLED', 'MOVED', 'DID_NOT_COME'];

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

const YES = /^\s*(так|да|yes|ок|окей|добре|гаразд|підтверджую|подтверждаю|згоден|согласен|угу|ага|звичайно|конечно)(?![\p{L}])/iu;
const NO = /^\s*(ні|нет|no|не\s+треба|не\s+надо|інший|другой|скасувати|отмена)(?![\p{L}])/iu;

const T = {
  uk: {
    askAll: 'Щоб оформити запис, напишіть, будь ласка, прізвище, ім’я та номер телефону. Можна одним повідомленням, наприклад: «Прізвище Коваль, ім’я Ірина, телефон 0971234567».',
    askLast: 'Підкажіть, будь ласка, ваше прізвище (одним словом).',
    askFirst: 'Дякуємо! Тепер, будь ласка, ваше ім’я (одним словом).',
    askPhone: 'Дякуємо! Підкажіть, будь ласка, номер телефону для зв’язку.',
    handed: (service: string | null, date: string, time: string) => `Дякуємо! Передали заявку на ${service ?? 'запис'} на ${date} о ${time} адміністратору. Очікуйте підтвердження запису.`,
    handedPlain: 'Дякуємо! Передали заявку адміністратору. Очікуйте підтвердження запису.',
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
    askLast: 'Подскажите, пожалуйста, вашу фамилию (одним словом).',
    askFirst: 'Спасибо! Теперь, пожалуйста, ваше имя (одним словом).',
    askPhone: 'Спасибо! Подскажите, пожалуйста, номер телефона для связи.',
    handed: (service: string | null, date: string, time: string) => `Спасибо! Передали заявку на ${service ?? 'запись'} на ${date} в ${time} администратору. Ожидайте подтверждения записи.`,
    handedPlain: 'Спасибо! Передали заявку администратору. Ожидайте подтверждения записи.',
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
export function confirmationText(lang: Lang, p: { service: string | null; startsAt: Date; doctor: string | null; clinic: string; address: string | null }): string {
  const x = T[lang];
  const lines = [x.head];
  if (p.service) lines.push(`${x.service}: ${p.service}`);
  lines.push(`${x.date}: ${fmtDate(clinicDate(p.startsAt))}`, `${x.time}: ${clinicHm(p.startsAt)}`);
  if (p.doctor) lines.push(`${x.doctor}: ${p.doctor}`);
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
  ) {}

  private async lang(c: FlowCtx): Promise<Lang> {
    const last = await this.prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, channel: c.channel, chatId: c.chatId, direction: 'IN', NOT: { text: { startsWith: 'Обрав час:' } } }, orderBy: { createdAt: 'desc' }, take: 6, select: { text: true } });
    return languageOf(last.map((m) => m.text));
  }

  // The bot's own message: only when the clinic allowed sending and the person did not opt out
  private async say(c: FlowCtx, text: string, options: SlotOption[] = []): Promise<boolean> {
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
    const prev = (open?.summary ?? '').replace(/^Обрано час:[^.]*\.\s*/, '');
    const row = await this.requests.upsert(
      c.clinicId,
      { channel: c.channel, chatId: c.chatId, patientId: c.patientId, contactName: c.contactName, kind: (open?.kind as 'BOOKING' | 'RESCHEDULE' | 'CANCEL') ?? 'BOOKING', summary: `Обрано час: ${label}. ${prev}`.trim() },
      false,
      // the staff is told when the request is complete, not at every step
      true,
    );
    // The button may carry the doctor as an id of Cliniccards ("#501"); only a doctor the clinic really has is stored, by id and by name.
    // A tap without a doctor never wipes the doctor of the request.
    let doctorPatch: Prisma.BookingRequestUpdateInput = {};
    if (slot.doctor?.startsWith('#')) {
      const d = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: slot.doctor.slice(1) } } });
      if (d) {
        doctorPatch = { doctorId: d.externalId, doctor: `${d.lastName} ${d.firstName}`.trim(), doctorReason: open?.doctorReason ?? 'CLIENT_CHOICE' };
        if (open?.doctorId !== d.externalId) await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: null, action: 'booking_request.doctor', details: { request: row.id, doctorId: d.externalId, reason: open?.doctorReason ?? 'CLIENT_CHOICE' } } });
      }
    } else if (slot.doctor) doctorPatch = { doctor: slot.doctor };
    // a different time or doctor than before: the request is collected again, and the automatic mode asks the person's yes again
    await this.prisma.bookingRequest.update({ where: { id: row.id }, data: { slotAt, ...doctorPatch, stage: 'COLLECT', autoState: null, asks: 0 } });
    await this.advance(c, row.id);
  }

  // ---- 2. later messages while the data is being collected ----

  // Returns true only when the message was taken as an answer AND the bot replied to it (otherwise the message goes on to the AI, never into silence)
  async onText(c: FlowCtx, text: string): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    // A proposed doctor waits for the person's "yes" or "no"
    if (open?.doctorState === 'PROPOSED' && open.stage !== 'CONFIRM' && !text.includes('?')) {
      if (isYes(text)) return this.onDoctorAnswer(c, 'yes', open.pendingDoctorId);
      if (isNo(text)) return this.onDoctorAnswer(c, 'no', open.pendingDoctorId);
    }
    if (!open || (open.stage !== 'COLLECT' && open.stage !== 'CONFIRM')) return false;
    // A forgotten question from long ago does not hold the dialog
    if (Date.now() - open.updatedAt.getTime() > COLLECT_STALE_MS) return this.skipCollect(c, 'stale');
    if (open.stage === 'CONFIRM') {
      const yes = YES.test(text);
      const no = NO.test(text);
      if (yes !== no) return this.onConfirmAnswer(c, yes, open.id);
      if (text.includes('?') || open.asks >= MAX_ASKS) return this.skipCollect(c, 'question');
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
    if (!labeled.lastName && !labeled.firstName) {
      // an answer to "your surname?" / "your first name?" is one word; anything else is never guessed (the order of words proves nothing)
      const word = singleNameWord(text);
      if (word && open.askField === 'lastName' && !open.lastName) patch.lastName = word;
      else if (word && open.askField === 'firstName' && !open.firstName) patch.firstName = word;
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
    const field = missing.length === 3 && r.asks === 0 ? 'all' : missing[0];
    // asks is raised first: a repeated delivery of the same event does not ask twice in a row
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, asks: r.asks, stage: 'COLLECT' }, data: { asks: r.asks + 1, askField: field } });
    if (!claim.count) return true;
    const sentOk = await this.say(c, field === 'all' ? x.askAll : field === 'lastName' ? x.askLast : field === 'firstName' ? x.askFirst : x.askPhone);
    if (!sentOk) this.log.log(`Booking flow could not ask for the data: message not sent (clinic ${c.clinicId}, ${c.channel})`);
    return sentOk;
  }

  // ---- the answer to a question about the doctor (a button, or "так"/"ні") ----

  // docpick: the person chose one of the doctors named; docyes/docno: the answer to a proposed doctor. A repeated answer does nothing twice.
  async onDoctorAnswer(c: FlowCtx, kind: 'pick' | 'yes' | 'no', doctorId: string | null): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    if (!open) return false;
    if (kind === 'pick') {
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
    const dec = await this.choice.answer({ clinicId: c.clinicId, patientId: c.patientId, service, texts, lang, request: open }, kind, doctorId);
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
      await this.say(c, dec.reply);
    }
    return true;
  }

  // ---- 3. complete: one full request for the administrator, or the automatic booking ----

  private async complete(c: FlowCtx, id: string, incomplete: boolean): Promise<void> {
    const pre = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    let note: string | undefined;
    // The automatic mode asks the person to confirm first, and only when everything needed for the booking is known: the length of the
    // visit (never guessed), a free place and a doctor (Cliniccards requires one). Otherwise a person completes the request.
    if (!incomplete && pre.slotAt && (await this.autoMode(c.clinicId))) {
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
    await this.tellHandedOver(c, r.service, r.slotAt);
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

  // The automatic mode: the person confirms the booking in so many words before anything is written
  private async askConfirm(c: FlowCtx, id: string) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    const x = T[await this.lang(c)];
    const text = x.confirmAsk(r.service, fmtDate(clinicDate(r.slotAt!)), clinicHm(r.slotAt!), r.doctor);
    await this.say(c, text, [
      { label: x.yes, date: '', time: '', payload: `bookyes|${id}` },
      { label: x.no, date: '', time: '', payload: `bookno|${id}` },
    ]);
  }

  // The answer to the question above (a button or a typed "так"/"ні"). A repeated answer does nothing the second time.
  async onConfirmAnswer(c: FlowCtx, yes: boolean, requestId: string | null): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    if (!open || open.stage !== 'CONFIRM' || (requestId && open.id !== requestId)) return false;
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
    if (r.slotAt && (await this.autoMode(c.clinicId))) await this.runAuto(c, open.id);
    else await this.tellHandedOver(c, r.service, r.slotAt);
    return true;
  }

  private async tellHandedOver(c: FlowCtx, service: string | null, slotAt: Date | null) {
    const x = T[await this.lang(c)];
    await this.say(c, slotAt ? x.handed(service, fmtDate(clinicDate(slotAt)), clinicHm(slotAt)) : x.handedPlain);
  }

  // ---- 4. the automatic mode ----

  // The mode is on only where the clinic asked for it AND writing is allowed at all (service-wide switch and the clinic's own switch)
  private async autoMode(clinicId: string): Promise<boolean> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiAutoBooking: true } });
    if (!c.aiAutoBooking || !bookingWriteSupported()) return false;
    return (await this.booking.status(clinicId)).enabled;
  }

  private async handToAdmin(c: FlowCtx, id: string, note: string) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, select: { service: true, slotAt: true, summary: true } });
    await this.prisma.bookingRequest.update({ where: { id }, data: { autoState: 'FAILED', autoNote: note.slice(0, 300), summary: `${r.summary}; автозапис не виконано: ${note}`.slice(0, 500) } });
    await this.requests.notify(c.clinicId, id, false);
    // never "you are booked": the person is told that the administrator confirms
    await this.tellHandedOver(c, r.service, r.slotAt);
  }

  private async runAuto(c: FlowCtx, id: string): Promise<void> {
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, autoState: null }, data: { autoState: 'RUNNING' } });
    if (!claim.count) return;
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
    const slotAt = r.slotAt!;
    try {
      let patientId = r.patientId;
      if (!patientId) {
        const found = r.phone ? await this.booking.matches(c.clinicId, r.phone) : [];
        // A card with this phone exists: a phone alone does not prove who writes, a person checks it
        if (found.length) return await this.handToAdmin(c, id, 'є картка з таким телефоном, потрібно підтвердити особу');
        if (!r.lastName || !r.firstName || !r.phone) return await this.handToAdmin(c, id, 'немає прізвища, імені або телефону');
        const created = await this.booking.createPatient(c.clinicId, null, { lastName: r.lastName, firstName: r.firstName, phone: r.phone, channel: c.channel });
        if (created.existing) return await this.handToAdmin(c, id, 'картка пацієнта вже існує, потрібно підтвердити особу');
        patientId = created.patientId;
        // the card is ours (just created for this chat): the chat can be tied to it
        await this.booking.linkChat(c.clinicId, patientId, c.channel, c.chatId);
        await this.prisma.bookingRequest.update({ where: { id }, data: { patientId } });
      }
      const durationMin = await this.durationFor(c.clinicId, r.service);
      if (durationMin === null) return await this.handToAdmin(c, id, 'тривалість послуги невідома');
      const place = await this.placement(c, r, durationMin);
      if (!place.ok) return place.busy ? await this.busy(c, id, 'вікно вже не вільне') : await this.handToAdmin(c, id, place.note ?? 'лікаря не визначено');
      const doBook = () => this.booking.book(c.clinicId, null, { patientId: patientId!, startsAt: slotAt, durationMin, cabinetId: place.cabinetId, doctorId: place.doctorId, note: 'Запис створено ботом LANKA', requestId: id });
      let res;
      try {
        res = await doBook();
      } catch (e) {
        // The answer was lost (timeout): look whether the visit appeared before anything else; a repeated call does exactly that
        if (e instanceof ConflictException && e.message === 'booking_unknown') res = await doBook();
        else throw e;
      }
      await this.finishAuto(c, id, r, slotAt, place.doctorName, res.externalVisitId);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'failed';
      if (code === 'booking_slot_taken' || code === 'booking_slot_blocked') return await this.busy(c, id, code);
      this.log.warn(`Automatic booking not done for request ${id}: ${code}`);
      await this.handToAdmin(c, id, code === 'booking_unknown' ? 'не вдалося перевірити, чи створено запис' : code === 'booking_patient_busy' ? 'у пацієнта вже є запис на цей час' : 'запис у Cliniccards не створено');
    }
  }

  // The visit exists in Cliniccards: only now is the client told, with the real time
  private async finishAuto(c: FlowCtx, id: string, r: { service: string | null; doctor: string | null; doctorId: string | null; doctorReason: string | null }, startsAt: Date, doctorName: string | null, externalVisitId: string | null) {
    const claim = await this.prisma.bookingRequest.updateMany({
      where: { id, confirmedAt: null },
      data: { status: 'DONE', handledAt: new Date(), confirmedAt: new Date(), confirmedBy: 'AUTO', confirmSource: 'AUTO', confirmedStartsAt: startsAt, confirmedService: r.service, confirmedDoctor: doctorName ?? r.doctor, externalVisitId, noticeStatus: 'PENDING', autoState: 'DONE' },
    });
    if (!claim.count) return;
    await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: null, action: 'booking_request.confirmed', details: { request: id, by: 'auto', visit: externalVisitId, at: startsAt.toISOString(), doctorId: r.doctorId, doctorReason: r.doctorReason } } });
    await this.deliver(c.clinicId, id, null);
  }

  // Fresh times after the chosen one is gone or refused: of the SAME doctor when the request has one (never another without the person's yes),
  // otherwise from the schedule report as before
  private async freshFor(c: FlowCtx, r: { doctorId: string | null; doctor: string | null; service: string | null; slotAt?: Date | null }, taken = false): Promise<SlotOption[]> {
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
  private async placement(c: FlowCtx, r: BookingRequest, minutes: number): Promise<{ ok: true; cabinetId: string; doctorId: string; doctorName: string | null } | { ok: false; busy: boolean; note?: string }> {
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
    const places = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'LOCATION', active: true, approvedAt: { not: null } }, select: { title: true, text: true }, take: 2 });
    const address = places.length === 1 ? (places[0].text.trim() || places[0].title).split('\n')[0].slice(0, 200) : null;
    const text = confirmationText(lang, { service: r.confirmedService, startsAt: r.confirmedStartsAt, doctor: r.confirmedDoctor, clinic: clinic.name, address });

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
