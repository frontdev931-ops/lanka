import { ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import { MailService } from '../auth/mail.service';
import { AiService } from '../ai/ai.service';
import { AssistantService } from '../ai/assistant.service';
import { clinicDate } from '../common/clinic-time';
import { Lang } from '../common/i18n';
import { Cur, MoneyTotal, clinicMoneyCurrency, effectiveCurrency, formatTotals, sumByCurrency } from '../common/money';
import { InsightsService } from '../insights/insights.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportBuilderService, ReportSpec } from '../report-builder/report-builder.service';
import { finishCurrency } from '../reports/report-currency';
import { Report, ReportsService } from '../reports/reports.service';
import { hasFeature, networkMonthlyUah } from '../service/plans';

const DAY = 86_400_000;
// The roles that see a branch in the network views: the management roles, the same ones that see money in a clinic (report builder MONEY_ROLES)
export const NETWORK_ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.ANALYST];

export interface Branch {
  id: string;
  name: string;
  role: Role;
}

const T: Record<Lang, { joined: (names: string) => string; records: string; branch: string; skipped: (names: string) => string; total: string }> = {
  uk: {
    joined: (n) => `Об'єднано філіали: ${n}`,
    records: 'Пацієнти рахуються як записи філіалів: одна людина, яка лікується у двох філіалах, — це два записи (особи між філіалами не поєднуються)',
    branch: 'Філіал',
    skipped: (n) => `Без філіалів, де у вас немає доступу до цього звіту: ${n}`,
    total: 'Мережа разом',
  },
  ru: {
    joined: (n) => `Объединены филиалы: ${n}`,
    records: 'Пациенты считаются как записи филиалов: один человек, который лечится в двух филиалах, — это две записи (личности между филиалами не объединяются)',
    branch: 'Филиал',
    skipped: (n) => `Без филиалов, где у вас нет доступа к этому отчёту: ${n}`,
    total: 'Сеть вместе',
  },
  en: {
    joined: (n) => `Branches joined: ${n}`,
    records: 'Patients are counted as branch records: one person treated in two branches is two records (people are not matched across branches)',
    branch: 'Branch',
    skipped: (n) => `Without the branches where you cannot open this report: ${n}`,
    total: 'Network total',
  },
};

// Consolidated views of a network of clinics (decided 2026-11-16).
//
// Access: a person sees a branch in the network views only when they are a member of the network AND hold a management role (NETWORK_ROLES) in that
// branch's own team. The network never opens a branch by itself; the branch's data are always read with that branch's clinicId, which comes from the
// person's memberships, never from the request (a `branch` parameter can only narrow the authorized set). PLATFORM_ADMIN gives nothing here.
//
// Aggregation rules:
//   - counts are added up; a rate is computed from the added counts (never an average of the branches' percentages);
//   - patients are branch RECORDS: people are not matched across branches (not by name, not by phone), so there is no "unique people" figure;
//   - money is a list per currency stamp (common/money.ts), never one number across currencies;
//   - usage allowances stay per branch (no shared pool).
@Injectable()
export class NetworkService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NetworkService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
    private builder: ReportBuilderService,
    private assistant: AssistantService,
    private ai: AiService,
    private insights: InsightsService,
    private mail: MailService,
  ) {}

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.digestTick().catch((e) => this.log.warn(`Network digest: ${(e as Error).message}`)), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // The networks of a person, each with its branches: `authorized` = the person may see it in the network views
  async mine(userId: string) {
    const rows = await this.prisma.networkMember.findMany({
      where: { userId },
      include: { network: { include: { clinics: { select: { id: true, name: true, branchSetupQuoteUah: true, branchSetupPaidAt: true }, orderBy: { name: 'asc' } } } } },
      orderBy: { createdAt: 'asc' },
    });
    const memberships = await this.prisma.membership.findMany({ where: { userId }, select: { clinicId: true, role: true } });
    const roleIn = new Map(memberships.map((m) => [m.clinicId, m.role]));
    return rows.map((r) => ({
      id: r.network.id,
      name: r.network.name,
      role: r.role,
      billingStatus: r.network.billingStatus,
      paidUntil: r.network.paidUntil,
      digest: r.network.digest,
      branches: r.network.clinics.map((c) => ({ id: c.id, name: c.name, role: roleIn.get(c.id) ?? null, authorized: NETWORK_ROLES.includes(roleIn.get(c.id) as Role), setupQuoteUah: c.branchSetupQuoteUah, setupPaid: !!c.branchSetupPaidAt })),
    }));
  }

  // The network of a member and the branches they may see (optionally narrowed to some of them). Not a member: 404 (the network's existence is not told).
  async access(userId: string, networkId: string, only?: string[]): Promise<{ network: { id: string; name: string; role: string }; branches: Branch[] }> {
    const nm = await this.prisma.networkMember.findUnique({ where: { networkId_userId: { networkId, userId } }, include: { network: { select: { id: true, name: true } } } });
    if (!nm) throw new NotFoundException('network_not_found');
    const clinics = await this.prisma.clinic.findMany({ where: { networkId, memberships: { some: { userId, role: { in: NETWORK_ROLES } } } }, select: { id: true, name: true, memberships: { where: { userId }, select: { role: true } } }, orderBy: { name: 'asc' } });
    let branches = clinics.map((c) => ({ id: c.id, name: c.name, role: c.memberships[0].role }));
    if (only?.length) branches = branches.filter((b) => only.includes(b.id));
    return { network: { id: nm.network.id, name: nm.network.name, role: nm.role }, branches };
  }

  async assertOwner(userId: string, networkId: string) {
    const nm = await this.prisma.networkMember.findUnique({ where: { networkId_userId: { networkId, userId } } });
    if (!nm) throw new NotFoundException('network_not_found');
    if (nm.role !== 'OWNER') throw new ForbiddenException();
  }

  // Branch comparison: the figures of each branch for the period and the network total. Totals add counts; rates come from the added counts.
  async summary(userId: string, networkId: string, days: number, only?: string[]) {
    const { network, branches } = await this.access(userId, networkId, only);
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const per = await Promise.all(
      branches.map(async (b) => {
        const [records, newCards, byStatus, booked, inquiries, payments, sync, branchCur] = await Promise.all([
          this.prisma.patient.count({ where: { clinicId: b.id, removedAt: null } }),
          this.prisma.patient.count({ where: { clinicId: b.id, removedAt: null, createdAtExt: { gte: since, lt: now } } }),
          this.prisma.visit.groupBy({ by: ['status'], where: { clinicId: b.id, startsAt: { gte: since, lt: now } }, _count: true }),
          this.prisma.visit.count({ where: { clinicId: b.id, bookedAt: { gte: since, lt: now } } }),
          this.prisma.inquiry.count({ where: { clinicId: b.id, occurredAt: { gte: since, lt: now } } }),
          this.prisma.payment.groupBy({ by: ['currency'], where: { clinicId: b.id, paidAt: { gte: since, lt: now } }, _sum: { amount: true } }),
          this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId: b.id, provider: Provider.CLINICCARDS } }, select: { lastSyncAt: true } }),
          clinicMoneyCurrency(this.prisma, b.id),
        ]);
        const c = (...st: string[]) => byStatus.filter((x) => st.includes(x.status)).reduce((s, x) => s + x._count, 0);
        const counts = { records, newCards, visited: c('VISITED'), noShow: c('DID_NOT_COME'), cancelled: c('CANCELLED'), booked, inquiries };
        return { id: b.id, name: b.name, ...counts, noShowRate: rate(counts.noShow, counts.visited + counts.noShow + counts.cancelled), cancelRate: rate(counts.cancelled, counts.visited + counts.noShow + counts.cancelled), paid: sumByCurrency(payments.map((p) => ({ currency: effectiveCurrency(p.currency, branchCur), amount: p._sum.amount }))), dataUpdatedAt: sync?.lastSyncAt ?? null };
      }),
    );
    const add = (k: 'records' | 'newCards' | 'visited' | 'noShow' | 'cancelled' | 'booked' | 'inquiries') => per.reduce((s, b) => s + b[k], 0);
    const t = { records: add('records'), newCards: add('newCards'), visited: add('visited'), noShow: add('noShow'), cancelled: add('cancelled'), booked: add('booked'), inquiries: add('inquiries') };
    const total = {
      ...t,
      noShowRate: rate(t.noShow, t.visited + t.noShow + t.cancelled),
      cancelRate: rate(t.cancelled, t.visited + t.noShow + t.cancelled),
      paid: sumByCurrency(per.flatMap((b) => b.paid)),
      // the oldest update among the branches: the network figures are only as fresh as the least fresh branch
      dataUpdatedAt: per.length && per.every((b) => b.dataUpdatedAt) ? new Date(Math.min(...per.map((b) => b.dataUpdatedAt!.getTime()))) : null,
    };
    return { network, days, from: clinicDate(since), to: clinicDate(now), branches: per, total, uniquePeople: null };
  }

  // A ready report over the authorized branches: each branch's rows (built with ITS clinicId and the person's role THERE), a "Branch" column first,
  // currency labels once over the joined rows. A branch where the role may not open the report is left out and named in the rule.
  async report(userId: string, networkId: string, reportId: string, days: number | undefined, lang: Lang, only?: string[]): Promise<Report> {
    const { branches } = await this.access(userId, networkId, only);
    const t = T[lang];
    const allowedB = branches.filter((b) => this.reports.allowedFor(reportId, b.role));
    const skipped = branches.filter((b) => !allowedB.includes(b));
    if (!allowedB.length) throw new ForbiddenException('report_forbidden');
    const built = await Promise.all(allowedB.map(async (b) => ({ b, r: await this.reports.buildRaw(b.id, reportId, days, lang, b.role) })));
    const first = built[0].r;
    const rows = built.flatMap(({ b, r }) => r.rows.map((row) => ({ branch: b.name, ...row })));
    const updated = built.map(({ r }) => r.dataUpdatedAt);
    const joined: Report = {
      ...first,
      rule: [first.rule, t.joined(allowedB.map((b) => b.name).join(', ')), t.records, ...(skipped.length ? [t.skipped(skipped.map((b) => b.name).join(', '))] : [])].join('. '),
      dataUpdatedAt: updated.every((d) => d) ? new Date(Math.min(...updated.map((d) => d!.getTime()))) : null,
      columns: [{ key: 'branch', label: t.branch }, ...first.columns],
      rows,
      canCreateTasks: false,
      sections: undefined,
    };
    return finishCurrency(joined, lang);
  }

  // The network assistant: the model writes ONE report spec (it never counts); the code runs that spec in each authorized branch with the person's role
  // there and joins the rows with a "Branch" column. Rows with people are never explained by the model (AssistantService.explain). The model's work is
  // counted against the allowance of the branch the person is signed in to, which must have the assistant in its plan and switched on.
  async ask(userId: string, signedClinicId: string, signedRole: Role, networkId: string, lang: Lang, question: string, history: { q: string; a: string }[]) {
    const { branches } = await this.access(userId, networkId);
    if (!branches.some((b) => b.id === signedClinicId)) throw new ForbiddenException('network_branch_required');
    const t = T[lang];
    const run = async (spec: ReportSpec, title: string) => {
      const parts = await Promise.all(
        branches.map(async (b) => {
          try {
            return { b, r: await this.builder.run(b.id, b.role, lang, spec, title, null, true) };
          } catch {
            return null; // a field the role may not see in that branch: the branch is left out
          }
        }),
      );
      const ok = parts.filter((p): p is NonNullable<typeof p> => !!p);
      if (!ok.length) throw new ForbiddenException('report_forbidden');
      const rows = ok.flatMap(({ b, r }) => r.rows.map((row) => ({ branch: b.name, ...row }))).slice(0, 500);
      const joined = finishCurrency({ ...ok[0].r, title: ok[0].r.title, rule: `${ok[0].r.rule}. ${t.joined(ok.map((p) => p.b.name).join(', '))}. ${t.records}`, columns: [{ key: 'branch', label: t.branch }, ...ok[0].r.columns], rows: rows as never, total: rows.length }, lang);
      return joined;
    };
    return this.assistant.ask(signedClinicId, signedRole, lang, question, history, run);
  }

  // Signals of the network: the same measures as a clinic's signals (InsightsService.measure), per branch, with the branch's own thresholds where it
  // has set them (the defaults otherwise). A rate measure is also computed for the network from the added counts.
  async signals(userId: string, networkId: string) {
    const { branches } = await this.access(userId, networkId);
    const now = new Date();
    const out: { branch: string; kind: string; value: number; threshold: number; fired: boolean }[] = [];
    for (const b of branches) {
      const rules = await this.insights.alerts(b.id);
      for (const r of rules) {
        const m = await this.insights.measure(b.id, { kind: r.kind, windowDays: r.windowDays, hours: r.hours }, now);
        if (m) out.push({ branch: b.name, kind: r.kind, value: m.value, threshold: r.threshold, fired: m.value >= r.threshold });
      }
    }
    return { signals: out };
  }

  // The network digest by email to the network's owners: per branch and in total, counts added, rates from the added counts, money per currency.
  // Weekly on Monday or daily, from 08:00 Kyiv time; a network not paid (or past its grace days) gets none. Nothing goes to patients.
  async digestText(networkId: string, ownerUserId: string, lang: Lang, days: number) {
    const s = await this.summary(ownerUserId, networkId, days);
    const sig = await this.signals(ownerUserId, networkId);
    const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
    const head = { uk: `Мережа «${s.network.name}»: ${s.from} – ${s.to}`, ru: `Сеть «${s.network.name}»: ${s.from} – ${s.to}`, en: `Network “${s.network.name}”: ${s.from} – ${s.to}` }[lang];
    const line = (name: string, x: { visited: number; noShow: number; booked: number; newCards: number; noShowRate: number | null; paid: MoneyTotal[] }) =>
      ({
        uk: `${name}: прийомів ${x.visited}, неявок ${x.noShow} (${pct(x.noShowRate)}), нових записів ${x.booked}, нових карток ${x.newCards}, оплати ${formatTotals(x.paid, lang)}`,
        ru: `${name}: приёмов ${x.visited}, неявок ${x.noShow} (${pct(x.noShowRate)}), новых записей ${x.booked}, новых карточек ${x.newCards}, оплаты ${formatTotals(x.paid, lang)}`,
        en: `${name}: visits ${x.visited}, no-shows ${x.noShow} (${pct(x.noShowRate)}), new bookings ${x.booked}, new cards ${x.newCards}, payments ${formatTotals(x.paid, lang)}`,
      })[lang];
    const fired = sig.signals.filter((x) => x.fired);
    const lines = [head, '', ...s.branches.map((b) => line(b.name, b)), line(T[lang].total, s.total), '', T[lang].records];
    if (fired.length) lines.push('', ...fired.map((f) => ({ uk: `Сигнал: ${f.branch} — ${f.kind} ${f.value} (поріг ${f.threshold})`, ru: `Сигнал: ${f.branch} — ${f.kind} ${f.value} (порог ${f.threshold})`, en: `Signal: ${f.branch} — ${f.kind} ${f.value} (threshold ${f.threshold})` })[lang]));
    return lines.join('\n');
  }

  async digestTick(now = new Date()) {
    const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (kyivHour < 8) return 0;
    const kyivDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', weekday: 'short' }).format(now);
    const nets = await this.prisma.network.findMany({ where: { digest: { in: ['WEEKLY', 'DAILY'] }, billingStatus: { in: ['ACTIVE', 'PAST_DUE'] } }, include: { members: { where: { role: 'OWNER' }, include: { user: { select: { id: true, email: true } } } } } });
    let sent = 0;
    for (const n of nets) {
      if (n.digest === 'WEEKLY' && weekday !== 'Mon') continue;
      if (n.lastDigestAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(n.lastDigestAt) === kyivDay) continue;
      // marked first: a failing mail does not turn into a mail every hour
      await this.prisma.network.update({ where: { id: n.id }, data: { lastDigestAt: now } });
      for (const m of n.members) {
        const text = await this.digestText(n.id, m.user.id, 'uk', n.digest === 'DAILY' ? 1 : 7).catch((e) => {
          this.log.warn(`Network digest ${n.id}: ${(e as Error).message}`);
          return null;
        });
        if (!text) continue;
        await this.mail.send({ to: m.user.email, subject: `LANKA: дайджест мережі «${n.name}»`, text });
        sent++;
      }
    }
    return sent;
  }

  async setDigest(userId: string, networkId: string, digest: string) {
    await this.assertOwner(userId, networkId);
    const branches = await this.prisma.clinic.findMany({ where: { networkId }, select: { plan: true } });
    if (digest === 'DAILY' && !branches.every((b) => hasFeature(b.plan, 'daily_digest'))) throw new ForbiddenException('plan_feature');
    await this.prisma.network.update({ where: { id: networkId }, data: { digest } });
    return { digest };
  }

  // What the network pays monthly for its current branches (the network billing uses the same function)
  async price(networkId: string) {
    const n = await this.prisma.clinic.count({ where: { networkId } });
    return { branches: n, monthlyUah: networkMonthlyUah(n) };
  }
}

const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
export type { Cur };
