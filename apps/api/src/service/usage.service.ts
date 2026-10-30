import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Limits, PLANS, effectiveLimits, periodStart } from './plans';

export interface Usage {
  users: number;
  pendingInvitations: number;
  patients: number;
  messagesThisMonth: number;
  aiRepliesThisMonth: number;
  aiTokensThisMonth: number;
}

@Injectable()
export class UsageService {
  constructor(private prisma: PrismaService) {}

  async clinicUsage(clinicId: string, now = new Date()): Promise<Usage> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { periodStartsAt: true } });
    const since = periodStart(c, now);
    const [users, pending, patients, messages, ai] = await Promise.all([
      this.prisma.membership.count({ where: { clinicId } }),
      this.prisma.invitation.count({ where: { clinicId, acceptedAt: null, expiresAt: { gt: now } } }),
      this.prisma.patient.count({ where: { clinicId, removedAt: null } }),
      this.prisma.outboundMessage.count({ where: { clinicId, status: 'SENT', sentAt: { gte: since } } }),
      this.prisma.aiUsage.aggregate({ where: { clinicId, ok: true, billable: true, createdAt: { gte: since } }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
    ]);
    return { users, pendingInvitations: pending, patients, messagesThisMonth: messages, aiRepliesThisMonth: ai._count, aiTokensThisMonth: (ai._sum.inputTokens ?? 0) + (ai._sum.outputTokens ?? 0) };
  }

  // Messages sent to people this period, per channel (Telegram counts the planned reminders too). The cost of a channel itself
  // (WhatsApp conversation fees, a Viber partner) is billed by its provider to the clinic and is not part of the subscription.
  async channelCounts(clinicId: string, now = new Date()): Promise<Record<string, number>> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { periodStartsAt: true } });
    const rows = await this.prisma.chatMessage.groupBy({ by: ['channel'], where: { clinicId, direction: 'OUT', error: null, createdAt: { gte: periodStart(c, now) } }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.channel, r._count]));
  }

  async overview(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, limitOverrides: true, require2fa: true, suspendedAt: true, aiPurchased: true, billingStatus: true, paidUntil: true } });
    return { channels: await this.channelCounts(clinicId), plan: c.plan, billingStatus: c.billingStatus, paidUntil: c.paidUntil, aiPurchased: c.aiPurchased, features: PLANS[c.plan]?.features ?? [], limits: effectiveLimits(c.plan, c.limitOverrides), usage: await this.clinicUsage(clinicId), require2fa: c.require2fa, suspended: !!c.suspendedAt };
  }

  async limitsOf(clinicId: string): Promise<Limits> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, limitOverrides: true } });
    return effectiveLimits(c.plan, c.limitOverrides);
  }
}
