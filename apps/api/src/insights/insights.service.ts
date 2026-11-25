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
import { KNOWN_RESULT_STATUSES, MISSED_STATUSES } from '../reports/visit-outcome';
import { eventText, overviewText, pushTitle, SignalFacts, SignalLang, SignalSettings, signalUrl } from './signal-text';

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
// A delivery being sent is claimed for this long, so two scheduler runs never send it twice; the outcome releases the claim
const TELEGRAM_CLAIM_MS = 10 * 60_000;
// A rule on a handful of visits or payments is noise: it needs at least this many in the period it compares with
const MIN_SAMPLE = 10;
// The cancellations and no-shows "without rebooking" are looked for in this many past days (shown on the signal)
const NO_REBOOK_LOOKBACK_DAYS = 30;
// The unfinished treatment of the "Unfinished treatment" report: plan items done within this many days
const UNFINISHED_LOOKBACK_DAYS = 180;
const LANG: Lang = 'uk';
// A delivery refused by the channel is tried again at most this many times (only within a day of its event)
const DELIVERY_ATTEMPTS = 3;
// The signal details list at most this many patients (the total is always shown)
const DETAILS_LIMIT = 300;
// "Send the current state to me": at most once a minute per person
const OVERVIEW_GAP_MS = 60_000;
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
  // clinicId|userId → when the current state was last sent to that person's own Telegram
  private overviewSent = new Map<string, number>();

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
    // A changed condition, the rule switched on again or a channel switched on starts from a new baseline: the next check only records the
    // state, so nothing that had accumulated is sent because of the change (switching channels off keeps the state)
    const fresh = d.threshold !== undefined || d.windowDays !== undefined || d.hours !== undefined || d.active === true || d.enabled === true || d.push === true || d.telegram === true;
    await this.prisma.alertRule.update({ where: { clinicId_kind: { clinicId, kind } }, data: { ...d, ...(fresh ? { evalState: null, evalValue: null, evalAt: null } : {}) } });
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
      const rows = await this.prisma.visit.groupBy({ by: ['status'], where: { clinicId, startsAt: { gte: from, lt: today }, status: { in: KNOWN_RESULT_STATUSES } }, _count: true });
      const total = rows.reduce((n, r) => n + r._count, 0);
      if (total < MIN_SAMPLE) return { state: 'insufficient', from, to: today, base: total, need: MIN_SAMPLE };
      const bad = rows.filter((r) => MISSED_STATUSES.includes(r.status)).reduce((n, r) => n + r._count, 0);
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
      const { waiting, base } = await this.unfinished(clinicId, rule.windowDays, now);
      return { state: 'measured', value: waiting.length, count: waiting.length, base, oldestDays: waiting.reduce((m, r) => Math.max(m, r.daysSince), 0), lookbackDays: UNFINISHED_LOOKBACK_DAYS };
    }
    // NO_REBOOK: patients whose cancelled or missed visit (within the lookback, at least windowDays ago) has no later completed visit and no
    // future active one; each patient once
    const r = await this.noRebook(clinicId, rule.windowDays, now);
    return { state: 'measured', value: r.open.length, count: r.open.length, base: r.base, from: r.from, to: r.to, lookbackDays: NO_REBOOK_LOOKBACK_DAYS };
  }

  // The patients of "Cancelled or missed without rebooking": a cancelled or missed visit (within the lookback, at least windowDays ago) and no
  // later completed visit and no future active one; each patient once, with the first such visit. The signal counts this list and its details
  // page shows it, so the number and the list never differ.
  private async noRebook(clinicId: string, windowDays: number, now: Date) {
    const today = startOfClinicDay(now);
    const from = new Date(today.getTime() - NO_REBOOK_LOOKBACK_DAYS * DAY);
    const to = new Date(today.getTime() - windowDays * DAY);
    const missed = await this.prisma.visit.findMany({ where: { clinicId, status: { in: ['CANCELLED', 'DID_NOT_COME'] }, startsAt: { gte: from, lt: to }, patient: { removedAt: null } }, select: { patientId: true, startsAt: true } });
    const firstMissed = new Map<string, Date>();
    for (const m of missed) if (m.patientId && (!firstMissed.has(m.patientId) || m.startsAt < firstMissed.get(m.patientId)!)) firstMissed.set(m.patientId, m.startsAt);
    const ids = [...firstMissed.keys()];
    const later = ids.length ? await this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids }, OR: [{ status: 'VISITED' }, { startsAt: { gt: now }, status: { notIn: INACTIVE_VISIT } }] }, select: { patientId: true, startsAt: true, status: true } }) : [];
    const resolved = new Set(later.filter((v) => v.patientId && (v.startsAt > now || v.startsAt > firstMissed.get(v.patientId)!)).map((v) => v.patientId as string));
    const open = ids.filter((id) => !resolved.has(id)).map((id) => ({ patientId: id, missedAt: firstMissed.get(id)! })).sort((a, b) => a.missedAt.getTime() - b.missedAt.getTime());
    return { open, base: ids.length, from, to };
  }
  private async noRebookList(clinicId: string, windowDays: number, now: Date) {
    return (await this.noRebook(clinicId, windowDays, now)).open;
  }

  // The patients of "Unfinished treatment without a next visit": the "Unfinished treatment" report's own definition (open plan items while some
  // work is already done, no future visit and no active reminder), then only patients with a completed visit whose last completed work is at
  // least windowDays old. One calculation for the signal and its details page.
  private async unfinished(clinicId: string, windowDays: number, now: Date) {
    const rows = await this.reports.unfinishedForSignals(clinicId, UNFINISHED_LOOKBACK_DAYS);
    const ids = rows.map((r) => r.patientId);
    const visited = new Set((await this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids }, status: 'VISITED', startsAt: { lt: now } }, select: { patientId: true }, distinct: ['patientId'] })).map((v) => v.patientId));
    const waiting = rows.filter((r) => visited.has(r.patientId) && r.daysSince >= windowDays).sort((a, b) => b.daysSince - a.daysSince);
    return { waiting, base: rows.filter((r) => visited.has(r.patientId)).length };
  }
  private async unfinishedList(clinicId: string, windowDays: number, now: Date) {
    return (await this.unfinished(clinicId, windowDays, now)).waiting;
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

  // ---------- events and delivery ----------

  // Checks the switched-on rules of one clinic that have a channel and notifies only on a NEW deviation. The state of each rule (evalState) is
  // kept apart from what deserves a message:
  // - the first successful measurement under the current settings only records the state (nothing accumulated is ever sent: a new channel, a
  //   new recipient, changed settings or this deploy start from here);
  // - normal → deviation creates one SignalEvent with its recipients fixed at that moment; a deviation that stays is not sent again;
  // - deviation → normal records the recovery; a later crossing is a new event (but not sooner than COOLDOWN_MS after the previous one, the
  //   existing once-a-day limit, so a value hovering at the threshold does not message every half hour);
  // - too little data, an old Cliniccards load or an error change nothing (they are not a recovery).
  // The change of state is a compare-and-set on the previous state, so two runs at once create one event. Returns the kinds that got an event.
  async evaluate(clinicId: string, now = new Date()): Promise<string[]> {
    const rules = await this.prisma.alertRule.findMany({ where: { clinicId, active: true, OR: [{ enabled: true }, { push: true }, { telegram: true }] } });
    const created: string[] = [];
    if (rules.length) {
      const sync = await this.syncState(clinicId, now);
      for (const rule of rules) {
        let e: SignalExplained | null;
        try {
          e = await this.explain(clinicId, rule, now, sync);
        } catch (err) {
          this.log.warn(`Signal ${rule.kind}: ${(err as Error).message}`);
          continue;
        }
        if (e?.state !== 'measured') continue;
        const fired = e.value >= rule.threshold;
        const next = fired ? 'FIRED' : 'OK';
        // the state this run read: the update applies only if nobody changed it meanwhile (another run, a settings change)
        const cas = { id: rule.id, active: true, evalState: rule.evalState, evalAt: rule.evalAt };
        if (rule.evalState !== 'OK' || !fired) {
          // baseline, a deviation that stays, normal that stays, or a recovery: the state only
          await this.prisma.alertRule.updateMany({ where: cas, data: { evalState: next, evalValue: e.value, evalAt: now } });
          continue;
        }
        // normal → deviation; within a day of the previous event it is recorded but not sent again
        const recent = !!rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < COOLDOWN_MS;
        const event = await this.prisma.$transaction(async (tx) => {
          const won = await tx.alertRule.updateMany({ where: cas, data: { evalState: 'FIRED', evalValue: e.value, evalAt: now, ...(recent ? {} : { lastFiredAt: now, lastValue: e.value }) } });
          if (!won.count) return 'lost' as const;
          if (recent) return null;
          const ev = await tx.signalEvent.create({
            data: { clinicId, kind: rule.kind, value: e.value, prevValue: rule.evalValue, prevAt: rule.evalAt, facts: JSON.parse(JSON.stringify(e)), settings: { threshold: rule.threshold, windowDays: rule.windowDays, hours: rule.hours } },
          });
          const targets = await this.recipientsOf(clinicId, rule);
          if (targets.length) await tx.signalDelivery.createMany({ data: targets.map((t) => ({ eventId: ev.id, clinicId, ...t })), skipDuplicates: true });
          return ev;
        });
        if (event === 'lost') continue;
        if (event) {
          created.push(rule.kind);
          await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.fired', details: { kind: rule.kind, value: e.value, event: event.id } } });
        } else if (recent) {
          await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.repeat_suppressed', details: { kind: rule.kind, value: e.value } } });
        }
      }
    }
    this.summaryCache.delete(clinicId);
    await this.deliverPending(clinicId, now);
    return created;
  }

  // Who receives an event, fixed when it is created: each manager who chose signals in the LANKA service bot and the legacy staff group (the
  // Telegram switch), the owner's email, the clinic's Push subscriptions
  private async recipientsOf(clinicId: string, rule: { telegram: boolean; enabled: boolean; push: boolean }) {
    const out: { channel: string; target: string }[] = [];
    if (rule.telegram) {
      for (const r of await this.leaders.recipients(clinicId, 'signals')) out.push({ channel: 'TG_LEADER', target: r.id });
      if (await this.staff.chat(clinicId)) out.push({ channel: 'TG_GROUP', target: 'group' });
    }
    if (rule.enabled) {
      const owner = await this.prisma.membership.findFirst({ where: { clinicId, role: 'OWNER' }, select: { userId: true } });
      if (owner) out.push({ channel: 'EMAIL', target: owner.userId });
    }
    if (rule.push) out.push({ channel: 'PUSH', target: 'clinic' });
    return out;
  }

  // Sends what is due: new deliveries and definite refusals not yet tried DELIVERY_ATTEMPTS times, of events younger than a day. Each row is
  // claimed first (two runs never send it twice); a failure of one recipient never repeats the message to those who already got it. The rule and
  // its channel are read again right before sending (switched off meanwhile: dropped).
  async deliverPending(clinicId: string, now = new Date()) {
    const due = await this.prisma.signalDelivery.findMany({
      where: { clinicId, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: DELIVERY_ATTEMPTS }, createdAt: { gt: new Date(now.getTime() - DAY) }, OR: [{ claimAt: null }, { claimAt: { lt: new Date(now.getTime() - TELEGRAM_CLAIM_MS) } }] },
      include: { event: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!due.length) return;
    const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } });
    for (const d of due) {
      const claim = await this.prisma.signalDelivery.updateMany({ where: { id: d.id, status: d.status, attempts: d.attempts, claimAt: d.claimAt }, data: { claimAt: now } });
      if (!claim.count) continue;
      const rule = await this.prisma.alertRule.findUnique({ where: { clinicId_kind: { clinicId, kind: d.event.kind } }, select: { active: true, telegram: true, enabled: true, push: true } });
      const on = !!rule?.active && (d.channel === 'EMAIL' ? rule.enabled : d.channel === 'PUSH' ? rule.push : rule.telegram);
      const text = (lang: SignalLang) => eventText({ clinic: clinic?.name ?? 'LANKA', kind: d.event.kind, facts: d.event.facts as unknown as SignalFacts, settings: d.event.settings as unknown as SignalSettings, prevValue: d.event.prevValue, prevAt: d.event.prevAt, url: signalUrl(d.event.kind, clinicId, d.event.id) }, lang);
      let outcome: 'sent' | 'failed' | 'unknown' | 'dropped';
      let error: string | null = null;
      if (!on) outcome = 'dropped';
      else if (d.channel === 'TG_LEADER') {
        const r = await this.leaders.deliverTo(clinicId, d.target, text, 'signals').catch(() => 'unknown' as const);
        outcome = r === 'sent' ? 'sent' : r === 'gone' ? 'dropped' : r === 'rejected' ? 'failed' : 'unknown';
      } else if (d.channel === 'TG_GROUP') {
        const r = await this.staff.deliver(clinicId, text(LANG)).catch(() => 'unknown' as const);
        outcome = r === 'sent' ? 'sent' : r === 'none' ? 'dropped' : r === 'rejected' ? 'failed' : 'unknown';
      } else if (d.channel === 'EMAIL') {
        const user = await this.prisma.membership.findFirst({ where: { clinicId, userId: d.target, role: 'OWNER' }, select: { user: { select: { email: true } } } });
        if (!user) outcome = 'dropped';
        else {
          try {
            await this.mail.send({ to: user.user.email, subject: `LANKA: ${pushTitle(d.event.kind)}`, text: text(LANG) });
            outcome = 'sent';
          } catch (e) {
            outcome = 'failed';
            error = (e as Error).message.slice(0, 200);
          }
        }
      } else {
        // the Push notification carries no numbers or names
        await this.push.notify(clinicId, { title: pushTitle(d.event.kind), body: 'Є відхилення в роботі клініки', url: `/signals/${d.event.kind}?c=${clinicId}&e=${d.event.id}`, tag: `alert-${d.event.kind}` }).catch(() => undefined);
        outcome = 'sent';
      }
      const status = { sent: 'SENT', failed: 'FAILED', unknown: 'UNKNOWN', dropped: 'DROPPED' }[outcome];
      await this.prisma.signalDelivery.update({ where: { id: d.id }, data: { status, attempts: { increment: outcome === 'dropped' ? 0 : 1 }, claimAt: null, ...(outcome === 'sent' ? { sentAt: now } : {}), lastError: error } });
      if (outcome === 'sent' && d.channel.startsWith('TG_')) await this.prisma.alertRule.updateMany({ where: { clinicId, kind: d.event.kind }, data: { telegramSentAt: now } });
      if (outcome !== 'sent') await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.delivery_failed', details: { kind: d.event.kind, channel: d.channel, outcome } } });
    }
  }

  // ---------- signal details and the current state ----------

  // One signal opened from a message or the section: the same measurement, the exact condition, the matching section and, for the patient
  // rules, the very patients the rule counted (names only inside the app, never in a message or a link). With the event of a message, what
  // that message showed, since the data may have changed after it was sent.
  async details(clinicId: string, kind: string, eventId: string | undefined, now = new Date()) {
    if (!ALERT_KINDS.includes(kind as AlertKind)) throw new NotFoundException('alert_not_found');
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, name: true } });
    if (!hasFeature(c.plan, 'advanced_analytics')) return { inPlan: false as const, kind };
    await this.alerts(clinicId);
    const rule = await this.prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId, kind } } });
    const sync = await this.syncState(clinicId, now);
    const e = rule.active ? await this.explain(clinicId, rule, now, sync) : null;
    const state = !e ? 'off' : e.state === 'measured' ? (e.value >= rule.threshold ? 'fired' : 'ok') : e.state;
    // the event must be this clinic's and this rule's; anything else is ignored
    const ev = eventId ? await this.prisma.signalEvent.findFirst({ where: { id: eventId, clinicId, kind }, select: { createdAt: true, value: true } }) : null;
    let patients: { id: string; name: string; at: Date | null; days: number | null }[] | undefined;
    let total: number | undefined;
    if (rule.active && e?.state === 'measured' && (kind === 'NO_REBOOK' || kind === 'UNFINISHED_NO_NEXT')) {
      const rows = kind === 'NO_REBOOK'
        ? (await this.noRebookList(clinicId, rule.windowDays, now)).map((r) => ({ id: r.patientId, at: r.missedAt as Date | null, days: Math.floor((startOfClinicDay(now).getTime() - r.missedAt.getTime()) / DAY) + 1 }))
        : (await this.unfinishedList(clinicId, rule.windowDays, now)).map((r) => ({ id: r.patientId, at: null as Date | null, days: r.daysSince as number | null }));
      total = rows.length;
      const shown = rows.slice(0, DETAILS_LIMIT);
      const names = new Map((await this.prisma.patient.findMany({ where: { clinicId, id: { in: shown.map((r) => r.id) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
      patients = shown.map((r) => ({ ...r, name: names.get(r.id) ?? '—' }));
    }
    return {
      ...(e ?? {}), inPlan: true as const, kind, clinic: c.name, checkedAt: now, state, active: rule.active, threshold: rule.threshold, windowDays: rule.windowDays, hours: rule.hours,
      sync: { lastSyncAt: sync.lastSyncAt, fresh: sync.fresh }, link: SIGNAL_LINK[kind as AlertKind],
      event: ev ? { at: ev.createdAt, value: ev.value } : null, patients, total, limit: DETAILS_LIMIT,
    };
  }

  // "Current state of signals" as one text, from the same measurements as the section (read only)
  async overview(clinicId: string, lang: SignalLang, now = new Date()) {
    const v = await this.signals(clinicId, now);
    if (!v.inPlan) return { inPlan: false as const };
    const clinic = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } })).name;
    const list = v.signals.map((s) => ({ kind: s.kind, state: s.state, active: s.active, facts: 'value' in s && typeof s.value === 'number' ? (s as unknown as SignalFacts) : undefined, settings: { windowDays: s.windowDays, hours: s.hours } }));
    const url = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/signals?c=${encodeURIComponent(clinicId)}`;
    return { inPlan: true as const, checkedAt: now, text: overviewText({ clinic, at: now, url, signals: list }, lang) };
  }

  // Sends the current state to the person's OWN service-bot chat, only on their explicit request: their connection for this clinic must exist,
  // not be blocked, and they must still be the owner or a manager (checked again in deliverTo). At most once a minute per person.
  async sendOverview(clinicId: string, userId: string, lang: SignalLang, now = new Date()) {
    const me = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { id: true, blockedAt: true } });
    if (!me || me.blockedAt) throw new BadRequestException('leader_tg_not_connected');
    const key = `${clinicId}|${userId}`;
    const last = this.overviewSent.get(key) ?? 0;
    if (now.getTime() - last < OVERVIEW_GAP_MS) throw new BadRequestException('too_often');
    const o = await this.overview(clinicId, lang, now);
    if (!o.inPlan) throw new BadRequestException('plan_feature');
    this.overviewSent.set(key, now.getTime());
    const r = await this.leaders.deliverTo(clinicId, me.id, () => o.text);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'alert.overview_sent', details: { outcome: r } } });
    if (r !== 'sent') {
      if (r !== 'unknown') this.overviewSent.delete(key);
      throw new BadRequestException(r === 'gone' ? 'leader_tg_not_connected' : 'telegram_failed');
    }
    return { sent: true };
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
