import { autoBookingTestStatus } from '../booking/auto-booking-gate';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature, periodStart } from '../service/plans';
import { Contacts, NO_CONTACTS, maskText } from './contact-mask';
import { LlmClient, LlmError, LlmResult } from './llm.client';

// The AI may book on its own only where writing to the clinic's system is switched on at all: the service-wide switch
// CLINICCARDS_WRITE_ENABLED (off for real clinics until the manual verification stage) and, per clinic, bookingWriteEnabled (checked at booking time).
export const bookingWriteSupported = () => process.env.CLINICCARDS_WRITE_ENABLED === 'true';

@Injectable()
export class AiService {
  constructor(
    private prisma: PrismaService,
    private llm: LlmClient,
  ) {}

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, aiAgentMode: true, aiMonthlyLimit: true, aiAutoBooking: true, aiAutoReply: true, aiRepliesPerChatDay: true, aiPauseMinutes: true, sendingEnabled: true, aiAssistantEnabled: true, aiPurchased: true, periodStartsAt: true } });
    // Only billable replies count; retries of one request are free
    const since = { clinicId, ok: true, billable: true, createdAt: { gte: periodStart(c) } };
    const [used, tokens] = await Promise.all([this.prisma.aiUsage.count({ where: since }), this.prisma.aiUsage.aggregate({ where: since, _sum: { inputTokens: true, outputTokens: true } })]);
    return {
      available: this.llm.configured,
      enabled: c.aiEnabled,
      monthlyLimit: c.aiMonthlyLimit,
      autoBooking: c.aiAutoBooking,
      autoReply: c.aiAutoReply,
      // the agent's drafts-only rule: with aiAgentMode on the automatic reply above is held back (it does not answer by itself)
      agentMode: c.aiAgentMode,
      autoReplyHeldByAgent: c.aiAgentMode && c.aiAutoReply,
      repliesPerChatDay: c.aiRepliesPerChatDay,
      pauseMinutes: c.aiPauseMinutes,
      assistant: c.aiAssistantEnabled,
      sendingEnabled: c.sendingEnabled,
      autoBookingSupported: bookingWriteSupported(),
      // The temporary server restriction of automatic booking to chosen dialogs (AUTOBOOKING_TEST_ONLY / AUTOBOOKING_TEST_DIALOGS)
      autoBookingTest: autoBookingTestStatus(),
      used,
      purchased: c.aiPurchased,
      tokens: (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
    };
  }

  async update(clinicId: string, patch: { enabled?: boolean; monthlyLimit?: number; autoBooking?: boolean; autoReply?: boolean; assistant?: boolean; repliesPerChatDay?: number; pauseMinutes?: number }) {
    if (patch.enabled && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.assistant && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.autoReply && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.autoReply) {
      const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, plan: true } });
      if (!hasFeature(cur.plan, 'ai_autoreply')) throw new BadRequestException('plan_feature');
      if (!(patch.enabled ?? cur.aiEnabled)) throw new BadRequestException('ai_disabled');
    }
    if (patch.autoBooking && !bookingWriteSupported()) throw new BadRequestException('booking_write_unsupported');
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { ...(patch.assistant !== undefined ? { aiAssistantEnabled: patch.assistant } : {}), ...(patch.enabled === false ? { aiAutoReply: false } : patch.autoReply !== undefined ? { aiAutoReply: patch.autoReply } : {}), ...(patch.autoBooking !== undefined ? { aiAutoBooking: patch.autoBooking } : {}), ...(patch.repliesPerChatDay !== undefined ? { aiRepliesPerChatDay: patch.repliesPerChatDay } : {}), ...(patch.pauseMinutes !== undefined ? { aiPauseMinutes: patch.pauseMinutes } : {}), ...(patch.enabled !== undefined ? { aiEnabled: patch.enabled } : {}), ...(patch.monthlyLimit !== undefined ? { aiMonthlyLimit: patch.monthlyLimit } : {}) },
    });
    return this.status(clinicId);
  }

  // The only place that calls the AI. Checks that the AI is on and the monthly limit is not used up, records the usage (without the text).
  async complete(clinicId: string, kind: string, system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens?: number, scope: 'chat' | 'assistant' = 'chat', billable = true, opts: { schema?: Record<string, unknown>; contacts?: Contacts } = {}): Promise<LlmResult> {
    const st = await this.status(clinicId);
    // chat: replies to patients and drafts; assistant: the manager's assistant (each has its own switch)
    if (!st.available || !(scope === 'assistant' ? st.assistant : st.enabled)) throw new BadRequestException('ai_disabled');
    // Included replies first, then bought ones; with neither left the caller hands the conversation to a person
    // Demo copies share a daily budget so that the public demo cannot run up the AI bill
    if ((await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { isDemo: true } }))?.isDemo) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if ((await this.prisma.aiUsage.count({ where: { createdAt: { gte: today }, clinic: { isDemo: true } } })) >= Number(process.env.DEMO_AI_DAILY_CAP ?? 200)) throw new BadRequestException('ai_limit');
    }
    const overIncluded = st.used >= st.monthlyLimit;
    if (billable && overIncluded && st.purchased <= 0) throw new BadRequestException('ai_limit');
    try {
      // A COPY is cleaned before it leaves (the chat itself is not changed): every recognisable phone in the messages, the known names in the messages, and the known phones also in the system text (names are NOT masked there: a stem of a patient's name can be a common word of the clinic's own facts, for example a doctor's title); see contact-mask.ts. The retry after a
      // refused answer goes through here too, so its text is cleaned the same way.
      const contacts = opts.contacts ?? NO_CONTACTS;
      const r = await this.llm.complete(maskText(system, { names: [], phones: contacts.phones }, false), messages.map((m) => ({ ...m, content: maskText(m.content, contacts) })), maxTokens, opts.schema ? { schema: opts.schema } : {});
      await this.prisma.aiUsage.create({ data: { clinicId, kind, ok: true, billable, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
      if (billable && overIncluded) await this.prisma.clinic.updateMany({ where: { id: clinicId, aiPurchased: { gt: 0 } }, data: { aiPurchased: { decrement: 1 } } });
      return r;
    } catch (e) {
      await this.prisma.aiUsage.create({ data: { clinicId, kind, ok: false } });
      if (e instanceof LlmError) throw new BadRequestException('ai_failed');
      throw e;
    }
  }
}
