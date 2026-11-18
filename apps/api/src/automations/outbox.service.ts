import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramApi, TelegramError } from './telegram.api';
import { marketingAllowed } from './consent';
import { scenario } from './scenarios';
import { effectiveLimits, periodStart } from '../service/plans';
import { WaitlistService } from './waitlist.service';
import { CustomAutomationsService } from './custom-automations.service';
import { madeFor, reminderStale } from './visit-reminders';
import { SyncService } from '../integrations/sync.service';
import { ClinicConnector, ExternalVisit } from '../integrations/connector';
import { clinicDate } from '../common/clinic-time';
// Sending window in the clinic's time zone: we do not write to patients at night
import { inSendWindow } from './send-window';
import { MessengerService } from './messenger.service';
import { SendError } from './channels';

// Failures that certainly did not reach the patient: nothing was sent (no bot, the visit could not be checked) or the provider refused the request
// outright (Telegram "Bad Request" / "Too Many Requests"; an Instagram error that is not "result unknown"). A network error, a 5xx and an unknown result
// may have been delivered, so they are not offered for a resend.
const MAX_RETRIES = 2;
export function retryableFailure(m: { channel: string; error: string | null }): boolean {
  const e = m.error ?? '';
  if (e === 'Telegram-бот не підключено' || e.startsWith('Не вдалося перевірити запис у Cliniccards')) return true;
  if (m.channel === 'TELEGRAM') return /^(Bad Request|Too Many Requests)/.test(e);
  if (m.channel === 'INSTAGRAM') return !!e && e !== 'Не вдалося надіслати';
  return false;
}

@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(
    private prisma: PrismaService,
    private telegram: TelegramApi,
    private waitlist: WaitlistService,
    private custom: CustomAutomationsService,
    private messenger: MessengerService,
    private sync: SyncService,
  ) {}

  // A reminder of a visit's time is checked against Cliniccards itself right before it goes: our copy is loaded once a day, and a visit moved or cancelled
  // there since then must not get a reminder with the old time. One read of the visit's day per clinic and day within one pass of the queue (not a full
  // load). A clinic without a Cliniccards key (the demo) has nothing to ask: its own copy is the truth.
  //   'ok': the visit is there, active, at the time the reminder was made for; 'stale': moved, cancelled or gone; 'unverified': Cliniccards did not answer.
  private async freshVisit(
    cache: { connectors: Map<string, Promise<ClinicConnector | null>>; days: Map<string, Promise<ExternalVisit[] | null>> },
    m: { clinicId: string; dedupeKey: string; expiresAt: Date | null },
    v: { externalId: string; startsAt: Date },
  ): Promise<'ok' | 'stale' | 'unverified' | 'local'> {
    if (!cache.connectors.has(m.clinicId)) cache.connectors.set(m.clinicId, this.sync.connectorForClinic(m.clinicId).catch(() => null));
    const connector = await cache.connectors.get(m.clinicId)!;
    if (!connector) return 'local';
    const at = madeFor(m) ?? v.startsAt;
    const key = `${m.clinicId}|${clinicDate(at)}`;
    // a day in the clinic's time zone fits inside this window in any case (the same window as the fresh checks of booking)
    if (!cache.days.has(key)) cache.days.set(key, connector.fetchVisits({ from: new Date(at.getTime() - 14 * 3_600_000), to: new Date(at.getTime() + 38 * 3_600_000) }).catch(() => null));
    const rows = await cache.days.get(key)!;
    if (!rows) return 'unverified';
    const now = rows.find((x) => x.externalId === v.externalId);
    // not on that day any more: moved to another day or removed
    return reminderStale(now ? { status: now.status, startsAt: now.startsAt } : null, m) ? 'stale' : 'ok';
  }

  async list(clinicId: string, status: string, page: number, channel?: string) {
    const pageSize = 50;
    const where = { clinicId, ...(status !== 'ALL' ? { status } : {}), ...(channel ? { channel } : {}) };
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
        // staff may send it again (retry below): a failure that certainly did not reach the patient, not expired
        retryable: m.status === 'FAILED' && retryableFailure(m) && !(m.expiresAt && m.expiresAt <= new Date()),
      })),
    };
  }

  // Staff send a FAILED message again: it goes back to the queue as approved and the sender checks EVERYTHING again (sending switch, consent,
  // the patient's channel, the visit in Cliniccards, the 24-hour window, the expiry). Only a failure that certainly did not reach the patient,
  // at most MAX_RETRIES times per message. A result that may have been delivered (UNKNOWN, a network error) is never resent.
  async retry(clinicId: string, userId: string, id: string, now = new Date()) {
    const m = await this.prisma.outboundMessage.findFirst({ where: { clinicId, id } });
    if (!m) throw new NotFoundException('message_not_found');
    if (m.status !== 'FAILED' || !retryableFailure(m)) throw new BadRequestException('message_not_retryable');
    if (m.expiresAt && m.expiresAt <= now) throw new BadRequestException('message_expired');
    const tries = await this.prisma.auditLog.count({ where: { clinicId, action: 'messages.retry', details: { path: ['id'], equals: id } } });
    if (tries >= MAX_RETRIES) throw new BadRequestException('message_retry_limit');
    const r = await this.prisma.outboundMessage.updateMany({ where: { id, clinicId, status: 'FAILED' }, data: { status: 'APPROVED', scheduledFor: now, error: null, approvedById: userId, approvedAt: now } });
    if (!r.count) throw new BadRequestException('message_not_retryable');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'messages.retry', details: { id, error: m.error } } });
    return { retried: true };
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

  // Sends approved messages whose time has come. Everything is re-checked before sending: the data may have changed.
  // `scope.clinicId` limits the run to one clinic (the scheduler never passes it: it serves every clinic; tests pass it, so the messages that
  // other tests or earlier runs left in a shared database are neither sent nor counted)
  async process(now = new Date(), scope?: { clinicId?: string }): Promise<{ sent: number; failed: number; skipped: number }> {
    const out = { sent: 0, failed: 0, skipped: 0 };
    const due = await this.prisma.outboundMessage.findMany({ where: { status: 'APPROVED', scheduledFor: { lte: now }, ...(scope?.clinicId ? { clinicId: scope.clinicId } : {}), clinic: { sendingEnabled: true, suspendedAt: null } }, orderBy: { scheduledFor: 'asc' }, take: 200 });
    const inWindow = inSendWindow(now);
    const tokens = new Map<string, string | null>();
    const confirmFor = new Map<string, boolean>();
    const fresh = { connectors: new Map<string, Promise<ClinicConnector | null>>(), days: new Map<string, Promise<ExternalVisit[] | null>>() };
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
        out.skipped++; // at night we wait for the morning
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
      // a reminder of a visit's time (the built-in one, or a clinic's "before the visit" automation) is sent only for the visit as it was made for: the same
      // visit, active, at the SAME time (the start it was made for, see visit-reminders.ts); a moved or cancelled visit's reminder is cancelled, never sent with the old time
      const rule = m.ruleKey.startsWith('auto:') && m.visitId ? await this.prisma.automation.findFirst({ where: { id: m.ruleKey.slice(5), clinicId: m.clinicId }, select: { trigger: true } }) : null;
      const beforeVisit = m.ruleKey === 'visit-reminder' || (rule?.trigger as { type?: string } | null | undefined)?.type === 'VISIT_BEFORE';
      if (beforeVisit && m.visitId) {
        const v = await this.prisma.visit.findFirst({ where: { id: m.visitId, clinicId: m.clinicId }, select: { status: true, startsAt: true, externalId: true } });
        if (reminderStale(v, m) || !v || v.startsAt <= now) {
          await mark('CANCELLED', 'Запис змінено або скасовано');
          out.skipped++;
          continue;
        }
        const check = await this.freshVisit(fresh, m, v);
        if (check === 'stale') {
          await mark('CANCELLED', 'Запис змінено або скасовано в Cliniccards');
          out.skipped++;
          continue;
        }
        // never a reminder that may carry a wrong time: it is not sent and the reason stays in the history (it is not tried again)
        if (check === 'unverified') {
          await mark('FAILED', 'Не вдалося перевірити запис у Cliniccards: нагадування не надіслано');
          out.failed++;
          continue;
        }
      }
      const ch = await this.prisma.patientChannel.findUnique({ where: { patientId_channel: { patientId: m.patientId, channel: m.channel } } });
      if (!ch || ch.optedOutAt || ch.clinicId !== m.clinicId) {
        await mark('CANCELLED', 'Пацієнт не підключений до каналу');
        out.skipped++;
        continue;
      }
      // An appointment reminder in the patient's linked Instagram conversation: text only (no Telegram buttons or links), through the channel sender, which checks
      // the 24-hour window right before sending. Each outcome is final for this row: no retry, and never another channel instead.
      if (m.channel === 'INSTAGRAM') {
        if (await this.prisma.patientChannel.count({ where: { clinicId: m.clinicId, patientId: m.patientId, optedOutAt: { not: null } } })) {
          await mark('CANCELLED', 'Пацієнт відмовився від повідомлень в іншому каналі');
          out.skipped++;
          continue;
        }
        try {
          await this.messenger.send(m.clinicId, 'INSTAGRAM', ch.externalId, m.text, []);
        } catch (e) {
          const se = e instanceof SendError ? e : null;
          if (se?.reason === 'window_closed') {
            await mark('CANCELLED', 'Вікно Instagram закрито: понад 24 години без повідомлення пацієнта');
            out.skipped++;
          } else if (se?.reason === 'not_connected') {
            await mark('CANCELLED', 'Instagram клініки не підключено');
            out.skipped++;
          } else if (se?.ambiguous) {
            // the provider may have received it: not repeated, not sent elsewhere; a person checks the conversation
            await mark('UNKNOWN', 'Результат доставки невідомий: повторно не надсилається');
            out.failed++;
          } else {
            await mark('FAILED', (se?.message ?? 'Не вдалося надіслати').slice(0, 200));
            out.failed++;
          }
          this.log.warn(`Нагадування в Instagram не надіслано: ${(e as Error).message}`);
          continue;
        }
        await mark('SENT');
        // the conversation shows what the clinic sent
        await this.prisma.chatMessage.create({ data: { clinicId: m.clinicId, patientId: m.patientId, channel: 'INSTAGRAM', chatId: ch.externalId, direction: 'OUT', text: m.text } });
        left.set(m.clinicId, (left.get(m.clinicId) ?? 1) - 1);
        out.sent++;
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
        // The rating request comes with buttons 1-5; a press is handled by the bot (TelegramService.handleRating)
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
        // 403: the patient blocked the bot: we do not write any more
        if (e instanceof TelegramError && e.code === 403) await this.prisma.patientChannel.update({ where: { id: ch.id }, data: { optedOutAt: new Date() } });
        await mark('FAILED', e instanceof TelegramError ? e.message.slice(0, 200) : 'Не вдалося надіслати');
        out.failed++;
        this.log.warn(`Повідомлення не надіслано: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
