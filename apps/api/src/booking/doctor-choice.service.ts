import { Injectable } from '@nestjs/common';
import { BookingRequest, Doctor, KbItem } from '@prisma/client';
import { clinicDate } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from './availability.service';
import { BLOCK_TEXT, BookingBlock, CabinetBookingService } from './cabinet-booking.service';
import { DoctorsService } from './doctors.service';

export type Lang = 'uk' | 'ru';
export type DoctorReason = 'CLIENT_CHOICE' | 'CONTINUATION' | 'PRIMARY' | 'SERVICE_MATCH' | 'URGENT';

export interface ChoiceButton {
  label: string;
  payload?: string;
  date?: string;
  time?: string;
  doctorId?: string;
}
// What is saved on the request after this turn
export interface RequestPatch {
  doctorId?: string | null;
  doctor?: string | null;
  doctorReason?: DoctorReason | null;
  doctorState?: 'PROPOSED' | 'AGREED' | 'NO_CONTINUATION' | 'WISH_ASKED' | 'ANY_DOCTOR' | 'WISH_ADMIN' | null;
  pendingDoctorId?: string | null;
  urgent?: boolean;
  // Booking by cabinets: how the times were offered, and the real doctor the patient wished (only a wish, never booked through the shared account)
  scheduleMode?: 'DOCTORS' | 'CABINETS' | null;
  wishedDoctor?: string | null;
  // Why a booking by cabinets went to the administrator (see BookingBlock)
  blockCode?: string | null;
}
export type Decision =
  | { kind: 'NONE' }
  | { kind: 'ASK'; reply: string; buttons: ChoiceButton[]; patch: RequestPatch }
  | { kind: 'OFFER'; reply: string; options: ChoiceButton[]; patch: RequestPatch }
  | { kind: 'HANDOFF'; reply: string; patch: RequestPatch; note: string; code?: BookingBlock };

export interface ChoiceContext {
  clinicId: string;
  // set only for a chat tied to a card (a phone typed in the chat proves nothing)
  patientId: string | null;
  service: KbItem;
  // the patient's messages, newest first
  texts: string[];
  lang: Lang;
  request: BookingRequest | null;
}

const name = (d: Pick<Doctor, 'lastName' | 'firstName'>) => `${d.lastName} ${d.firstName}`.trim();
const norm = (s: string) => s.toLowerCase().replace(/[’ʼ'`]/g, '');
const WD = { uk: ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] };
const YES = /^\s*(так|да|yes|ок|окей|добре|гаразд|згоден|согласен|угу|ага|звичайно|конечно)(?![\p{L}])/iu;
const NO = /^\s*(ні|нет|no|не\s+треба|не\s+надо|інший|другой|не\s+згоден|не\s+согласен)(?![\p{L}])/iu;
export const isYes = (t: string) => YES.test(t) && !NO.test(t);
export const isNo = (t: string) => NO.test(t) && !YES.test(t);

// A surname in any case ("до Іваненка", "к Иваненко") or, failing that, a first name; two doctors with one surname are told apart by the first
// name when the person gave it. Returns every doctor that fits: more than one means "ask who".
export function matchDoctors(text: string, doctors: Pick<Doctor, 'externalId' | 'lastName' | 'firstName'>[]): string[] {
  const tokens = norm(text).split(/[^\p{L}-]+/u).filter((t) => t.length >= 3);
  const stem = (w: string) => norm(w).slice(0, Math.max(4, norm(w).length - 2));
  const hits = (w: string) => !!w && tokens.some((t) => t.startsWith(stem(w)) && t.length <= norm(w).length + 3);
  const byLast = doctors.filter((d) => hits(d.lastName));
  if (byLast.length > 1) {
    const byBoth = byLast.filter((d) => hits(d.firstName));
    return (byBoth.length ? byBoth : byLast).map((d) => d.externalId);
  }
  if (byLast.length === 1) return [byLast[0].externalId];
  // a first name alone only counts when it is unique among the doctors
  const byFirst = doctors.filter((d) => hits(d.firstName));
  return byFirst.length === 1 ? [byFirst[0].externalId] : byFirst.length > 1 ? byFirst.map((d) => d.externalId) : [];
}

export const serves = (d: Pick<Doctor, 'serviceIds'>, service: Pick<KbItem, 'id'>): 'yes' | 'no' | 'unknown' => (!d.serviceIds.length ? 'unknown' : d.serviceIds.includes(service.id) ? 'yes' : 'no');

const T = {
  uk: {
    ambiguous: (names: string[]) => `Уточніть, будь ласка, до якого лікаря: ${names.join(' чи ')}?`,
    offer: (n: string) => `Вільний час у лікаря ${n}. Оберіть, будь ласка, зручний кнопкою нижче. Запис підтверджує адміністратор.`,
    offerMany: 'Найближчий вільний час. Оберіть, будь ласка, зручний кнопкою нижче. Запис підтверджує адміністратор.',
    continue: (n: string, service: string) => `Раніше цю послугу («${service}») вам надавав(ла) ${n}. Продовжимо в цього лікаря?`,
    primary: (n: string) => `Для першого запису пропонуємо лікаря ${n}. Підходить?`,
    noWindows: (n: string, alt: string) => `У лікаря ${n} найближчим часом немає вільного часу для цієї послуги. Можемо запропонувати лікаря ${alt}. Згодні?`,
    notProvided: (n: string, alt: string) => `Лікар ${n} цієї послуги не надає. Можемо запропонувати лікаря ${alt}. Згодні?`,
    suitable: (n: string) => `Для цієї послуги можемо запропонувати лікаря ${n}. Згодні?`,
    urgentOther: (n: string) => `Ви хотіли до іншого лікаря, але найближчий вільний час зараз у лікаря ${n}. Згодні на найближчий час в іншого лікаря?`,
    yes: 'Так',
    no: 'Ні',
    handedKeep: (n: string) => `Гаразд, лікаря не змінюємо. Передали заявку адміністратору: він підбере час у лікаря ${n} і напише вам.`,
    handed: 'Передали заявку адміністратору. Він підбере лікаря й час та напише вам. Запис ще не підтверджено.',
    handedService: 'Цю послугу записує адміністратор. Передали заявку: він підбере час та напише вам. Запис ще не підтверджено. Якщо хочете іншу послугу, напишіть, яку саме.',
    handedDoctor: (n: string) => `Передали заявку адміністратору з побажанням: лікар ${n}. Він підбере час та напише вам. Запис ще не підтверджено.`,
    askWho: 'Гаразд. Напишіть, будь ласка, до якого лікаря ви хочете, або що вам усе одно.',
    other: 'Інший',
    offerCabinets: 'Найближчий вільний час. Конкретного лікаря призначає клініка. Оберіть, будь ласка, зручний час кнопкою нижче. Запис підтверджує адміністратор.',
    wishAsk: (n: string) => `Ви згадали лікаря ${n}. Окремого розкладу цього лікаря ми не бачимо, тому не можемо обіцяти запис саме до нього. Можемо записати вас на зручний час до будь-якого лікаря або передати ваше побажання адміністратору, який уточнить. Що обираєте?`,
    wishAny: 'Будь-який лікар',
    wishAdmin: 'Побажання адміністратору',
    wishHanded: (n: string) => `Передали заявку адміністратору з побажанням: лікар ${n}. Напишіть, будь ласка, зручні дату й час: адміністратор уточнить, чи приймає цей лікар, і підтвердить. Запис ще не підтверджено.`,
    handedNoSchedule: 'Не вдалося перевірити актуальний розклад. Передали заявку адміністратору: він підбере час і напише вам. Запис ще не підтверджено.',
  },
  ru: {
    ambiguous: (names: string[]) => `Уточните, пожалуйста, к какому врачу: ${names.join(' или ')}?`,
    offer: (n: string) => `Свободное время у врача ${n}. Выберите, пожалуйста, удобное кнопкой ниже. Запись подтверждает администратор.`,
    offerMany: 'Ближайшее свободное время. Выберите, пожалуйста, удобное кнопкой ниже. Запись подтверждает администратор.',
    continue: (n: string, service: string) => `Ранее эту услугу («${service}») вам оказывал(а) ${n}. Продолжим у этого врача?`,
    primary: (n: string) => `Для первой записи предлагаем врача ${n}. Подходит?`,
    noWindows: (n: string, alt: string) => `У врача ${n} в ближайшее время нет свободного времени для этой услуги. Можем предложить врача ${alt}. Согласны?`,
    notProvided: (n: string, alt: string) => `Врач ${n} эту услугу не оказывает. Можем предложить врача ${alt}. Согласны?`,
    suitable: (n: string) => `Для этой услуги можем предложить врача ${n}. Согласны?`,
    urgentOther: (n: string) => `Вы хотели к другому врачу, но ближайшее свободное время сейчас у врача ${n}. Согласны на ближайшее время у другого врача?`,
    yes: 'Да',
    no: 'Нет',
    handedKeep: (n: string) => `Хорошо, врача не меняем. Передали заявку администратору: он подберёт время у врача ${n} и напишет вам.`,
    handed: 'Передали заявку администратору. Он подберёт врача и время и напишет вам. Запись ещё не подтверждена.',
    handedService: 'Эту услугу записывает администратор. Передали заявку: он подберёт время и напишет вам. Запись ещё не подтверждена. Если хотите другую услугу, напишите, какую именно.',
    handedDoctor: (n: string) => `Передали заявку администратору с пожеланием: врач ${n}. Он подберёт время и напишет вам. Запись ещё не подтверждена.`,
    askWho: 'Хорошо. Напишите, пожалуйста, к какому врачу вы хотите, или что вам всё равно.',
    other: 'Другой',
    offerCabinets: 'Ближайшее свободное время. Конкретного врача назначает клиника. Выберите, пожалуйста, удобное время кнопкой ниже. Запись подтверждает администратор.',
    wishAsk: (n: string) => `Вы упомянули врача ${n}. Отдельного расписания этого врача мы не видим, поэтому не можем обещать запись именно к нему. Можем записать вас на удобное время к любому врачу или передать ваше пожелание администратору, который уточнит. Что выбираете?`,
    wishAny: 'Любой врач',
    wishAdmin: 'Пожелание администратору',
    wishHanded: (n: string) => `Передали заявку администратору с пожеланием: врач ${n}. Напишите, пожалуйста, удобные дату и время: администратор уточнит, принимает ли этот врач, и подтвердит. Запись ещё не подтверждена.`,
    handedNoSchedule: 'Не удалось проверить актуальное расписание. Передали заявку администратору: он подберёт время и напишет вам. Запись ещё не подтверждена.',
  },
};

// Which doctor a visit is booked to, and the dialogue that settles it, in the order: the patient's own wish, the continuation of treatment,
// the doctor for a first booking from the settings, an urgent request. All of it is decided by code on ids of Cliniccards; the model only
// writes the usual part of the conversation. A doctor is never changed without the patient's agreement, and a doctor without a real
// schedule (shifts in Cliniccards or the schedule kept in LANKA) is never offered: an empty calendar does not mean he works.
@Injectable()
export class DoctorChoiceService {
  private tried = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private doctors: DoctorsService,
    private availability: AvailabilityService,
    private cabinets: CabinetBookingService,
  ) {}

  // The doctors of the clinic; read from Cliniccards when nothing is stored yet (at most once per ten minutes per clinic)
  async known(clinicId: string): Promise<Doctor[]> {
    let rows = await this.doctors.activeDoctors(clinicId);
    if (!rows.length && Date.now() - (this.tried.get(clinicId) ?? 0) > 10 * 60_000) {
      this.tried.set(clinicId, Date.now());
      await this.doctors.refresh(clinicId);
      rows = await this.doctors.activeDoctors(clinicId);
    }
    return rows;
  }

  // The service of the dialogue: the approved service of the reference that the name points to
  async findService(clinicId: string, service: string | null): Promise<KbItem | null> {
    if (!service) return null;
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } } });
    const s = norm(service);
    // Several positions can share a name (an imported one and a hand-made one, or the same name in two groups): the one that can really be
    // booked online (allowed, with a length) goes first, then one with a length
    const rank = (x: KbItem) => (x.onlineBooking && x.durationMin ? 0 : x.durationMin ? 1 : 2);
    const best = (list: KbItem[]) => [...list].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    const exact = best(rows.filter((x) => norm(x.title) === s));
    if (exact) return exact;
    // no exact title: a position is taken only when it is the ONLY one the words fit; with several (a generic word like "чистка") nothing is
    // chosen here, so one allowed position never silently stands in for its siblings
    const part = rows.filter((x) => norm(x.title).includes(s) || s.includes(norm(x.title)));
    return new Set(part.map((x) => `${norm(x.title)}|${x.category ?? ''}`)).size > 1 ? null : best(part);
  }

  // Which service the words point to. One exact title wins; with no exact title and several different positions that contain the words
  // ("чистка" can be three hygiene services) the answer is "ambiguous": the patient is asked, nothing is chosen for them.
  async serviceMatch(clinicId: string, service: string | null): Promise<{ service: KbItem | null; ambiguous: KbItem[] }> {
    if (!service) return { service: null, ambiguous: [] };
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null }, missingInSourceAt: null }, orderBy: { title: 'asc' } });
    const s = norm(service);
    if (!rows.some((x) => norm(x.title) === s)) {
      const part = rows.filter((x) => norm(x.title).includes(s) || s.includes(norm(x.title)));
      const distinct = new Map(part.map((x) => [`${norm(x.title)}|${x.category ?? ''}`, x]));
      if (distinct.size > 1) return { service: null, ambiguous: [...distinct.values()].slice(0, 6) };
    }
    return { service: await this.findService(clinicId, service), ambiguous: [] };
  }

  private label(date: string, time: string, lang: Lang, d?: Doctor) {
    const [y, m, day] = date.split('-').map(Number);
    return `${WD[lang][new Date(Date.UTC(y, m - 1, day)).getUTCDay()]} ${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}, ${time}${d ? ` · ${d.lastName}` : ''}`;
  }

  // Buttons with the nearest times of the given doctors (offers carry the id of the doctor)
  private async offerOptions(clinicId: string, docs: Doctor[], minutes: number, lang: Lang): Promise<ChoiceButton[]> {
    const offers = await this.availability.offers(clinicId, docs.map((d) => d.externalId), minutes);
    return offers.map((o) => ({ label: this.label(o.date, o.time, lang, docs.length > 1 ? docs.find((d) => d.externalId === o.doctorId) : undefined), date: o.date, time: o.time, doctorId: o.doctorId }));
  }

  // The nearest times of ONE doctor on buttons (the doctor stays the same: used when the chosen time is gone or the person asks for another)
  // `exclude`: a time that was just found taken in Cliniccards (our copy of the schedule may not know it yet), never offered again
  async doctorOffers(clinicId: string, doctorId: string, minutes: number, lang: Lang, exclude?: { date: string; time: string }): Promise<ChoiceButton[]> {
    const d = (await this.doctors.activeDoctors(clinicId)).find((x) => x.externalId === doctorId);
    if (!d) return [];
    const offers = await this.availability.offers(clinicId, [doctorId], minutes, exclude ? 8 : 3);
    return offers
      .filter((o) => !(exclude && o.date === exclude.date && o.time === exclude.time))
      .slice(0, 3)
      .map((o) => ({ label: this.label(o.date, o.time, lang), date: o.date, time: o.time, doctorId: o.doctorId }));
  }

  private minutes(service: KbItem) {
    return service.durationMin ?? 30;
  }

  // Doctors who really have free time for the service, with the earliest first
  private async withTime(clinicId: string, docs: Doctor[], minutes: number) {
    const out: { doctor: Doctor; first: string }[] = [];
    for (const d of docs) {
      const w = (await this.availability.windows(clinicId, d.externalId, { minutes }))[0];
      if (w) out.push({ doctor: d, first: `${w.date} ${String(w.startMin).padStart(5, '0')}` });
    }
    return out.sort((a, b) => a.first.localeCompare(b.first));
  }

  private handoff(c: ChoiceContext, patch: RequestPatch, note: string, doctor?: Doctor): Decision {
    const x = T[c.lang];
    return { kind: 'HANDOFF', reply: doctor ? x.handedDoctor(name(doctor)) : x.handed, patch, note };
  }

  private ask(c: ChoiceContext, reply: string, doctor: Doctor, patch: RequestPatch): Decision {
    const x = T[c.lang];
    return {
      kind: 'ASK',
      reply,
      buttons: [{ label: x.yes, payload: `docyes|${doctor.externalId}` }, { label: x.no, payload: `docno|${doctor.externalId}` }],
      patch: { ...patch, doctorState: 'PROPOSED', pendingDoctorId: doctor.externalId },
    };
  }

  // An alternative to a doctor who cannot be booked: the first doctor who provides the service and has time; null when there is none
  private async alternative(c: ChoiceContext, exclude: string | null): Promise<Doctor | null> {
    const docs = (await this.known(c.clinicId)).filter((d) => d.externalId !== exclude && serves(d, c.service) === 'yes');
    return (await this.withTime(c.clinicId, docs, this.minutes(c.service)))[0]?.doctor ?? null;
  }

  // ---- the first decision of a booking dialogue ----

  async decide(c: ChoiceContext): Promise<Decision> {
    // The service vanished from the price list of Cliniccards: new online bookings of it are paused until an administrator decides
    if (c.service.missingInSourceAt) return this.handoff(c, {}, 'послугу прибрано з прайсу Cliniccards: запис призупинено до рішення адміністратора');
    const mode = await this.mode(c.clinicId);
    if (mode.scheduleMode === 'CABINETS') return this.decideCabinets(c, mode.sharedDoctorId);
    const docs = await this.known(c.clinicId);
    if (!docs.length) return { kind: 'NONE' };
    const x = T[c.lang];
    const minutes = this.minutes(c.service);
    const req = c.request;
    // a decision is already made and agreed: only the times of that doctor are shown
    if (req?.doctorState === 'AGREED' && req.doctorId) {
      const d = docs.find((y) => y.externalId === req.doctorId);
      if (d) return this.offerOrHandoff(c, d, (req.doctorReason as DoctorReason) ?? 'CLIENT_CHOICE', minutes);
    }
    // a proposal still waiting for an answer is answered by `answer` (a button or "так"/"ні"); any other message is decided again below

    // 1. the patient's own wish
    const wish = c.texts.slice(0, 3).map((t) => matchDoctors(t, docs)).find((m) => m.length);
    if (wish && wish.length > 1) {
      const cand = docs.filter((d) => wish.includes(d.externalId));
      return { kind: 'ASK', reply: x.ambiguous(cand.map(name)), buttons: cand.map((d) => ({ label: name(d), payload: `docpick|${d.externalId}` })), patch: { doctorReason: 'CLIENT_CHOICE', doctorState: null, pendingDoctorId: null } };
    }
    if (wish) return this.fromWish(c, docs.find((d) => d.externalId === wish[0])!, minutes);

    // 2. the continuation of treatment (only for a chat tied to a card, only by the same service)
    if (c.patientId && req?.doctorState !== 'NO_CONTINUATION') {
      const hist = await this.continuationDoctors(c.clinicId, c.patientId, c.service, docs);
      if (hist.length > 1) return { kind: 'ASK', reply: x.ambiguous(hist.map(name)), buttons: hist.map((d) => ({ label: name(d), payload: `docpick|${d.externalId}` })), patch: { doctorReason: 'CLIENT_CHOICE', doctorState: null, pendingDoctorId: null } };
      if (hist.length === 1) {
        const d = hist[0];
        const withTime = await this.withTime(c.clinicId, [d], minutes);
        if (!withTime.length) return this.noWindows(c, d, 'CONTINUATION');
        return this.ask(c, x.continue(name(d), c.service.title), d, { doctorReason: 'CONTINUATION' });
      }
    }

    // 3. the doctor for a first booking
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { primaryDoctorId: true } });
    if (!clinic.primaryDoctorId) return { kind: 'NONE' };
    const primary = docs.find((d) => d.externalId === clinic.primaryDoctorId);
    if (primary && serves(primary, c.service) === 'yes') {
      if (!(await this.withTime(c.clinicId, [primary], minutes)).length) return this.noWindows(c, primary, 'PRIMARY');
      return this.offerOrHandoff(c, primary, 'PRIMARY', minutes);
    }
    // missing, inactive, or does not (or is not known to) provide the service: never booked to him automatically
    const alt = await this.alternative(c, primary?.externalId ?? null);
    if (alt) return this.ask(c, x.suitable(name(alt)), alt, { doctorReason: 'SERVICE_MATCH' });
    return this.handoff(c, { doctorReason: 'PRIMARY', doctorId: primary?.externalId ?? null, doctor: primary ? name(primary) : null }, 'жоден лікар не надає цю послугу з вільним часом');
  }

  private async fromWish(c: ChoiceContext, d: Doctor, minutes: number): Promise<Decision> {
    const x = T[c.lang];
    const kind = serves(d, c.service);
    if (kind === 'no') {
      const alt = await this.alternative(c, d.externalId);
      if (alt) return this.ask(c, x.notProvided(name(d), name(alt)), alt, { doctorReason: 'CLIENT_CHOICE', doctorId: d.externalId, doctor: name(d) });
      return this.handoff(c, { doctorId: d.externalId, doctor: name(d), doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED' }, 'лікар не надає цю послугу', d);
    }
    // unknown: whether he provides the service is not configured, so no time is promised; the administrator decides
    if (kind === 'unknown') return this.handoff(c, { doctorId: d.externalId, doctor: name(d), doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED' }, 'не налаштовано, які послуги надає лікар', d);
    return this.offerOrHandoff(c, d, 'CLIENT_CHOICE', minutes);
  }

  // The doctor is settled: his times on buttons; with no time (or no schedule at all) the doctor is kept on the request and a person takes it
  private async offerOrHandoff(c: ChoiceContext, d: Doctor, reason: DoctorReason, minutes: number): Promise<Decision> {
    const x = T[c.lang];
    const patch: RequestPatch = { doctorId: d.externalId, doctor: name(d), doctorReason: reason, doctorState: 'AGREED', pendingDoctorId: null };
    const options = await this.offerOptions(c.clinicId, [d], minutes, c.lang);
    if (!options.length) return this.noWindows(c, d, reason);
    return { kind: 'OFFER', reply: x.offer(name(d)), options, patch };
  }

  // The settled doctor has no time: another date is not enough here (the list covers two weeks), so another doctor is proposed, or a person
  private async noWindows(c: ChoiceContext, d: Doctor, reason: DoctorReason): Promise<Decision> {
    const x = T[c.lang];
    const alt = await this.alternative(c, d.externalId);
    const source = await this.availability.source(c.clinicId, d.externalId);
    if (alt && source !== 'NONE') return this.ask(c, x.noWindows(name(d), name(alt)), alt, { doctorReason: reason === 'CONTINUATION' || reason === 'CLIENT_CHOICE' ? reason : 'SERVICE_MATCH', doctorId: d.externalId, doctor: name(d) });
    return this.handoff(c, { doctorId: d.externalId, doctor: name(d), doctorReason: reason, doctorState: 'AGREED' }, source === 'NONE' ? 'у лікаря немає надійного розкладу (ні змін у Cliniccards, ні розкладу в LANKA)' : 'у лікаря немає вільного часу', d);
  }

  // Doctors who treated this person with this very service (plan items done by a doctor, visits that took place), never "the last doctor"
  private async continuationDoctors(clinicId: string, patientId: string, service: KbItem, docs: Doctor[]): Promise<Doctor[]> {
    const t = norm(service.title);
    const cat = service.category ? norm(service.category) : null;
    const [items, visits] = await Promise.all([
      this.prisma.planItem.findMany({ where: { clinicId, patientId, status: { in: ['DONE', 'INVOICED'] }, doneByDoctorId: { not: null } }, select: { name: true, groupName: true, doneByDoctorId: true, markedDoneAt: true } }),
      this.prisma.visit.findMany({ where: { clinicId, patientId, status: 'VISITED', doctorId: { not: null } }, select: { serviceName: true, doctorId: true, startsAt: true } }),
    ]);
    const ids = new Set<string>();
    for (const i of items) if (norm(i.name).includes(t) || t.includes(norm(i.name)) || (cat && i.groupName && norm(i.groupName) === cat)) ids.add(i.doneByDoctorId!);
    for (const v of visits) if (v.serviceName && (norm(v.serviceName).includes(t) || t.includes(norm(v.serviceName)))) ids.add(v.doctorId!);
    return docs.filter((d) => ids.has(d.externalId));
  }

  // ---- the answer to a question of the bot (a button or "так"/"ні") ----

  async answer(c: ChoiceContext, kind: 'pick' | 'yes' | 'no' | 'any' | 'wish', doctorId: string | null): Promise<Decision> {
    const x0 = T[c.lang];
    // booking by cabinets: "any doctor" goes on with the ordinary booking by cabinets, "a wish" is passed to an administrator
    if (kind === 'any') return this.cabinetOffer(c, { doctorState: 'ANY_DOCTOR' });
    if (kind === 'wish') return this.cabinetHandoff(c, { doctorState: 'WISH_ADMIN' }, 'wish_admin', x0.wishHanded(c.request?.wishedDoctor ?? ''));
    const docs = await this.known(c.clinicId);
    const req = c.request;
    const x = T[c.lang];
    const minutes = this.minutes(c.service);
    const byId = (id: string | null) => docs.find((d) => d.externalId === id) ?? null;
    if (kind === 'pick') {
      const d = byId(doctorId);
      if (!d) return { kind: 'NONE' };
      return this.fromWish(c, d, minutes);
    }
    const reason = (req?.doctorReason as DoctorReason | null) ?? null;
    const pending = byId(doctorId ?? req?.pendingDoctorId ?? null);
    if (kind === 'yes') {
      if (!pending) return { kind: 'NONE' };
      if (reason === 'URGENT') {
        const urgent = docs.filter((d) => d.acceptsUrgent);
        const options = await this.offerOptions(c.clinicId, urgent, minutes, c.lang);
        return options.length ? { kind: 'OFFER', reply: x.offerMany, options, patch: { doctorReason: 'URGENT', doctorState: 'AGREED', pendingDoctorId: null, urgent: true } } : this.handoff(c, { doctorReason: 'URGENT', urgent: true }, 'жоден лікар, що приймає термінові звернення, не має вільного часу');
      }
      return this.offerOrHandoff(c, pending, reason ?? 'SERVICE_MATCH', minutes);
    }
    // "no"
    const kept = byId(req?.doctorId ?? null);
    if (reason === 'CONTINUATION') return { kind: 'ASK', reply: x.askWho, buttons: [], patch: { doctorReason: null, doctorState: 'NO_CONTINUATION', pendingDoctorId: null, doctorId: null, doctor: null } };
    if (reason === 'URGENT') {
      // the person keeps the doctor they wanted: his times if he has any, otherwise a person takes the urgent request
      if (kept) {
        const options = await this.offerOptions(c.clinicId, [kept], minutes, c.lang);
        if (options.length) return { kind: 'OFFER', reply: x.offer(name(kept)), options, patch: { doctorId: kept.externalId, doctor: name(kept), doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED', pendingDoctorId: null, urgent: true } };
        return this.handoff(c, { doctorState: 'AGREED', pendingDoctorId: null, urgent: true }, 'клієнт відмовився від іншого лікаря', kept);
      }
      return this.handoff(c, { urgent: true, pendingDoctorId: null }, 'клієнт відмовився від іншого лікаря');
    }
    // CLIENT_CHOICE (declined another doctor), PRIMARY, SERVICE_MATCH: the doctor is not changed, a person takes it
    return { kind: 'HANDOFF', reply: kept ? x.handedKeep(name(kept)) : x.handed, patch: { doctorState: kept ? 'AGREED' : null, pendingDoctorId: null }, note: 'клієнт відмовився від запропонованого лікаря' };
  }

  // ---- booking by cabinets through one shared account ----

  private async mode(clinicId: string) {
    return this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true, sharedDoctorId: true } });
  }

  // A real doctor the patient named: first among the doctors of the reference (surname in any case), then "до лікаря Прізвище"
  private async wishedDoctor(clinicId: string, texts: string[]): Promise<string | null> {
    const kb = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'DOCTOR', active: true, approvedAt: { not: null } }, select: { id: true, title: true } });
    const fake = kb.map((k) => ({ externalId: k.id, lastName: k.title.split(/\s+/)[0] ?? k.title, firstName: k.title.split(/\s+/).slice(1).join(' ') }));
    for (const t of texts.slice(0, 3)) {
      const hit = matchDoctors(t, fake)[0];
      if (hit) return kb.find((k) => k.id === hit)!.title;
      const m = /(?:^|[^\p{L}])(?:до|к)\s+(?:лікар(?:я|ю|і)|доктор(?:а|у)?|врач(?:а|у)?)\s+([\p{Lu}][\p{L}'’-]{2,})/u.exec(t);
      if (m) return m[1];
    }
    return null;
  }

  // The reply of a hand-over in this mode: no time and no doctor are promised. `why` is a BookingBlock code (the administrator sees its text next
  // to the request) or a short fixed note; the patient never gets a technical word.
  private cabinetHandoff(c: { lang: Lang }, patch: RequestPatch, why: BookingBlock | 'wish_admin', text?: string): Decision {
    const note = why === 'wish_admin' ? 'клієнт хоче конкретного лікаря: потрібно уточнити, чи він приймає' : BLOCK_TEXT[why];
    return { kind: 'HANDOFF', reply: text ?? T[c.lang].handed, patch: { scheduleMode: 'CABINETS', ...(why === 'wish_admin' ? {} : { blockCode: why }), ...patch }, note, ...(why === 'wish_admin' ? {} : { code: why }) };
  }

  // The nearest times of the cabinets for the service; a schedule that cannot be read is never replaced by an old one
  private async cabinetOffer(c: ChoiceContext, patch: RequestPatch): Promise<Decision> {
    const x = T[c.lang];
    const svc = c.service;
    // the reason is found step by step (settings, then the schedule read from Cliniccards now): the administrator sees exactly which one
    const r = await this.cabinets.blockReason(c.clinicId, svc);
    if (r.code) return this.cabinetHandoff(c, patch, r.code, r.code === 'schedule_unreadable' ? x.handedNoSchedule : r.code === 'service_not_allowed' || r.code === 'no_length' ? x.handedService : undefined);
    return { kind: 'OFFER', reply: x.offerCabinets, options: r.offers.map((o) => ({ label: this.label(o.date, o.time, c.lang), date: o.date, time: o.time })), patch: { scheduleMode: 'CABINETS', ...patch } };
  }

  private async decideCabinets(c: ChoiceContext, sharedId: string | null): Promise<Decision> {
    const x = T[c.lang];
    const req = c.request;
    // The service itself first (never replaced by another one: a different service is offered only if the patient agrees), then the shared account
    if (!c.service.onlineBooking) return this.cabinetHandoff(c, {}, 'service_not_allowed', x.handedService);
    if (!c.service.durationMin) return this.cabinetHandoff(c, {}, 'no_length', x.handedService);
    const shared = sharedId ? (await this.doctors.activeDoctors(c.clinicId)).find((d) => d.externalId === sharedId) : null;
    if (!shared) return this.cabinetHandoff(c, {}, 'no_shared_account');
    if (req?.doctorState === 'WISH_ADMIN') return this.cabinetHandoff(c, {}, 'wish_admin', x.wishHanded(req.wishedDoctor ?? ''));
    if (req?.doctorState !== 'ANY_DOCTOR') {
      // a real doctor was named: there is no separate schedule of his, so he is only a wish, and the person decides what to do with it
      const wish = await this.wishedDoctor(c.clinicId, c.texts);
      if (wish) {
        return {
          kind: 'ASK',
          reply: x.wishAsk(wish),
          buttons: [{ label: x.wishAny, payload: 'docany|0' }, { label: x.wishAdmin, payload: 'docwish|0' }],
          patch: { scheduleMode: 'CABINETS', wishedDoctor: wish, doctorState: 'WISH_ASKED', doctorId: null, doctor: null, doctorReason: null },
        };
      }
    }
    return this.cabinetOffer(c, req?.doctorState === 'ANY_DOCTOR' ? { doctorState: 'ANY_DOCTOR' } : {});
  }

  // ---- an urgent request ----

  async urgent(c: Omit<ChoiceContext, 'service'> & { service: KbItem | null }): Promise<Decision> {
    const mode = await this.mode(c.clinicId);
    if (mode.scheduleMode === 'CABINETS') {
      // the cabinets the clinic allows for urgent patients; one priority request; the bot never books it by itself
      const x = T[c.lang];
      const patch: RequestPatch = { scheduleMode: 'CABINETS', doctorReason: 'URGENT', urgent: true };
      try {
        const offers = await this.cabinets.offers(c.clinicId, { minutes: c.service?.durationMin ?? 30, service: c.service, urgent: true });
        if (!offers.length) return { kind: 'HANDOFF', reply: x.handed, patch, note: 'немає вільного часу в кабінетах для термінових звернень' };
        return { kind: 'OFFER', reply: x.offerCabinets, options: offers.map((o) => ({ label: this.label(o.date, o.time, c.lang), date: o.date, time: o.time })), patch };
      } catch {
        return { kind: 'HANDOFF', reply: x.handedNoSchedule, patch, note: 'не вдалося оновити розклад Cliniccards' };
      }
    }
    const docs = await this.known(c.clinicId);
    if (!docs.length) return { kind: 'NONE' };
    const x = T[c.lang];
    const minutes = c.service?.durationMin ?? 30;
    const urgentDocs = docs.filter((d) => d.acceptsUrgent);
    // nobody is marked as taking urgent patients: the usual urgent answer (the nearest times of the clinic) applies, and the settings say so
    if (!urgentDocs.length) return { kind: 'NONE' };
    const patch: RequestPatch = { doctorReason: 'URGENT', urgent: true };
    const options = await this.offerOptions(c.clinicId, urgentDocs, minutes, c.lang);
    const wantedId = c.request?.doctorReason === 'CLIENT_CHOICE' ? c.request.doctorId : null;
    if (!options.length) return this.handoff({ ...c, service: c.service ?? ({} as KbItem) }, { ...patch }, 'жоден лікар, що приймає термінові звернення, не має вільного часу');
    // the person wanted a particular doctor, and the nearest time is somebody else's: the doctor is changed only with a "yes"
    if (wantedId && options[0].doctorId !== wantedId) {
      const other = urgentDocs.find((d) => d.externalId === options[0].doctorId)!;
      return this.ask({ ...c, service: c.service ?? ({} as KbItem) }, x.urgentOther(name(other)), other, patch);
    }
    return { kind: 'OFFER', reply: x.offerMany, options, patch: { ...patch, doctorState: 'AGREED' } };
  }

  static today = () => clinicDate(new Date());
}
