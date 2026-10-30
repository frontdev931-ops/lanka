import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { clinicDate } from '../common/clinic-time';
import { normalizePhone } from '../common/phone';
import { ClinicConnector, ExternalVisit } from '../integrations/connector';
import { CliniccardsError } from '../integrations/cliniccards.client';
import { VISIT_STATUS } from '../integrations/cliniccards.connector';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';

const MIN = 60_000;
// A visit in these statuses does not occupy its place
const FREE_STATUSES = new Set(['CANCELLED', 'MOVED', 'DID_NOT_COME']);
const MOVABLE = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'BOOKING'];
// An attempt that started this recently and has no result is treated as still running
const RUNNING_MS = 2 * MIN;

export interface BookInput {
  patientId: string;
  startsAt: Date;
  durationMin: number;
  cabinetId: string;
  doctorId?: string;
  note?: string;
  requestId?: string;
}
export interface BookingResult {
  externalVisitId: string | null;
  // The same request was already done earlier: nothing new was written
  duplicate: boolean;
  // The visit was seen in Cliniccards after the write
  verified: boolean;
}

type Spec = {
  key: string;
  kind: 'CREATE' | 'RESCHEDULE' | 'CANCEL' | 'CONFIRM' | 'PATIENT';
  patientId?: string;
  requestId?: string;
  startsAt?: Date;
  // Throws when the write must not happen (the place is taken, the patient is booked twice)
  check?: () => Promise<void>;
  // Looks at the clinic's system: id of the visit/patient if the effect is already there, null if it is not, 'unknown' if we cannot tell
  reconcile: () => Promise<string | null | 'unknown'>;
  act: () => Promise<string | undefined>;
  // Updates our own copy; safe to repeat
  after: (externalId: string | undefined) => Promise<void>;
};

// Writes to the clinic's system (Cliniccards) on an explicit staff action. Every write has one unique key, so a repeated click,
// a repeated request or a retry after a lost answer never creates a second record; the place is re-checked against fresh data
// just before the write; and an answer we did not get is checked (reconcile) instead of guessed.
@Injectable()
export class BookingService {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
  ) {}

  private key(...parts: (string | number)[]) {
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
  }

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { bookingWriteEnabled: true } });
    const connector = await this.sync.connectorForClinic(clinicId);
    return { enabled: c.bookingWriteEnabled && !!connector?.createVisit && process.env.CLINICCARDS_WRITE_ENABLED === 'true' };
  }

  private async connector(clinicId: string): Promise<ClinicConnector> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { bookingWriteEnabled: true } });
    if (!c.bookingWriteEnabled) throw new BadRequestException('booking_write_disabled');
    const connector = await this.sync.connectorForClinic(clinicId);
    if (!connector?.createVisit || !connector.updateVisit) throw new BadRequestException('booking_write_disabled');
    return connector;
  }

  // Options for the booking form: cabinets and doctors we know from the clinic's system
  async options(clinicId: string) {
    const [cabinets, shifts] = await Promise.all([
      this.prisma.cabinet.findMany({ where: { clinicId }, orderBy: { name: 'asc' }, select: { externalId: true, name: true } }),
      this.prisma.shift.findMany({ where: { clinicId, startsAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, distinct: ['doctorId'], select: { doctorId: true, doctorName: true } }),
    ]);
    return { cabinets, doctors: shifts.map((s) => ({ externalId: s.doctorId, name: s.doctorName ?? s.doctorId })) };
  }

  private async dayVisits(connector: ClinicConnector, at: Date): Promise<ExternalVisit[]> {
    // a day in the clinic's time zone fits inside this window in any case
    return connector.fetchVisits({ from: new Date(at.getTime() - 14 * 3_600_000), to: new Date(at.getTime() + 38 * 3_600_000) }).then((rows) => rows.filter((v) => clinicDate(v.startsAt) === clinicDate(at)));
  }

  // Fresh data from the clinic's system, not our copy: is the place free and is the patient not already booked then
  private async assertFree(connector: ClinicConnector, p: { patientExternalId: string; startsAt: Date; endsAt: Date; cabinetId: string; doctorId?: string; ignoreVisitId?: string }) {
    let visits: ExternalVisit[];
    let blocks: { cabinetId: string; startsAt: Date; endsAt: Date }[] = [];
    try {
      visits = await this.dayVisits(connector, p.startsAt);
      blocks = (await connector.fetchSchedule({ from: new Date(p.startsAt.getTime() - 14 * 3_600_000), to: new Date(p.startsAt.getTime() + 38 * 3_600_000) })).blocks;
    } catch {
      // never write blind
      throw new BadRequestException('booking_check_failed');
    }
    const overlaps = (a: { startsAt: Date; endsAt?: Date }) => a.startsAt < p.endsAt && (a.endsAt ?? new Date(a.startsAt.getTime() + 30 * MIN)) > p.startsAt;
    for (const v of visits) {
      if (FREE_STATUSES.has(v.status) || v.externalId === p.ignoreVisitId || !overlaps(v)) continue;
      if (v.patientExternalId === p.patientExternalId) throw new ConflictException('booking_patient_busy');
      if (v.cabinetId === p.cabinetId || (p.doctorId && v.doctorId === p.doctorId)) throw new ConflictException('booking_slot_taken');
    }
    if (blocks.some((b) => b.cabinetId === p.cabinetId && b.startsAt < p.endsAt && b.endsAt > p.startsAt)) throw new ConflictException('booking_slot_blocked');
  }

  private async run(clinicId: string, userId: string, s: Spec): Promise<BookingResult> {
    const base = { clinicId, key: s.key, kind: s.kind, patientId: s.patientId ?? null, requestId: s.requestId ?? null, startsAt: s.startsAt ?? null, createdById: userId };
    let attempt = await this.prisma.bookingAttempt.findUnique({ where: { clinicId_key: { clinicId, key: s.key } } });
    if (attempt?.status === 'DONE') return { externalVisitId: attempt.externalVisitId ?? attempt.externalPatientId, duplicate: true, verified: true };
    if (attempt && (attempt.status === 'STARTED' || attempt.status === 'UNKNOWN')) {
      if (attempt.status === 'STARTED' && Date.now() - attempt.updatedAt.getTime() < RUNNING_MS) throw new ConflictException('booking_in_progress');
      // A previous try did not finish: look at the clinic's system before doing anything again
      const found = await s.reconcile().catch(() => 'unknown' as const);
      if (found === 'unknown') {
        await this.prisma.bookingAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN' } });
        throw new ConflictException('booking_unknown');
      }
      if (found) {
        await this.prisma.bookingAttempt.update({ where: { id: attempt.id }, data: { status: 'DONE', externalVisitId: s.kind === 'PATIENT' ? null : found, externalPatientId: s.kind === 'PATIENT' ? found : null, error: null } });
        await s.after(found);
        return { externalVisitId: found, duplicate: true, verified: true };
      }
    }
    if (attempt) {
      // FAILED, or an earlier unfinished try that left no trace: a clean new try on the same row (the claim keeps two clicks apart)
      const claim = await this.prisma.bookingAttempt.updateMany({ where: { id: attempt.id, status: attempt.status, updatedAt: attempt.updatedAt }, data: { status: 'STARTED', error: null } });
      if (!claim.count) throw new ConflictException('booking_in_progress');
    } else {
      try {
        attempt = await this.prisma.bookingAttempt.create({ data: base });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('booking_in_progress');
        throw e;
      }
    }
    const id = attempt.id;
    const fail = (status: 'FAILED' | 'UNKNOWN', error: string) => this.prisma.bookingAttempt.update({ where: { id }, data: { status, error: error.slice(0, 300) } });
    try {
      await s.check?.();
    } catch (e) {
      await fail('FAILED', (e as Error).message);
      throw e;
    }
    let externalId: string | undefined;
    try {
      externalId = await s.act();
    } catch (e) {
      if (e instanceof CliniccardsError && e.ambiguous) {
        await fail('UNKNOWN', e.message);
        throw new ConflictException('booking_unknown');
      }
      await fail('FAILED', (e as Error).message);
      this.log.warn(`Booking ${s.kind} refused: ${(e as Error).message}`);
      throw new BadRequestException('booking_failed');
    }
    await this.prisma.bookingAttempt.update({ where: { id }, data: { status: 'DONE', externalVisitId: s.kind === 'PATIENT' ? null : (externalId ?? null), externalPatientId: s.kind === 'PATIENT' ? (externalId ?? null) : null, error: null } });
    await s.after(externalId);
    // Read it back: the record must be visible in the clinic's system
    const seen = await s.reconcile().catch(() => 'unknown' as const);
    return { externalVisitId: externalId ?? null, duplicate: false, verified: seen !== null && seen !== 'unknown' };
  }

  async book(clinicId: string, userId: string, d: BookInput): Promise<BookingResult> {
    const connector = await this.connector(clinicId);
    const patient = await this.prisma.patient.findFirst({ where: { id: d.patientId, clinicId, removedAt: null }, select: { id: true, externalId: true, fullName: true } });
    if (!patient || patient.externalId.startsWith('demo-')) throw new BadRequestException('patient_not_found');
    const startsAt = d.startsAt;
    const endsAt = new Date(startsAt.getTime() + d.durationMin * MIN);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() || startsAt.getUTCMinutes() % 5 || d.durationMin < 5 || d.durationMin > 240 || clinicDate(startsAt) !== clinicDate(endsAt)) throw new BadRequestException('booking_bad_time');
    const note = (d.note?.trim() || 'Запис створено в LANKA').slice(0, 400);
    const find = async (): Promise<string | null> => {
      const hit = (await this.dayVisits(connector, startsAt)).find((v) => v.patientExternalId === patient.externalId && v.startsAt.getTime() === startsAt.getTime() && !FREE_STATUSES.has(v.status));
      return hit?.externalId ?? null;
    };
    const res = await this.run(clinicId, userId, {
      key: this.key(clinicId, 'CREATE', patient.id, startsAt.toISOString(), d.cabinetId),
      kind: 'CREATE',
      patientId: patient.id,
      requestId: d.requestId,
      startsAt,
      check: () => this.assertFree(connector, { patientExternalId: patient.externalId, startsAt, endsAt, cabinetId: d.cabinetId, doctorId: d.doctorId }),
      reconcile: find,
      act: async () => (await connector.createVisit!({ patientExternalId: patient.externalId, cabinetId: d.cabinetId, doctorId: d.doctorId, startsAt, endsAt, note })).externalId,
      after: async (externalId) => {
        if (!externalId) return;
        const doctorName = d.doctorId ? (await this.prisma.shift.findFirst({ where: { clinicId, doctorId: d.doctorId }, select: { doctorName: true } }))?.doctorName : undefined;
        await this.prisma.visit.upsert({
          where: { clinicId_externalId: { clinicId, externalId } },
          create: { clinicId, patientId: patient.id, externalId, doctorId: d.doctorId, doctorName, cabinetId: d.cabinetId, startsAt, endsAt, status: VISIT_STATUS.created, bookedAt: new Date() },
          update: {},
        });
        if (d.requestId) await this.prisma.bookingRequest.updateMany({ where: { id: d.requestId, clinicId, status: 'NEW' }, data: { status: 'DONE', handledById: userId, handledAt: new Date() } });
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.created', details: { visit: externalId, patientId: patient.id, at: startsAt.toISOString() } } });
      },
    });
    return res;
  }

  private async movable(clinicId: string, visitId: string) {
    const v = await this.prisma.visit.findFirst({ where: { id: visitId, clinicId, status: { in: MOVABLE }, startsAt: { gt: new Date() } }, include: { patient: { select: { id: true, externalId: true } } } });
    if (!v) throw new BadRequestException('visit_not_changeable');
    return v;
  }

  async reschedule(clinicId: string, userId: string, visitId: string, d: { startsAt: Date; durationMin?: number; cabinetId?: string; doctorId?: string }): Promise<BookingResult> {
    const connector = await this.connector(clinicId);
    const v = await this.movable(clinicId, visitId);
    const dur = d.durationMin ?? Math.max(5, Math.round(((v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN)).getTime() - v.startsAt.getTime()) / MIN));
    const startsAt = d.startsAt;
    const endsAt = new Date(startsAt.getTime() + dur * MIN);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() || startsAt.getUTCMinutes() % 5 || dur > 240 || clinicDate(startsAt) !== clinicDate(endsAt)) throw new BadRequestException('booking_bad_time');
    const cabinetId = d.cabinetId ?? v.cabinetId ?? '';
    const doctorId = d.doctorId ?? v.doctorId ?? undefined;
    return this.run(clinicId, userId, {
      key: this.key(clinicId, 'RESCHEDULE', v.externalId, startsAt.toISOString(), cabinetId),
      kind: 'RESCHEDULE',
      patientId: v.patientId,
      startsAt,
      check: () => this.assertFree(connector, { patientExternalId: v.patient.externalId, startsAt, endsAt, cabinetId, doctorId, ignoreVisitId: v.externalId }),
      reconcile: async () => ((await this.dayVisits(connector, startsAt)).find((x) => x.externalId === v.externalId && x.startsAt.getTime() === startsAt.getTime()) ? v.externalId : null),
      act: async () => {
        await connector.updateVisit!(v.externalId, { currentStartsAt: v.startsAt, status: VISIT_STATUS.created, startsAt, endsAt, cabinetId, doctorId });
        return v.externalId;
      },
      after: async () => {
        await this.prisma.visit.update({ where: { id: v.id }, data: { startsAt, endsAt, cabinetId, doctorId: doctorId ?? null, status: VISIT_STATUS.created } });
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.rescheduled', details: { visit: v.externalId, to: startsAt.toISOString() } } });
      },
    });
  }

  private async setStatus(clinicId: string, userId: string, visitId: string, kind: 'CANCEL' | 'CONFIRM'): Promise<BookingResult> {
    const connector = await this.connector(clinicId);
    const v = await this.movable(clinicId, visitId);
    const target = kind === 'CANCEL' ? VISIT_STATUS.cancelled : VISIT_STATUS.confirmed;
    return this.run(clinicId, userId, {
      key: this.key(clinicId, kind, v.externalId),
      kind,
      patientId: v.patientId,
      startsAt: v.startsAt,
      reconcile: async () => ((await this.dayVisits(connector, v.startsAt)).find((x) => x.externalId === v.externalId && x.status === target) ? v.externalId : null),
      act: async () => {
        await connector.updateVisit!(v.externalId, { currentStartsAt: v.startsAt, status: target });
        return v.externalId;
      },
      after: async () => {
        await this.prisma.visit.update({ where: { id: v.id }, data: { status: target } });
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: kind === 'CANCEL' ? 'booking.cancelled' : 'booking.confirmed', details: { visit: v.externalId } } });
      },
    });
  }

  cancel(clinicId: string, userId: string, visitId: string) {
    return this.setStatus(clinicId, userId, visitId, 'CANCEL');
  }

  confirm(clinicId: string, userId: string, visitId: string) {
    return this.setStatus(clinicId, userId, visitId, 'CONFIRM');
  }

  // ---- patients ----

  // Cards with this phone. One card is a candidate that still has to be verified with the person; several go to a human.
  async matches(clinicId: string, phone: string) {
    const norm = normalizePhone(phone);
    if (!norm) return [];
    return this.prisma.patient.findMany({ where: { clinicId, removedAt: null, phoneNorm: norm }, select: { id: true, fullName: true, phone: true, birthDate: true } });
  }

  // The person answers a question ("surname or date of birth"): the code compares, the AI is not involved
  async verify(clinicId: string, patientId: string, answer: string): Promise<boolean> {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, clinicId, removedAt: null }, select: { fullName: true, birthDate: true } });
    if (!p) return false;
    const text = answer.toLowerCase().replace(/[’'`ʼ]/g, '');
    const surname = p.fullName.split(/\s+/)[0]?.toLowerCase().replace(/[’'`ʼ]/g, '');
    if (surname && surname.length >= 3 && text.split(/[^\p{L}]+/u).includes(surname)) return true;
    if (p.birthDate) {
      const [y, m, d] = p.birthDate.toISOString().slice(0, 10).split('-');
      if (text.includes(`${d}.${m}.${y}`) || text.includes(`${y}-${m}-${d}`)) return true;
    }
    return false;
  }

  // Links a chat to a card once the person is verified (or by staff)
  async linkChat(clinicId: string, patientId: string, channel: string, chatId: string) {
    await this.prisma.patientChannel.upsert({
      where: { patientId_channel: { patientId, channel } },
      create: { clinicId, patientId, channel, externalId: chatId },
      update: { externalId: chatId, optedOutAt: null, linkedAt: new Date() },
    });
    await this.prisma.chatMessage.updateMany({ where: { clinicId, channel, chatId }, data: { patientId } });
  }

  // A new card without duplicates: an existing card with the same phone is returned instead; the write is guarded like a booking
  async createPatient(clinicId: string, userId: string, d: { fullName: string; phone: string; source?: string }): Promise<{ patientId: string; existing: boolean }> {
    const norm = normalizePhone(d.phone);
    if (!norm) throw new BadRequestException('bad_phone');
    const [lastName, ...rest] = d.fullName.trim().split(/\s+/);
    if (!lastName || !rest.length) throw new BadRequestException('patient_name_needed');
    const existing = await this.prisma.patient.findFirst({ where: { clinicId, removedAt: null, phoneNorm: norm }, select: { id: true } });
    if (existing) return { patientId: existing.id, existing: true };
    const connector = await this.connector(clinicId);
    if (!connector.createPatient) throw new BadRequestException('booking_write_disabled');
    const local = async (externalId: string) => {
      await this.prisma.patient.upsert({
        where: { clinicId_externalId: { clinicId, externalId } },
        create: { clinicId, externalId, fullName: d.fullName.trim(), phone: d.phone.trim(), phoneNorm: norm, source: d.source ?? null },
        update: {},
      });
    };
    await this.run(clinicId, userId, {
      key: this.key(clinicId, 'PATIENT', norm),
      kind: 'PATIENT',
      check: async () => {
        // the phone may have appeared in the clinic's system after our last sync
        const ids = await connector.findPatientIdsByPhone?.(norm).catch(() => null);
        if (ids && ids.length) throw new ConflictException('patient_exists_in_clinic');
      },
      reconcile: async () => {
        if (!connector.findPatientIdsByPhone) return 'unknown';
        const ids = await connector.findPatientIdsByPhone(norm);
        return ids.length === 1 ? ids[0] : ids.length === 0 ? null : 'unknown';
      },
      act: async () => (await connector.createPatient!({ lastName, firstName: rest.join(' '), phone: `+${norm}`, source: d.source })).externalId,
      after: async (externalId) => {
        if (!externalId) return;
        await local(externalId);
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'patient.created_in_clinic', details: { externalId } } });
      },
    });
    const created = await this.prisma.patient.findFirst({ where: { clinicId, phoneNorm: norm, removedAt: null }, select: { id: true } });
    if (!created) throw new BadRequestException('booking_failed');
    return { patientId: created.id, existing: false };
  }
}
