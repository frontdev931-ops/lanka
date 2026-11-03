import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService, ScheduleSource } from './availability.service';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export interface WeeklyRow {
  weekday: number;
  from: string;
  to: string;
  cabinetId: string;
}
export interface ExceptionRow {
  date: string;
  closed: boolean;
  from?: string;
  to?: string;
  cabinetId?: string;
}

// The doctors of the clinic for the booking settings: the list from Cliniccards, the doctor for a first booking, what each doctor provides,
// and the schedule of online booking that is kept in LANKA. Everything is saved by the id of the doctor in Cliniccards, never by the name only.
@Injectable()
export class DoctorsService {
  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
    private availability: AvailabilityService,
  ) {}

  // Reads the doctors from Cliniccards (a GET). A failure keeps what is stored.
  async refresh(clinicId: string): Promise<{ ok: boolean; reason?: 'not_connected' | 'failed' }> {
    const connector = await this.sync.connectorForClinic(clinicId).catch(() => null);
    if (!connector?.fetchDoctors) return { ok: false, reason: 'not_connected' };
    let rows;
    try {
      rows = await connector.fetchDoctors();
    } catch {
      return { ok: false, reason: 'failed' };
    }
    const now = new Date();
    for (const d of rows) {
      await this.prisma.doctor.upsert({
        where: { clinicId_externalId: { clinicId, externalId: d.externalId } },
        create: { clinicId, externalId: d.externalId, lastName: d.lastName, firstName: d.firstName, refreshedAt: now },
        update: { lastName: d.lastName, firstName: d.firstName, active: true, refreshedAt: now },
      });
    }
    // a doctor who is no longer in Cliniccards stays in our list as inactive: his profile is not lost, but he is never booked
    await this.prisma.doctor.updateMany({ where: { clinicId, externalId: { notIn: rows.map((r) => r.externalId) } }, data: { active: false } });
    const primary = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { primaryDoctorId: true } });
    const p = primary?.primaryDoctorId ? rows.find((r) => r.externalId === primary.primaryDoctorId) : null;
    if (p) await this.prisma.clinic.update({ where: { id: clinicId }, data: { primaryDoctorName: `${p.lastName} ${p.firstName}`.trim() } });
    return { ok: true };
  }

  async activeDoctors(clinicId: string) {
    return this.prisma.doctor.findMany({ where: { clinicId, active: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] });
  }

  async list(clinicId: string, refresh = true) {
    const refreshed = refresh ? await this.refresh(clinicId) : { ok: true };
    const [doctors, clinic, services, cabinets, avail] = await Promise.all([
      this.prisma.doctor.findMany({ where: { clinicId }, orderBy: [{ active: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }] }),
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { primaryDoctorId: true, primaryDoctorName: true } }),
      this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true }, orderBy: { title: 'asc' }, select: { id: true, title: true, durationMin: true, approvedAt: true } }),
      this.prisma.cabinet.findMany({ where: { clinicId }, orderBy: { name: 'asc' }, select: { externalId: true, name: true } }),
      this.prisma.doctorAvailability.findMany({ where: { clinicId } }),
    ]);
    const rows = [];
    for (const d of doctors) {
      const source: ScheduleSource = await this.availability.source(clinicId, d.externalId);
      const problems: string[] = [];
      if (!d.active) problems.push('inactive');
      if (!d.serviceIds.length) problems.push('no_services');
      if (source === 'NONE') problems.push('no_schedule');
      rows.push({
        externalId: d.externalId,
        name: `${d.lastName} ${d.firstName}`.trim(),
        active: d.active,
        serviceIds: d.serviceIds,
        acceptsUrgent: d.acceptsUrgent,
        scheduleSource: source,
        hasLankaSchedule: avail.some((a) => a.doctorId === d.externalId),
        problems,
      });
    }
    const primary = clinic.primaryDoctorId ? rows.find((r) => r.externalId === clinic.primaryDoctorId) : null;
    const primaryProblems: string[] = [];
    if (clinic.primaryDoctorId && !primary) primaryProblems.push('missing');
    else if (primary) for (const p of primary.problems) primaryProblems.push(p);
    return {
      connected: refreshed.ok || refreshed.reason !== 'not_connected',
      refreshFailed: !refreshed.ok,
      primary: clinic.primaryDoctorId ? { doctorId: clinic.primaryDoctorId, name: primary?.name ?? clinic.primaryDoctorName, problems: primaryProblems } : null,
      doctors: rows,
      services: services.map((s) => ({ id: s.id, title: s.title, durationMin: s.durationMin, approved: !!s.approvedAt })),
      cabinets,
    };
  }

  async setPrimary(clinicId: string, userId: string, doctorId: string | null) {
    if (doctorId === null) {
      await this.prisma.clinic.update({ where: { id: clinicId }, data: { primaryDoctorId: null, primaryDoctorName: null } });
    } else {
      // only a doctor that Cliniccards lists: an arbitrary id is never stored
      const d = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId, externalId: doctorId } } });
      if (!d || !d.active) throw new BadRequestException('doctor_unknown');
      await this.prisma.clinic.update({ where: { id: clinicId }, data: { primaryDoctorId: d.externalId, primaryDoctorName: `${d.lastName} ${d.firstName}`.trim() } });
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'doctors.primary', details: { doctorId } } });
    return this.list(clinicId, false);
  }

  async updateProfile(clinicId: string, userId: string, externalId: string, patch: { serviceIds?: string[]; acceptsUrgent?: boolean }) {
    const d = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId, externalId } } });
    if (!d) throw new NotFoundException('doctor_not_found');
    if (patch.serviceIds) {
      const ok = await this.prisma.kbItem.count({ where: { clinicId, kind: 'SERVICE', id: { in: patch.serviceIds } } });
      if (ok !== new Set(patch.serviceIds).size) throw new BadRequestException('bad_services');
    }
    await this.prisma.doctor.update({ where: { id: d.id }, data: { ...(patch.serviceIds ? { serviceIds: [...new Set(patch.serviceIds)] } : {}), ...(patch.acceptsUrgent !== undefined ? { acceptsUrgent: patch.acceptsUrgent } : {}) } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'doctors.profile', details: { doctorId: externalId } } });
    return this.list(clinicId, false);
  }

  async getAvailability(clinicId: string, externalId: string) {
    const rows = await this.prisma.doctorAvailability.findMany({ where: { clinicId, doctorId: externalId }, orderBy: [{ weekday: 'asc' }, { fromHm: 'asc' }, { date: 'asc' }] });
    return {
      weekly: rows.filter((r) => r.weekday !== null).map((r) => ({ weekday: r.weekday!, from: r.fromHm!, to: r.toHm!, cabinetId: r.cabinetId! })) as WeeklyRow[],
      exceptions: rows.filter((r) => r.date !== null).sort((a, b) => a.date!.localeCompare(b.date!)).map((r) => ({ date: r.date!, closed: r.closed, ...(r.fromHm ? { from: r.fromHm } : {}), ...(r.toHm ? { to: r.toHm } : {}), ...(r.cabinetId ? { cabinetId: r.cabinetId } : {}) })) as ExceptionRow[],
      source: await this.availability.source(clinicId, externalId),
    };
  }

  // Saves the whole schedule of one doctor. Rejected: bad hours, an unknown cabinet, two rows of the doctor that overlap, a cabinet that
  // another doctor already has at the same time. Returned as warnings: cabinets that the visits of Cliniccards already occupy at those hours.
  async setAvailability(clinicId: string, userId: string, externalId: string, input: unknown) {
    const doctor = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId, externalId } } });
    if (!doctor || !doctor.active) throw new NotFoundException('doctor_not_found');
    const body = (input && typeof input === 'object' ? input : {}) as { weekly?: unknown; exceptions?: unknown };
    const weekly = this.parseWeekly(body.weekly);
    const exceptions = this.parseExceptions(body.exceptions);
    const cabinets = new Set((await this.prisma.cabinet.findMany({ where: { clinicId }, select: { externalId: true } })).map((c) => c.externalId));
    for (const w of weekly) if (!cabinets.has(w.cabinetId)) throw new BadRequestException('bad_availability');
    for (const e of exceptions) if (e.cabinetId && !cabinets.has(e.cabinetId)) throw new BadRequestException('bad_availability');
    const overlap = (a: { from: string; to: string }, b: { from: string; to: string }) => toMin(a.from) < toMin(b.to) && toMin(b.from) < toMin(a.to);
    for (const [i, a] of weekly.entries()) for (const b of weekly.slice(i + 1)) if (a.weekday === b.weekday && overlap(a, b)) throw new ConflictException('availability_conflict');
    // a cabinet is in one place at a time: another doctor's weekly row in the same cabinet at the same hours is a conflict
    const others = await this.prisma.doctorAvailability.findMany({ where: { clinicId, doctorId: { not: externalId }, weekday: { not: null } } });
    for (const w of weekly) {
      if (others.some((o) => o.weekday === w.weekday && o.cabinetId === w.cabinetId && o.fromHm && o.toHm && overlap(w, { from: o.fromHm, to: o.toHm }))) throw new ConflictException('availability_conflict');
    }
    await this.prisma.$transaction([
      this.prisma.doctorAvailability.deleteMany({ where: { clinicId, doctorId: externalId } }),
      this.prisma.doctorAvailability.createMany({
        data: [
          ...weekly.map((w) => ({ clinicId, doctorId: externalId, weekday: w.weekday, fromHm: w.from, toHm: w.to, cabinetId: w.cabinetId })),
          ...exceptions.map((e) => ({ clinicId, doctorId: externalId, date: e.date, closed: e.closed, fromHm: e.from ?? null, toHm: e.to ?? null, cabinetId: e.cabinetId ?? null })),
        ],
      }),
    ]);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'doctors.availability', details: { doctorId: externalId, weekly: weekly.length, exceptions: exceptions.length } } });
    return { ...(await this.getAvailability(clinicId, externalId)), warnings: await this.cabinetWarnings(clinicId, externalId, weekly) };
  }

  // Visits of the next two weeks in the cabinet of a weekly row, made for ANOTHER doctor at those hours (Cliniccards already uses the place)
  private async cabinetWarnings(clinicId: string, externalId: string, weekly: WeeklyRow[]) {
    const from = localToUtc(`${clinicDate(new Date())} 00:00:00`);
    const visits = await this.prisma.visit.findMany({ where: { clinicId, status: { notIn: ['CANCELLED', 'MOVED', 'DID_NOT_COME'] }, startsAt: { gte: from, lt: new Date(from.getTime() + 14 * 86_400_000) }, NOT: { doctorId: externalId } }, select: { cabinetId: true, startsAt: true } });
    const out: { weekday: number; cabinetId: string; visits: number }[] = [];
    for (const w of weekly) {
      const n = visits.filter((v) => v.cabinetId === w.cabinetId && (new Date(`${clinicDate(v.startsAt)}T00:00:00Z`).getUTCDay() || 7) === w.weekday && toMin(clinicHm(v.startsAt)) >= toMin(w.from) && toMin(clinicHm(v.startsAt)) < toMin(w.to)).length;
      if (n) out.push({ weekday: w.weekday, cabinetId: w.cabinetId, visits: n });
    }
    return out;
  }

  private parseWeekly(raw: unknown): WeeklyRow[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 40) throw new BadRequestException('bad_availability');
    return raw.map((r) => {
      const x = r as Partial<WeeklyRow>;
      if (!Number.isInteger(x.weekday) || x.weekday! < 1 || x.weekday! > 7 || typeof x.from !== 'string' || typeof x.to !== 'string' || !HM.test(x.from) || !HM.test(x.to) || x.from >= x.to || typeof x.cabinetId !== 'string' || !x.cabinetId) throw new BadRequestException('bad_availability');
      return { weekday: x.weekday!, from: x.from, to: x.to, cabinetId: x.cabinetId };
    });
  }

  private parseExceptions(raw: unknown): ExceptionRow[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 120) throw new BadRequestException('bad_availability');
    const seen = new Set<string>();
    return raw.map((r) => {
      const x = r as Partial<ExceptionRow>;
      if (typeof x.date !== 'string' || !DATE.test(x.date) || Number.isNaN(Date.parse(x.date)) || seen.has(x.date)) throw new BadRequestException('bad_availability');
      seen.add(x.date);
      if (x.closed) return { date: x.date, closed: true };
      if (typeof x.from !== 'string' || typeof x.to !== 'string' || !HM.test(x.from) || !HM.test(x.to) || x.from >= x.to) throw new BadRequestException('bad_availability');
      return { date: x.date, closed: false, from: x.from, to: x.to, ...(x.cabinetId ? { cabinetId: String(x.cabinetId) } : {}) };
    });
  }
}
