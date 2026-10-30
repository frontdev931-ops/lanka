import { Injectable, Logger } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { clinicHm } from '../common/clinic-time';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramApi, TelegramError } from './telegram.api';
import { marketingAllowed } from './consent';
import { scenario } from './scenarios';
import { effectiveLimits, periodStart } from '../service/plans';
import { WaitlistService } from './waitlist.service';
import { CustomAutomationsService } from './custom-automations.service';

const ACTIVE_VISIT = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'];
// Окно отправки по часовому поясу клиники: ночью пациентам не пишем
const SEND_FROM = '08:00';
const SEND_TO = '22:00';

@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(
    private prisma: PrismaService,
    private telegram: TelegramApi,
    private waitlist: WaitlistService,
    private custom: CustomAutomationsService,
  ) {}

  async list(clinicId: string, status: string, page: number) {
    const pageSize = 50;
    const where = { clinicId, ...(status !== 'ALL' ? { status } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.outboundMessage.count({ where }),
      this.prisma.outboundMessage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (Math.max(page, 1) - 1) * pageSize,
        take: pageSize,
        include: { patient: { select: { id: true, fullName: true } } },
      }),
    ]);
    const counts = await this.prisma.outboundMessage.groupBy({ by: ['status'], where: { clinicId }, _count: true });
    const campaignIds = [...new Set(rows.filter((m) => m.ruleKey.startsWith('campaign:')).map((m) => m.ruleKey.slice(9)))];
    const campaigns = new Map((campaignIds.length ? await this.prisma.campaign.findMany({ where: { clinicId, id: { in: campaignIds } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    return {
      total,
      page,
      pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      rows: rows.map((m) => ({
        id: m.id,
        patient: m.patient,
        ruleKey: m.ruleKey,
        campaignName: m.ruleKey.startsWith('campaign:') ? (campaigns.get(m.ruleKey.slice(9)) ?? null) : null,
        channel: m.channel,
        text: m.text,
        status: m.status,
        scheduledFor: m.scheduledFor,
        sentAt: m.sentAt,
        error: m.error,
      })),
    };
  }

  async approve(clinicId: string, userId: string, opts: { ids?: string[]; all?: boolean }) {
    const where = { clinicId, status: 'PENDING_APPROVAL', ...(opts.all ? {} : { id: { in: opts.ids ?? [] } }) };
    const r = await this.prisma.outboundMessage.updateMany({ where, data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() } });
    if (r.count) await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'messages.approved', details: { count: r.count } } });
    return { approved: r.count };
  }

  async cancel(clinicId: string, ids: string[]) {
    const r = await this.prisma.outboundMessage.updateMany({ where: { clinicId, id: { in: ids }, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELLED', error: 'Скасовано співробітником' } });
    return { cancelled: r.count };
  }

  // Отправляет одобренные сообщения, срок которых наступил. Перед отправкой всё проверяется заново: данные могли измениться.
  async process(now = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
    const out = { sent: 0, failed: 0, skipped: 0 };
    const due = await this.prisma.outboundMessage.findMany({ where: { status: 'APPROVED', scheduledFor: { lte: now }, clinic: { sendingEnabled: true, suspendedAt: null } }, orderBy: { scheduledFor: 'asc' }, take: 200 });
    const hm = clinicHm(now);
    const inWindow = hm >= SEND_FROM && hm < SEND_TO;
    const tokens = new Map<string, string | null>();
    const confirmFor = new Map<string, boolean>();
    const assume = new Map<string, boolean>((await this.prisma.clinic.findMany({ where: { id: { in: [...new Set(due.map((m) => m.clinicId))] } }, select: { id: true, assumeConsent: true } })).map((c) => [c.id, c.assumeConsent]));

    // Plan limit of messages per month: what is left for each clinic. Over the limit, messages wait (they are not lost).
    const left = new Map<string, number>();
    for (const c of await this.prisma.clinic.findMany({ where: { id: { in: [...new Set(due.map((m) => m.clinicId))] } }, select: { id: true, plan: true, limitOverrides: true, periodStartsAt: true } })) {
      const sent = await this.prisma.outboundMessage.count({ where: { clinicId: c.id, status: 'SENT', sentAt: { gte: periodStart(c, now) } } });
      left.set(c.id, effectiveLimits(c.plan, c.limitOverrides).messagesPerMonth - sent);
    }

    for (const m of due) {
      const mark = (status: string, error?: string) => this.prisma.outboundMessage.update({ where: { id: m.id }, data: { status, error, ...(status === 'SENT' ? { sentAt: new Date() } : {}) } });
      if (m.expiresAt && m.expiresAt <= now) {
        await mark('EXPIRED', 'Час минув');
        out.skipped++;
        continue;
      }
      if (!inWindow) {
        out.skipped++; // ночью ждём утра
        continue;
      }
      if ((left.get(m.clinicId) ?? 0) <= 0) {
        out.skipped++; // plan limit reached: wait for the next month or a higher plan
        continue;
      }
      const p = await this.prisma.patient.findFirst({ where: { id: m.patientId, clinicId: m.clinicId }, select: { removedAt: true, automationPaused: true, consent: true } });
      const sc = scenario(m.ruleKey);
      if (!p || p.removedAt || p.automationPaused || p.consent === 'WITHDRAWN' || ((sc?.kind === 'marketing' || m.ruleKey.startsWith('campaign:') || m.ruleKey.startsWith('auto-m:')) && !marketingAllowed(p.consent, assume.get(m.clinicId) ?? false))) {
        await mark('CANCELLED', 'Пацієнт відмовився або дані змінилися');
        out.skipped++;
        continue;
      }
      // An automation of the clinic: its own conditions to stop (switched off, the patient has booked, the patient has answered)
      if (m.ruleKey.startsWith('auto:') || m.ruleKey.startsWith('auto-m:')) {
        const why = await this.custom.stopReason(m, now);
        if (why) {
          await mark('CANCELLED', why);
          out.skipped++;
          continue;
        }
      }
      if (m.ruleKey === 'visit-reminder' && m.visitId) {
        const v = await this.prisma.visit.findUnique({ where: { id: m.visitId }, select: { status: true, startsAt: true } });
        if (!v || !ACTIVE_VISIT.includes(v.status) || v.startsAt <= now) {
          await mark('CANCELLED', 'Запис змінено або скасовано');
          out.skipped++;
          continue;
        }
      }
      const ch = await this.prisma.patientChannel.findUnique({ where: { patientId_channel: { patientId: m.patientId, channel: m.channel } } });
      if (!ch || ch.optedOutAt) {
        await mark('CANCELLED', 'Пацієнт не підключений до каналу');
        out.skipped++;
        continue;
      }
      if (!tokens.has(m.clinicId)) {
        const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId: m.clinicId, provider: Provider.TELEGRAM } } });
        tokens.set(m.clinicId, i?.apiKeyEnc ? decrypt(i.apiKeyEnc) : null);
      }
      const token = tokens.get(m.clinicId);
      if (!token) {
        await mark('FAILED', 'Telegram-бот не підключено');
        out.failed++;
        continue;
      }
      try {
        // Просьба об оценке приходит с кнопками 1-5; нажатие обрабатывает бот (TelegramService.handleRating)
        // A reminder can carry "I confirm / I want to reschedule" buttons when the clinic turned that on for the scenario
        if (m.ruleKey === 'visit-reminder' && m.visitId && !confirmFor.has(m.clinicId)) {
          const rule = await this.prisma.automationRule.findUnique({ where: { clinicId_key: { clinicId: m.clinicId, key: 'visit-reminder' } }, select: { params: true } });
          confirmFor.set(m.clinicId, !!(rule?.params as { confirmButtons?: boolean } | null)?.confirmButtons);
        }
        // An offer from the waiting list carries "suits me / does not suit me"; the time to answer starts when it is really sent
        const wlOffer = m.ruleKey === 'waitlist-offer' ? await this.prisma.slotOffer.findFirst({ where: { outboundId: m.id, status: 'OFFERED' }, select: { id: true } }) : null;
        if (m.ruleKey === 'waitlist-offer' && !wlOffer) {
          await mark('CANCELLED', 'Пропозицію вже закрито');
          out.skipped++;
          continue;
        }
        const extra = wlOffer
          ? { reply_markup: { inline_keyboard: [[{ text: 'Підходить', callback_data: `wl|${wlOffer.id}|y` }, { text: 'Не підходить', callback_data: `wl|${wlOffer.id}|n` }]] } }
          : m.ruleKey === 'visit-reminder' && m.visitId && confirmFor.get(m.clinicId)
          ? { reply_markup: { inline_keyboard: [[{ text: 'Підтверджую', callback_data: `confirm|${m.visitId}|y` }], [{ text: 'Хочу перенести', callback_data: `confirm|${m.visitId}|m` }]] } }
          : m.ruleKey === 'visit-review' && m.visitId ? { reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: String(n), callback_data: `rate|${m.visitId}|${n}` }))] } } : undefined;
        await this.telegram.sendMessage(token, ch.externalId, m.text, extra);
        await mark('SENT');
        if (wlOffer) await this.waitlist.markSent(m.id);
        left.set(m.clinicId, (left.get(m.clinicId) ?? 1) - 1);
        out.sent++;
      } catch (e) {
        // 403: пациент заблокировал бота: больше не пишем
        if (e instanceof TelegramError && e.code === 403) await this.prisma.patientChannel.update({ where: { id: ch.id }, data: { optedOutAt: new Date() } });
        await mark('FAILED', e instanceof TelegramError ? e.message.slice(0, 200) : 'Не вдалося надіслати');
        out.failed++;
        this.log.warn(`Повідомлення не надіслано: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
