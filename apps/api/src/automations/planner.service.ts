import { Injectable } from '@nestjs/common';
import { clinicDate, clinicHm } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { marketingAllowed } from './consent';
import { Kind, SCENARIOS, Scenario, render, scenario } from './scenarios';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACTIVE_VISIT = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'];
const CLOSED_BAD = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];
// Marketing messages to one patient no more often than once in this many days (a birthday greeting does not count)
export const MARKETING_GAP_DAYS = 14;

interface Candidate {
  patientId: string;
  dedupeKey: string;
  visitId?: string;
  vars: { date?: string; time?: string; months?: number };
  scheduledFor: Date;
  expiresAt?: Date;
}

export interface RuleReport {
  key: string;
  enabled: boolean;
  candidates: number; // how many match the condition
  alreadyQueued: number; // for how many a message is already created
  toQueue: number; // how many will be queued
  noChannel: number; // no messenger connected
  blockedConsent: number; // no consent for marketing
  paused: number; // the patient opted out or is paused
  tooSoon: number; // a marketing message to this patient was already sent recently
  sample: { patient: string; channel: string; text: string }[];
}

@Injectable()
export class PlannerService {
  constructor(private prisma: PrismaService) {}

  async rules(clinicId: string) {
    const rows = await this.prisma.automationRule.findMany({ where: { clinicId } });
    const by = new Map(rows.map((r) => [r.key, r]));
    return SCENARIOS.map((s) => {
      const r = by.get(s.key);
      return {
        key: s.key,
        kind: s.kind,
        enabled: r?.enabled ?? false,
        params: { ...s.defaultParams, ...((r?.params as object) ?? {}) } as Record<string, unknown>,
        text: ((r?.templates as { text?: string } | undefined)?.text ?? s.defaultText) as string,
        defaultText: s.defaultText,
      };
    });
  }

  // Picks the candidates of a scenario for the current moment
  private async candidates(clinicId: string, s: Scenario, params: Record<string, unknown>, now: Date): Promise<Candidate[]> {
    if (s.key === 'visit-reminder') {
      const hours = (Array.isArray(params.hoursBefore) ? params.hoursBefore : [24]).map(Number).filter((h) => h > 0 && h <= 72);
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: { in: ACTIVE_VISIT }, startsAt: { gt: new Date(now.getTime() + 30 * 60_000), lte: new Date(now.getTime() + 72 * HOUR) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true, bookedAt: true },
      });
      const out: Candidate[] = [];
      for (const v of visits) {
        for (const h of hours) {
          const at = new Date(v.startsAt.getTime() - h * HOUR);
          // A reminder is created when no more than h hours are left before the appointment; for those booked later than that moment it is not needed
          if (at.getTime() > now.getTime()) continue;
          if (v.bookedAt && v.bookedAt.getTime() > at.getTime()) continue;
          out.push({ patientId: v.patientId, visitId: v.id, dedupeKey: `visit-reminder:${v.id}:${h}`, vars: { date: clinicDate(v.startsAt).slice(5).split('-').reverse().join('.'), time: clinicHm(v.startsAt) }, scheduledFor: now, expiresAt: v.startsAt });
        }
      }
      return out;
    }

    if (s.key === 'no-show') {
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: 'DID_NOT_COME', startsAt: { gte: new Date(now.getTime() - DAY), lte: now }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true },
      });
      const out: Candidate[] = [];
      for (const v of visits) {
        // If the patient has already booked again, asking "when is convenient for you" is pointless
        const rebooked = await this.prisma.visit.count({ where: { patientId: v.patientId, status: { notIn: CLOSED_BAD }, startsAt: { gt: now } } });
        if (rebooked) continue;
        out.push({ patientId: v.patientId, visitId: v.id, dedupeKey: `no-show:${v.id}`, vars: { date: clinicDate(v.startsAt).slice(5).split('-').reverse().join('.') }, scheduledFor: now, expiresAt: new Date(v.startsAt.getTime() + 3 * DAY) });
      }
      return out;
    }

    if (s.key === 'hygiene-recall') {
      const months = Math.max(1, Math.min(24, Number(params.months) || 6));
      // The due date fell within the last 14 days: so that turning a scenario on does not send to the whole history
      const dueTo = new Date(now.getTime() - months * 30 * DAY);
      const dueFrom = new Date(dueTo.getTime() - 14 * DAY);
      const done = await this.prisma.planItem.findMany({
        where: { clinicId, status: { in: ['DONE', 'INVOICED'] }, groupName: { startsWith: 'Профілактика', mode: 'insensitive' }, markedDoneAt: { not: null }, patient: { removedAt: null } },
        select: { patientId: true, markedDoneAt: true },
      });
      const last = new Map<string, Date>();
      for (const d of done) if (!last.has(d.patientId) || d.markedDoneAt! > last.get(d.patientId)!) last.set(d.patientId, d.markedDoneAt!);
      const due = [...last].filter(([, at]) => at >= dueFrom && at <= dueTo).map(([id]) => id);
      if (!due.length) return [];
      const busy = new Set(
        (await this.prisma.visit.findMany({ where: { patientId: { in: due }, status: { notIn: CLOSED_BAD }, startsAt: { gt: now } }, select: { patientId: true } })).map((v) => v.patientId),
      );
      const reminded = new Set(
        (await this.prisma.reminder.findMany({ where: { patientId: { in: due }, status: 'NEW', dueDate: { gte: new Date(clinicDate(now) + 'T00:00:00Z') } }, select: { patientId: true } })).map((r) => r.patientId as string),
      );
      return due.filter((id) => !busy.has(id) && !reminded.has(id)).map((id) => ({ patientId: id, dedupeKey: `hygiene-recall:${id}:${clinicDate(last.get(id)!).slice(0, 7)}`, vars: { months }, scheduledFor: now }));
    }
    if (s.key === 'cancel-followup') {
      // A visit was cancelled or moved 1-3 days ago and the patient has no new active appointment: ask when it suits them
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: { in: ['CANCELLED', 'MOVED'] }, startsAt: { gte: new Date(now.getTime() - 3 * DAY), lte: new Date(now.getTime() - DAY) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true },
      });
      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const v of visits) {
        if (seen.has(v.patientId)) continue;
        const rebooked = await this.prisma.visit.count({ where: { patientId: v.patientId, status: { in: ACTIVE_VISIT }, startsAt: { gt: now } } });
        if (rebooked) continue;
        seen.add(v.patientId);
        out.push({ patientId: v.patientId, visitId: v.id, dedupeKey: `cancel-followup:${v.id}`, vars: { date: clinicDate(v.startsAt).slice(5).split('-').reverse().join('.') }, scheduledFor: now, expiresAt: new Date(v.startsAt.getTime() + 5 * DAY) });
      }
      return out;
    }

    if (s.key === 'post-visit-thanks') {
      // Thank the patient the day after a visit that took place (no more than once a day per patient)
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: 'VISITED', startsAt: { gte: new Date(now.getTime() - 48 * HOUR), lte: new Date(now.getTime() - 18 * HOUR) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true },
      });
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const v of visits) {
        const key = `post-visit-thanks:${v.patientId}:${clinicDate(v.startsAt)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ patientId: v.patientId, visitId: v.id, dedupeKey: key, vars: {}, scheduledFor: now, expiresAt: new Date(v.startsAt.getTime() + 3 * DAY) });
      }
      return out;
    }

    if (s.key === 'visit-review') {
      // We ask for a rating a few hours after the visit and not later than the next day; once a day per patient
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: 'VISITED', startsAt: { gte: new Date(now.getTime() - 30 * HOUR), lte: new Date(now.getTime() - 3 * HOUR) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true },
        orderBy: { startsAt: 'desc' },
      });
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const v of visits) {
        if (seen.has(v.patientId)) continue;
        seen.add(v.patientId);
        out.push({ patientId: v.patientId, visitId: v.id, dedupeKey: `visit-review:${v.id}`, vars: {}, scheduledFor: now, expiresAt: new Date(v.startsAt.getTime() + 3 * DAY) });
      }
      return out;
    }

    if (s.key === 'continue-treatment' || s.key === 'lapsed') {
      // The "no visit" due date fell within the last 14 days: turning a scenario on does not send to the whole history
      const days = Math.max(7, Math.min(1095, Number(params.days) || (s.key === 'lapsed' ? 180 : 30)));
      const dueTo = new Date(now.getTime() - days * DAY);
      const dueFrom = new Date(dueTo.getTime() - 14 * DAY);
      let onlyIds: string[] | undefined;
      if (s.key === 'continue-treatment') {
        // treatment started (there are completed items) and incomplete ones remain
        const open = await this.prisma.planItem.findMany({ where: { clinicId, status: { in: ['NEW', 'PLANNED_TO_DO'] } }, select: { patientId: true }, distinct: ['patientId'] });
        const started = await this.prisma.planItem.findMany({ where: { clinicId, status: { in: ['DONE', 'INVOICED'] }, patientId: { in: open.map((o) => o.patientId) } }, select: { patientId: true }, distinct: ['patientId'] });
        onlyIds = started.map((x) => x.patientId);
        if (!onlyIds.length) return [];
      }
      const patients = await this.prisma.patient.findMany({
        where: {
          clinicId,
          removedAt: null,
          ...(onlyIds ? { id: { in: onlyIds } } : {}),
          lastVisitAt: { not: null, gte: dueFrom, lte: dueTo },
          visits: { none: { status: { notIn: CLOSED_BAD }, startsAt: { gt: now } } },
          reminders: { none: { status: 'NEW', dueDate: { gte: new Date(clinicDate(now) + 'T00:00:00Z') } } },
        },
        select: { id: true, lastVisitAt: true },
      });
      return patients.map((p) => ({ patientId: p.id, dedupeKey: `${s.key}:${p.id}:${clinicDate(p.lastVisitAt!).slice(0, 7)}`, vars: {}, scheduledFor: now }));
    }

    if (s.key === 'birthday') {
      // Today's birthday in the clinic's time; the message is valid until the end of the day
      const [, mm, dd] = clinicDate(now).split('-');
      const rows = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, birthDate: { not: null } }, select: { id: true, birthDate: true } });
      const year = clinicDate(now).slice(0, 4);
      return rows
        .filter((p) => p.birthDate!.toISOString().slice(5, 10) === `${mm}-${dd}`)
        .map((p) => ({ patientId: p.id, dedupeKey: `birthday:${p.id}:${year}`, vars: {}, scheduledFor: now, expiresAt: new Date(now.getTime() + 20 * HOUR) }));
    }
    return [];
  }

  // Patients who already have a marketing message (scenario or campaign) created in the last days: so as not to write too often
  async recentlyContacted(clinicId: string, patientIds: string[], now: Date): Promise<Set<string>> {
    if (!patientIds.length) return new Set();
    const marketingKeys = SCENARIOS.filter((x) => x.kind === 'marketing' && x.key !== 'birthday').map((x) => x.key);
    const rows = await this.prisma.outboundMessage.findMany({
      where: {
        clinicId,
        patientId: { in: patientIds },
        status: { notIn: ['CANCELLED', 'EXPIRED'] },
        createdAt: { gte: new Date(now.getTime() - MARKETING_GAP_DAYS * DAY) },
        OR: [{ ruleKey: { in: marketingKeys } }, { ruleKey: { startsWith: 'campaign:' } }, { ruleKey: { startsWith: 'auto-m:' } }],
      },
      select: { patientId: true },
    });
    return new Set(rows.map((r) => r.patientId));
  }

  // Builds the queue. dryRun only counts and shows examples, writing nothing.
  async plan(clinicId: string, opts: { dryRun: boolean; includeDisabled?: boolean; now?: Date }): Promise<RuleReport[]> {
    const now = opts.now ?? new Date();
    if ((await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { suspendedAt: true } })).suspendedAt) return [];
    const [clinic, rules] = await Promise.all([
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, autoSendService: true, assumeConsent: true } }),
      this.rules(clinicId),
    ]);
    const report: RuleReport[] = [];
    for (const r of rules) {
      if (!r.enabled && !opts.includeDisabled) continue;
      const sc = scenario(r.key)!;
      const cands = await this.candidates(clinicId, sc, r.params, now);
      const row: RuleReport = { key: r.key, enabled: r.enabled, candidates: cands.length, alreadyQueued: 0, toQueue: 0, noChannel: 0, blockedConsent: 0, paused: 0, tooSoon: 0, sample: [] };
      if (cands.length) {
        const patients = new Map(
          (
            await this.prisma.patient.findMany({
              where: { clinicId, id: { in: [...new Set(cands.map((c) => c.patientId))] } },
              select: { id: true, fullName: true, consent: true, automationPaused: true, channels: { where: { channel: 'TELEGRAM', optedOutAt: null }, select: { id: true } } },
            })
          ).map((p) => [p.id, p]),
        );
        const existing = new Set(
          (await this.prisma.outboundMessage.findMany({ where: { clinicId, dedupeKey: { in: cands.map((c) => c.dedupeKey) } }, select: { dedupeKey: true } })).map((m) => m.dedupeKey),
        );
        const tooSoonSet = (sc.kind as Kind) === 'marketing' && r.key !== 'birthday' ? await this.recentlyContacted(clinicId, [...new Set(cands.map((c) => c.patientId))], now) : new Set<string>();
        const create: { clinicId: string; patientId: string; ruleKey: string; channel: string; text: string; status: string; scheduledFor: Date; expiresAt?: Date; dedupeKey: string; visitId?: string }[] = [];
        for (const c of cands) {
          if (existing.has(c.dedupeKey)) {
            row.alreadyQueued++;
            continue;
          }
          const p = patients.get(c.patientId);
          if (!p) continue;
          if (p.automationPaused || p.consent === 'WITHDRAWN') {
            row.paused++;
            continue;
          }
          if ((sc.kind as Kind) === 'marketing' && !marketingAllowed(p.consent, clinic.assumeConsent)) {
            row.blockedConsent++;
            continue;
          }
          if (tooSoonSet.has(c.patientId)) {
            row.tooSoon++;
            continue;
          }
          // Only Telegram is connected now; SMS will be added as a fallback channel
          if (!p.channels.length) {
            row.noChannel++;
            continue;
          }
          const text = render(r.text, { fullName: p.fullName, clinic: clinic.name, ...c.vars });
          row.toQueue++;
          if (row.sample.length < 5) row.sample.push({ patient: p.fullName, channel: 'TELEGRAM', text });
          create.push({
            clinicId,
            patientId: c.patientId,
            ruleKey: r.key,
            channel: 'TELEGRAM',
            text,
            // Service messages go out at once if the clinic allowed it; the others wait for the staff's confirmation
            status: sc.kind === 'service' && clinic.autoSendService ? 'APPROVED' : 'PENDING_APPROVAL',
            scheduledFor: c.scheduledFor,
            expiresAt: c.expiresAt,
            dedupeKey: c.dedupeKey,
            visitId: c.visitId,
          });
        }
        if (!opts.dryRun && create.length) await this.prisma.outboundMessage.createMany({ data: create, skipDuplicates: true });
      }
      report.push(row);
    }
    return report;
  }
}
