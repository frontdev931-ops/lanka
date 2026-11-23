import { autoBookingTestStatus } from '../booking/auto-booking-gate';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature, periodStart } from '../service/plans';
import { Contacts, NO_CONTACTS, maskText } from './contact-mask';
import { LlmClient, LlmError, LlmResult } from './llm.client';

// The AI may book on its own only where writing to the clinic's system is switched on at all: the service-wide switch
// CLINICCARDS_WRITE_ENABLED (off for real clinics until the manual verification stage) and, per clinic, bookingWriteEnabled (checked at booking time).
export const bookingWriteSupported = () => process.env.CLINICCARDS_WRITE_ENABLED === 'true';

// A failed (or impossible: no staff chat yet) Telegram alert is tried again not sooner than this, and only while the allowance stays used up
export const LIMIT_ALERT_RETRY_MS = 15 * 60_000;
// Sends a text to the clinic's staff destination and tells what happened (see StaffNotifyOutcome in StaffNotifierService, which registers it):
// sent = confirmed, none = no destination, rejected = certainly not delivered, unknown = no answer came back, it may or may not have been delivered.
export type StaffNotify = (clinicId: string, text: string) => Promise<'sent' | 'none' | 'rejected' | 'unknown'>;

@Injectable()
export class AiService {
  private readonly log = new Logger(AiService.name);
  private staffNotify?: StaffNotify;

  constructor(
    private prisma: PrismaService,
    private llm: LlmClient,
  ) {}

  // The messaging module gives the way to reach the staff (this module must not depend on it)
  setStaffNotifier(fn: StaffNotify) {
    this.staffNotify = fn;
  }

  // The shared monthly allowance is used up: ONE alert to the staff per exhaustion episode, however many requests and chats are refused meanwhile.
  // The in-app notice needs no record (it is the live state, see limitReached in status); the two columns exist only for the Telegram message:
  // the attempt is claimed atomically (concurrent requests: one winner), and the episode is marked delivered only after a real delivery.
  // A refused delivery, or a staff chat that is not linked yet, is tried again by a later refused request, at most once in LIMIT_ALERT_RETRY_MS.
  // An UNKNOWN outcome (a timeout, a network failure: Telegram may have taken the message) is recorded as such, is not counted as delivered and is
  // NOT tried again in this episode, because a repeat could be a duplicate. So the Telegram alert of that episode may never have arrived; the in-app notice is there anyway.
  // Never goes to a patient: the only destination is the clinic's staff chat. The link leads to where the limit is managed: Payment, or General in a demo clinic.
  private async limitAlert(clinicId: string, period: Date, demo: boolean) {
    try {
      if (!this.staffNotify) return;
      const now = new Date();
      const claimed = await this.prisma.clinic.updateMany({
        where: { id: clinicId, AND: [{ OR: [{ aiLimitAlertAt: null }, { aiLimitAlertAt: { lt: period } }] }, { OR: [{ aiLimitAlertUnknownAt: null }, { aiLimitAlertUnknownAt: { lt: period } }] }, { OR: [{ aiLimitAlertTryAt: null }, { aiLimitAlertTryAt: { lt: new Date(now.getTime() - LIMIT_ALERT_RETRY_MS) } }] }] },
        data: { aiLimitAlertTryAt: now, aiLimitAlertAt: null, aiLimitAlertUnknownAt: null },
      });
      if (!claimed.count) return;
      const text = `Місячний ліміт ШІ вичерпано. Призупинено: автоматичні відповіді пацієнтам, чернетки відповідей і ШІ-помічник керівника. Звернення пацієнтів обробляє адміністратор.\n\nЛіміт і поповнення: ${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/settings${demo ? '' : '?tab=billing'}`;
      // the mark is kept only if this very attempt is still the current one: a budget restored meanwhile has cleared it and must stay cleared
      const outcome = await this.staffNotify(clinicId, text);
      if (outcome === 'sent') await this.prisma.clinic.updateMany({ where: { id: clinicId, aiLimitAlertTryAt: now }, data: { aiLimitAlertAt: now } });
      else if (outcome === 'unknown') await this.prisma.clinic.updateMany({ where: { id: clinicId, aiLimitAlertTryAt: now }, data: { aiLimitAlertUnknownAt: now } });
    } catch (e) {
      this.log.warn(`AI limit alert: ${(e as Error).message} (clinic ${clinicId})`);
    }
  }

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, aiEnabled: true, aiAgentMode: true, aiAgentAuto: true, aiMonthlyLimit: true, aiAutoBooking: true, aiAutoReply: true, aiRepliesPerChatDay: true, aiPauseMinutes: true, sendingEnabled: true, aiAssistantEnabled: true, aiPurchased: true, periodStartsAt: true } });
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
      // the agent's limited autonomous mode (the service owner's switch); it works only in the dialogs of the server list, which is never shown here
      agentAuto: c.aiAgentMode && c.aiAgentAuto,
      repliesPerChatDay: c.aiRepliesPerChatDay,
      pauseMinutes: c.aiPauseMinutes,
      // the manager's assistant works only where the plan includes it (Pro); the clinic's own switch stays as it was saved
      assistant: c.aiAssistantEnabled,
      assistantInPlan: hasFeature(c.plan, 'ai_assistant'),
      sendingEnabled: c.sendingEnabled,
      autoBookingSupported: bookingWriteSupported(),
      // the AI's own booking and rescheduling in Cliniccards is a Pro feature
      autoBookingInPlan: hasFeature(c.plan, 'auto_booking'),
      // The temporary server restriction of automatic booking to chosen dialogs (AUTOBOOKING_TEST_ONLY / AUTOBOOKING_TEST_DIALOGS)
      autoBookingTest: autoBookingTestStatus(),
      used,
      // nothing is left of the shared allowance (included and bought): every billable AI feature of the clinic is paused
      limitReached: used >= c.aiMonthlyLimit && c.aiPurchased <= 0,
      purchased: c.aiPurchased,
      tokens: (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
    };
  }

  async update(clinicId: string, patch: { enabled?: boolean; monthlyLimit?: number; autoBooking?: boolean; autoReply?: boolean; assistant?: boolean; repliesPerChatDay?: number; pauseMinutes?: number }) {
    if (patch.enabled && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.assistant && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.assistant && !hasFeature((await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan, 'ai_assistant')) throw new BadRequestException('plan_feature');
    if (patch.autoReply && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.autoReply) {
      const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, plan: true } });
      if (!hasFeature(cur.plan, 'ai_autoreply')) throw new BadRequestException('plan_feature');
      if (!(patch.enabled ?? cur.aiEnabled)) throw new BadRequestException('ai_disabled');
    }
    if (patch.autoBooking && !bookingWriteSupported()) throw new BadRequestException('booking_write_unsupported');
    if (patch.autoBooking && !hasFeature((await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan, 'auto_booking')) throw new BadRequestException('plan_feature');
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
    // the manager's assistant is a Pro feature: checked here, the only place that calls the model, so no route can go round it
    if (scope === 'assistant' && !st.assistantInPlan) throw new BadRequestException('plan_feature');
    if (!st.available || !(scope === 'assistant' ? st.assistant : st.enabled)) throw new BadRequestException('ai_disabled');
    // Included replies first, then bought ones; with neither left the caller hands the conversation to a person
    // Demo copies share a daily budget so that the public demo cannot run up the AI bill
    const row = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { isDemo: true, periodStartsAt: true, aiLimitAlertAt: true, aiLimitAlertTryAt: true, aiLimitAlertUnknownAt: true } });
    if (row?.isDemo) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if ((await this.prisma.aiUsage.count({ where: { createdAt: { gte: today }, clinic: { isDemo: true } } })) >= Number(process.env.DEMO_AI_DAILY_CAP ?? 200)) throw new BadRequestException('ai_limit');
    }
    const overIncluded = st.used >= st.monthlyLimit;
    const period = periodStart({ periodStartsAt: row?.periodStartsAt ?? null });
    if (billable && overIncluded && st.purchased <= 0) {
      await this.limitAlert(clinicId, period, !!row?.isDemo);
      throw new BadRequestException('ai_limit');
    }
    // The budget is back (a new period, a raised limit, a bought pack): the episode is over, a later exhaustion alerts again
    if (!st.limitReached && (row?.aiLimitAlertAt || row?.aiLimitAlertTryAt || row?.aiLimitAlertUnknownAt)) await this.prisma.clinic.updateMany({ where: { id: clinicId }, data: { aiLimitAlertAt: null, aiLimitAlertTryAt: null, aiLimitAlertUnknownAt: null } });
    try {
      // A COPY is cleaned before it leaves (the chat itself is not changed): every recognisable phone in the messages, the known names in the messages, and the known phones also in the system text (names are NOT masked there: a stem of a patient's name can be a common word of the clinic's own facts, for example a doctor's title); see contact-mask.ts. The retry after a
      // refused answer goes through here too, so its text is cleaned the same way.
      const contacts = opts.contacts ?? NO_CONTACTS;
      const r = await this.llm.complete(maskText(system, { names: [], phones: contacts.phones }, false), messages.map((m) => ({ ...m, content: maskText(m.content, contacts) })), maxTokens, opts.schema ? { schema: opts.schema } : {});
      await this.prisma.aiUsage.create({ data: { clinicId, kind, ok: true, billable, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
      if (billable && overIncluded) await this.prisma.clinic.updateMany({ where: { id: clinicId, aiPurchased: { gt: 0 } }, data: { aiPurchased: { decrement: 1 } } });
      // This reply used the last of the allowance: the staff learn it now, not from the first refused request
      if (billable && (overIncluded ? st.purchased <= 1 : st.used + 1 >= st.monthlyLimit && st.purchased <= 0)) await this.limitAlert(clinicId, period, !!row?.isDemo);
      return r;
    } catch (e) {
      await this.prisma.aiUsage.create({ data: { clinicId, kind, ok: false } });
      if (e instanceof LlmError) throw new BadRequestException('ai_failed');
      throw e;
    }
  }
}
