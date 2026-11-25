import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, Provider } from '@prisma/client';
import { DigestService } from '../automations/digest.service';
import { LeaderTelegramService } from '../automations/leader-telegram.service';
import { startOfClinicDay } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { InsightsService } from './insights.service';
import { NO_RESULT_STATUSES } from '../reports/visit-outcome';
import { attentionLines, CurrentIssue, dueAt, IssueChecks, lastCompleted, PeriodKind, PeriodRange, periodOf, previousPeriod, recentPeriods, ReportFacts, reportText } from './period-report-text';
import { SignalLang, signalLang } from './signal-text';

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
// Saved reports per page of the history
const HISTORY_PAGE = 20;
// How many completed periods the workspace offers
const PERIODS_SHOWN = { WEEKLY: 12, MONTHLY: 12 };
// The current issues, in this order, at most three: a signal at its threshold (Pro) or a plain fact of LANKA's data (every plan). A fact covered
// by its signal is not repeated.
const ISSUE_ORDER = ['STALE_REQUESTS', 'OPEN_REQUESTS', 'NO_REBOOK', 'UNFINISHED_NO_NEXT', 'OVERDUE_TASKS', 'OVERDUE', 'UNCLOSED_NOW', 'CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP', 'SYNC_OVERDUE'];
const FACT_OF_SIGNAL: Record<string, string> = { STALE_REQUESTS: 'OPEN_REQUESTS', OVERDUE_TASKS: 'OVERDUE' };

const nextFirst = (first: string) => {
  const [y, m] = first.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
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
    private digest: DigestService,
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

  async settings(clinicId: string, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { weeklyReportOn: true, weeklyReportWeekday: true, weeklyReportHour: true, weeklyReportSince: true, monthlyReportOn: true, monthlyReportHour: true, monthlyReportSince: true } });
    const people = await this.leaders.recipients(clinicId);
    const w = { weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour };
    const m = { weekday: 1, hour: c.monthlyReportHour };
    return {
      // next: the next scheduled sending and its period, as if switched on now when it is off (the preview of switching on)
      weekly: { on: c.weeklyReportOn, weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour, to: people.filter((p) => p.weekly).map((p) => p.name), next: this.next('WEEKLY', w, c.weeklyReportOn ? c.weeklyReportSince : now, now) },
      monthly: { on: c.monthlyReportOn, hour: c.monthlyReportHour, to: people.filter((p) => p.monthly).map((p) => p.name), next: this.next('MONTHLY', m, c.monthlyReportOn ? c.monthlyReportSince : now, now) },
      serviceBot: this.leaders.available,
    };
  }

  // The next scheduled report: the last completed period if its due time is still ahead (and after `since`, the moment of switching on), else
  // the period after it. Never an older period (the late switch-on rule of prepare()).
  next(kind: PeriodKind, cfg: { weekday: number; hour: number }, since: Date | null, now = new Date()) {
    let p = lastCompleted(kind, now);
    let due = dueAt(p, cfg);
    if (due <= now || (since && since > due)) {
      p = periodOf(kind, kind === 'WEEKLY' ? new Date(Date.parse(`${p.from}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : nextFirst(p.from))!;
      due = dueAt(p, cfg);
    }
    return { at: due, from: p.from, to: p.to };
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

  // ---------- moving from the old rolling 7-day weekly digest (2026-11-25) ----------

  // What a move would change for THIS person: the old weekly digest (its day, hour, next sending, a 7-day rolling period) against the weekly
  // report (a completed Monday–Sunday week, its own schedule kept if already on, the next sending, whether the clinic schedule must be switched
  // on first), and the person's state. Read only.
  async legacyWeekly(clinicId: string, userId: string, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { legacyWeeklyOn: true, legacyWeeklyWeekday: true, legacyWeeklyHour: true, lastLegacyWeeklyAt: true, weeklyReportOn: true, weeklyReportWeekday: true, weeklyReportHour: true, weeklyReportSince: true } });
    const me = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { legacyWeekly: true, weekly: true, blockedAt: true, legacyWeeklyMovedAt: true } });
    const legacyChats = await this.prisma.digestRecipient.count({ where: { clinicId, migratedAt: null, legacyWeekly: true } });
    // others already subscribed to the weekly report: switching the clinic's weekly schedule on resumes it for them too (their choice, unchanged)
    const othersSubscribed = (await this.leaders.recipients(clinicId, 'weekly')).filter((r) => r.userId !== userId).length;
    return {
      legacy: c.legacyWeeklyOn,
      old: c.legacyWeeklyOn ? { weekday: c.legacyWeeklyWeekday, hour: c.legacyWeeklyHour, nextAt: this.digest.nextAt('WEEKLY', c.legacyWeeklyHour, c.legacyWeeklyWeekday, c.lastLegacyWeeklyAt, now) } : null,
      weekly: { on: c.weeklyReportOn, weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour, next: this.next('WEEKLY', { weekday: c.weeklyReportWeekday, hour: c.weeklyReportHour }, c.weeklyReportOn ? c.weeklyReportSince : now, now), othersSubscribed },
      me: me ? { connected: !me.blockedAt, receivesOld: c.legacyWeeklyOn && me.legacyWeekly && !me.blockedAt, moved: !!me.legacyWeeklyMovedAt && !me.legacyWeekly, weekly: me.weekly } : null,
      // chats of the clinic's patient bot still on the old weekly: never moved by a name; each person connects the LANKA service bot first
      legacyChats,
    };
  }

  // The person's explicit move: from now on the weekly report instead of the old weekly digest. Only this person's own subscriptions change (the
  // old weekly off, the weekly report on from now); the clinic's weekly schedule is switched on only when asked (owner or manager: the
  // controller), keeps its own day and hour, and then also reaches the people already subscribed to it. The daily digest and the monthly report
  // are not touched; nothing due before is sent. Repeating it changes nothing.
  async moveLegacyWeekly(clinicId: string, userId: string, o: { enableSchedule?: boolean }, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { legacyWeeklyOn: true, weeklyReportOn: true } });
    const me = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } } });
    if (!c.legacyWeeklyOn && !me?.legacyWeekly) throw new BadRequestException('legacy_weekly_none');
    if (!me || me.blockedAt) throw new BadRequestException('leader_tg_not_connected');
    if (!c.weeklyReportOn) {
      if (!o.enableSchedule) throw new BadRequestException('weekly_schedule_off');
      await this.prisma.clinic.updateMany({ where: { id: clinicId, weeklyReportOn: false }, data: { weeklyReportOn: true, weeklyReportSince: now } });
      await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'period_report.schedule', details: { weeklyOn: true, via: 'legacy_weekly_move' } } });
    }
    await this.prisma.leaderTelegram.update({
      where: { id: me.id },
      data: { ...(me.weekly ? {} : { weekly: true, weeklySince: now }), ...(me.legacyWeekly ? { legacyWeekly: false, legacyWeeklyMovedAt: now } : {}) },
    });
    if (me.legacyWeekly) await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'digest.legacy_weekly_moved', details: {} } });
    return this.legacyWeekly(clinicId, userId, now);
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
    // the clinic's name as of the preparation: a saved report shows it even if the clinic is renamed later
    const base = { preparedAt: now.toISOString(), clinicName: await this.clinicName(clinicId), connected: sync.connected, lastSyncAt: sync.lastSyncAt?.toISOString() ?? null };
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

  // A saved report (history, 2026-11-25): the link of a sent message opens exactly this report, never a recalculation
  private runUrl(clinicId: string, runId: string) {
    return `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/period-report/r/${encodeURIComponent(runId)}?c=${encodeURIComponent(clinicId)}`;
  }

  // The exact message of a saved report in one language: rendered once from the saved figures and kept (run.texts[lang]); every later delivery and
  // retry in that language uses the kept text, so neither a template change nor new data alters a report already sent. Two senders at once
  // converge on the first one written.
  private async frozenText(run: { id: string; clinicId: string; kind: string; periodFrom: string; facts: unknown }, lang: SignalLang): Promise<string> {
    const cur = await this.prisma.periodReportRun.findUniqueOrThrow({ where: { id: run.id }, select: { texts: true } });
    const kept = (cur.texts as Record<string, string>)[lang];
    if (typeof kept === 'string') return kept;
    const p = periodOf(run.kind as PeriodKind, run.periodFrom)!;
    const facts = run.facts as unknown as ReportFacts;
    const text = reportText({ clinic: facts.clinicName ?? (await this.clinicName(run.clinicId)), period: p, prevPeriod: previousPeriod(p), facts, url: this.runUrl(run.clinicId, run.id) }, lang);
    await this.prisma.$executeRaw`UPDATE "PeriodReportRun" SET "texts" = "texts" || jsonb_build_object(${lang}::text, ${text}::text) WHERE "id" = ${run.id} AND NOT ("texts" ? ${lang}::text)`;
    const after = await this.prisma.periodReportRun.findUniqueOrThrow({ where: { id: run.id }, select: { texts: true } });
    return (after.texts as Record<string, string>)[lang] ?? text;
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

  // The report to the person's OWN service-bot chat on their explicit request: connected and not blocked, still the owner or a manager (checked
  // again in deliverTo), at most once a minute. It is saved as a MANUAL report of its own (the figures and the exact text sent, visible only to
  // this person) with one delivery; the scheduled report of the period is neither created, changed nor blocked by it.
  async sendToMe(clinicId: string, userId: string, kind: PeriodKind, from: string | undefined, lang: SignalLang, now = new Date()) {
    const me = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { id: true, blockedAt: true } });
    if (!me || me.blockedAt) throw new BadRequestException('leader_tg_not_connected');
    const key = `${clinicId}|${userId}`;
    if (now.getTime() - (this.selfSent.get(key) ?? 0) < SELF_GAP_MS) throw new BadRequestException('too_often');
    const p = this.pick(kind, from, now);
    this.selfSent.set(key, now.getTime());
    const facts = await this.facts(clinicId, p, now);
    const run = await this.prisma.periodReportRun.create({
      data: { clinicId, kind, periodFrom: p.from, periodTo: p.to, scheduledAt: now, state: facts.state, facts: facts as unknown as Prisma.InputJsonValue, source: 'MANUAL', dedupeKey: `MANUAL:${randomUUID()}`, createdById: userId },
    });
    const text = await this.frozenText(run, lang);
    const d = await this.prisma.periodReportDelivery.create({ data: { runId: run.id, clinicId, userId, kind, periodFrom: p.from, lang, claimAt: now } });
    const r = await this.leaders.deliverTo(clinicId, me.id, () => text);
    const status = r === 'sent' ? 'SENT' : r === 'gone' ? 'DROPPED' : r === 'rejected' ? 'FAILED' : 'UNKNOWN';
    await this.prisma.periodReportDelivery.update({ where: { id: d.id }, data: { status, attempts: 1, claimAt: null, ...(r === 'sent' ? { sentAt: now } : {}) } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'period_report.sent_to_self', details: { kind, from: p.from, outcome: r, run: run.id } } });
    if (r !== 'sent') {
      if (r !== 'unknown') this.selfSent.delete(key);
      throw new BadRequestException(r === 'gone' ? 'leader_tg_not_connected' : 'telegram_failed');
    }
    return { sent: true, runId: run.id };
  }

  // ---------- the history ----------

  // What a saved report's deliveries came to, without naming anybody: counts only (a "sent" = accepted by Telegram's service, not read or shown)
  private summary(run: { state: string; createdAt: Date; deliveries: { status: string; attempts: number }[] }, now: Date) {
    const c = { total: run.deliveries.length, sent: 0, failed: 0, unknown: 0, dropped: 0, pending: 0 };
    const open = now.getTime() - run.createdAt.getTime() < RETRY_WINDOW_MS;
    for (const d of run.deliveries) {
      if (d.status === 'SENT') c.sent++;
      else if (d.status === 'UNKNOWN') c.unknown++;
      else if (d.status === 'DROPPED') c.dropped++;
      else if (d.status === 'PENDING' || (d.status === 'FAILED' && d.attempts < DELIVERY_ATTEMPTS && open)) c.pending++;
      else c.failed++;
    }
    const status = !c.total ? 'no_recipients' : c.pending ? 'pending' : c.sent === c.total ? 'sent' : c.sent > 0 ? 'partial' : c.unknown > 0 ? 'unknown' : c.dropped === c.total ? 'cancelled' : 'failed';
    return { status, counts: c };
  }

  // Visible to a person: the clinic's scheduled reports (owner and manager: the controller), and their OWN manual sends
  private visible(clinicId: string, userId: string) {
    return { clinicId, OR: [{ source: 'SCHEDULED' }, { source: 'MANUAL', createdById: userId }] };
  }

  // The history, newest first, a page at a time; nothing is recalculated
  async history(clinicId: string, userId: string, kind: PeriodKind | undefined, page: number, now = new Date()) {
    const where = { ...this.visible(clinicId, userId), ...(kind ? { kind } : {}) };
    const size = HISTORY_PAGE;
    const skip = (Math.max(1, page) - 1) * size;
    const [rows, total] = await Promise.all([
      this.prisma.periodReportRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: size, include: { deliveries: { select: { status: true, attempts: true } } } }),
      this.prisma.periodReportRun.count({ where }),
    ]);
    return {
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / size)),
      items: rows.map((r) => ({ id: r.id, kind: r.kind, from: r.periodFrom, to: r.periodTo, source: r.source, state: r.state, preparedAt: (r.facts as { preparedAt?: string }).preparedAt ?? r.createdAt.toISOString(), ...this.summary(r, now) })),
    };
  }

  // One saved report exactly as prepared: the saved figures, the attention block and its checks as of the preparation, the kept texts per language
  // (with how many deliveries used each, no names or chat ids), the person's own delivery. Another clinic's id or another person's manual send:
  // not found.
  async savedRun(clinicId: string, userId: string, id: string, lang: SignalLang = 'uk', now = new Date()) {
    const r = await this.prisma.periodReportRun.findFirst({ where: { id, ...this.visible(clinicId, userId) }, include: { deliveries: { select: { userId: true, status: true, attempts: true, sentAt: true, lang: true } } } });
    if (!r) throw new NotFoundException('report_not_found');
    const facts = r.facts as unknown as ReportFacts;
    const p = periodOf(r.kind as PeriodKind, r.periodFrom)!;
    const prev = previousPeriod(p);
    const texts = r.texts as Record<string, string>;
    const byLang = new Map<string, number>();
    for (const d of r.deliveries) if (d.lang && d.status === 'SENT') byLang.set(d.lang, (byLang.get(d.lang) ?? 0) + 1);
    const mine = r.deliveries.find((d) => d.userId === userId);
    return {
      id: r.id,
      kind: r.kind,
      source: r.source,
      state: r.state,
      clinic: facts.clinicName ?? null,
      period: { from: p.from, to: p.to, days: p.days },
      prevPeriod: { from: prev.from, to: prev.to, days: prev.days },
      preparedAt: facts.preparedAt ?? r.createdAt.toISOString(),
      facts,
      // what this old snapshot lacks (prepared before the history): told, never filled in from today's data
      missing: [...(facts.clinicName ? [] : ['clinicName']), ...(facts.state === 'READY' && !facts.checks ? ['checks'] : []), ...(Object.keys(texts).length ? [] : ['text'])],
      // the attention block as it was at the preparation (the saved items and checks), in the viewer's language
      attention: facts.state === 'READY' ? attentionLines(facts, lang) : [],
      texts: Object.entries(texts).map(([lang, text]) => ({ lang, text, sentCount: byLang.get(lang) ?? 0 })),
      mine: mine ? { status: mine.status, sentAt: mine.sentAt, lang: mine.lang } : null,
      ...this.summary(r, now),
    };
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
    if (await this.prisma.periodReportRun.findUnique({ where: { clinicId_kind_periodFrom_dedupeKey: { clinicId, kind, periodFrom: p.from, dedupeKey: 'SCHEDULED' } }, select: { id: true } })) return;
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
      where: { clinicId, run: { source: 'SCHEDULED' }, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: DELIVERY_ATTEMPTS }, createdAt: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) }, OR: [{ claimAt: null }, { claimAt: { lt: new Date(now.getTime() - CLAIM_MS) } }] },
      include: { run: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!due.length) return;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { weeklyReportOn: true, monthlyReportOn: true } });
    for (const d of due) {
      const claim = await this.prisma.periodReportDelivery.updateMany({ where: { id: d.id, status: d.status, attempts: d.attempts, claimAt: d.claimAt }, data: { claimAt: now } });
      if (!claim.count) continue;
      const kind = d.kind as PeriodKind;
      const key = subKey(kind);
      const clinicOn = kind === 'WEEKLY' ? clinic.weeklyReportOn : clinic.monthlyReportOn;
      const lt = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId: d.userId } } });
      const subscribed = !!lt && lt[key] && !!lt[`${key}Since`] && lt[`${key}Since`]! <= d.run.scheduledAt;
      let outcome: 'sent' | 'failed' | 'unknown' | 'dropped' = 'dropped';
      let lang: SignalLang | null = null;
      if (clinicOn && subscribed && lt) {
        // the saved report's text in this person's language, the same for every retry
        lang = signalLang(lt.lang);
        const text = await this.frozenText(d.run, lang);
        const r = await this.leaders.deliverTo(clinicId, lt.id, () => text, key).catch(() => 'unknown' as const);
        outcome = r === 'sent' ? 'sent' : r === 'gone' ? 'dropped' : r === 'rejected' ? 'failed' : 'unknown';
      }
      const status = { sent: 'SENT', failed: 'FAILED', unknown: 'UNKNOWN', dropped: 'DROPPED' }[outcome];
      await this.prisma.periodReportDelivery.update({ where: { id: d.id }, data: { status, attempts: { increment: outcome === 'dropped' ? 0 : 1 }, claimAt: null, ...(lang ? { lang } : {}), ...(outcome === 'sent' ? { sentAt: now } : {}) } });
      if (outcome !== 'sent') await this.prisma.auditLog.create({ data: { clinicId, action: 'period_report.delivery_failed', details: { kind, from: d.periodFrom, outcome } } });
    }
  }
}
