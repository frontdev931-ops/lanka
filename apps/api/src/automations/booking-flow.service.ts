import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { bookingWriteSupported } from '../ai/ai.service';
import { ChatAssistantService, SlotOption } from '../ai/chat-assistant.service';
import { languageOf } from '../ai/guardrails';
import { BookingService } from '../booking/booking.service';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { normalizePhone } from '../common/phone';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { MessengerService, SendError } from './messenger.service';
import { RequestsService } from './requests.service';

// After the bot asks this many times for the name and the phone it stops and hands the request over with what it has
const MAX_ASKS = 3;
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

const fmtDate = (ymd: string) => ymd.split('-').reverse().join('.');
const titleCase = (w: string) => w.charAt(0).toLocaleUpperCase('uk') + w.slice(1).toLocaleLowerCase('uk');

const FILLER = new Set(['мене', 'звати', 'звуть', 'мое', 'моє', 'моё', 'мій', 'мой', 'имя', 'ім’я', 'ім\'я', 'прізвище', 'фамилия', 'піб', 'фио', 'номер', 'телефон', 'тел', 'це', 'вот', 'ось', 'дякую', 'спасибо', 'будь', 'ласка', 'пожалуйста', 'и', 'та', 'і', 'я', 'мобільний', 'мобильный', 'мій', 'номер']);

// Words of an ordinary answer or question: text that holds one of them is a sentence, not a name
const NOT_A_NAME = new Set(['не', 'знаю', 'так', 'ні', 'да', 'нет', 'ок', 'окей', 'добре', 'привіт', 'привет', 'що', 'шо', 'як', 'коли', 'де', 'чи', 'чому', 'скільки', 'сколько', 'когда', 'что', 'как', 'почему', 'хочу', 'можна', 'можно', 'буду', 'потрібно', 'нужно', 'запишіть', 'запишите', 'будь', 'ласка', 'хотів', 'хотела', 'хотіла', 'хотел', 'є', 'есть', 'ціна', 'цена', 'коштує']);

// A name and a phone out of free text ("Ірина Коваль 097 123 45 67"). A name needs at least two words (surname and first name).
export function parseContact(text: string): { name: string | null; phone: string | null } {
  const m = /\+?\d[\d\s().-]{7,}\d/.exec(text);
  const phone = m ? normalizePhone(m[0]) : null;
  const rest = m ? text.replace(m[0], ' ') : text;
  const words = rest.split(/[^\p{L}'’ʼ-]+/u).filter((w) => w.length > 0 && !FILLER.has(w.toLowerCase()));
  const sentence = words.some((w) => NOT_A_NAME.has(w.toLowerCase()));
  const name = !sentence && words.length >= 2 && words.length <= 4 && words.every((w) => w.length >= 2) ? words.map(titleCase).join(' ') : null;
  return { name, phone };
}

const T = {
  uk: {
    askBoth: 'Щоб передати заявку адміністратору, підкажіть, будь ласка, ваше прізвище та ім’я і номер телефону.',
    askName: 'Дякуємо! Підкажіть, будь ласка, ваше прізвище та ім’я повністю.',
    askPhone: 'Дякуємо! Підкажіть, будь ласка, номер телефону для зв’язку.',
    handed: (service: string | null, date: string, time: string) => `Дякуємо! Передали заявку на ${service ?? 'запис'} на ${date} о ${time} адміністратору. Очікуйте підтвердження запису.`,
    handedPlain: 'Дякуємо! Передали заявку адміністратору. Очікуйте підтвердження запису.',
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
    askBoth: 'Чтобы передать заявку администратору, подскажите, пожалуйста, вашу фамилию и имя и номер телефона.',
    askName: 'Спасибо! Подскажите, пожалуйста, вашу фамилию и имя полностью.',
    askPhone: 'Спасибо! Подскажите, пожалуйста, номер телефона для связи.',
    handed: (service: string | null, date: string, time: string) => `Спасибо! Передали заявку на ${service ?? 'запись'} на ${date} в ${time} администратору. Ожидайте подтверждения записи.`,
    handedPlain: 'Спасибо! Передали заявку администратору. Ожидайте подтверждения записи.',
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
        ...(options.length ? { buttons: options.map((o) => ({ label: o.label, payload: `slot|${o.date}|${o.time}${o.doctor ? `|${o.doctor.slice(0, 16)}` : ''}` })) } : {}),
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
    // a different time than before: the request is collected again for the new time
    await this.prisma.bookingRequest.update({ where: { id: row.id }, data: { slotAt, doctor: slot.doctor ?? null, stage: 'COLLECT', autoState: null } });
    await this.advance(c, row.id);
  }

  // ---- 2. later messages while the data is being collected ----

  // Returns true only when the message was taken as an answer AND the bot replied to it (otherwise the message goes on to the AI, never into silence)
  async onText(c: FlowCtx, text: string): Promise<boolean> {
    const open = await this.requests.openFor(c.clinicId, c.channel, c.chatId);
    if (!open || open.stage !== 'COLLECT') return false;
    // A forgotten question from long ago does not hold the dialog
    if (Date.now() - open.updatedAt.getTime() > COLLECT_STALE_MS) return this.skipCollect(c, 'stale');
    const got = parseContact(text);
    if (!got.name && !got.phone) {
      // a question is for the AI; anything else is asked again a few times, then the request goes on as it is
      if (text.includes('?')) return this.skipCollect(c, 'question');
      if (open.asks >= MAX_ASKS) {
        await this.complete(c, open.id, true);
        return false;
      }
      return this.advance(c, open.id);
    }
    const patch: Prisma.BookingRequestUpdateInput = {};
    if (got.name) patch.fullName = got.name;
    if (got.phone) patch.phone = got.phone;
    await this.prisma.bookingRequest.update({ where: { id: open.id }, data: patch });
    return this.advance(c, open.id);
  }

  private skipCollect(c: FlowCtx, reason: string): false {
    this.log.log(`Booking flow did not take the message: ${reason} (clinic ${c.clinicId}, ${c.channel})`);
    return false;
  }

  // Asks for what is missing, or completes the request when everything is known. Returns true when the bot sent a message.
  private async advance(c: FlowCtx, id: string): Promise<boolean> {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, include: { patient: { select: { fullName: true, phone: true } } } });
    if (r.stage === 'READY') return false;
    const needName = !r.fullName && !r.patient?.fullName;
    const needPhone = !r.phone && !normalizePhone(r.patient?.phone);
    if (!needName && !needPhone) {
      await this.complete(c, id, false);
      return true;
    }
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { sendingEnabled: true } });
    // The bot cannot ask (sending is off) or already asked enough: the administrator gets what there is
    if (!clinic.sendingEnabled || r.asks >= MAX_ASKS) {
      await this.complete(c, id, true);
      return false;
    }
    const lang = await this.lang(c);
    const x = T[lang];
    // asks is raised first: a repeated delivery of the same event does not ask twice in a row
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, asks: r.asks, stage: 'COLLECT' }, data: { asks: r.asks + 1 } });
    if (!claim.count) return true;
    const sentOk = await this.say(c, needName && needPhone ? x.askBoth : needName ? x.askName : x.askPhone);
    if (!sentOk) this.log.log(`Booking flow could not ask for the data: message not sent (clinic ${c.clinicId}, ${c.channel})`);
    return sentOk;
  }

  // ---- 3. complete: one full request for the administrator, or the automatic booking ----

  private async complete(c: FlowCtx, id: string, incomplete: boolean): Promise<void> {
    const claim = await this.prisma.bookingRequest.updateMany({ where: { id, stage: { not: 'READY' } }, data: { stage: 'READY' } });
    if (!claim.count) return;
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, include: { patient: { select: { fullName: true, phone: true } } } });
    const name = r.fullName ?? r.patient?.fullName ?? null;
    const phone = r.phone ?? r.patient?.phone ?? null;
    const when = r.slotAt ? `${fmtDate(clinicDate(r.slotAt))} ${clinicHm(r.slotAt)}` : null;
    const summary = [
      r.kind === 'RESCHEDULE' ? 'Перенесення' : 'Запис',
      r.service ? `послуга: ${r.service}` : null,
      when ? `час: ${when}` : null,
      r.doctor ? `лікар: ${r.doctor}` : null,
      name ? `ПІБ: ${name}` : 'ПІБ не отримано',
      phone ? `тел.: ${phone}` : 'телефон не отримано',
      `канал: ${c.channel}`,
    ]
      .filter(Boolean)
      .join('; ');
    await this.prisma.bookingRequest.update({ where: { id }, data: { summary: summary.slice(0, 500) } });
    await this.requests.notify(c.clinicId, id, false);

    if (!incomplete && r.slotAt && (await this.autoMode(c.clinicId))) return this.runAuto(c, id);
    await this.tellHandedOver(c, r.service, r.slotAt);
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
        if (!r.fullName || !r.phone) return await this.handToAdmin(c, id, 'немає ПІБ або телефону');
        const created = await this.booking.createPatient(c.clinicId, null, { fullName: r.fullName, phone: r.phone, source: c.channel });
        if (created.existing) return await this.handToAdmin(c, id, 'картка пацієнта вже існує, потрібно підтвердити особу');
        patientId = created.patientId;
        // the card is ours (just created for this chat): the chat can be tied to it
        await this.booking.linkChat(c.clinicId, patientId, c.channel, c.chatId);
        await this.prisma.bookingRequest.update({ where: { id }, data: { patientId } });
      }
      const durationMin = await this.durationFor(c.clinicId, r.service);
      const place = await this.place(c.clinicId, slotAt, durationMin, r.doctor);
      if (!place) return await this.busy(c, id, 'вікно вже не вільне');
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
  private async finishAuto(c: FlowCtx, id: string, r: { service: string | null; doctor: string | null }, startsAt: Date, doctorName: string | null, externalVisitId: string | null) {
    const claim = await this.prisma.bookingRequest.updateMany({
      where: { id, confirmedAt: null },
      data: { status: 'DONE', handledAt: new Date(), confirmedAt: new Date(), confirmedBy: 'AUTO', confirmSource: 'AUTO', confirmedStartsAt: startsAt, confirmedService: r.service, confirmedDoctor: doctorName ?? r.doctor, externalVisitId, noticeStatus: 'PENDING', autoState: 'DONE' },
    });
    if (!claim.count) return;
    await this.prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: null, action: 'booking_request.confirmed', details: { request: id, by: 'auto', visit: externalVisitId, at: startsAt.toISOString() } } });
    await this.deliver(c.clinicId, id, null);
  }

  // The chosen time is gone: fresh times are offered, the request stays open
  private async busy(c: FlowCtx, id: string, note: string) {
    const r = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id }, select: { doctor: true } });
    const options = await this.assistant.freshOptions(c.clinicId, r.doctor).catch(() => [] as SlotOption[]);
    await this.prisma.bookingRequest.update({ where: { id }, data: { stage: 'NONE', slotAt: null, autoState: null, autoNote: note.slice(0, 300) } });
    const x = T[await this.lang(c)];
    await this.say(c, options.length ? x.busy : x.busyNoOptions, options);
  }

  // The length of the visit from the clinic's approved reference (default half an hour)
  private async durationFor(clinicId: string, service: string | null): Promise<number> {
    if (!service) return 30;
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null }, durationMin: { not: null } }, select: { title: true, durationMin: true } });
    const s = service.toLowerCase();
    const hit = rows.find((x) => x.title.toLowerCase() === s) ?? rows.find((x) => x.title.toLowerCase().includes(s) || s.includes(x.title.toLowerCase()));
    return Math.min(240, Math.max(15, hit?.durationMin ?? 30));
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
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking_request.confirmed', details: { request: id, by: 'admin', source: hit ? 'cliniccards' : 'manual', at: startsAt.toISOString() } } });
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
