import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { readWorkHours } from '../clinic/work-hours';
import { ExternalBlock, ExternalVisit } from '../integrations/connector';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { DoctorsService } from './doctors.service';

const MIN = 60_000;
const INACTIVE = ['CANCELLED', 'MOVED', 'DID_NOT_COME'];
const LEAD_MIN = 120;
const CACHE_MS = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface HoursException {
  date: string;
  closed: boolean;
  from?: string;
  to?: string;
}
export interface CabinetWindow {
  date: string;
  startMin: number;
  endMin: number;
  cabinetId: string;
}
export type CabinetProblem = 'no_shared_account' | 'no_cabinets' | 'no_services' | 'no_hours';

// Booking by CABINETS through one shared account of Cliniccards (an alternative to booking by doctors). The clinic allows a service and a
// time without naming a specialist and makes sure somebody is there in the allowed hours. The free times are computed per cabinet: the
// allowed hours (the working hours of the clinic and their exceptions) minus EVERY visit in the cabinet whatever its doctor_id, and the
// blocks of the cabinet. The busy time of the shared doctor_id is never taken for one physical doctor busy in all cabinets at once.
// The schedule is read from Cliniccards for the period shortly before it is used; when it cannot be read nothing is offered or confirmed.
@Injectable()
export class CabinetBookingService {
  private cache = new Map<string, { at: number; days: number; visits: ExternalVisit[]; blocks: ExternalBlock[] }>();

  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
    private doctors: DoctorsService,
  ) {}

  // ---- settings ----

  private parseExceptions(raw: unknown): HoursException[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => r as Partial<HoursException>)
      .filter((x) => typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .map((x) => ({ date: x.date!, closed: !!x.closed, ...(x.from ? { from: x.from } : {}), ...(x.to ? { to: x.to } : {}) }));
  }

  async settings(clinicId: string, refreshDoctors = true) {
    if (refreshDoctors) await this.doctors.refresh(clinicId);
    const [clinic, cabinets, services, doctors] = await Promise.all([
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true, sharedDoctorId: true, sharedDoctorName: true, workHours: true, workHoursExceptions: true } }),
      this.prisma.cabinet.findMany({ where: { clinicId }, orderBy: { name: 'asc' }, select: { externalId: true, name: true, onlineBooking: true, acceptsUrgent: true } }),
      this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true }, orderBy: { title: 'asc' }, select: { id: true, title: true, durationMin: true, onlineBooking: true, cabinetIds: true, approvedAt: true } }),
      this.doctors.activeDoctors(clinicId),
    ]);
    const hoursSet = !!clinic.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    const problems: CabinetProblem[] = [];
    const shared = clinic.sharedDoctorId ? doctors.find((d) => d.externalId === clinic.sharedDoctorId) : null;
    if (!clinic.sharedDoctorId || !shared) problems.push('no_shared_account');
    if (!cabinets.some((c) => c.onlineBooking)) problems.push('no_cabinets');
    if (!services.some((s) => s.onlineBooking && s.durationMin && s.approvedAt)) problems.push('no_services');
    if (!hoursSet || Object.values(readWorkHours(clinic.workHours)).every((h) => !h)) problems.push('no_hours');
    return {
      mode: clinic.scheduleMode as 'DOCTORS' | 'CABINETS',
      shared: clinic.sharedDoctorId ? { doctorId: clinic.sharedDoctorId, name: shared ? `${shared.lastName} ${shared.firstName}`.trim() : clinic.sharedDoctorName, missing: !shared } : null,
      accounts: doctors.map((d) => ({ externalId: d.externalId, name: `${d.lastName} ${d.firstName}`.trim() })),
      cabinets,
      services: services.map((s) => ({ id: s.id, title: s.title, durationMin: s.durationMin, approved: !!s.approvedAt, onlineBooking: s.onlineBooking, cabinetIds: s.cabinetIds })),
      exceptions: this.parseExceptions(clinic.workHoursExceptions),
      hoursSet,
      problems,
    };
  }

  async setMode(clinicId: string, userId: string, mode: string) {
    if (mode !== 'DOCTORS' && mode !== 'CABINETS') throw new BadRequestException('bad_schedule_mode');
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { scheduleMode: mode } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.schedule_mode', details: { mode } } });
    return this.settings(clinicId, false);
  }

  // The account whose id is used as doctor_id: only one that Cliniccards lists
  async setShared(clinicId: string, userId: string, doctorId: string | null) {
    if (doctorId === null) await this.prisma.clinic.update({ where: { id: clinicId }, data: { sharedDoctorId: null, sharedDoctorName: null } });
    else {
      const d = await this.prisma.doctor.findUnique({ where: { clinicId_externalId: { clinicId, externalId: doctorId } } });
      if (!d || !d.active) throw new BadRequestException('doctor_unknown');
      await this.prisma.clinic.update({ where: { id: clinicId }, data: { sharedDoctorId: d.externalId, sharedDoctorName: `${d.lastName} ${d.firstName}`.trim() } });
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.shared_account', details: { doctorId } } });
    return this.settings(clinicId, false);
  }

  async setCabinets(clinicId: string, userId: string, rows: { externalId: string; onlineBooking: boolean; acceptsUrgent: boolean }[]) {
    const known = new Set((await this.prisma.cabinet.findMany({ where: { clinicId }, select: { externalId: true } })).map((c) => c.externalId));
    for (const r of rows) {
      if (!known.has(r.externalId)) throw new BadRequestException('bad_cabinets');
      // urgent patients only in a cabinet that is open for online booking at all
      await this.prisma.cabinet.update({ where: { clinicId_externalId: { clinicId, externalId: r.externalId } }, data: { onlineBooking: r.onlineBooking, acceptsUrgent: r.onlineBooking && r.acceptsUrgent } });
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.cabinets', details: { count: rows.length } } });
    return this.settings(clinicId, false);
  }

  // A service can be booked online only with an approved name and a KNOWN length; cabinets: empty means any cabinet open for online booking
  async setServices(clinicId: string, userId: string, rows: { id: string; onlineBooking: boolean; cabinetIds: string[] }[]) {
    const cabinets = new Set((await this.prisma.cabinet.findMany({ where: { clinicId }, select: { externalId: true } })).map((c) => c.externalId));
    for (const r of rows) {
      const item = await this.prisma.kbItem.findFirst({ where: { id: r.id, clinicId, kind: 'SERVICE' } });
      if (!item) throw new BadRequestException('bad_services');
      if (r.onlineBooking && (!item.durationMin || !item.approvedAt)) throw new BadRequestException('service_needs_duration');
      if (r.cabinetIds.some((c) => !cabinets.has(c))) throw new BadRequestException('bad_cabinets');
      await this.prisma.kbItem.update({ where: { id: item.id }, data: { onlineBooking: r.onlineBooking, cabinetIds: [...new Set(r.cabinetIds)] } });
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.services', details: { count: rows.length } } });
    return this.settings(clinicId, false);
  }

  async setExceptions(clinicId: string, userId: string, input: unknown) {
    if (!Array.isArray(input) || input.length > 120) throw new BadRequestException('bad_exceptions');
    const seen = new Set<string>();
    const rows: HoursException[] = input.map((r) => {
      const x = r as Partial<HoursException>;
      if (typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || Number.isNaN(Date.parse(x.date)) || seen.has(x.date)) throw new BadRequestException('bad_exceptions');
      seen.add(x.date);
      if (x.closed) return { date: x.date, closed: true };
      if (typeof x.from !== 'string' || typeof x.to !== 'string' || !HM.test(x.from) || !HM.test(x.to) || x.from >= x.to) throw new BadRequestException('bad_exceptions');
      return { date: x.date, closed: false, from: x.from, to: x.to };
    });
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { workHoursExceptions: rows as unknown as Prisma.InputJsonValue } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'booking.hours_exceptions', details: { count: rows.length } } });
    return this.settings(clinicId, false);
  }

  // ---- the schedule ----

  private range(days: number) {
    const [y, m, d] = clinicDate(new Date()).split('-').map(Number);
    const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
    const from = localToUtc(`${dates[0]} 00:00:00`);
    return { from, to: new Date(localToUtc(`${dates[days - 1]} 00:00:00`).getTime() + 26 * 3_600_000), dates };
  }

  // The visits and the reserved blocks of the period as Cliniccards has them NOW (two reads, kept for a minute so a burst of messages does
  // not flood the API). A failure throws 'schedule_unavailable': the caller offers and confirms nothing on stale data.
  async fresh(clinicId: string, days: number, force = false) {
    const hit = this.cache.get(clinicId);
    if (!force && hit && hit.days >= days && Date.now() - hit.at < CACHE_MS) return hit;
    const connector = await this.sync.connectorForClinic(clinicId).catch(() => null);
    if (!connector) throw new Error('schedule_unavailable');
    const { from, to } = this.range(days);
    try {
      const [visits, schedule] = await Promise.all([connector.fetchVisits({ from, to }), connector.fetchSchedule({ from, to })]);
      const entry = { at: Date.now(), days, visits, blocks: schedule.blocks };
      this.cache.set(clinicId, entry);
      return entry;
    } catch {
      this.cache.delete(clinicId);
      throw new Error('schedule_unavailable');
    }
  }

  private async allowedCabinets(clinicId: string, service: { cabinetIds: string[] } | null, urgent: boolean): Promise<string[]> {
    const rows = await this.prisma.cabinet.findMany({ where: { clinicId, onlineBooking: true, ...(urgent ? { acceptsUrgent: true } : {}) }, select: { externalId: true } });
    const ids = rows.map((r) => r.externalId);
    return service?.cabinetIds.length ? ids.filter((id) => service.cabinetIds.includes(id)) : ids;
  }

  // Free windows by cabinet. Hours are the clinic's working hours with their exceptions; unset hours offer nothing.
  async windows(clinicId: string, opts: { minutes: number; service?: { cabinetIds: string[] } | null; urgent?: boolean; days?: number; force?: boolean }): Promise<CabinetWindow[]> {
    const days = opts.days ?? 7;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { workHours: true, workHoursExceptions: true } });
    const configured = !!clinic.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    const cabinets = await this.allowedCabinets(clinicId, opts.service ?? null, !!opts.urgent);
    if (!configured || !cabinets.length) return [];
    const { visits, blocks } = await this.fresh(clinicId, days, opts.force);
    const week = readWorkHours(clinic.workHours);
    const exceptions = this.parseExceptions(clinic.workHoursExceptions);
    const { dates } = this.range(days);
    const today = clinicDate(new Date());
    const earliestToday = Math.ceil((toMin(clinicHm(new Date())) + LEAD_MIN) / 30) * 30;
    const out: CabinetWindow[] = [];
    for (const date of dates) {
      const exc = exceptions.find((e) => e.date === date);
      const h = exc ? (exc.closed ? null : { from: exc.from!, to: exc.to! }) : week[String(new Date(`${date}T00:00:00Z`).getUTCDay() || 7)];
      if (!h) continue;
      for (const cabinetId of cabinets) {
        // EVERY visit in the cabinet counts, whatever doctor_id it has (the shared account is not one busy physical doctor)
        const busy: [number, number][] = [];
        for (const v of visits) {
          if (v.cabinetId !== cabinetId || INACTIVE.includes(v.status) || clinicDate(v.startsAt) !== date) continue;
          const end = v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN);
          busy.push([toMin(clinicHm(v.startsAt)), clinicDate(end) === date ? toMin(clinicHm(end)) : 24 * 60]);
        }
        for (const b of blocks) {
          if (b.cabinetId !== cabinetId || clinicDate(b.startsAt) !== date) continue;
          busy.push([toMin(clinicHm(b.startsAt)), clinicDate(b.endsAt) === date ? toMin(clinicHm(b.endsAt)) : 24 * 60]);
        }
        let cursor = date === today ? Math.max(toMin(h.from), earliestToday) : toMin(h.from);
        const end = toMin(h.to);
        for (const [a, b] of busy.sort((x, y) => x[0] - y[0])) {
          if (a > cursor && a - cursor >= opts.minutes) out.push({ date, startMin: cursor, endMin: Math.min(a, end), cabinetId });
          cursor = Math.max(cursor, b);
        }
        if (end - cursor >= opts.minutes) out.push({ date, startMin: cursor, endMin: end, cabinetId });
      }
    }
    return out.filter((w) => w.endMin - w.startMin >= opts.minutes).sort((x, y) => x.date.localeCompare(y.date) || x.startMin - y.startMin);
  }

  // The nearest times (one per day, the first free half hour, across the cabinets), up to `max`
  async offers(clinicId: string, opts: { minutes: number; service?: { cabinetIds: string[] } | null; urgent?: boolean }, max = 3): Promise<{ date: string; time: string }[]> {
    const seen = new Set<string>();
    const out: { date: string; time: string }[] = [];
    for (const w of await this.windows(clinicId, opts)) {
      const from = Math.ceil(w.startMin / 30) * 30;
      if (from + opts.minutes > w.endMin || seen.has(w.date)) continue;
      seen.add(w.date);
      out.push({ date: w.date, time: hmOf(from) });
      if (out.length >= max) break;
    }
    return out;
  }

  // The cabinet for this exact time, from data read right now (never from the cache): null when no allowed cabinet is free for the whole visit
  async placeFor(clinicId: string, startsAt: Date, minutes: number, service: { cabinetIds: string[] } | null): Promise<{ cabinetId: string } | null> {
    const date = clinicDate(startsAt);
    const start = toMin(clinicHm(startsAt));
    const days = Math.min(30, Math.max(2, Math.ceil((startsAt.getTime() - Date.now()) / 86_400_000) + 2));
    const w = (await this.windows(clinicId, { minutes, service, days, force: true })).find((x) => x.date === date && x.startMin <= start && start + minutes <= x.endMin);
    return w ? { cabinetId: w.cabinetId } : null;
  }

  invalidate(clinicId: string) {
    this.cache.delete(clinicId);
  }
}
