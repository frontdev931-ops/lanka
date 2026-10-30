import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import { MailService } from '../auth/mail.service';
import { StaffNotifierService } from '../automations/staff-notifier.service';
import { Lang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { ROW_LIMIT_MAX, ReportBuilderService, ReportSpec } from '../report-builder/report-builder.service';
import { toPdf, toXlsx } from '../reports/report-export';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { Frequency, nextRun } from './schedule';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_SCHEDULES = 20;
const MAX_RECIPIENTS = 5;
const COOLDOWN_MS = 24 * HOUR;
// A rule on a handful of visits is noise: it needs at least this many in the period
const MIN_SAMPLE = 10;
const LANG: Lang = 'uk';

export const ALERT_KINDS = ['CANCEL_RATE', 'RETURN_DROP', 'STALE_REQUESTS'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
const ALERT_DEFAULTS: Record<AlertKind, { threshold: number; windowDays: number; hours: number }> = {
  CANCEL_RATE: { threshold: 25, windowDays: 7, hours: 4 },
  RETURN_DROP: { threshold: 30, windowDays: 14, hours: 4 },
  STALE_REQUESTS: { threshold: 3, windowDays: 7, hours: 4 },
};

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

  constructor(
    private prisma: PrismaService,
    private builder: ReportBuilderService,
    private mail: MailService,
    private staff: StaffNotifierService,
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
    return this.prisma.alertRule.findMany({ where: { clinicId }, orderBy: { kind: 'asc' }, select: { kind: true, threshold: true, windowDays: true, hours: true, enabled: true, lastFiredAt: true, lastValue: true } });
  }

  async updateAlert(clinicId: string, userId: string, kind: string, d: { enabled?: boolean; threshold?: number; windowDays?: number; hours?: number }) {
    if (!ALERT_KINDS.includes(kind as AlertKind)) throw new NotFoundException('alert_not_found');
    const { plan } = await this.clinicOk(clinicId);
    if (d.enabled && !hasFeature(plan, 'advanced_analytics')) throw new BadRequestException('plan_feature');
    if (d.threshold !== undefined && !(d.threshold > 0 && d.threshold <= 1000)) throw new BadRequestException('bad_alert');
    if (d.windowDays !== undefined && !(Number.isInteger(d.windowDays) && d.windowDays >= 3 && d.windowDays <= 60)) throw new BadRequestException('bad_alert');
    if (d.hours !== undefined && !(Number.isInteger(d.hours) && d.hours >= 1 && d.hours <= 72)) throw new BadRequestException('bad_alert');
    await this.alerts(clinicId);
    await this.prisma.alertRule.update({ where: { clinicId_kind: { clinicId, kind } }, data: d });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'alert.changed', details: { kind, ...d } } });
  }

  // The number each rule is about, calculated from our copy of the clinic's data
  async measure(clinicId: string, rule: { kind: string; windowDays: number; hours: number }, now: Date): Promise<{ value: number; ok: boolean } | null> {
    const win = rule.windowDays * DAY;
    if (rule.kind === 'CANCEL_RATE') {
      const rows = await this.prisma.visit.groupBy({ by: ['status'], where: { clinicId, startsAt: { gte: new Date(now.getTime() - win), lt: now }, status: { in: ['VISITED', 'IN_CLINIC', 'IN_CHAIR', 'DID_NOT_COME', 'CANCELLED', 'MOVED'] } }, _count: true });
      const total = rows.reduce((s, r) => s + r._count, 0);
      if (total < MIN_SAMPLE) return null;
      const bad = rows.filter((r) => r.status === 'DID_NOT_COME' || r.status === 'CANCELLED').reduce((s, r) => s + r._count, 0);
      return { value: Math.round((bad / total) * 1000) / 10, ok: true };
    }
    if (rule.kind === 'RETURN_DROP') {
      const done = (from: Date, to: Date) => this.prisma.visit.count({ where: { clinicId, status: 'VISITED', startsAt: { gte: from, lt: to } } });
      const [cur, prev] = await Promise.all([done(new Date(now.getTime() - win), now), done(new Date(now.getTime() - 2 * win), new Date(now.getTime() - win))]);
      if (prev < MIN_SAMPLE) return null;
      return { value: Math.round(((prev - cur) / prev) * 1000) / 10, ok: true };
    }
    if (rule.kind === 'STALE_REQUESTS') {
      return { value: await this.prisma.bookingRequest.count({ where: { clinicId, status: 'NEW', kind: { in: ['BOOKING', 'RESCHEDULE', 'CANCEL', 'HANDOFF'] }, createdAt: { lt: new Date(now.getTime() - rule.hours * HOUR) } } }), ok: true };
    }
    return null;
  }

  private alertText(kind: string, value: number, rule: { threshold: number; windowDays: number; hours: number }) {
    if (kind === 'CANCEL_RATE') return `Сигнал: за останні ${rule.windowDays} дн. скасувань і неявок ${value}% від візитів (поріг ${rule.threshold}%).`;
    if (kind === 'RETURN_DROP') return `Сигнал: кількість завершених візитів за ${rule.windowDays} дн. впала на ${value}% порівняно з попереднім періодом (поріг ${rule.threshold}%).`;
    return `Сигнал: необроблених заявок, що чекають понад ${rule.hours} год.: ${value} (поріг ${rule.threshold}).`;
  }

  // Checks the enabled rules of one clinic. A rule that fired is quiet for 24 hours. Returns the kinds that fired.
  async evaluate(clinicId: string, now = new Date()): Promise<string[]> {
    const rules = await this.prisma.alertRule.findMany({ where: { clinicId, enabled: true } });
    const fired: string[] = [];
    for (const rule of rules) {
      if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < COOLDOWN_MS) continue;
      const m = await this.measure(clinicId, rule, now);
      if (!m || m.value < rule.threshold) continue;
      // marked first, so a failing delivery cannot turn into a message every half hour
      await this.prisma.alertRule.update({ where: { id: rule.id }, data: { lastFiredAt: now, lastValue: m.value } });
      fired.push(rule.kind);
      const text = this.alertText(rule.kind, m.value, rule);
      await this.staff.notify(clinicId, `${text}\n\nВідкрити: ${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/analytics`).catch(() => undefined);
      // the phone notification carries no numbers or names
      await this.push.notify(clinicId, { title: 'Сигнал для керівника', body: 'Є відхилення в роботі клініки', url: '/analytics', tag: `alert-${rule.kind}` }).catch(() => undefined);
      const owner = await this.prisma.membership.findFirst({ where: { clinicId, role: 'OWNER' }, select: { user: { select: { email: true } } } });
      if (owner) await this.mail.send({ to: owner.user.email, subject: 'LANKA: сигнал для керівника', text });
      await this.prisma.auditLog.create({ data: { clinicId, action: 'alert.fired', details: { kind: rule.kind, value: m.value } } });
    }
    return fired;
  }

  async evaluateAll(now = new Date()) {
    const clinics = await this.prisma.alertRule.findMany({ where: { enabled: true }, distinct: ['clinicId'], select: { clinicId: true } });
    for (const c of clinics) {
      if (!(await this.clinicOk(c.clinicId)).ok) continue;
      await this.evaluate(c.clinicId, now).catch((e) => this.log.warn(`Alerts ${c.clinicId}: ${(e as Error).message}`));
    }
  }
}
