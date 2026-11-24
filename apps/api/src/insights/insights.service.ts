import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import { MailService } from '../auth/mail.service';
import { StaffNotifierService } from '../automations/staff-notifier.service';
import { LeaderTelegramService } from '../automations/leader-telegram.service';
import { startOfClinicDay } from '../common/clinic-time';
import { clinicMoneyCurrency, effectiveCurrency } from '../common/money';
import { Lang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { ROW_LIMIT_MAX, ReportBuilderService, ReportSpec } from '../report-builder/report-builder.service';
import { ReportsService } from '../reports/reports.service';
import { toPdf, toXlsx } from '../reports/report-export';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { Frequency, nextRun } from './schedule';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_SCHEDULES = 20;
const MAX_RECIPIENTS = 5;
const COOLDOWN_MS = 24 * HOUR;
// The menu badge reuses a measurement this long (see signalsSummary)
const SUMMARY_TTL_MS = 5 * 60_000;
// Fired = a switched-on rule whose measured value reached its threshold; off, too little data, needs a load and errors are not counted
const firedCount = (list: { active: boolean; state: string }[]) => list.filter((x) => x.active && x.state === 'fired').length;
// Cliniccards-based signals use our copy of Cliniccards: without a successful load in this time they are not computed (old data is not "zero")
const SYNC_FRESH_MS = 48 * HOUR;
// A Telegram alert being sent is claimed for this long, so two scheduler runs never send the same alert; a failed send releases the claim
const TELEGRAM_CLAIM_MS = 10 * 60_000;
// A rule on a handful of visits or payments is noise: it needs at least this many in the period it compares with
const MIN_SAMPLE = 10;
// The cancellations and no-shows "without rebooking" are looked for in this many past days (shown on the signal)
const NO_REBOOK_LOOKBACK_DAYS = 30;
// The unfinished treatment of the "Unfinished treatment" report: plan items done within this many days
const UNFINISHED_LOOKBACK_DAYS = 180;
const LANG: Lang = 'uk';
const INACTIVE_VISIT = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];

export const ALERT_KINDS = ['CANCEL_RATE', 'NO_REBOOK', 'OVERDUE_TASKS', 'PAYMENTS_DROP', 'RETURN_DROP', 'STALE_REQUESTS', 'SYNC_OVERDUE', 'UNFINISHED_NO_NEXT'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
// Defaults of each rule (product defaults, editable; the first three are the rules of 2026-11-11). threshold: % (CANCEL_RATE, RETURN_DROP,
// PAYMENTS_DROP), a count (STALE_REQUESTS, UNFINISHED_NO_NEXT, NO_REBOOK, OVERDUE_TASKS) or hours (SYNC_OVERDUE); windowDays: the period, the
// days of waiting (UNFINISHED_NO_NEXT) or the days after the missed visit (NO_REBOOK); hours: the waiting of a request.
const ALERT_DEFAULTS: Record<AlertKind, { threshold: number; windowDays: number; hours: number }> = {
  CANCEL_RATE: { threshold: 25, windowDays: 7, hours: 4 },
  RETURN_DROP: { threshold: 30, windowDays: 14, hours: 4 },
  STALE_REQUESTS: { threshold: 3, windowDays: 7, hours: 4 },
  PAYMENTS_DROP: { threshold: 30, windowDays: 14, hours: 4 },
  UNFINISHED_NO_NEXT: { threshold: 5, windowDays: 30, hours: 4 },
  NO_REBOOK: { threshold: 5, windowDays: 7, hours: 4 },
  OVERDUE_TASKS: { threshold: 5, windowDays: 7, hours: 4 },
  SYNC_OVERDUE: { threshold: 48, windowDays: 7, hours: 4 },
};
// What may be set per rule: [min, max] of the threshold, of windowDays (null: not used), of hours (null: not used)
const ALERT_LIMITS: Record<AlertKind, { threshold: [number, number]; windowDays: [number, number] | null; hours: [number, number] | null }> = {
  CANCEL_RATE: { threshold: [1, 100], windowDays: [3, 60], hours: null },
  RETURN_DROP: { threshold: [1, 100], windowDays: [3, 60], hours: null },
  PAYMENTS_DROP: { threshold: [1, 100], windowDays: [7, 60], hours: null },
  STALE_REQUESTS: { threshold: [1, 1000], windowDays: null, hours: [1, 72] },
  UNFINISHED_NO_NEXT: { threshold: [1, 1000], windowDays: [7, UNFINISHED_LOOKBACK_DAYS], hours: null },
  NO_REBOOK: { threshold: [1, 1000], windowDays: [1, NO_REBOOK_LOOKBACK_DAYS - 7], hours: null },
  OVERDUE_TASKS: { threshold: [1, 1000], windowDays: null, hours: null },
  SYNC_OVERDUE: { threshold: [24, 336], windowDays: null, hours: null },
};
// Rules calculated from our copy of Cliniccards (need a recent load); the others use LANKA's own data
const CLINICCARDS_KINDS: string[] = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP', 'UNFINISHED_NO_NEXT', 'NO_REBOOK'];
// Where each signal leads in the app (with the matching filter where the page takes one). The drop in completed visits has no report comparing
// two periods: the signal itself shows both periods, both counts and the change, so it carries no link.
const SIGNAL_LINK: Record<AlertKind, string | null> = {
  CANCEL_RATE: '/reports?report=missed-visits',
  RETURN_DROP: null,
  STALE_REQUESTS: '/inbox?tab=requests',
  PAYMENTS_DROP: '/reports?report=revenue&days=60',
  UNFINISHED_NO_NEXT: `/reports?report=unfinished-treatment&days=${UNFINISHED_LOOKBACK_DAYS}`,
  NO_REBOOK: `/reports?report=missed-visits&days=${NO_REBOOK_LOOKBACK_DAYS}`,
  OVERDUE_TASKS: '/tasks',
  SYNC_OVERDUE: '/settings',
};

// One signal explained: measured (the value with what it was calculated from), too little data, a Cliniccards load needed first, or (the sync
// rule) Cliniccards not connected / never loaded
export type SignalExplained =
  | {
      state: 'measured'; value: number; from?: Date; to?: Date; count?: number; base?: number; prevFrom?: Date; prevTo?: Date;
      currency?: string; amount?: number; prevAmount?: number; oldestDays?: number; lookbackDays?: number; lastSyncAt?: Date;
    }
  | { state: 'insufficient'; from?: Date; to?: Date; base: number; need: number; reason?: 'currency' }
  | { state: 'needs_sync' }
  | { state: 'never' }
  | { state: 'not_connected' };

export interface ScheduleInput {
  savedReportId: string;
  frequency: Frequency;
  hour: number;
  weekday: number;
  monthDay: number;
  format: 'XLSX' | 'PDF';
  recipientIds: string[];
}

@Injectable()
export class InsightsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(InsightsService.name);
  private timer?: NodeJS.Timeout;
  private n = 0;

  // clinicId → the last measured number of fired signals (see signalsSummary)
  private summaryCache = new Map<string, { at: number; sync: number; fired: number }>();

  constructor(
    private prisma: PrismaService,
    private builder: ReportBuilderService,
    private mail: MailService,
    private staff: StaffNotifierService,
    private leaders: LeaderTelegramService,
    private reports: ReportsService,
    private push: PushService,
  ) {}

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`Insights: ${(e as Error).message}`)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    await this.runDue(now);
    if (this.n++ % 30 === 0) await this.evaluateAll(now);
  }

  // ---------- scheduled reports ----------

  private async clinicOk(clinicId: string) {
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true, plan: true } });
    return { ok: !!c && !c.suspendedAt && !c.isDemo && !(billingEnforced() && accessBlocked(c)), plan: c?.plan ?? 'START' };
  }

  async list(clinicId: string) {
    const rows = await this.prisma.scheduledReport.findMany({ where: { clinicId }, orderBy: { createdAt: 'desc' } });
    const saved = new Map((await this.prisma.savedReport.findMany({ where: { clinicId }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    return rows.map((r) => ({ id: r.id, savedReportId: r.savedReportId, reportName: saved.get(r.savedReportId) ?? null, frequency: r.frequency, hour: r.hour, weekday: r.weekday, monthDay: r.monthDay, format: r.format, recipientIds: r.recipientIds as string[], enabled: r.enabled, nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt, lastStatus: r.lastStatus, lastError: r.lastError }));
  }

  // Members of the clinic that a report may be sent to
  async members(clinicId: string) {
    const rows = await this.prisma.membership.findMany({ where: { clinicId }, select: { role: true, user: { select: { id: true, name: true, email: true } } } });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
  }

  private async validate(clinicId: string, d: Partial<ScheduleInput>, plan: string) {
    if (d.frequency !== undefined) {
      if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(d.frequency)) throw new BadRequestException('bad_schedule');
      if (d.frequency === 'DAILY' && !hasFeature(plan, 'daily_digest')) throw new BadRequestException('plan_feature');
    }
    if (d.hour !== undefined && !(Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23)) throw new BadRequestException('bad_schedule');
    if (d.weekday !== undefined && !(Number.isInteger(d.weekday) && d.weekday >= 1 && d.weekday <= 7)) throw new BadRequestException('bad_schedule');
    if (d.monthDay !== undefined && !(Number.isInteger(d.monthDay) && d.monthDay >= 1 && d.monthDay <= 28)) throw new BadRequestException('bad_schedule');
    if (d.format !== undefined && !['XLSX', 'PDF'].includes(d.format)) throw new BadRequestException('bad_schedule');
    if (d.recipientIds !== undefined) {
      const ids = [...new Set(d.recipientIds)];
      if (!ids.length || ids.length > MAX_RECIPIENTS) throw new BadRequestException('bad_recipients');
      // only people of this clinic: a report is never mailed to an address typed in by hand
      if ((await this.prisma.membership.count({ where: { clinicId, userId: { in: ids } } })) !== ids.length) throw new BadRequestException('bad_recipients');
      d.recipientIds = ids;
    }
  }

  async create(clinicId: string, userId: string, d: ScheduleInput) {
    const { plan } = await this.clinicOk(clinicId);
    await this.validate(clinicId, d, plan);
    if (!(await this.prisma.savedReport.findFirst({ where: { id: d.savedReportId, clinicId }, select: { id: true } }))) throw new NotFoundException('report_not_found');
    if ((await this.prisma.scheduledReport.count({ where: { clinicId } })) >= MAX_SCHEDULES) throw new BadRequestException('too_many_saved');
    const row = await this.prisma.scheduledReport.create({ data: { clinicId, savedReportId: d.savedReportId, frequency: d.frequency, hour: d.hour, weekday: d.weekday, monthDay: d.monthDay, format: d.format, recipientIds: d.recipientIds, nextRunAt: nextRun(d, new Date()), createdById: userId } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'report.schedule_created', details: { id: row.id, frequency: d.frequency, recipients: d.recipientIds.length } } });
    return row.id;
  }

  async update(clinicId: string, userId: string, id: string, d: Partial<ScheduleInput> & { enabled?: boolean }) {
    const cur = await this.prisma.scheduledReport.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('report_not_found');
    const { plan } = await this.clinicOk(clinicId);
    await this.validate(clinicId, d, plan);
    const next = { frequency: (d.frequency ?? cur.frequency) as Frequency, hour: d.hour ?? cur.hour, weekday: d.weekday ?? cur.weekday, monthDay: d.monthDay ?? cur.monthDay };
    await this.prisma.scheduledReport.update({ where: { id }, data: { ...(d.frequency !== undefined ? { frequency: d.frequency } : {}), ...(d.hour !== undefined ? { hour: d.hour } : {}), ...(d.weekday !== undefined ? { weekday: d.weekday } : {}), ...(d.monthDay !== undefined ? { monthDay: d.monthDay } : {}), ...(d.format !== undefined ? { format: d.format } : {}), ...(d.recipientIds !== undefined ? { recipientIds: d.recipientIds } : {}), ...(d.enabled !== undefined ? { enabled: d.enabled } : {}), nextRunAt: nextRun(next, new Date()) } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'report.schedule_changed', details: { id } } });
  }

  async remove(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.scheduledReport.deleteMany({ where: { id, clinicId } });
    if (!r.count) throw new NotFoundException('report_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'report.schedule_deleted', details: { id } } });
  }

  async runNow(clinicId: string, id: string) {
    const row = await this.prisma.scheduledReport.findFirst({ where: { id, clinicId } });
    if (!row) throw new NotFoundException('report_not_found');
    return this.send(row.id);
  }

  async runDue(now = new Date()): Promise<number> {
    const due = await this.prisma.scheduledReport.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, take: 50 });
    let n = 0;
    for (const r of due) {
      // claim: the next time is written first, so two servers or a slow run never send the same report twice
      const claim = await this.prisma.scheduledReport.updateMany({ where: { id: r.id, nextRunAt: r.nextRunAt }, data: { nextRunAt: nextRun({ frequency: r.frequency as Frequency, hour: r.hour, weekday: r.weekday, monthDay: r.monthDay }, now) } });
      if (!claim.count) continue;
      if (!(await this.clinicOk(r.clinicId)).ok) continue;
      await this.send(r.id).catch((e) => this.log.warn(`Scheduled report ${r.id}: ${(e as Error).message}`));
      n++;
    }
    return n;
  }

  // Calculates the report for each recipient with that person's role and mails it as a file. Never throws for a single recipient.
  private async send(id: string): Promise<{ sent: number; failed: number }> {
    const r = await this.prisma.scheduledReport.findUniqueOrThrow({ where: { id } });
    const saved = await this.prisma.savedReport.findFirst({ where: { id: r.savedReportId, clinicId: r.clinicId } });
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    if (!saved) {
      errors.push('saved report was deleted');
      failed = 1;
    } else {
      const updatedAt = (await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId: r.clinicId, provider: Provider.CLINICCARDS } } }))?.lastSyncAt ?? null;
      const members = await this.prisma.membership.findMany({ where: { clinicId: r.clinicId, userId: { in: r.recipientIds as string[] } }, select: { role: true, user: { select: { id: true, email: true } } } });
      for (const m of members) {
        try {
          const report = await this.builder.run(r.clinicId, m.role as Role, LANG, { ...(saved.spec as unknown as ReportSpec), limit: ROW_LIMIT_MAX }, saved.name, updatedAt);
          const pdf = r.format === 'PDF';
          const content = pdf ? await toPdf(report, LANG) : await toXlsx(report, LANG);
          await this.mail.send({ to: m.user.email, subject: `LANKA: ${saved.name}`, text: `Звіт «${saved.name}» за розкладом у вкладенні.\nДані оновлено: ${updatedAt ? updatedAt.toISOString().slice(0, 16).replace('T', ' ') : 'невідомо'}.\nУ файлі дані пацієнтів: не пересилайте його стороннім.`, attachments: [{ filename: `${saved.name.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60) || 'report'}.${pdf ? 'pdf' : 'xlsx'}`, content }] });
          await this.prisma.auditLog.create({ data: { clinicId: r.clinicId, userId: m.user.id, action: 'report.scheduled_sent', details: { schedule: r.id, rows: report.rows.length, format: r.format } } });
          sent++;
        } catch (e) {
          failed++;
          errors.push((e as Error).message.slice(0, 120));
        }
      }
      if (!members.length) {
        failed = 1;
        errors.push('no recipients left');
      }
    }
    await this.prisma.scheduledReport.update({ where: { id }, data: { lastRunAt: new Date(), lastStatus: failed === 0 ? 'OK' : sent > 0 ? 'PARTIAL' : 'FAILED', lastError: errors.length ? errors.join('; ').slice(0, 300) : null } });
    return { sent, failed };
  }

  // ---------- alerts ----------

  async alerts(clinicId: string) {
    for (const kind of ALERT_KINDS) await this.prisma.alertRule.upsert({ where: { clinicId_kind: { clinicId, kind } }, create: { clinicId, kind, ...ALERT_DEFAULTS[kind] }, update: {} });
    return this.prisma.alertRule.findMany({ where: { clinicId }, orderBy: { kind: 'asc' }, select: { kind: true, threshold: true, windowDays: true, hours: true, active: true, enabled: true, push: true, telegram: true, lastFiredAt: true, telegramSentAt: true, lastValue: true } });
  }

  // Settings of one rule (owner and manager; the controller checks the role). Saving never sends anything. "active" is the master switch:
  // turning it off keeps the channel preferences (they apply again when it is back on); a channel cannot be changed while the rule is off.
  async updateAlert(clinicId: string, userId: string, kind: string, d: { active?: boolean; enabled?: boolean; push?: boolean; telegram?: boolean; threshold?: number; windowDays?: number; hours?: number }) {
    if (!ALERT_KINDS.includes(kind as AlertKind)) throw new NotFoundException('alert_not_found');
    const lim = ALERT_LIMITS[kind as AlertKind];
    const { plan } = await this.clinicOk(clinicId);
    if ((d.active || d.enabled || d.push || d.telegram) && !hasFeature(plan, 'advanced_analytics')) throw new BadRequestException('plan_feature');
    const inRange = (v: number, [lo, hi]: [number, number], int: boolean) => Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v));
    if (d.threshold !== undefined && !inRange(d.threshold, lim.threshold, kind !== 'CANCEL_RATE' && kind !== 'RETURN_DROP' && kind !== 'PAYMENTS_DROP')) throw new BadRequestException('bad_alert');
    if (d.windowDays !== undefined && (!lim.windowDays || !inRange(d.windowDays, lim.windowDays, true))) throw new BadRequestException('bad_alert');
    if (d.hours !== undefined && (!lim.hours || !inRange(d.hours, lim.hours, true))) throw new BadRequestException('bad_alert');
    await this.alerts(clinicId);
    const channel = d.enabled !== undefined || d.push !== undefined || d.telegram !== undefined;
    if (channel && d.active !== true) {
      const cur = await this.prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId, kind } }, select: { active: true } });
      if (!cur.active || d.active === false) throw new BadRequestException('alert_inactive');
    }
    await this.prisma.alertRule.update({ where: { clinicId_kind: { clinicId, kind } }, data: d });
    this.summaryCache.delete(clinicId);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'alert.changed', details: { kind, ...d } } });
  }

  // Whether our copy of Cliniccards is recent enough for the Cliniccards-based signals
  private async syncState(clinicId: string, now: Date) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } }, select: { lastSyncAt: true, apiKeyEnc: true } });
    const lastSyncAt = i?.lastSyncAt ?? null;
    return { lastSyncAt, connected: !!i?.apiKeyEnc, fresh: !!lastSyncAt && now.getTime() - lastSyncAt.getTime() < SYNC_FRESH_MS };
  }

  // The number each rule is about, with what it was calculated from: ONE calculation for the section, the checks and the network view.
  // Cliniccards rules count complete days in the clinic's time zone (today's visits are often not closed yet) and only after a recent load;
  // a small sample is "too little data", never a value.
  async explain(clinicId: string, rule: { kind: string; windowDays: number; hours: number }, now: Date, sync?: { fresh: boolean; connected: boolean; lastSyncAt: Date | null }): Promise<SignalExplained | null> {
    if (!ALERT_KINDS.includes(rule.kind as AlertKind)) return null;
    const st = sync ?? (await this.syncState(clinicId, now));
    const today = startOfClinicDay(now);
    if (rule.kind === 'STALE_REQUESTS') {
      // requests are LANKA's own data: no load needed
      const cutoff = new Date(now.getTime() - rule.hours * HOUR);
      const where = { clinicId, kind: { in: ['BOOKING', 'RESCHEDULE', 'CANCEL', 'HANDOFF'] } };
      const [count, base] = await Promise.all([
        this.prisma.bookingRequest.count({ where: { ...where, status: 'NEW', createdAt: { lt: cutoff } } }),
        this.prisma.bookingRequest.count({ where: { ...where, status: 'NEW' } }),
      ]);
      return { state: 'measured', value: count, from: cutoff, to: now, count, base };
    }
    if (rule.kind === 'OVERDUE_TASKS') {
      // LANKA's tasks: open ones whose due day has passed (completed and cancelled tasks are not open)
      const overdue = await this.prisma.task.findMany({ where: { clinicId, status: 'OPEN', dueDate: { lt: today } }, select: { dueDate: true }, orderBy: { dueDate: 'asc' } });
      const base = await this.prisma.task.count({ where: { clinicId, status: 'OPEN' } });
      return { state: 'measured', value: overdue.length, count: overdue.length, base, oldestDays: overdue.length ? Math.floor((today.getTime() - overdue[0].dueDate.getTime()) / DAY) + 1 : 0 };
    }
    if (rule.kind === 'SYNC_OVERDUE') {
      // only for a clinic that connected Cliniccards; "never loaded" is told apart and not alerted (the first load may be running)
      if (!st.connected) return { state: 'not_connected' };
      if (!st.lastSyncAt) return { state: 'never' };
      const hours = Math.floor((now.getTime() - st.lastSyncAt.getTime()) / HOUR);
      return { state: 'measured', value: hours, lastSyncAt: st.lastSyncAt };
    }
    if (CLINICCARDS_KINDS.includes(rule.kind) && !st.fresh) return { state: 'needs_sync' };
    const win = rule.windowDays * DAY;
    if (rule.kind === 'CANCEL_RATE') {
      const from = new Date(today.getTime() - win);
      const rows = await this.prisma.visit.groupBy({ by: ['status'], where: { clinicId, startsAt: { gte: from, lt: today }, status: { in: ['VISITED', 'IN_CLINIC', 'IN_CHAIR', 'DID_NOT_COME', 'CANCELLED', 'MOVED'] } }, _count: true });
      const total = rows.reduce((n, r) => n + r._count, 0);
      if (total < MIN_SAMPLE) return { state: 'insufficient', from, to: today, base: total, need: MIN_SAMPLE };
      const bad = rows.filter((r) => r.status === 'DID_NOT_COME' || r.status === 'CANCELLED').reduce((n, r) => n + r._count, 0);
      return { state: 'measured', value: Math.round((bad / total) * 1000) / 10, from, to: today, count: bad, base: total };
    }
    if (rule.kind === 'RETURN_DROP') {
      const from = new Date(today.getTime() - win);
      const prevFrom = new Date(from.getTime() - win);
      const done = (a: Date, b: Date) => this.prisma.visit.count({ where: { clinicId, status: 'VISITED', startsAt: { gte: a, lt: b } } });
      const [cur, prev] = await Promise.all([done(from, today), done(prevFrom, from)]);
      if (prev < MIN_SAMPLE) return { state: 'insufficient', from: prevFrom, to: from, base: prev, need: MIN_SAMPLE };
      return { state: 'measured', value: Math.round(((prev - cur) / prev) * 1000) / 10, from, to: today, count: cur, base: prev, prevFrom, prevTo: from };
    }
    if (rule.kind === 'PAYMENTS_DROP') {
      // received payments as the "Revenue" report sums them (amounts as loaded by their payment date); one currency only, never added across
      const from = new Date(today.getTime() - win);
      const prevFrom = new Date(from.getTime() - win);
      const clinicCur = await clinicMoneyCurrency(this.prisma, clinicId);
      const rows = (await this.prisma.payment.findMany({ where: { clinicId, paidAt: { gte: prevFrom, lt: today } }, select: { paidAt: true, amount: true, currency: true } }))
        .map((r) => ({ ...r, currency: effectiveCurrency(r.currency, clinicCur) }));
      const currencies = new Set(rows.map((r) => r.currency));
      const prev = rows.filter((r) => r.paidAt < from);
      if (currencies.size > 1) return { state: 'insufficient', from: prevFrom, to: today, base: prev.length, need: MIN_SAMPLE, reason: 'currency' };
      const sum = (xs: typeof rows) => Math.round(xs.reduce((n, r) => n + Number(r.amount), 0));
      const prevAmount = sum(prev);
      const amount = sum(rows.filter((r) => r.paidAt >= from));
      if (prev.length < MIN_SAMPLE || prevAmount <= 0) return { state: 'insufficient', from: prevFrom, to: from, base: prev.length, need: MIN_SAMPLE };
      return { state: 'measured', value: Math.round(((prevAmount - amount) / prevAmount) * 1000) / 10, from, to: today, prevFrom, prevTo: from, amount, prevAmount, currency: [...currencies][0] as string };
    }
    if (rule.kind === 'UNFINISHED_NO_NEXT') {
      // the "Unfinished treatment" report's own definition: open plan items while some work is already done, no future visit and no active
      // reminder; then only patients with a completed visit, whose last completed work is at least windowDays old
      const rows = await this.reports.unfinishedForSignals(clinicId, UNFINISHED_LOOKBACK_DAYS);
      const ids = rows.map((r) => r.patientId);
      const visited = new Set((await this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids }, status: 'VISITED', startsAt: { lt: now } }, select: { patientId: true }, distinct: ['patientId'] })).map((v) => v.patientId));
      const waiting = rows.filter((r) => visited.has(r.patientId) && r.daysSince >= rule.windowDays);
      return { state: 'measured', value: waiting.length, count: waiting.length, base: rows.filter((r) => visited.has(r.patientId)).length, oldestDays: waiting.reduce((m, r) => Math.max(m, r.daysSince), 0), lookbackDays: UNFINISHED_LOOKBACK_DAYS };
    }
    // NO_REBOOK: patients whose cancelled or missed visit (within the lookback, at least windowDays ago) has no later completed visit and no
    // future active one; each patient once
    const from = new Date(today.getTime() - NO_REBOOK_LOOKBACK_DAYS * DAY);
    const to = new Date(today.getTime() - win);
    const missed = await this.prisma.visit.findMany({ where: { clinicId, status: { in: ['CANCELLED', 'DID_NOT_COME'] }, startsAt: { gte: from, lt: to }, patient: { removedAt: null } }, select: { patientId: true, startsAt: true } });
    const firstMissed = new Map<string, Date>();
    for (const m of missed) if (m.patientId && (!firstMissed.has(m.patientId) || m.startsAt < firstMissed.get(m.patientId)!)) firstMissed.set(m.patientId, m.startsAt);
    const ids = [...firstMissed.keys()];
    const later = ids.length ? await this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids }, OR: [{ status: 'VISITED' }, { startsAt: { gt: now }, status: { notIn: INACTIVE_VISIT } }] }, select: { patientId: true, startsAt: true, status: true } }) : [];
    const resolved = new Set(later.filter((v) => v.patientId && (v.startsAt > now || v.startsAt > firstMissed.get(v.patientId)!)).map((v) => v.patientId as string));
    const open = ids.filter((id) => !resolved.has(id));
    return { state: 'measured', value: open.length, count: open.length, base: ids.length, from, to, lookbackDays: NO_REBOOK_LOOKBACK_DAYS };
  }

  // The number each rule is about (null: not measurable now), for the network view
  async measure(clinicId: string, rule: { kind: string; windowDays: number; hours: number }, now: Date): Promise<{ value: number; ok: boolean } | null> {
    const e = await this.explain(clinicId, rule, now);
    return e?.state === 'measured' ? { value: e.value, ok: true } : null;
  }

  // The "Signals" section: every rule of this clinic, measured now from its own data, with its settings and the Telegram destination. Read
  // only: opening it never sends anything. A plan without the signals gets no numbers.
  async signals(clinicId: string, now = new Date(), userId?: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } });
    if (!hasFeature(c.plan, 'advanced_analytics')) return { inPlan: false, checkedAt: now, sync: null, telegram: null, signals: [] };
    const [rules, sync, chat, people, mine] = await Promise.all([this.alerts(clinicId), this.syncState(clinicId, now), this.staff.chat(clinicId), this.leaders.recipients(clinicId, 'signals'), userId ? this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { signals: true, blockedAt: true } }) : null]);
    const signals = [];
    for (const r of rules) {
      // a rule switched off is not measured: no green or red assessment, only its settings
      const e: SignalExplained | null = r.active ? await this.explain(clinicId, r, now, sync) : null;
      if (r.active && !e) continue;
      const state = !e ? 'off' : e.state === 'measured' ? (e.value >= r.threshold ? 'fired' : 'ok') : e.state;
      const lim = ALERT_LIMITS[r.kind as AlertKind];
      signals.push({
        ...(e ?? {}), kind: r.kind, state, active: r.active, threshold: r.threshold, windowDays: r.windowDays, hours: r.hours,
        // which settings this rule has, with their limits (the screen edits only these)
        limits: lim, telegramOn: r.telegram, emailOn: r.enabled, pushOn: r.push, lastFiredAt: r.lastFiredAt, telegramSentAt: r.telegramSentAt, link: SIGNAL_LINK[r.kind as AlertKind],
      });
    }
    // the section has just measured everything: the menu badge takes this number instead of measuring again
    this.summaryCache.set(clinicId, { at: now.getTime(), sync: sync.lastSyncAt?.getTime() ?? 0, fired: firedCount(signals.map((x) => ({ active: x.active, state: x.state }))) });
    return { inPlan: true, checkedAt: now, sync: { lastSyncAt: sync.lastSyncAt, fresh: sync.fresh, connected: sync.connected }, // who a rule's Telegram switch reaches (the switch is the clinic's, the recipients are each person's own choice): managers through the LANKA
      // service bot (names only) and the legacy staff group of the clinic's patient bot, if one was linked before
      telegram: { serviceBot: this.leaders.available, people: people.map((p) => p.name), group: chat?.title ?? null, me: mine ? { signals: mine.signals && !mine.blockedAt, blocked: !!mine.blockedAt } : null },
      signals };
  }

  // The menu badge: how many switched-on rules show a deviation now (rules, not patients or alerts). The states come from signals() above, so
  // there is no second formula. Kept per clinic for a few minutes so moving around the menu does not measure everything again; a changed rule,
  // a new Cliniccards load (another lastSyncAt) or the section itself refreshes it. A plan without the signals gets no number.
  async signalsSummary(clinicId: string, now = new Date()): Promise<{ inPlan: false } | { inPlan: true; fired: number; checkedAt: Date }> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } });
    if (!hasFeature(c.plan, 'advanced_analytics')) return { inPlan: false };
    const sync = (await this.syncState(clinicId, now)).lastSyncAt?.getTime() ?? 0;
    const hit = this.summaryCache.get(clinicId);
    if (hit && hit.sync === sync && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < SUMMARY_TTL_MS) return { inPlan: true, fired: hit.fired, checkedAt: new Date(hit.at) };
    const v = await this.signals(clinicId, now);
    return { inPlan: true, fired: firedCount(v.signals), checkedAt: now };
  }

  // The alert text: aggregate numbers only (no names, phones or treatment), with the link to the section
  private alertText(kind: string, e: Extract<SignalExplained, { state: 'measured' }>, rule: { threshold: number; windowDays: number; hours: number }) {
    const link = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/signals`;
    const t = {
      CANCEL_RATE: `за останні ${rule.windowDays} дн. скасувань і неявок ${e.value}% від візитів (поріг ${rule.threshold}%).`,
      RETURN_DROP: `кількість завершених візитів за ${rule.windowDays} дн. впала на ${e.value}% порівняно з попереднім періодом (поріг ${rule.threshold}%).`,
      STALE_REQUESTS: `необроблених заявок, що чекають понад ${rule.hours} год.: ${e.value} (поріг ${rule.threshold}).`,
      PAYMENTS_DROP: `отримані оплати за ${rule.windowDays} дн. менші на ${e.value}%, ніж за попередній такий самий період (поріг ${rule.threshold}%).`,
      UNFINISHED_NO_NEXT: `пацієнтів із незавершеним лікуванням без наступного запису понад ${rule.windowDays} дн.: ${e.value} (поріг ${rule.threshold}).`,
      NO_REBOOK: `пацієнтів, які скасували або не прийшли й досі не записані знову: ${e.value} (поріг ${rule.threshold}).`,
      OVERDUE_TASKS: `прострочених завдань команди: ${e.value}, найдавніше — ${e.oldestDays ?? 0} дн. (поріг ${rule.threshold}).`,
      SYNC_OVERDUE: `дані з Cliniccards не оновлювалися ${e.value} год. (поріг ${rule.threshold} год.).`,
    }[kind] ?? '';
    return `Сигнал: ${t}\n\nВідкрити: ${link}`;
  }

  // Checks the rules of one clinic that are switched on (active) and deliver anything. Email and push and Telegram (its own switch) are
  // throttled separately, at most once per 24 hours per rule while it stays triggered. The master switch and the channel are read again in the
  // claim right before sending (a rule switched off meanwhile sends nothing); the alert is claimed first (two runs never send it twice), and
  // only a delivered Telegram message counts as sent. Returns the kinds that delivered.
  async evaluate(clinicId: string, now = new Date()): Promise<string[]> {
    const rules = await this.prisma.alertRule.findMany({ where: { clinicId, active: true, OR: [{ enabled: true }, { push: true }, { telegram: true }] } });
    if (!rules.length) return [];
    const sync = await this.syncState(clinicId, now);
    const quiet = new Date(now.getTime() - COOLDOWN_MS);
    const fired: string[] = [];
    for (const rule of rules) {
      const e = await this.explain(clinicId, rule, now, sync);
      if (e?.state !== 'measured' || e.value < rule.threshold) continue;
      const text = this.alertText(rule.kind, e, rule);
      let delivered = false;
      if (rule.enabled || rule.push) {
        // marked first, so a failing delivery cannot turn into a message every half hour (the existing rule for email and push); the two
        // switches are read again in the claim and each channel is used only when its own switch is on
        const claimed = await this.prisma.alertRule.updateMany({ where: { id: rule.id, active: true, OR: [{ enabled: true }, { push: true }], AND: [{ OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: quiet } }] }] }, data: { lastFiredAt: now, lastValue: e.value } });
        if (claimed.count) {
          const now2 = await this.prisma.alertRule.findUniqueOrThrow({ where: { id: rule.id }, select: { active: true, enabled: true, push: true } });
          if (!now2.active) now2.enabled = now2.push = false;
          delivered = now2.enabled || now2.push;
          // the Push notification carries no numbers or names
          if (now2.push) await this.push.notify(clinicId, { title: 'Сигнал для керівника', body: 'Є відхилення в роботі клініки', url: '/signals', tag: `alert-${rule.kind}` }).catch(() => undefined);
          if (now2.enabled) {
            const owner = await this.prisma.membership.findFirst({ where: { clinicId, role: 'OWNER' }, select: { user: { select: { email: true } } } });
            if (owner) await this.mail.send({ to: owner.user.email, subject: 'LANKA: сигнал для керівника', text }).catch(() => undefined);
          }
          await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.fired', details: { kind: rule.kind, value: e.value, email: now2.enabled, push: now2.push } } });
        }
      }
      if (rule.telegram) {
        const claim = await this.prisma.alertRule.updateMany({
          where: { id: rule.id, active: true, telegram: true, OR: [{ telegramSentAt: null }, { telegramSentAt: { lt: quiet } }], AND: [{ OR: [{ telegramClaimAt: null }, { telegramClaimAt: { lt: new Date(now.getTime() - TELEGRAM_CLAIM_MS) } }] }] },
          data: { telegramClaimAt: now },
        });
        if (claim.count) {
          // two routes: each manager who chose signals in their LANKA service bot (role checked again inside), and the legacy staff group of the
          // clinic's patient bot; delivered when either one confirmed. A rule with no recipient at all sends nothing and is tried again later.
          const personal = await this.leaders.send(clinicId, 'signals', () => text).catch(() => 0);
          const group = await this.staff.deliver(clinicId, text).catch(() => 'failed' as const);
          const outcome = personal > 0 || group === 'sent' ? 'sent' : group;
          if (outcome === 'sent') {
            await this.prisma.alertRule.update({ where: { id: rule.id }, data: { telegramSentAt: now, telegramClaimAt: null, lastValue: e.value } });
            await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.telegram', details: { kind: rule.kind, value: e.value } } });
            delivered = true;
          } else {
            // not delivered: not recorded as sent; the next run tries again
            await this.prisma.alertRule.update({ where: { id: rule.id }, data: { telegramClaimAt: null } });
            await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.telegram_failed', details: { kind: rule.kind, outcome } } });
          }
        }
      }
      if (delivered) fired.push(rule.kind);
    }
    return fired;
  }

  async evaluateAll(now = new Date()) {
    const clinics = await this.prisma.alertRule.findMany({ where: { active: true, OR: [{ enabled: true }, { push: true }, { telegram: true }] }, distinct: ['clinicId'], select: { clinicId: true } });
    for (const c of clinics) {
      const ok = await this.clinicOk(c.clinicId);
      if (!ok.ok || !hasFeature(ok.plan, 'advanced_analytics')) continue;
      await this.evaluate(c.clinicId, now).catch((e) => this.log.warn(`Alerts ${c.clinicId}: ${(e as Error).message}`));
    }
  }
}
