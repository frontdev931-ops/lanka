import { Injectable } from '@nestjs/common';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';

const MIN = 60_000;
const INACTIVE = ['CANCELLED', 'MOVED', 'DID_NOT_COME'];
// A time for today is offered no earlier than this long from now
const LEAD_MIN = 120;

export interface FreeWindow {
  date: string;
  startMin: number;
  endMin: number;
  cabinetId: string;
  cabinetName: string | null;
  source: 'SHIFTS' | 'LANKA';
}
export type ScheduleSource = 'SHIFTS' | 'LANKA' | 'NONE';

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
export const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

// When a doctor can be booked, and which of that time is really free. The hours come from the doctor's shifts in Cliniccards or, for a doctor
// without shifts there, from the schedule the clinic set in LANKA; with neither the doctor has NO schedule and nothing is offered (an empty
// calendar is not a proof that he works). The visits of the doctor and of the cabinet, and the reserved blocks of the cabinet, are subtracted.
// This is a view over our synced copy; BookingService re-checks the place against fresh data of Cliniccards before every write.
@Injectable()
export class AvailabilityService {
  constructor(private prisma: PrismaService) {}

  private range(days: number) {
    const from = localToUtc(`${clinicDate(new Date())} 00:00:00`);
    const dates: string[] = [];
    const [y, m, d] = clinicDate(new Date()).split('-').map(Number);
    for (let i = 0; i < days; i++) dates.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
    return { from, to: new Date(localToUtc(`${dates[dates.length - 1]} 00:00:00`).getTime() + 26 * 3_600_000), dates };
  }

  async source(clinicId: string, doctorId: string, days = 14): Promise<ScheduleSource> {
    const { from, to } = this.range(days);
    if (await this.prisma.shift.count({ where: { clinicId, doctorId, startsAt: { gte: from, lt: to } } })) return 'SHIFTS';
    if (await this.prisma.doctorAvailability.count({ where: { clinicId, doctorId } })) return 'LANKA';
    return 'NONE';
  }

  // Free windows of one doctor for the visit length, sorted by time
  // `ignoreVisitId`: the external id of the ONE visit that is being moved (its own place does not count against its new time; every other visit does)
  async windows(clinicId: string, doctorId: string, opts: { days?: number; minutes: number; ignoreVisitId?: string }): Promise<FreeWindow[]> {
    const days = opts.days ?? 14;
    const { from, to, dates } = this.range(days);
    const [shifts, availability, visits, blocks, cabinets] = await Promise.all([
      this.prisma.shift.findMany({ where: { clinicId, doctorId, startsAt: { gte: from, lt: to } } }),
      this.prisma.doctorAvailability.findMany({ where: { clinicId, doctorId } }),
      this.prisma.visit.findMany({ where: { clinicId, status: { notIn: INACTIVE }, startsAt: { gte: from, lt: to } }, select: { externalId: true, doctorId: true, cabinetId: true, startsAt: true, endsAt: true } }),
      this.prisma.reservedBlock.findMany({ where: { clinicId, startsAt: { gte: from, lt: to } }, select: { cabinetId: true, startsAt: true, endsAt: true } }),
      this.prisma.cabinet.findMany({ where: { clinicId }, select: { externalId: true, name: true } }),
    ]);
    const names = new Map(cabinets.map((c) => [c.externalId, c.name]));
    // the hours of the doctor, per date: [startMin, endMin, cabinetId]
    const hours = new Map<string, { s: number; e: number; cabinetId: string }[]>();
    const add = (date: string, s: number, e: number, cabinetId: string) => hours.set(date, [...(hours.get(date) ?? []), { s, e, cabinetId }]);
    const source: 'SHIFTS' | 'LANKA' | null = shifts.length ? 'SHIFTS' : availability.length ? 'LANKA' : null;
    if (source === 'SHIFTS') for (const sh of shifts) add(clinicDate(sh.startsAt), toMin(clinicHm(sh.startsAt)), clinicDate(sh.endsAt) === clinicDate(sh.startsAt) ? toMin(clinicHm(sh.endsAt)) : 24 * 60, sh.cabinetId);
    if (source === 'LANKA') {
      for (const date of dates) {
        const exc = availability.filter((a) => a.date === date);
        const weekly = availability.filter((a) => a.weekday === weekdayOf(date));
        if (exc.some((a) => a.closed)) continue;
        const rows = exc.length ? exc : weekly;
        for (const a of rows) {
          const cabinetId = a.cabinetId ?? weekly[0]?.cabinetId;
          if (a.fromHm && a.toHm && cabinetId) add(date, toMin(a.fromHm), toMin(a.toHm), cabinetId);
        }
      }
    }
    if (!source) return [];

    const out: FreeWindow[] = [];
    const today = clinicDate(new Date());
    const earliestToday = Math.ceil((toMin(clinicHm(new Date())) + LEAD_MIN) / 30) * 30;
    for (const date of dates) {
      for (const h of hours.get(date) ?? []) {
        const busy: [number, number][] = [];
        for (const v of visits) {
          if (clinicDate(v.startsAt) !== date || (v.doctorId !== doctorId && v.cabinetId !== h.cabinetId) || (opts.ignoreVisitId && v.externalId === opts.ignoreVisitId)) continue;
          const end = v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN);
          busy.push([toMin(clinicHm(v.startsAt)), clinicDate(end) === date ? toMin(clinicHm(end)) : 24 * 60]);
        }
        for (const b of blocks) {
          if (b.cabinetId !== h.cabinetId || clinicDate(b.startsAt) !== date) continue;
          busy.push([toMin(clinicHm(b.startsAt)), clinicDate(b.endsAt) === date ? toMin(clinicHm(b.endsAt)) : 24 * 60]);
        }
        let cursor = date === today ? Math.max(h.s, earliestToday) : h.s;
        for (const [a, b] of busy.sort((x, y) => x[0] - y[0])) {
          // a free gap ends at the next busy time OR at the end of the working interval, whichever is first: a visit of another doctor in the same cabinet after
          // the doctor's hours must not stretch his free time past them (it did: 10:00-10:10 hours and a visit at 11:00 gave a free 10:00-11:00)
          const end = Math.min(a, h.e);
          if (end > cursor && end - cursor >= opts.minutes) out.push({ date, startMin: cursor, endMin: end, cabinetId: h.cabinetId, cabinetName: names.get(h.cabinetId) ?? null, source });
          cursor = Math.max(cursor, b);
          if (cursor >= h.e) break;
        }
        if (h.e - cursor >= opts.minutes) out.push({ date, startMin: cursor, endMin: h.e, cabinetId: h.cabinetId, cabinetName: names.get(h.cabinetId) ?? null, source });
      }
    }
    return out.sort((x, y) => x.date.localeCompare(y.date) || x.startMin - y.startMin);
  }

  // The cabinet in which this doctor can take this exact time, or null when he cannot (not working, busy, or the cabinet is busy)
  async placeFor(clinicId: string, doctorId: string, startsAt: Date, minutes: number, ignoreVisitId?: string): Promise<{ cabinetId: string; cabinetName: string | null } | null> {
    const date = clinicDate(startsAt);
    const start = toMin(clinicHm(startsAt));
    const days = Math.max(2, Math.ceil((startsAt.getTime() - Date.now()) / 86_400_000) + 2);
    const w = (await this.windows(clinicId, doctorId, { days: Math.min(days, 90), minutes, ignoreVisitId })).find((x) => x.date === date && x.startMin <= start && start + minutes <= x.endMin);
    return w ? { cabinetId: w.cabinetId, cabinetName: w.cabinetName } : null;
  }

  // The first free half hour of each day (up to `max` days) for several doctors, sorted by time: what the bot offers on buttons
  async offers(clinicId: string, doctorIds: string[], minutes: number, max = 3): Promise<{ doctorId: string; date: string; time: string }[]> {
    const all: { doctorId: string; date: string; startMin: number }[] = [];
    for (const doctorId of doctorIds) {
      const seenDays = new Set<string>();
      for (const w of await this.windows(clinicId, doctorId, { minutes })) {
        const from = Math.ceil(w.startMin / 30) * 30;
        if (from + minutes > w.endMin || seenDays.has(w.date)) continue;
        seenDays.add(w.date);
        all.push({ doctorId, date: w.date, startMin: from });
      }
    }
    all.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
    // one offer per doctor and day; different doctors at the same time are both shown
    return all.slice(0, max).map((x) => ({ doctorId: x.doctorId, date: x.date, time: hmOf(x.startMin) }));
  }
}
