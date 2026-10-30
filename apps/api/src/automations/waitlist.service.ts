import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { accessBlocked, billingEnforced } from '../service/plans';
import { RequestsService } from './requests.service';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ENTRY_DAYS = 30;
const MAX_ENTRIES = 300;
// The patient has this long to answer from the moment the offer is really sent; never later than 30 minutes before the visit
export const OFFER_TTL_MS = 3 * HOUR;
// Nothing sooner than this is offered: the patient needs time to come
const MIN_LEAD_MS = 2 * HOUR;
// An accepted time stays reserved for the administrator this long
const ACCEPTED_HOLD_MS = 24 * HOUR;
const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export interface EntryInput {
  patientId: string;
  doctorName?: string | null;
  weekdays?: number[];
  fromHour?: number;
  toHour?: number;
  note?: string | null;
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;

// The waiting list: a patient who wants a time that was not free. Every few minutes the code compares the free windows of the schedule
// with the wishes, offers a fitting window to the person who has waited longest (through the approval queue, over Telegram), holds it
// for them for a few hours, and gives it to the next one if they decline or do not answer. One window is never offered to two people:
// the database holds the open offer under a unique key.
@Injectable()
export class WaitlistService {
  private readonly log = new Logger(WaitlistService.name);

  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
    private requests: RequestsService,
  ) {}

  // ---------- staff ----------

  async list(clinicId: string) {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: { clinicId, status: { in: ['ACTIVE', 'OFFERED', 'DONE'] } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { patient: { select: { id: true, fullName: true, phone: true } }, offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const telegram = new Set((await this.prisma.patientChannel.findMany({ where: { clinicId, channel: 'TELEGRAM', optedOutAt: null, patientId: { in: rows.map((r) => r.patientId) } }, select: { patientId: true } })).map((c) => c.patientId));
    return rows.map((r) => ({
      id: r.id,
      patient: r.patient,
      doctorName: r.doctorName,
      weekdays: r.weekdays as number[],
      fromHour: r.fromHour,
      toHour: r.toHour,
      note: r.note,
      status: r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      // An offer can be sent only over Telegram (no other channel lets the clinic write first)
      canBeOffered: telegram.has(r.patientId),
      lastOffer: r.offers[0] ? { status: r.offers[0].status, startsAt: r.offers[0].startsAt, expiresAt: r.offers[0].expiresAt } : null,
    }));
  }

  async add(clinicId: string, userId: string, d: EntryInput): Promise<string> {
    const patient = await this.prisma.patient.findFirst({ where: { id: d.patientId, clinicId, removedAt: null }, select: { id: true } });
    if (!patient) throw new NotFoundException('patient_not_found');
    const weekdays = [...new Set(d.weekdays ?? [])];
    const fromHour = d.fromHour ?? 9;
    const toHour = d.toHour ?? 20;
    if (weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7) || !Number.isInteger(fromHour) || !Number.isInteger(toHour) || fromHour < 0 || toHour > 24 || toHour - fromHour < 1) throw new BadRequestException('bad_waitlist');
    if ((await this.prisma.waitlistEntry.count({ where: { clinicId, status: { in: ['ACTIVE', 'OFFERED'] } } })) >= MAX_ENTRIES) throw new BadRequestException('waitlist_full');
    // One live entry per patient: a second wish replaces nothing and is refused
    if (await this.prisma.waitlistEntry.findFirst({ where: { clinicId, patientId: d.patientId, status: { in: ['ACTIVE', 'OFFERED'] } }, select: { id: true } })) throw new BadRequestException('waitlist_exists');
    const row = await this.prisma.waitlistEntry.create({ data: { clinicId, patientId: d.patientId, doctorName: d.doctorName?.trim() || null, weekdays, fromHour, toHour, note: d.note?.trim().slice(0, 300) || null, expiresAt: new Date(Date.now() + ENTRY_DAYS * DAY), createdById: userId } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'waitlist.added', details: { id: row.id } } });
    return row.id;
  }

  async cancel(clinicId: string, userId: string, id: string) {
    const entry = await this.prisma.waitlistEntry.findFirst({ where: { id, clinicId, status: { in: ['ACTIVE', 'OFFERED'] } } });
    if (!entry) throw new NotFoundException('waitlist_not_found');
    await this.prisma.$transaction([
      this.prisma.slotOffer.updateMany({ where: { entryId: id, status: 'OFFERED' }, data: { status: 'EXPIRED', activeKey: null } }),
      this.prisma.waitlistEntry.update({ where: { id }, data: { status: 'CANCELLED' } }),
    ]);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'waitlist.cancelled', details: { id } } });
  }

  // ---------- the loop ----------

  async tickAll(now = new Date()) {
    const clinics = await this.prisma.waitlistEntry.findMany({ where: { status: { in: ['ACTIVE', 'OFFERED'] } }, distinct: ['clinicId'], select: { clinicId: true } });
    for (const c of clinics) await this.tick(c.clinicId, now).catch((e) => this.log.warn(`Waitlist ${c.clinicId}: ${(e as Error).message}`));
  }

  // Frees what must be freed, then offers windows to waiting patients. Returns the number of new offers.
  async tick(clinicId: string, now = new Date()): Promise<number> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true, autoSendService: true, sendingEnabled: true } });
    await this.sweep(clinicId, now);
    if (clinic.suspendedAt || clinic.isDemo || !clinic.sendingEnabled || (billingEnforced() && accessBlocked(clinic))) return 0;

    const entries = await this.prisma.waitlistEntry.findMany({ where: { clinicId, status: 'ACTIVE', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' }, take: 50 });
    if (!entries.length) return 0;
    const rows = await this.reports.freeSlots(clinicId, 7);
    let made = 0;
    for (const e of entries) {
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, patientId: e.patientId, channel: 'TELEGRAM', optedOutAt: null }, select: { id: true } });
      if (!ch) continue;
      // The same patient never gets a second offer while one is open, and a slot already offered to this entry is not offered again
      for (const slot of this.candidates(rows as Record<string, unknown>[], e, now)) {
        if (await this.offer(clinic.autoSendService, e, slot, now)) {
          made++;
          break;
        }
      }
    }
    return made;
  }

  // Free 30-minute starts that fit the wishes, earliest first. Start times are on the half hour.
  private candidates(rows: Record<string, unknown>[], e: { doctorName: string | null; weekdays: unknown; fromHour: number; toHour: number }, now: Date) {
    const weekdays = e.weekdays as number[];
    const out: { startsAt: Date; doctor: string | null; cabinet: string | null; key: string }[] = [];
    for (const r of rows) {
      const day = String(r.dayAt);
      if (e.doctorName && r.doctor !== e.doctorName) continue;
      const wd = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
      if (weekdays.length && !weekdays.includes(wd)) continue;
      for (const w of String(r.windows ?? '').split(', ')) {
        const [a, b] = w.split('–');
        if (!a || !b) continue;
        const from = Math.max(Math.ceil(toMin(a) / 30) * 30, e.fromHour * 60);
        const to = Math.min(toMin(b), e.toHour * 60);
        for (let t = from; t + 30 <= to; t += 30) {
          const startsAt = new Date(this.at(day, t));
          if (startsAt.getTime() < now.getTime() + MIN_LEAD_MS) continue;
          out.push({ startsAt, doctor: (r.doctor as string | null) ?? null, cabinet: (r.cabinet as string | null) ?? null, key: `${day}|${hm(t)}|${(r.doctor as string | null) ?? (r.cabinet as string | null) ?? ''}` });
        }
      }
    }
    return out.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  }

  // The date and the minutes are clinic local time
  private at(day: string, minutes: number): number {
    return localToUtc(`${day} ${hm(minutes)}:00`).getTime();
  }

  private async offer(autoSend: boolean, e: { id: string; clinicId: string; patientId: string }, slot: { startsAt: Date; doctor: string | null; cabinet: string | null; key: string }, now: Date): Promise<boolean> {
    const dedupeKey = `wl-${e.id}-${slot.key}`;
    if (await this.prisma.outboundMessage.findUnique({ where: { clinicId_dedupeKey: { clinicId: e.clinicId, dedupeKey } }, select: { id: true } })) return false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const offer = await tx.slotOffer.create({ data: { clinicId: e.clinicId, entryId: e.id, patientId: e.patientId, slotKey: slot.key, activeKey: slot.key, startsAt: slot.startsAt, doctorName: slot.doctor, cabinetName: slot.cabinet, expiresAt: new Date(slot.startsAt.getTime() - 30 * 60_000) } });
        const when = `${WD[new Date(`${clinicDate(slot.startsAt)}T00:00:00Z`).getUTCDay()]} ${clinicDate(slot.startsAt).slice(5).split('-').reverse().join('.')}, ${clinicHm(slot.startsAt)}`;
        const msg = await tx.outboundMessage.create({
          data: {
            clinicId: e.clinicId,
            patientId: e.patientId,
            ruleKey: 'waitlist-offer',
            channel: 'TELEGRAM',
            text: `Добрий день! Звільнився час, на який ви чекали: ${when}${slot.doctor ? `, лікар ${slot.doctor}` : ''}. Чи підходить він вам? Відповісти потрібно протягом ${OFFER_TTL_MS / HOUR} год. після цього повідомлення, інакше запропонуємо час іншому пацієнту.`,
            // a service message, like a reminder: it goes by itself when the clinic allows, otherwise it waits for approval
            status: autoSend ? 'APPROVED' : 'PENDING_APPROVAL',
            scheduledFor: now,
            expiresAt: new Date(slot.startsAt.getTime() - 30 * 60_000),
            dedupeKey,
          },
        });
        await tx.slotOffer.update({ where: { id: offer.id }, data: { outboundId: msg.id } });
        await tx.waitlistEntry.update({ where: { id: e.id }, data: { status: 'OFFERED' } });
      });
      return true;
    } catch (err) {
      // The window is held by another open offer: try the next one
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  // Ends offers that ran out, were never sent (the queue message was cancelled or failed), or were accepted and not booked for a day
  async sweep(clinicId: string, now = new Date()) {
    const open = await this.prisma.slotOffer.findMany({ where: { clinicId, status: { in: ['OFFERED', 'ACCEPTED'] }, activeKey: { not: null } } });
    for (const o of open) {
      let end: 'EXPIRED' | null = null;
      if (o.status === 'OFFERED') {
        if (o.expiresAt <= now) end = 'EXPIRED';
        else if (o.outboundId) {
          const m = await this.prisma.outboundMessage.findUnique({ where: { id: o.outboundId }, select: { status: true } });
          if (m && ['CANCELLED', 'FAILED', 'EXPIRED'].includes(m.status)) end = 'EXPIRED';
        }
      } else if (now.getTime() - o.createdAt.getTime() > ACCEPTED_HOLD_MS + OFFER_TTL_MS) {
        // the administrator had a day to book the accepted time
        await this.prisma.slotOffer.update({ where: { id: o.id }, data: { activeKey: null } });
        continue;
      }
      if (!end) continue;
      await this.prisma.$transaction([
        this.prisma.slotOffer.update({ where: { id: o.id }, data: { status: end, activeKey: null } }),
        this.prisma.waitlistEntry.updateMany({ where: { id: o.entryId, status: 'OFFERED' }, data: { status: 'ACTIVE' } }),
      ]);
    }
    await this.prisma.waitlistEntry.updateMany({ where: { clinicId, status: { in: ['ACTIVE', 'OFFERED'] }, expiresAt: { lte: now } }, data: { status: 'CANCELLED' } });
  }

  // Called when the queue really sends the offer: the time to answer starts now
  async markSent(outboundId: string, now = new Date()) {
    const o = await this.prisma.slotOffer.findFirst({ where: { outboundId, status: 'OFFERED' } });
    if (!o) return;
    await this.prisma.slotOffer.update({ where: { id: o.id }, data: { sentAt: now, expiresAt: new Date(Math.min(now.getTime() + OFFER_TTL_MS, o.startsAt.getTime() - 30 * 60_000)) } });
  }

  async forOutbound(outboundId: string) {
    return this.prisma.slotOffer.findFirst({ where: { outboundId }, select: { id: true } });
  }

  // The patient pressed a button. Only the person the offer was made to can answer; the claim is atomic, so two presses or a late
  // press cannot take the window twice. Returns what to tell the patient.
  async respond(clinicId: string, chatId: string, offerId: string, yes: boolean, now = new Date()): Promise<{ text: 'accepted' | 'declined' | 'late' | 'ignored'; label?: string } | null> {
    const offer = await this.prisma.slotOffer.findFirst({ where: { id: offerId, clinicId } });
    if (!offer) return null;
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId, patientId: offer.patientId }, select: { id: true } });
    if (!ch) return null;
    const label = `${WD[new Date(`${clinicDate(offer.startsAt)}T00:00:00Z`).getUTCDay()]} ${clinicDate(offer.startsAt).slice(5).split('-').reverse().join('.')}, ${clinicHm(offer.startsAt)}`;
    if (!yes) {
      const r = await this.prisma.slotOffer.updateMany({ where: { id: offer.id, status: 'OFFERED' }, data: { status: 'DECLINED', activeKey: null } });
      if (!r.count) return { text: 'ignored' };
      await this.prisma.waitlistEntry.updateMany({ where: { id: offer.entryId, status: 'OFFERED' }, data: { status: 'ACTIVE' } });
      return { text: 'declined' };
    }
    if (offer.status === 'ACCEPTED') return { text: 'ignored' }; // a second press of the same button
    const claim = await this.prisma.slotOffer.updateMany({ where: { id: offer.id, status: 'OFFERED', expiresAt: { gt: now } }, data: { status: 'ACCEPTED' } });
    if (!claim.count) return { text: 'late', label };
    await this.prisma.waitlistEntry.updateMany({ where: { id: offer.entryId }, data: { status: 'DONE' } });
    // The administrator books it (writing to the clinic's system is a separate, guarded step)
    const p = await this.prisma.patient.findUnique({ where: { id: offer.patientId }, select: { fullName: true } });
    await this.requests.upsert(clinicId, { channel: 'TELEGRAM', chatId, patientId: offer.patientId, contactName: p?.fullName ?? null, kind: 'BOOKING', summary: `Лист очікування: пацієнт погодився на ${label}${offer.doctorName ? `, лікар ${offer.doctorName}` : ''}${offer.cabinetName ? `, ${offer.cabinetName}` : ''}. Час утримується за ним.` }, true);
    return { text: 'accepted', label };
  }
}
