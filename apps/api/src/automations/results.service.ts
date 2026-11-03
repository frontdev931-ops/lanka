import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
}
