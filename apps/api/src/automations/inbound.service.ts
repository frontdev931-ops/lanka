import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type InboundHandler = (clinicId: string, payload: unknown) => Promise<void>;

const MAX_ATTEMPTS = 6;
// Waits before attempt 2, 3, ...; the first attempt runs at once
const BACKOFF_MIN = [1, 5, 15, 60, 180];
// An event that is still PENDING after this long is taken over by the scheduler (the server may have stopped mid-run)
const CLAIM_MS = 2 * 60_000;
const KEEP_DONE_DAYS = 7;
const KEEP_FAILED_DAYS = 30;

// Durable inbox for events from messengers. An event is saved before anything is done with it, then handled;
// if handling fails it is retried with growing pauses and, after the last attempt, kept as FAILED for staff to retry.
@Injectable()
export class InboundService {
  private readonly log = new Logger(InboundService.name);
  private handlers = new Map<string, InboundHandler>();

  constructor(private prisma: PrismaService) {}

  register(channel: string, handler: InboundHandler) {
    this.handlers.set(channel, handler);
  }

  // Never throws: the webhook must answer quickly and the event is already safe in the database
  async receive(clinicId: string, channel: string, externalId: string | null, payload: unknown): Promise<void> {
    let id: string;
    try {
      id = (await this.prisma.inboundEvent.create({ data: { clinicId, channel, externalId, payload: payload as Prisma.InputJsonValue, nextAttemptAt: new Date(Date.now() + CLAIM_MS) }, select: { id: true } })).id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // the same delivery again
      this.log.error(`Inbound event not saved: ${(e as Error).message}`);
      return;
    }
    await this.run(id);
  }

  private async run(id: string): Promise<void> {
    const ev = await this.prisma.inboundEvent.findUnique({ where: { id } });
    if (!ev || ev.status !== 'PENDING') return;
    try {
      const handler = this.handlers.get(ev.channel);
      if (!handler) throw new Error(`no handler for ${ev.channel}`);
      await handler(ev.clinicId, ev.payload);
      await this.prisma.inboundEvent.update({ where: { id }, data: { status: 'DONE', processedAt: new Date(), attempts: ev.attempts + 1, lastError: null } });
    } catch (e) {
      const attempts = ev.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      this.log.warn(`Inbound ${ev.channel} attempt ${attempts} failed: ${(e as Error).message}`);
      await this.prisma.inboundEvent.update({
        where: { id },
        data: { attempts, lastError: (e as Error).message.slice(0, 300), status: failed ? 'FAILED' : 'PENDING', nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000) },
      });
    }
  }

  // Called by the scheduler: picks up events whose pause is over. The update claims an event so that two servers do not both run it.
  async retryDue(limit = 20): Promise<number> {
    const due = await this.prisma.inboundEvent.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: 'asc' }, take: limit, select: { id: true } });
    let n = 0;
    for (const { id } of due) {
      const claimed = await this.prisma.inboundEvent.updateMany({ where: { id, status: 'PENDING', nextAttemptAt: { lte: new Date() } }, data: { nextAttemptAt: new Date(Date.now() + CLAIM_MS) } });
      if (!claimed.count) continue;
      await this.run(id);
      n++;
    }
    return n;
  }

  // Events keep message texts, so they are not stored for long
  async purge() {
    const day = 86_400_000;
    await this.prisma.inboundEvent.deleteMany({ where: { status: 'DONE', createdAt: { lt: new Date(Date.now() - KEEP_DONE_DAYS * day) } } });
    await this.prisma.inboundEvent.deleteMany({ where: { status: 'FAILED', createdAt: { lt: new Date(Date.now() - KEEP_FAILED_DAYS * day) } } });
  }

  // For the clinic's integration control page: counts and problems, never the payload (it holds patient text)
  async overview(clinicId: string) {
    const [groups, problems] = await Promise.all([
      this.prisma.inboundEvent.groupBy({ by: ['status'], where: { clinicId, createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } }, _count: true }),
      this.prisma.inboundEvent.findMany({ where: { clinicId, OR: [{ status: 'FAILED' }, { status: 'PENDING', attempts: { gt: 0 } }] }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, channel: true, status: true, attempts: true, lastError: true, createdAt: true } }),
    ]);
    return { counts: Object.fromEntries(groups.map((g) => [g.status, g._count])), problems };
  }

  // Staff retries a failed event
  async retry(clinicId: string, id: string): Promise<boolean> {
    const r = await this.prisma.inboundEvent.updateMany({ where: { id, clinicId, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, lastError: null, nextAttemptAt: new Date() } });
    if (!r.count) return false;
    await this.run(id);
    return true;
  }
}
