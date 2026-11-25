import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma, Provider } from '@prisma/client';
import { LeaderTelegramService } from '../automations/leader-telegram.service';
import { startOfClinicDay } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { InsightsService } from './insights.service';
import { NO_RESULT_STATUSES } from '../reports/visit-outcome';
import { CurrentIssue, dueAt, IssueChecks, lastCompleted, PeriodKind, PeriodRange, periodOf, previousPeriod, recentPeriods, ReportFacts, reportText } from './period-report-text';
import { SignalLang } from './signal-text';

const HOUR = 3_600_000;
// A report is prepared from its due time until this long after it (a short server stop is caught up the same day); an older period is never sent
const CATCH_UP_MS = 12 * HOUR;
// Until this long after the due time the report waits for a Cliniccards load that covers the whole period; then a short notice is sent instead
const WAIT_FOR_DATA_MS = 6 * HOUR;
// A delivery refused by Telegram is tried again at most this many times, only within this time of its run
const DELIVERY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 18 * HOUR;
// A delivery being sent is claimed for this long (two servers never send it twice)
const CLAIM_MS = 10 * 60_000;
// "Send to my Telegram": at most once a minute per person
const SELF_GAP_MS = 60_000;
// How many completed periods the workspace offers
const PERIODS_SHOWN = { WEEKLY: 12, MONTHLY: 12 };
// The current issues, in this order, at most three: a signal at its threshold (Pro) or a plain fact of LANKA's data (every plan). A fact covered
// by its signal is not repeated.
const ISSUE_ORDER = ['STALE_REQUESTS', 'OPEN_REQUESTS', 'NO_REBOOK', 'UNFINISHED_NO_NEXT', 'OVERDUE_TASKS', 'OVERDUE', 'UNCLOSED_NOW', 'CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP', 'SYNC_OVERDUE'];
const FACT_OF_SIGNAL: Record<string, string> = { STALE_REQUESTS: 'OPEN_REQUESTS', OVERDUE_TASKS: 'OVERDUE' };

const subKey = (kind: PeriodKind) => (kind === 'WEEKLY' ? 'weekly' : 'monthly');

// Weekly and monthly reports to the managers through the LANKA service bot (2026-11-25), next to the existing digest (DigestService, kept as
// it is). The clinic's schedule (Clinic.weeklyReport*, monthlyReport*: owner and manager, for everyone) is apart from each person's own
// subscription (LeaderTelegram.weekly / monthly: only that person). The figures come from ReportsService.periodSummary, the same calculation as
// the report page in LANKA.
@Injectable()
export class PeriodReportService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(PeriodReportService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  // clinicId|userId → when a report was last sent to that person on request
  private selfSent = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
    private insights: InsightsService,
    private leaders: LeaderTelegramService,
  ) {}

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((e) => this.log.warn(`Period reports: ${(e as Error).message}`))
        .finally(() => (this.running = false));
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- settings ----------

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { weeklyReportOn: true, weeklyReportWeekday: true, weeklyReportHour: true, monthlyReportOn: true, monthlyReportHour: true } });
    const people = await this.leaders.recipients(clinicId);
    return {
      weekly: { on: c.weeklyReportOn, weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour, to: people.filter((p) => p.weekly).map((p) => p.name) },
      monthly: { on: c.monthlyReportOn, hour: c.monthlyReportHour, to: people.filter((p) => p.monthly).map((p) => p.name) },
      serviceBot: this.leaders.available,
    };
  }

  // The clinic's schedule (the controller allows the owner and the manager). Switching a report on records the moment: a report whose due time is
  // before it is never sent, so switching on never sends an older one. Saving sends nothing.
  async updateSettings(clinicId: string, userId: string, d: { weeklyOn?: boolean; weeklyWeekday?: number; weeklyHour?: number; monthlyOn?: boolean; monthlyHour?: number }) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { weeklyReportOn: true, monthlyReportOn: true } });
    const now = new Date();
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: {
        ...(d.weeklyOn !== undefined ? { weeklyReportOn: d.weeklyOn, ...(d.weeklyOn && !cur.weeklyReportOn ? { weeklyReportSince: now } : {}) } : {}),
        ...(d.weeklyWeekday !== undefined ? { weeklyReportWeekday: d.weeklyWeekday } : {}),
        ...(d.weeklyHour !== undefined ? { weeklyReportHour: d.weeklyHour } : {}),
        ...(d.monthlyOn !== undefined ? { monthlyReportOn: d.monthlyOn, ...(d.monthlyOn && !cur.monthlyReportOn ? { monthlyReportSince: now } : {}) } : {}),
        ...(d.monthlyHour !== undefined ? { monthlyReportHour: d.monthlyHour } : {}),
      },
    });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'period_report.schedule', details: d } });
    return this.settings(clinicId);
  }

  // ---------- the figures ----------

  private async syncInfo(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } }, select: { apiKeyEnc: true, lastSyncAt: true } });
    return { connected: !!i?.apiKeyEnc, lastSyncAt: i?.lastSyncAt ?? null };
  }

  // The figures of period p and of the period before, or STALE when our copy of Cliniccards does not cover the whole period (not connected, or
  // the last successful load is before the period's end): then there are no figures at all, never zeros that only look real
  async facts(clinicId: string, p: PeriodRange, now = new Date()): Promise<ReportFacts> {
    const sync = await this.syncInfo(clinicId);
    const base = { preparedAt: now.toISOString(), connected: sync.connected, lastSyncAt: sync.lastSyncAt?.toISOString() ?? null };
    if (!sync.connected || !sync.lastSyncAt || sync.lastSyncAt < p.end) return { ...base, state: 'STALE', issues: [] };
    const prev = previousPeriod(p);
    const [cur, before, now2] = await Promise.all([this.reports.periodSummary(clinicId, p.since, p.end), this.reports.periodSummary(clinicId, prev.since, prev.end), this.issues(clinicId, now)]);
    return { ...base, state: 'READY', cur, prev: before, issues: now2.issues, checks: now2.checks };
  }

  // What needs attention NOW (at most three): the signals at their threshold (the "Signals" calculation, Pro, switched-on rules only) and plain
  // facts of LANKA's own data; nothing made up when all is well. `checks` says what was really checked, so an empty list after checks that did not
  // run never reads as "no problems": signals not in the plan or all switched off (only the facts were checked), switched-on rules that could not
  // be measured (too little data, an old or missing Cliniccards load), and checks that failed.
  async issues(clinicId: string, now = new Date()): Promise<{ issues: CurrentIssue[]; checks: IssueChecks }> {
    const plan = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan;
    const found = new Map<string, CurrentIssue>();
    const checks: IssueChecks = { signals: 'checked', notMeasured: 0, failed: 0, factsFailed: 0 };
    if (!hasFeature(plan, 'advanced_analytics')) checks.signals = 'not_in_plan';
    else {
      const rules = (await this.insights.alerts(clinicId)).filter((r) => r.active);
      if (!rules.length) checks.signals = 'all_off';
      for (const r of rules) {
        let e: Awaited<ReturnType<InsightsService['explain']>>;
        try {
          e = await this.insights.explain(clinicId, r, now);
        } catch {
          checks.failed++;
          continue;
        }
        if (e?.state !== 'measured') checks.notMeasured++;
        else if (e.value >= r.threshold && e.value > 0) found.set(r.kind, { kind: r.kind, facts: JSON.parse(JSON.stringify(e)), settings: { windowDays: r.windowDays, hours: r.hours } });
      }
    }
    const fact = (q: Promise<number>) => q.catch(() => null);
    const [openRequests, overdue, unclosed] = await Promise.all([
      fact(this.prisma.bookingRequest.count({ where: { clinicId, status: 'NEW', kind: { in: ['BOOKING', 'RESCHEDULE', 'CANCEL', 'HANDOFF'] }, createdAt: { lt: new Date(now.getTime() - 4 * HOUR) } } })),
      fact(this.prisma.task.count({ where: { clinicId, status: 'OPEN', dueDate: { lt: startOfClinicDay(now) } } })),
      fact(this.prisma.visit.count({ where: { clinicId, status: { in: NO_RESULT_STATUSES }, startsAt: { lt: startOfClinicDay(now) } } })),
    ]);
    const facts: [string, number | null][] = [['OPEN_REQUESTS', openRequests], ['OVERDUE', overdue], ['UNCLOSED_NOW', unclosed]];
    for (const [kind, count] of facts) {
      if (count === null) checks.factsFailed++;
      else if (count > 0 && !Object.entries(FACT_OF_SIGNAL).some(([sig, f]) => f === kind && found.has(sig))) found.set(kind, { kind, count });
    }
    return { issues: ISSUE_ORDER.filter((k) => found.has(k)).slice(0, 3).map((k) => found.get(k)!), checks };
  }

  private url(clinicId: string, p: PeriodRange) {
    return `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/period-report?kind=${p.kind}&from=${p.from}&c=${encodeURIComponent(clinicId)}`;
  }

  private async clinicName(clinicId: string) {
    return (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } })).name;
  }

  // A completed period the workspace may open (the default: the last completed one)
  private pick(kind: PeriodKind, from: string | undefined, now: Date): PeriodRange {
    const list = recentPeriods(kind, now, PERIODS_SHOWN[kind]);
    if (!from) return list[0];
    const p = periodOf(kind, from);
    if (!p || !list.some((x) => x.from === p.from)) throw new BadRequestException('bad_period');
    return p;
  }

  // The page of the report and the preview of the exact text: read only, sends nothing
  async preview(clinicId: string, kind: PeriodKind, from: string | undefined, lang: SignalLang, now = new Date()) {
    const p = this.pick(kind, from, now);
    const prev = previousPeriod(p);
    const facts = await this.facts(clinicId, p, now);
    const text = reportText({ clinic: await this.clinicName(clinicId), period: p, prevPeriod: prev, facts, url: this.url(clinicId, p) }, lang);
    return { kind, period: { from: p.from, to: p.to, days: p.days }, prevPeriod: { from: prev.from, to: prev.to, days: prev.days }, periods: recentPeriods(kind, now, PERIODS_SHOWN[kind]).map((x) => ({ from: x.from, to: x.to })), facts, text };
  }

  // The same text to the person's OWN service-bot chat on their explicit request: connected and not blocked, still the owner or a manager
  // (checked again in deliverTo). It neither creates nor marks a scheduled delivery, so the scheduled report still arrives as planned.
  async sendToMe(clinicId: string, userId: string, kind: PeriodKind, from: string | undefined, lang: SignalLang, now = new Date()) {
    const me = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { id: true, blockedAt: true } });
    if (!me || me.blockedAt) throw new BadRequestException('leader_tg_not_connected');
    const key = `${clinicId}|${userId}`;
    if (now.getTime() - (this.selfSent.get(key) ?? 0) < SELF_GAP_MS) throw new BadRequestException('too_often');
    const v = await this.preview(clinicId, kind, from, lang, now);
    this.selfSent.set(key, now.getTime());
    const r = await this.leaders.deliverTo(clinicId, me.id, () => v.text);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'period_report.sent_to_self', details: { kind, from: v.period.from, outcome: r } } });
    if (r !== 'sent') {
      if (r !== 'unknown') this.selfSent.delete(key);
      throw new BadRequestException(r === 'gone' ? 'leader_tg_not_connected' : 'telegram_failed');
    }
    return { sent: true };
  }

  // ---------- the schedule ----------

  private async clinicOk(c: { suspendedAt: Date | null; isDemo: boolean; billingStatus: string | null; paidUntil: Date | null; plan: string }) {
    return !c.suspendedAt && !c.isDemo && !(billingEnforced() && accessBlocked(c as never));
  }

  // Every minute: for each clinic with a report switched on, the last completed period is prepared once when its due time has come (and not
  // more than CATCH_UP_MS ago: only that period, never a history of missed ones); then whatever is due is delivered.
  // scope: one clinic only (tests on a shared database)
  async tick(now = new Date(), scope?: { clinicId: string }) {
    const clinics = await this.prisma.clinic.findMany({
      where: { OR: [{ weeklyReportOn: true }, { monthlyReportOn: true }], ...(scope ? { id: scope.clinicId } : {}) },
      select: { id: true, suspendedAt: true, isDemo: true, billingStatus: true, paidUntil: true, plan: true, weeklyReportOn: true, weeklyReportWeekday: true, weeklyReportHour: true, weeklyReportSince: true, monthlyReportOn: true, monthlyReportHour: true, monthlyReportSince: true },
    });
    for (const c of clinics) {
      if (!(await this.clinicOk(c))) continue;
      const kinds: [PeriodKind, boolean, { weekday: number; hour: number }, Date | null][] = [
        ['WEEKLY', c.weeklyReportOn, { weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour }, c.weeklyReportSince],
        ['MONTHLY', c.monthlyReportOn, { weekday: 1, hour: c.monthlyReportHour }, c.monthlyReportSince],
      ];
      for (const [kind, on, cfg, since] of kinds) {
        if (!on) continue;
        await this.prepare(c.id, kind, cfg, since, now).catch((e) => this.log.warn(`Period report ${kind} ${c.id}: ${(e as Error).message}`));
      }
    }
    const pending = await this.prisma.periodReportDelivery.findMany({ where: { status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: DELIVERY_ATTEMPTS }, createdAt: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) }, ...(scope ? { clinicId: scope.clinicId } : {}) }, distinct: ['clinicId'], select: { clinicId: true } });
    for (const p of pending) await this.deliverPending(p.clinicId, now).catch((e) => this.log.warn(`Period report delivery ${p.clinicId}: ${(e as Error).message}`));
  }

  private async prepare(clinicId: string, kind: PeriodKind, cfg: { weekday: number; hour: number }, since: Date | null, now: Date) {
    const p = lastCompleted(kind, now);
    const due = dueAt(p, cfg);
    if (now < due || now.getTime() - due.getTime() > CATCH_UP_MS) return;
    // switched on after the due time: this period is not sent (the next one is)
    if (!since || since > due) return;
    if (await this.prisma.periodReportRun.findUnique({ where: { clinicId_kind_periodFrom: { clinicId, kind, periodFrom: p.from } }, select: { id: true } })) return;
    const facts = await this.facts(clinicId, p, now);
    // the data does not cover the period yet: wait for the morning load, then send a short notice instead of figures
    if (facts.state === 'STALE' && facts.connected && now.getTime() - due.getTime() < WAIT_FOR_DATA_MS) return;
    const key = subKey(kind);
    // the recipients as of now, each only if their own subscription started before the due time
    const people = (await this.leaders.recipients(clinicId, key)).filter((r) => (r[`${key}Since`] ?? null) !== null && r[`${key}Since`]! <= due);
    try {
      await this.prisma.$transaction(async (tx) => {
        const run = await tx.periodReportRun.create({ data: { clinicId, kind, periodFrom: p.from, periodTo: p.to, scheduledAt: due, state: facts.state, facts: facts as unknown as Prisma.InputJsonValue } });
        if (people.length) await tx.periodReportDelivery.createMany({ data: people.map((r) => ({ runId: run.id, clinicId, userId: r.userId, kind, periodFrom: p.from })), skipDuplicates: true });
      });
      await this.prisma.auditLog.create({ data: { clinicId, action: 'period_report.prepared', details: { kind, from: p.from, state: facts.state, recipients: people.length } } });
    } catch (e) {
      // another server prepared it at the same moment: theirs stands
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }

  // Sends what is due, each delivery claimed first; the clinic's switch, the person's subscription, role, connection and the bot are checked again
  // right before sending (anything gone: dropped). A definite refusal is retried; "may have arrived" is not.
  async deliverPending(clinicId: string, now = new Date()) {
    const due = await this.prisma.periodReportDelivery.findMany({
      where: { clinicId, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: DELIVERY_ATTEMPTS }, createdAt: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) }, OR: [{ claimAt: null }, { claimAt: { lt: new Date(now.getTime() - CLAIM_MS) } }] },
      include: { run: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!due.length) return;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, weeklyReportOn: true, monthlyReportOn: true } });
    for (const d of due) {
      const claim = await this.prisma.periodReportDelivery.updateMany({ where: { id: d.id, status: d.status, attempts: d.attempts, claimAt: d.claimAt }, data: { claimAt: now } });
      if (!claim.count) continue;
      const kind = d.kind as PeriodKind;
      const key = subKey(kind);
      const clinicOn = kind === 'WEEKLY' ? clinic.weeklyReportOn : clinic.monthlyReportOn;
      const lt = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId: d.userId } } });
      const subscribed = !!lt && lt[key] && !!lt[`${key}Since`] && lt[`${key}Since`]! <= d.run.scheduledAt;
      let outcome: 'sent' | 'failed' | 'unknown' | 'dropped' = 'dropped';
      if (clinicOn && subscribed && lt) {
        const p = periodOf(kind, d.periodFrom)!;
        const text = (lang: SignalLang) => reportText({ clinic: clinic.name, period: p, prevPeriod: previousPeriod(p), facts: d.run.facts as unknown as ReportFacts, url: this.url(clinicId, p) }, lang);
        const r = await this.leaders.deliverTo(clinicId, lt.id, text, key).catch(() => 'unknown' as const);
        outcome = r === 'sent' ? 'sent' : r === 'gone' ? 'dropped' : r === 'rejected' ? 'failed' : 'unknown';
      }
      const status = { sent: 'SENT', failed: 'FAILED', unknown: 'UNKNOWN', dropped: 'DROPPED' }[outcome];
      await this.prisma.periodReportDelivery.update({ where: { id: d.id }, data: { status, attempts: { increment: outcome === 'dropped' ? 0 : 1 }, claimAt: null, ...(outcome === 'sent' ? { sentAt: now } : {}) } });
      if (outcome !== 'sent') await this.prisma.auditLog.create({ data: { clinicId, action: 'period_report.delivery_failed', details: { kind, from: d.periodFrom, outcome } } });
    }
  }
}
