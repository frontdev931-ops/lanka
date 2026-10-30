import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature, periodStart } from '../service/plans';
import { LlmClient, LlmError, LlmResult } from './llm.client';

// Запись в Cliniccards пока не подключена (мы там ничего не меняем), поэтому ИИ может только готовить заявку для администратора.
// Когда коннектор научится создавать записи, этот признак станет true и настройка заработает.
export const BOOKING_WRITE_SUPPORTED = false;

@Injectable()
export class AiService {
  constructor(
    private prisma: PrismaService,
    private llm: LlmClient,
  ) {}

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, aiMonthlyLimit: true, aiAutoBooking: true, aiAutoReply: true, sendingEnabled: true, aiAssistantEnabled: true, aiPurchased: true, periodStartsAt: true } });
    // Only billable replies count; retries of one request are free
    const since = { clinicId, ok: true, billable: true, createdAt: { gte: periodStart(c) } };
    const [used, tokens] = await Promise.all([this.prisma.aiUsage.count({ where: since }), this.prisma.aiUsage.aggregate({ where: since, _sum: { inputTokens: true, outputTokens: true } })]);
    return {
      available: this.llm.configured,
      enabled: c.aiEnabled,
      monthlyLimit: c.aiMonthlyLimit,
      autoBooking: c.aiAutoBooking,
      autoReply: c.aiAutoReply,
      assistant: c.aiAssistantEnabled,
      sendingEnabled: c.sendingEnabled,
      autoBookingSupported: BOOKING_WRITE_SUPPORTED,
      used,
      purchased: c.aiPurchased,
      tokens: (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
    };
  }

  async update(clinicId: string, patch: { enabled?: boolean; monthlyLimit?: number; autoBooking?: boolean; autoReply?: boolean; assistant?: boolean }) {
    if (patch.enabled && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.assistant && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.autoReply && !this.llm.configured) throw new BadRequestException('ai_not_configured');
    if (patch.autoReply) {
      const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, plan: true } });
      if (!hasFeature(cur.plan, 'ai_autoreply')) throw new BadRequestException('plan_feature');
      if (!(patch.enabled ?? cur.aiEnabled)) throw new BadRequestException('ai_disabled');
    }
    if (patch.autoBooking && !BOOKING_WRITE_SUPPORTED) throw new BadRequestException('booking_write_unsupported');
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { ...(patch.assistant !== undefined ? { aiAssistantEnabled: patch.assistant } : {}), ...(patch.enabled === false ? { aiAutoReply: false } : patch.autoReply !== undefined ? { aiAutoReply: patch.autoReply } : {}), ...(patch.autoBooking !== undefined ? { aiAutoBooking: patch.autoBooking } : {}), ...(patch.enabled !== undefined ? { aiEnabled: patch.enabled } : {}), ...(patch.monthlyLimit !== undefined ? { aiMonthlyLimit: patch.monthlyLimit } : {}) },
    });
    return this.status(clinicId);
  }

  // Единственная точка вызова ИИ. Проверяет, что ИИ включён и месячный лимит не исчерпан, пишет расход (без текста).
  async complete(clinicId: string, kind: string, system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens?: number, scope: 'chat' | 'assistant' = 'chat', billable = true): Promise<LlmResult> {
    const st = await this.status(clinicId);
    // chat: ответы пациентам и черновики; assistant: помощник руководителя (у каждого свой выключатель)
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
      const r = await this.llm.complete(system, messages, maxTokens);
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
