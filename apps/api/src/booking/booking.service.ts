import { liveWriteAllowed } from '../integrations/cliniccards.client';
import { AutoBookingGate, DialogOrigin } from './auto-booking-gate';
import { FunnelEventsService } from '../funnel-events/funnel-events.service';
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
import { cancelStaleReminders } from '../automations/visit-reminders';

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
  // Cliniccards requires a doctor for every visit (official documentation of POST /visits)
  doctorId?: string;
  note?: string;
  requestId?: string;
  // Booking by cabinets through ONE shared account: the doctor_id is sent, but only the CABINET decides whether the place is taken
  // (the shared account is not one physical doctor who cannot be in two cabinets at once)
  sharedAccount?: boolean;
  // The dialog that asked for an automatic booking (the live-test restriction is checked against it, see AutoBookingGate)
  origin?: DialogOrigin;
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
  origin?: DialogOrigin;
  // Throws when the write must not happen (the place is taken, the patient is booked twice)
  check?: () => Promise<void>;
  // Looks at the clinic's system: id of the visit/patient if the effect is already there, null if it is not, 'unknown' if we cannot tell
  reconcile: () => Promise<string | null | 'unknown'>;
  act: () => Promise<string | undefined>;
  // Updates our own copy; called once per attempt that reached DONE (`attemptId`: the identity of that operation)
  after: (externalId: string | undefined, attemptId: string) => Promise<void>;
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
    private gate: AutoBookingGate,
    private funnel: FunnelEventsService,
  ) {}

  private key(...parts: (string | number)[]) {
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
  }

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { bookingWriteEnabled: true } });
    const connector = await this.sync.connectorForClinic(clinicId);
    // all three keys: the clinic's own flag, CLINICCARDS_WRITE_ENABLED, and for the real address CLINICCARDS_WRITE_LIVE (otherwise the client
    // refuses every write, so the automatic mode must not even start: no card is made, the request goes to the administrator)
    return { enabled: c.bookingWriteEnabled && !!connector?.createVisit && process.env.CLINICCARDS_WRITE_ENABLED === 'true' && liveWriteAllowed() };
  }

  // Will THIS dialogue be booked by the bot itself? All the keys at once: the clinic's setting aiAutoBooking, the server and clinic write flags
  // (status), and the live-test restriction of dialogues. The same answer decides the text the patient reads before choosing a time.
  async autoModeFor(clinicId: string, chat: DialogOrigin): Promise<boolean> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiAutoBooking: true } });
    if (!c.aiAutoBooking || process.env.CLINICCARDS_WRITE_ENABLED !== 'true') return false;
    if (!this.gate.allowed(clinicId, chat)) return false;
    return (await this.status(clinicId)).enabled;
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

  private async run(clinicId: string, userId: string | null, s: Spec): Promise<BookingResult> {
    // the live-test restriction: before anything is claimed or sent (and once more right before the write, below)
    this.gate.assert(clinicId, userId, s.origin);
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
        // one reconciliation closes the attempt (a compare-and-set): two at the same time record the result once, the other only reports it
        const won = await this.prisma.bookingAttempt.updateMany({ where: { id: attempt.id, status: attempt.status, updatedAt: attempt.updatedAt }, data: { status: 'DONE', externalVisitId: s.kind === 'PATIENT' ? null : found, externalPatientId: s.kind === 'PATIENT' ? found : null, error: null } });
        if (won.count) await s.after(found, attempt.id);
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
      // right before the write to the clinic's system, retries included: the restriction may have changed since the start of this call
      this.gate.assert(clinicId, userId, s.origin);
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
    await s.after(externalId, id);
    // Read it back: the record must be visible in the clinic's system
    const seen = await s.reconcile().catch(() => 'unknown' as const);
    return { externalVisitId: externalId ?? null, duplicate: false, verified: seen !== null && seen !== 'unknown' };
  }

  async book(clinicId: string, userId: string | null, d: BookInput): Promise<BookingResult> {
    this.gate.assert(clinicId, userId, d.origin);
    const connector = await this.connector(clinicId);
    const doctorId = d.doctorId;
    if (!doctorId) throw new BadRequestException('booking_doctor_needed');
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
      origin: d.origin,
      check: () => this.assertFree(connector, { patientExternalId: patient.externalId, startsAt, endsAt, cabinetId: d.cabinetId, doctorId: d.sharedAccount ? undefined : doctorId }),
      reconcile: find,
      act: async () => (await connector.createVisit!({ patientExternalId: patient.externalId, cabinetId: d.cabinetId, doctorId, startsAt, endsAt, note })).externalId,
      after: async (externalId) => {
        if (!externalId) return;
        const doctorName = doctorId ? (await this.prisma.shift.findFirst({ where: { clinicId, doctorId }, select: { doctorName: true } }))?.doctorName : undefined;
        await this.prisma.visit.upsert({
          where: { clinicId_externalId: { clinicId, externalId } },
          create: { clinicId, patientId: patient.id, externalId, doctorId, doctorName, cabinetId: d.cabinetId, startsAt, endsAt, status: VISIT_STATUS.created, bookedAt: new Date() },
          update: {},
        });
        if (d.requestId) await this.prisma.bookingRequest.updateMany({ where: { id: d.requestId, clinicId, status: 'NEW' }, data: { status: 'DONE', handledById: userId, handledAt: new Date() } });
        // The visit exists and belongs to this request (the attempt that made it carries the request id): the one place where BOOKED is written.
        // A visit that someone else made, or one that only looks the same, never gets here.
        const req = d.requestId ? await this.prisma.bookingRequest.findFirst({ where: { id: d.requestId, clinicId }, select: { id: true, channel: true, chatId: true, patientId: true } }) : null;
        if (req) await this.funnel.record(clinicId, { channel: req.channel, chatId: req.chatId, kind: 'BOOKED', refKey: req.id, source: userId ? 'ADMIN' : 'AUTO', reason: 'visit_created', linked: !!req.patientId });
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

  // A move of the SAME visit to another time (one PUT of the existing visit: the same external id, patient, doctor and length; Cliniccards gets the status the
  // code has always sent for it, PLANNED, see cliniccards-api.md). Before the write: the visit as Cliniccards has it now must still be the one we know (the same
  // patient, time, doctor, a status that can change), `verify` (the caller's schedule rules: the doctor's hours, the service, the cabinet) and the place must be
  // free with only this visit left out. `expect`: what the patient was asked about.
  // `operationId`: the identity of THIS move, persisted by the caller (the agent: the id of the patient's confirmation). Without it (the staff action) the
  // operation is the next move of the visit: the number of moves of it already done. Retries and parallel calls of one operation share its attempt (its key);
  // a later move to a time used before is a new attempt, never answered by an old DONE.
  async reschedule(clinicId: string, userId: string | null, visitId: string, d: { startsAt: Date; durationMin?: number; cabinetId?: string; doctorId?: string; origin?: DialogOrigin; expect?: { externalId: string; startsAt: Date; doctorId: string | null }; verify?: () => Promise<void>; operationId?: string }): Promise<BookingResult> {
    this.gate.assert(clinicId, userId, d.origin);
    const connector = await this.connector(clinicId);
    const v = await this.movable(clinicId, visitId);
    if (d.expect && (v.externalId !== d.expect.externalId || v.startsAt.getTime() !== d.expect.startsAt.getTime() || (v.doctorId ?? null) !== (d.expect.doctorId ?? null))) throw new ConflictException('visit_changed');
    const dur = d.durationMin ?? Math.max(5, Math.round(((v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN)).getTime() - v.startsAt.getTime()) / MIN));
    const startsAt = d.startsAt;
    const endsAt = new Date(startsAt.getTime() + dur * MIN);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() || startsAt.getUTCMinutes() % 5 || dur > 240 || clinicDate(startsAt) !== clinicDate(endsAt)) throw new BadRequestException('booking_bad_time');
    const cabinetId = d.cabinetId ?? v.cabinetId ?? '';
    const doctorId = d.doctorId ?? v.doctorId ?? undefined;
    const from = v.startsAt;
    // an unfinished move of this patient to this time (started, or its answer lost) is the SAME operation: it is reconciled first, not written again
    const pending = await this.prisma.bookingAttempt.findFirst({ where: { clinicId, kind: 'RESCHEDULE', patientId: v.patientId, startsAt, status: { in: ['STARTED', 'UNKNOWN'] } }, orderBy: { createdAt: 'desc' }, select: { key: true } });
    // nothing open and the visit already at that time and cabinet: nothing to move (a repeated click after the move)
    if (!pending && v.startsAt.getTime() === startsAt.getTime() && (v.cabinetId ?? '') === cabinetId) return { externalVisitId: v.externalId, duplicate: true, verified: false };
    const done = await this.prisma.bookingAttempt.count({ where: { clinicId, kind: 'RESCHEDULE', externalVisitId: v.externalId, status: 'DONE' } });
    return this.run(clinicId, userId, {
      key: pending?.key ?? this.key(clinicId, 'RESCHEDULE', v.externalId, d.operationId ? `op:${d.operationId}` : `move:${done}`, startsAt.toISOString(), cabinetId),
      kind: 'RESCHEDULE',
      patientId: v.patientId,
      startsAt,
      origin: d.origin,
      check: async () => {
        const now = await this.freshState(connector, v);
        if (now === 'unknown') throw new BadRequestException('booking_check_failed');
        if (now !== 'ok') throw new ConflictException('visit_changed');
        await d.verify?.();
        await this.assertFree(connector, { patientExternalId: v.patient.externalId, startsAt, endsAt, cabinetId, doctorId, ignoreVisitId: v.externalId });
      },
      reconcile: async () => ((await this.dayVisits(connector, startsAt)).find((x) => x.externalId === v.externalId && x.startsAt.getTime() === startsAt.getTime()) ? v.externalId : null),
      act: async () => {
        await connector.updateVisit!(v.externalId, { currentStartsAt: v.startsAt, status: VISIT_STATUS.created, startsAt, endsAt, cabinetId, doctorId });
        return v.externalId;
      },
      after: async (_ext, attemptId) => {
        await this.prisma.visit.update({ where: { id: v.id }, data: { startsAt, endsAt, cabinetId, doctorId: doctorId ?? null, status: VISIT_STATUS.created } });
        // the booking request that created this visit now tells its new time (what the agent and the confirmation screen read)
        await this.prisma.bookingRequest.updateMany({ where: { clinicId, kind: 'BOOKING', status: 'DONE', externalVisitId: v.externalId }, data: { confirmedStartsAt: startsAt } });
        // `attempt`: the BookingAttempt of this operation, one per move (what a report counts)
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.rescheduled', details: { visit: v.externalId, from: from.toISOString(), to: startsAt.toISOString(), attempt: attemptId, ...(d.operationId ? { operation: d.operationId } : {}), ...(d.origin ? { by: 'agent' } : {}) } } });
        // the reminders made for the old time are not sent; the scheduler makes the one for the new time
        await cancelStaleReminders(this.prisma, clinicId, [v.id]);
      },
    });
  }

  private async setStatus(clinicId: string, userId: string | null, visitId: string, kind: 'CANCEL' | 'CONFIRM', o: { origin?: DialogOrigin; check?: (connector: ClinicConnector, v: Awaited<ReturnType<BookingService['movable']>>) => Promise<void> } = {}): Promise<BookingResult> {
    const connector = await this.connector(clinicId);
    const v = await this.movable(clinicId, visitId);
    const target = kind === 'CANCEL' ? VISIT_STATUS.cancelled : VISIT_STATUS.confirmed;
    return this.run(clinicId, userId, {
      key: this.key(clinicId, kind, v.externalId),
      kind,
      patientId: v.patientId,
      startsAt: v.startsAt,
      origin: o.origin,
      ...(o.check ? { check: () => o.check!(connector, v) } : {}),
      reconcile: async () => ((await this.dayVisits(connector, v.startsAt)).find((x) => x.externalId === v.externalId && x.status === target) ? v.externalId : null),
      act: async () => {
        await connector.updateVisit!(v.externalId, { currentStartsAt: v.startsAt, status: target });
        return v.externalId;
      },
      after: async () => {
        await this.prisma.visit.update({ where: { id: v.id }, data: { status: target } });
        if (kind === 'CANCEL') await cancelStaleReminders(this.prisma, clinicId, [v.id]);
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: kind === 'CANCEL' ? 'booking.cancelled' : 'booking.confirmed', details: { visit: v.externalId, ...(o.origin ? { by: 'agent' } : {}) } } });
      },
    });
  }

  // The visit as Cliniccards has it NOW, against what we expect: the same id, the same patient, the same time and doctor, still ahead and in a status that can be
  // cancelled. 'cancelled': it already is (nothing has to be written). Cliniccards has no conditional update, so a change made by staff between this read and
  // the PUT is not excluded; the read narrows that window to a moment, it does not close it.
  private async freshState(connector: ClinicConnector, v: { externalId: string; startsAt: Date; doctorId: string | null; patient: { externalId: string } }): Promise<'ok' | 'cancelled' | 'changed' | 'unknown'> {
    let rows: ExternalVisit[];
    try {
      rows = await this.dayVisits(connector, v.startsAt);
    } catch {
      return 'unknown';
    }
    const f = rows.find((x) => x.externalId === v.externalId);
    if (!f || f.patientExternalId !== v.patient.externalId || f.startsAt.getTime() !== v.startsAt.getTime()) return 'changed';
    if (v.doctorId && f.doctorId && f.doctorId !== v.doctorId) return 'changed';
    if (f.status === VISIT_STATUS.cancelled) return 'cancelled';
    if (!MOVABLE.includes(f.status) || f.startsAt.getTime() <= Date.now()) return 'changed';
    return 'ok';
  }

  // A cancellation (by a staff member, or by the agent after the patient's explicit yes: userId null and the dialog as the origin, under the same write gates).
  // Fresh data first: a visit that changed, is gone or cannot be read is NOT written (visit_changed / booking_check_failed); one that is already cancelled in
  // Cliniccards is recorded as such without a PUT. `expect`: what the patient was asked about (the visit must still be exactly that).
  async cancel(clinicId: string, userId: string | null, visitId: string, o: { origin?: DialogOrigin; expect?: { externalId: string; startsAt: Date; doctorId: string | null } } = {}): Promise<BookingResult> {
    this.gate.assert(clinicId, userId, o.origin);
    const connector = await this.connector(clinicId);
    const v = await this.movable(clinicId, visitId);
    if (o.expect && (v.externalId !== o.expect.externalId || v.startsAt.getTime() !== o.expect.startsAt.getTime() || (v.doctorId ?? null) !== (o.expect.doctorId ?? null))) throw new ConflictException('visit_changed');
    const prior = await this.prisma.bookingAttempt.findUnique({ where: { clinicId_key: { clinicId, key: this.key(clinicId, 'CANCEL', v.externalId) } } });
    // (an earlier attempt that was started or whose answer was lost is settled by the reconciliation of run(), not by a new reading here)
    if (!prior || prior.status === 'FAILED') {
      const now = await this.freshState(connector, v);
      if (now === 'unknown') throw new BadRequestException('booking_check_failed');
      if (now === 'changed') throw new ConflictException('visit_changed');
      if (now === 'cancelled') {
        await this.prisma.visit.update({ where: { id: v.id }, data: { status: VISIT_STATUS.cancelled } });
        await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.cancel_seen', details: { visit: v.externalId, ...(o.origin ? { by: 'agent' } : {}) } } });
        return { externalVisitId: v.externalId, duplicate: true, verified: true };
      }
    }
    return this.setStatus(clinicId, userId, visitId, 'CANCEL', {
      origin: o.origin,
      // the same reading right before the write (retries included)
      check: async (k, cur) => {
        const s = await this.freshState(k, cur);
        if (s === 'unknown') throw new BadRequestException('booking_check_failed');
        if (s !== 'ok') throw new ConflictException('visit_changed');
      },
    });
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
  async createPatient(clinicId: string, userId: string | null, d: { lastName: string; firstName: string; phone: string; channel?: string; origin?: DialogOrigin }): Promise<{ patientId: string; existing: boolean }> {
    this.gate.assert(clinicId, userId, d.origin);
    const norm = normalizePhone(d.phone);
    if (!norm) throw new BadRequestException('bad_phone');
    // the surname and the first name are given separately: they are never told apart by the order of words
    const lastName = d.lastName.trim();
    const firstName = d.firstName.trim();
    if (!lastName || !firstName) throw new BadRequestException('patient_name_needed');
    const existing = await this.prisma.patient.findFirst({ where: { clinicId, removedAt: null, phoneNorm: norm }, select: { id: true } });
    if (existing) return { patientId: existing.id, existing: true };
    const connector = await this.connector(clinicId);
    if (!connector.createPatient) throw new BadRequestException('booking_write_disabled');
    const local = async (externalId: string) => {
      await this.prisma.patient.upsert({
        where: { clinicId_externalId: { clinicId, externalId } },
        create: { clinicId, externalId, fullName: `${lastName} ${firstName}`, phone: d.phone.trim(), phoneNorm: norm, source: d.channel ?? null },
        update: {},
      });
    };
    await this.run(clinicId, userId, {
      key: this.key(clinicId, 'PATIENT', norm),
      kind: 'PATIENT',
      origin: d.origin,
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
      act: async () => (await connector.createPatient!({ lastName, firstName, phone: norm, channel: d.channel })).externalId,
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
