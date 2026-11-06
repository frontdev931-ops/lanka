import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

// The funnel events of the AI administrator-agent foundation (see .claude/docs/agent-administrator.md, 3.9).
// One event = one REAL action that happened (a message was received, a message with times was sent, the client confirmed a concrete time, a visit
// was created or found in the clinic's system, a request went to a person). Not a draft, not an attempt that failed.
//
// What counts as one conversation: a PERMANENT CHAT (clinic + channel + chat), not an episode of booking. So INQUIRY is written once per chat and the
// count of INQUIRY events is "chats that wrote since the collection was switched on for the clinic", NOT the number of new enquiries.
//
// The collection is controlled by ONE clinic flag, funnelEventsEnabled (default off, set by the service owner). With it off nothing is written, not
// even the conversation row. aiAgentMode does not switch it on. An event holds no message text; every query filters by clinicId.
export type FunnelKind = 'INQUIRY' | 'TIME_OFFERED' | 'CLIENT_CONFIRMED' | 'BOOKED' | 'HANDED_OFF' | 'DECLINED';

export interface FunnelEventInput {
  channel: string;
  chatId: string;
  kind: FunnelKind;
  // What the action is keyed by (an outgoing message id, a request id plus the time, ...); the same action always gets the same key
  refKey: string;
  reason?: string;
  source?: 'AUTO' | 'ADMIN';
  // the chat is tied to a card
  linked?: boolean;
}

export type RecordResult = 'recorded' | 'duplicate' | 'off' | 'failed';

@Injectable()
export class FunnelEventsService {
  private readonly log = new Logger(FunnelEventsService.name);

  constructor(private prisma: PrismaService) {}

  // Never throws: an event must not break the work it describes. The answer says what happened (for tests and the log).
  async record(clinicId: string, d: FunnelEventInput): Promise<RecordResult> {
    try {
      const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { funnelEventsEnabled: true } });
      if (!clinic?.funnelEventsEnabled) return 'off';
      const where = { clinicId_channel_chatId: { clinicId, channel: d.channel, chatId: d.chatId } };
      let state = await this.prisma.conversationState.findUnique({ where, select: { id: true } });
      if (!state) {
        try {
          state = await this.prisma.conversationState.create({ data: { clinicId, channel: d.channel, chatId: d.chatId }, select: { id: true } });
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
          state = await this.prisma.conversationState.findUniqueOrThrow({ where, select: { id: true } });
        }
      }
      try {
        await this.prisma.funnelEvent.create({
          data: { clinicId, conversationId: state.id, kind: d.kind, refKey: d.refKey.slice(0, 120), reason: d.reason?.slice(0, 60) ?? null, source: d.source ?? null, leadStatus: d.linked ? 'EXISTING_LINKED' : 'UNKNOWN' },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'duplicate';
        throw e;
      }
      return 'recorded';
    } catch (e) {
      this.log.warn(`Funnel event ${d.kind} not written: ${(e as Error).message.slice(0, 120)} (clinic ${clinicId})`);
      return 'failed';
    }
  }

  // The key of a TIME_OFFERED event: the incoming message the offer answers plus the offered times. The same message answered with the same times
  // (a handler run again after a crash between the send and the save) is the same offer; another incoming message or other times are another one.
  async offerKey(clinicId: string, channel: string, chatId: string, options: { date?: string; time?: string }[]): Promise<string> {
    const trigger = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    const times = options.filter((o) => o.date && o.time).map((o) => `${o.date}T${o.time}`).sort().join(',');
    return `in:${trigger?.id ?? 'none'}:${createHash('sha1').update(times).digest('hex').slice(0, 10)}`;
  }

  // Counts by kind for one clinic (the only read in this stage; no screen uses it yet)
  async counts(clinicId: string, from?: Date, to?: Date): Promise<Record<string, number>> {
    const rows = await this.prisma.funnelEvent.groupBy({ by: ['kind'], where: { clinicId, ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.kind, r._count._all]));
  }
}
