import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PLANS } from '../service/plans';
import { Period } from '../reports/period';

const DAY = 86_400_000;
const ATTRIBUTION_DAYS = 14;
const REPLY_DAYS = 7;
const BAD = ['CANCELLED', 'MOVED'];

export interface ResultRow {
  key: string;
  label: string | null; // campaign name for campaign:*
  channel: string;
  sent: number;
  replied: number; // the patient wrote to the bot within 7 days
  booked: number; // a new appointment appeared within 14 days after the message
  attended: number; // and the patient came
  matured: number; // messages older than 14 days: only they count for conversion
  bookedMatured: number;
  // only for visit reminders: how the appointment ended
  attendedVisit?: number;
  noShowVisit?: number;
  cancelledVisit?: number;
}

// Measuring the result of messages: what happened to the patient after they were written to. This is a coincidence in time, not proof of a cause:
// an appointment could have appeared without the message. That is why the window is short (14 days) and the interface carries a caveat.
@Injectable()
export class ResultsService {
  constructor(private prisma: PrismaService) {}

  async results(clinicId: string, months: number, now = new Date()) {
    const since = new Date(now.getTime() - months * 30 * DAY);
    const msgs = await this.prisma.outboundMessage.findMany({
      where: { clinicId, status: 'SENT', sentAt: { gte: since } },
      select: { ruleKey: true, channel: true, patientId: true, visitId: true, sentAt: true },
    });
    const patientIds = [...new Set(msgs.map((m) => m.patientId))];
    const [visits, replies, requests, campaigns] = await Promise.all([
      this.prisma.visit.findMany({ where: { clinicId, patientId: { in: patientIds }, bookedAt: { gte: since } }, select: { id: true, patientId: true, bookedAt: true, status: true } }),
      this.prisma.chatMessage.findMany({ where: { clinicId, direction: 'IN', patientId: { in: patientIds }, createdAt: { gte: since } }, select: { patientId: true, createdAt: true } }),
      this.prisma.bookingRequest.groupBy({ by: ['kind', 'status'], where: { clinicId, createdAt: { gte: since } }, _count: true }),
      this.prisma.campaign.findMany({ where: { clinicId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(campaigns.map((c) => [`campaign:${c.id}`, c.name]));
    const visitById = new Map((await this.prisma.visit.findMany({ where: { id: { in: msgs.map((m) => m.visitId).filter((x): x is string => !!x) } }, select: { id: true, status: true } })).map((v) => [v.id, v.status]));
    const visitsBy = new Map<string, typeof visits>();
    for (const v of visits) visitsBy.set(v.patientId, [...(visitsBy.get(v.patientId) ?? []), v]);
    const repliesBy = new Map<string, Date[]>();
    for (const r of replies) repliesBy.set(r.patientId as string, [...(repliesBy.get(r.patientId as string) ?? []), r.createdAt]);

    const rows = new Map<string, ResultRow>();
    for (const m of msgs) {
      const gk = `${m.ruleKey}|${m.channel}`;
      const row = rows.get(gk) ?? { key: m.ruleKey, label: names.get(m.ruleKey) ?? null, channel: m.channel, sent: 0, replied: 0, booked: 0, attended: 0, matured: 0, bookedMatured: 0 };
      const at = m.sentAt!.getTime();
      row.sent++;
      const mature = at <= now.getTime() - ATTRIBUTION_DAYS * DAY;
      if (mature) row.matured++;
      if ((repliesBy.get(m.patientId) ?? []).some((d) => d.getTime() >= at && d.getTime() <= at + REPLY_DAYS * DAY)) row.replied++;
      if (m.ruleKey === 'visit-reminder') {
        // visit reminder: we count the outcome of the appointment itself
        const st = m.visitId ? visitById.get(m.visitId) : undefined;
        row.attendedVisit = (row.attendedVisit ?? 0) + (st === 'VISITED' ? 1 : 0);
        row.noShowVisit = (row.noShowVisit ?? 0) + (st === 'DID_NOT_COME' ? 1 : 0);
        row.cancelledVisit = (row.cancelledVisit ?? 0) + (st && BAD.includes(st) ? 1 : 0);
      } else {
        const hit = (visitsBy.get(m.patientId) ?? []).find((v) => v.bookedAt && v.bookedAt.getTime() >= at && v.bookedAt.getTime() <= at + ATTRIBUTION_DAYS * DAY && !BAD.includes(v.status));
        if (hit) {
          row.booked++;
          if (mature) row.bookedMatured++;
          if (hit.status === 'VISITED') row.attended++;
        }
      }
      rows.set(gk, row);
    }
    const requestStats = { total: 0, done: 0, dismissed: 0, open: 0 };
    for (const r of requests) {
      requestStats.total += r._count;
      if (r.status === 'DONE') requestStats.done += r._count;
      else if (r.status === 'DISMISSED') requestStats.dismissed += r._count;
      else requestStats.open += r._count;
    }
    return { months, attributionDays: ATTRIBUTION_DAYS, rows: [...rows.values()].sort((a, b) => b.sent - a.sent), requests: requestStats };
  }

  // The payback screen: what the clinic got in the last `days` days next to what the subscription costs. All of it is counted by code from our copy of the
  // data, with the same rule as the results above (a new appointment within 14 days after a message that is not a visit reminder). It is a coincidence
  // in time, not proof of a cause, and the screen says so. Money: the payments of the patients who booked after a message, made after that message
  // (Payment rows as they come from the clinic's system, in the clinic's currency). Only the owner and the manager see it (the controller).
  // period: a chosen range of days instead of the last `days` days. The messages, requests and AI replies are those of the period; what followed a
  // message (a booking within 14 days, payments) is counted also after the period ends.
  async payback(clinicId: string, days: number, now = new Date(), period?: Period | null) {
    const since = period ? period.since : new Date(now.getTime() - days * DAY);
    const end = period ? period.end : new Date(now.getTime() + 1);
    const inPeriod = { gte: since, lt: end };
    const [clinic, msgs, requests, aiReplies] = await Promise.all([
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } }),
      this.prisma.outboundMessage.findMany({ where: { clinicId, status: 'SENT', sentAt: inPeriod }, select: { ruleKey: true, patientId: true, visitId: true, sentAt: true } }),
      this.prisma.bookingRequest.count({ where: { clinicId, kind: 'BOOKING', status: 'DONE', createdAt: inPeriod } }),
      // replies and drafts for patients; the manager's assistant (owner_report) is not a patient reply
      this.prisma.aiUsage.count({ where: { clinicId, ok: true, billable: true, kind: { not: 'owner_report' }, createdAt: inPeriod } }),
    ]);
    const patientIds = [...new Set(msgs.map((m) => m.patientId))];
    const reminderVisitIds = msgs.filter((m) => m.ruleKey === 'visit-reminder' && m.visitId).map((m) => m.visitId as string);
    const [visits, reminded] = await Promise.all([
      this.prisma.visit.findMany({ where: { clinicId, patientId: { in: patientIds }, bookedAt: { gte: since } }, select: { id: true, patientId: true, bookedAt: true, status: true } }),
      this.prisma.visit.count({ where: { clinicId, id: { in: reminderVisitIds }, status: 'VISITED' } }),
    ]);
    // every appointment is counted once, for the earliest message it follows; the patient's payments count from that message on
    const booked = new Set<string>();
    const attended = new Set<string>();
    const paidFrom = new Map<string, Date>();
    for (const m of msgs) {
      if (m.ruleKey === 'visit-reminder') continue;
      const at = m.sentAt!.getTime();
      for (const v of visits) {
        if (v.patientId !== m.patientId || !v.bookedAt || BAD.includes(v.status)) continue;
        const t = v.bookedAt.getTime();
        if (t < at || t > at + ATTRIBUTION_DAYS * DAY) continue;
        booked.add(v.id);
        if (v.status === 'VISITED') attended.add(v.id);
        const cur = paidFrom.get(m.patientId);
        if (!cur || cur.getTime() > at) paidFrom.set(m.patientId, m.sentAt!);
      }
    }
    let paid = 0;
    if (paidFrom.size) {
      const payments = await this.prisma.payment.findMany({ where: { clinicId, patientId: { in: [...paidFrom.keys()] }, paidAt: { gte: since } }, select: { patientId: true, paidAt: true, amount: true } });
      for (const p of payments) if (p.patientId && p.paidAt.getTime() >= paidFrom.get(p.patientId)!.getTime()) paid += Number(p.amount);
    }
    return {
      days: period ? period.days : days,
      from: period?.from ?? null,
      to: period?.to ?? null,
      attributionDays: ATTRIBUTION_DAYS,
      sent: msgs.length,
      booked: booked.size,
      attended: attended.size,
      remindedVisits: reminded,
      bookingRequestsDone: requests,
      aiReplies,
      paid: Math.round(paid * 100) / 100,
      plan: clinic.plan,
      // what one month of the plan costs (0 for individual terms: no comparison is shown then)
      planPriceUah: PLANS[clinic.plan]?.priceUah ?? 0,
    };
  }
}
