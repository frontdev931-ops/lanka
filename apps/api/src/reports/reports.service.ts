import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clinicDate, clinicHm, clinicMonth, localToUtc, startOfClinicDay } from '../common/clinic-time';
import { readWorkHours } from '../clinic/work-hours';
import { COLUMN_LABEL, LANKA_MOVES_TEXT, Lang, PERIOD_PHRASE, REPORT_RULE, REPORT_TEXT, ReportId, VALUE_LABEL } from '../common/i18n';
import { Period, periodDate } from './period';
import { cellLabel, headLabel } from './report-export';
import { MIXED, MoneyKind, RowCur, finishCurrency, CurrencyInfo } from './report-currency';
import { Cur, MoneyTotal, clinicMoneyCurrency, effectiveCurrency, formatTotals, sumByCurrency } from '../common/money';
import { lankaMoves } from './lanka-moves';
import { KNOWN_RESULT_STATUSES, MISSED_STATUSES, NO_RESULT_STATUSES } from './visit-outcome';

// Cliniccards statuses: the visit took place / the appointment is no longer valid.
const DONE = 'VISITED';
// Appointment statuses that must change to an outcome by the end of the visit (came, did not come, cancelled, moved)
const UNCLOSED = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'IN_CLINIC', 'IN_CHAIR'];
const INACTIVE = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];
const NO_SCHEDULE_NOTICE: Record<string, string> = {
  uk: 'Вільних вікон не показано: у Cliniccards немає змін лікарів, а робочі години клініки не задано, тож надійного розкладу немає. Задайте години в «Налаштуваннях» або підтягніть їх з Cliniccards.',
  ru: 'Свободных окон не показано: в Cliniccards нет смен врачей, а рабочие часы клиники не заданы, поэтому надёжного расписания нет. Задайте часы в «Настройках» или подтяните их из Cliniccards.',
  en: 'No free times are shown: Cliniccards has no doctor shifts and the working hours of the clinic are not set, so there is no reliable schedule. Set the hours in Settings or take them from Cliniccards.',
};

const DAY = 86_400_000;

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

// Money columns of the ready reports (common/money.ts, report-currency.ts). source: amounts of the clinic's accounts (balances, debt, payments,
// invoices, the remainder from plan totals), labelled with the stamped currency. unconverted: `revenue` of the sources report, a sum of visit amounts
// built from service prices, which may be in different currencies.
const MONEY_COLUMNS: Record<string, MoneyKind> = { balanceIssued: 'source', balancePaid: 'source', debt: 'source', openSum: 'source', lifetimePaid: 'source', invoiced: 'source', paid: 'source', revenue: 'unconverted' };
const col = (lang: Lang, key: string) => ({ key, label: COLUMN_LABEL[lang][key] ?? key, ...(MONEY_COLUMNS[key] ? { money: MONEY_COLUMNS[key] } : {}) });

// The money cells of one row: when every amount of the row has one stamp, numbers and that stamp; when they differ, each cell is the text of its
// totals per currency ("1 200 грн; 50 USD") and the row is MIXED. A cell with no amount is 0 (or null when `none` says the amount is not known).
function moneyCells<K extends string>(cells: Record<K, MoneyTotal[] | null>, fallback: Cur, lang: Lang): Record<K, Cell> & { currency: RowCur } {
  const stamps = new Set<Cur>();
  for (const list of Object.values(cells) as (MoneyTotal[] | null)[]) for (const t of list ?? []) stamps.add(t.currency);
  const entries = Object.entries(cells) as [K, MoneyTotal[] | null][];
  if (stamps.size > 1) return { ...(Object.fromEntries(entries.map(([k, list]) => [k, list === null ? null : formatTotals(list, lang)])) as Record<K, Cell>), currency: MIXED };
  const code = stamps.size ? [...stamps][0] : fallback;
  return { ...(Object.fromEntries(entries.map(([k, list]) => [k, list === null ? null : Math.round(list.reduce((a, t) => a + t.amount, 0))])) as Record<K, Cell>), currency: code };
}
const num0 = (v: Cell) => (typeof v === 'number' ? v : 0);

export interface Report {
  id: string;
  title: string;
  rule: string;
  days: number;
  // the chosen period, when there is one (YYYY-MM-DD, both included)
  from?: string | null;
  to?: string | null;
  maxDays: number | null;
  dataUpdatedAt: Date | null;
  generatedAt: string;
  columns: { key: string; label: string; money?: MoneyKind }[];
  // the currency of the report's amounts (report-currency.ts)
  currency?: CurrencyInfo;
  canCreateTasks: boolean;
  // A reason shown instead of data that would only be a guess (for example no reliable schedule for the free times), or null
  notice?: string | null;
  // The values kind (status code), rebooked (boolean) and an empty source are labelled by the client in its own language
  rows: Row[];
  // Separate parts of a report with their own rule, totals and rows (never added to the main rows): "Rescheduled through LANKA" of missed-visits
  sections?: ReportSection[];
}

export interface ReportSection {
  key: string;
  title: string;
  rule: string;
  summary: { label: string; value: number }[];
  // e.g. the legacy audit entries that are not counted
  note: string | null;
  columns: { key: string; label: string; currency?: boolean }[];
  // already in the report's language (no client labelling)
  rows: Row[];
}

interface Meta {
  id: ReportId;
  defaultDays: number;
  // The upper bound of the period (for "long absent"): not older than this many days; null means no bound
  defaultMaxDays?: number;
  // false: the report's period is not applied (the field is hidden in the interface)
  usesDays: boolean;
  canCreateTasks: boolean;
  // If set, the report is available only to these roles (the clinic's financial figures)
  roles?: Role[];
  columns: string[];
}

const MIN_GAP_MINUTES = 30;
const MIN = 60_000;

const META: Meta[] = [
  { id: 'no-next-visit', defaultDays: 90, usesDays: true, canCreateTasks: true, columns: ['fullName', 'phone', 'visitedAt', 'lastService', 'lastDoctor', 'daysSince'] },
  { id: 'missed-visits', defaultDays: 30, usesDays: true, canCreateTasks: true, columns: ['fullName', 'phone', 'visitAt', 'kind', 'doctor', 'service', 'rebooked'] },
  { id: 'unclosed-visits', defaultDays: 90, usesDays: true, canCreateTasks: true, columns: ['fullName', 'phone', 'visitAt', 'visitTime', 'visitStatus', 'cabinet', 'daysSince'] },
  { id: 'lapsed-patients', defaultDays: 180, defaultMaxDays: 730, usesDays: true, canCreateTasks: true, columns: ['fullName', 'phone', 'lastVisitAt', 'daysSince', 'source', 'openSum', 'lifetimePaid'] },
  { id: 'unfinished-treatment', defaultDays: 180, usesDays: true, canCreateTasks: true, columns: ['fullName', 'phone', 'openItems', 'openSum', 'lastDoneAt', 'daysSince'] },
  { id: 'debtors', defaultDays: 0, usesDays: false, canCreateTasks: true, roles: [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST], columns: ['fullName', 'phone', 'balanceIssued', 'balancePaid', 'debt', 'lastVisitAt'] },
  { id: 'sources', defaultDays: 90, usesDays: true, canCreateTasks: false, roles: [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST], columns: ['source', 'patients', 'active', 'visits', 'revenue'] },
  { id: 'revenue', defaultDays: 365, usesDays: true, canCreateTasks: false, roles: [Role.OWNER, Role.MANAGER, Role.ANALYST], columns: ['month', 'invoiced', 'paid', 'paymentsCount'] },
  { id: 'free-slots', defaultDays: 7, usesDays: true, canCreateTasks: false, columns: ['dayAt', 'doctor', 'cabinet', 'freeMinutes', 'windows'] },
];

const allowed = (m: Meta, role?: Role) => !m.roles || (!!role && m.roles.includes(role));

// A patient who already has a valid reminder (NEW) for today or later is not needed in the "bring the patient back" lists
const activeReminder = () => ({ status: 'NEW', dueDate: { gte: new Date(clinicDate(new Date()) + 'T00:00:00Z') } });

const date = (d: Date | null | undefined) => (d ? clinicDate(d) : null);

// The visits of a report's period: since → until (until is never later than now)
type Window = { since: Date; until: Date };
// The reports that take a chosen period (?from=&to=): their rows are visits of the period
const PERIOD_REPORTS = new Set<ReportId>(['no-next-visit', 'missed-visits', 'unclosed-visits']);

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  catalog(lang: Lang, role?: Role) {
    return META.filter((m) => allowed(m, role)).map((m) => ({
      id: m.id,
      title: REPORT_TEXT[m.id].title[lang],
      daysLabel: REPORT_TEXT[m.id].daysLabel[lang],
      defaultDays: m.defaultDays,
      defaultMaxDays: m.defaultMaxDays ?? null,
      usesDays: m.usesDays,
      canCreateTasks: m.canCreateTasks,
    }));
  }

  // period: a chosen range of days (from the home page or a link); it is used by the reports whose rows are tied to a date of a visit
  // (PERIOD_REPORTS), the others keep their "last N days"
  // Whether a role may open a ready report (the network report asks it per branch)
  allowedFor(id: string, role: Role): boolean {
    const meta = META.find((m) => m.id === id);
    return !!meta && allowed(meta, role);
  }

  async build(clinicId: string, id: string, days: number | undefined, lang: Lang, role?: Role, maxDays?: number, period?: Period | null): Promise<Report> {
    return finishCurrency(await this.buildRaw(clinicId, id, days, lang, role, maxDays, period), lang);
  }

  // The report before its currency labels (report-currency.ts): the network report joins several branches and labels the joined rows once
  async buildRaw(clinicId: string, id: string, days: number | undefined, lang: Lang, role?: Role, maxDays?: number, period?: Period | null): Promise<Report> {
    const meta = META.find((m) => m.id === id);
    if (!meta) throw new NotFoundException('report_not_found');
    if (!allowed(meta, role)) throw new ForbiddenException('report_forbidden');
    const range = period && PERIOD_REPORTS.has(meta.id) ? period : null;
    const d = range ? range.days : (days ?? meta.defaultDays);
    const now = new Date();
    const win = range ? { since: range.since, until: range.until } : { since: new Date(now.getTime() - d * DAY), until: now };
    const phrase = range ? PERIOD_PHRASE[lang](periodDate(range.from), periodDate(range.to)) : undefined;
    const integration = await this.prisma.integration.findFirst({
      where: { clinicId },
      select: { lastSyncAt: true },
    });
    const max = meta.defaultMaxDays ? Math.max(maxDays ?? meta.defaultMaxDays, d + 1) : undefined;
    const rows = await this.rows(meta.id, clinicId, d, max, win, lang);
    return {
      id,
      title: REPORT_TEXT[meta.id].title[lang],
      rule: REPORT_RULE[meta.id][lang](d, max, phrase),
      days: d,
      from: range?.from ?? null,
      to: range?.to ?? null,
      maxDays: max ?? null,
      dataUpdatedAt: integration?.lastSyncAt ?? null,
      generatedAt: new Date().toISOString(),
      canCreateTasks: meta.canCreateTasks,
      // a reason shown instead of times that would only be guesses
      notice: id === 'free-slots' && !rows.length && (await this.freeSlotsNotice(clinicId, undefined, d)) ? NO_SCHEDULE_NOTICE[lang] : null,
      // Free windows by cabinet hours are not tied to a doctor: the "Doctor" column is then not needed
      columns: meta.columns.filter((key) => !(id === 'free-slots' && key === 'doctor' && rows.every((r) => !r.doctor))).map((key) => col(lang, key)),
      rows,
      ...(meta.id === 'missed-visits' ? { rule: `${REPORT_RULE[meta.id][lang](d, max, phrase)}. ${LANKA_MOVES_TEXT[lang].mainNote}`, sections: [await this.lankaMovesSection(clinicId, d, lang, win, phrase)] } : {}),
    };
  }

  // "Rescheduled through LANKA": the operations of the period by their date (the same counting as the digest, lanka-moves.ts), with what is recorded of each
  private async lankaMovesSection(clinicId: string, days: number, lang: Lang, win: Window, phrase?: string): Promise<ReportSection> {
    const t = LANKA_MOVES_TEXT[lang];
    const m = await lankaMoves(this.prisma, clinicId, win.since, new Date(win.until.getTime() + 1));
    const ops = [...m.operations].sort((a, b) => b.at.getTime() - a.at.getTime());
    const visits = await this.prisma.visit.findMany({ where: { clinicId, externalId: { in: ops.map((o) => o.visit).filter((v): v is string => !!v) } }, select: { externalId: true, patient: { select: { fullName: true } } } });
    const patientOf = new Map(visits.map((v) => [v.externalId, v.patient.fullName]));
    // staff names only of members of this clinic
    const users = await this.prisma.user.findMany({ where: { id: { in: ops.map((o) => o.userId).filter((u): u is string => !!u) }, memberships: { some: { clinicId } } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const at = (d: Date | null) => (d ? `${clinicDate(d)} ${clinicHm(d)}` : t.notRecorded);
    const cols = ['opWhen', 'visitRef', 'patient', 'oldWhen', 'newWhen', 'actor'];
    return {
      key: 'lanka-moves',
      title: t.title,
      rule: t.rule(days, phrase),
      summary: [
        { label: t.operations, value: ops.length },
        { label: t.visits, value: m.visits },
      ],
      note: m.legacy ? t.legacy(m.legacy) : null,
      columns: cols.map((key) => col(lang, key)),
      rows: ops.map((o) => ({
        opWhen: at(o.at),
        visitRef: o.visit ?? t.notRecorded,
        patient: (o.visit && patientOf.get(o.visit)) || t.noVisit,
        oldWhen: at(o.from),
        newWhen: at(o.to),
        actor: o.actor === 'agent' ? t.agent : o.actor === 'staff' ? t.staff(o.userId ? (nameOf.get(o.userId) ?? null) : null) : t.unknown,
      })),
    };
  }

  private rows(id: ReportId, clinicId: string, days: number, maxDays: number | undefined, win: Window, lang: Lang): Promise<Row[]> {
    switch (id) {
      case 'no-next-visit':
        return this.noNextVisit(clinicId, win);
      case 'missed-visits':
        return this.missedVisits(clinicId, win);
      case 'unclosed-visits':
        return this.unclosedVisits(clinicId, win);
      case 'lapsed-patients':
        return this.lapsed(clinicId, days, maxDays ?? 730, lang);
      case 'unfinished-treatment':
        return this.unfinishedTreatment(clinicId, days, lang);
      case 'debtors':
        return this.debtors(clinicId);
      case 'revenue':
        return this.revenue(clinicId, days);
      case 'free-slots':
        return this.freeSlots(clinicId, days);
      default:
        return this.sources(clinicId, days);
    }
  }

  // Treatment started (a plan item was completed in the period), but incomplete items remain in the same plan;
  // patients with a future valid appointment are not included.
  // The same definition for the management signal "unfinished treatment without a next visit" (no names leave the server through it)
  async unfinishedForSignals(clinicId: string, days: number): Promise<{ patientId: string; daysSince: number }[]> {
    return (await this.unfinishedTreatment(clinicId, days, 'uk')).map((r) => ({ patientId: r.patientId as string, daysSince: r.daysSince as number }));
  }

  private async unfinishedTreatment(clinicId: string, days: number, lang: Lang): Promise<Row[]> {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const items = await this.prisma.planItem.findMany({
      where: { clinicId, OR: [{ status: { in: ['NEW', 'PLANNED_TO_DO'] } }, { markedDoneAt: { gte: since } }] },
      select: { patientId: true, planId: true, name: true, status: true, price: true, markedDoneAt: true },
    });

    // open is the number of different services (for dental services there is one plan row per tooth, we count by name)
    const plans = new Map<string, { patientId: string; planId: string; open: number; openSum: number; lastDone: Date | null; names: Set<string> }>();
    for (const i of items) {
      const p = plans.get(`${i.patientId}|${i.planId}`) ?? { patientId: i.patientId, planId: i.planId, open: 0, openSum: 0, lastDone: null, names: new Set<string>() };
      if (i.status === 'NEW' || i.status === 'PLANNED_TO_DO') {
        p.names.add(i.name);
        p.open = p.names.size;
        p.openSum += Number(i.price ?? 0);
      } else if (i.markedDoneAt && (!p.lastDone || i.markedDoneAt > p.lastDone)) {
        p.lastDone = i.markedDoneAt;
      }
      plans.set(`${i.patientId}|${i.planId}`, p);
    }

    const byPatient = new Map<string, { open: number; openSum: number; lastDone: Date }>();
    for (const p of plans.values()) {
      if (!p.open || !p.lastDone) continue; // treatment not started or everything already done
      const a = byPatient.get(p.patientId) ?? { open: 0, openSum: 0, lastDone: p.lastDone };
      a.open += p.open;
      a.openSum += p.openSum;
      if (p.lastDone > a.lastDone) a.lastDone = p.lastDone;
      byPatient.set(p.patientId, a);
    }
    if (!byPatient.size) return [];

    // The remaining treatment comes ONLY from the plan totals (the clinic's main currency of Cliniccards, with the plan's fixed rate and discount),
    // with the currency stamped on the plan. Item prices may be in another currency: they are never added up into this sum. A plan without a total
    // adds nothing; a patient whose open plans have no total at all has no sum (null), not 0.
    const planIds = [...new Set([...plans.values()].map((p) => p.planId))];
    const totals = new Map(
      (await this.prisma.treatmentPlan.findMany({ where: { clinicId, externalId: { in: planIds } } })).map((t) => [t.externalId, { currency: t.currency, amount: Math.max(0, Number(t.total) - Number(t.totalDone)) }]),
    );
    const openOf = new Map<string, MoneyTotal[]>();
    for (const p of plans.values()) {
      if (!p.open || !p.lastDone) continue;
      const tot = totals.get(p.planId);
      if (tot) openOf.set(p.patientId, [...(openOf.get(p.patientId) ?? []), tot]);
    }

    const ids = [...byPatient.keys()];
    const booked = new Set(
      (
        await this.prisma.visit.findMany({
          where: { clinicId, patientId: { in: ids }, status: { notIn: INACTIVE }, startsAt: { gt: now } },
          select: { patientId: true },
        })
      ).map((v) => v.patientId),
    );
    const reminded = await this.prisma.reminder.findMany({ where: { clinicId, patientId: { in: ids }, ...activeReminder() }, select: { patientId: true } });
    for (const r of reminded) if (r.patientId) booked.add(r.patientId);
    const patients = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, id: { in: ids.filter((id) => !booked.has(id)) } } });

    return patients
      .map((p) => {
        const a = byPatient.get(p.id)!;
        const open = openOf.get(p.id);
        return {
          patientId: p.id,
          fullName: p.fullName,
          phone: p.phone,
          openItems: a.open,
          ...moneyCells({ openSum: open ? sumByCurrency(open) : null }, null, lang),
          lastDoneAt: date(a.lastDone),
          daysSince: Math.floor((now.getTime() - a.lastDone.getTime()) / DAY),
        };
      })
      .sort((a, b) => (b.daysSince as number) - (a.daysSince as number));
  }

  // Debt is calculated from the Cliniccards card: billed for payment minus paid
  private async debtors(clinicId: string): Promise<Row[]> {
    const patients = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, balanceIssued: { gt: 0 } } });
    return patients
      .map((p) => {
        const issued = Number(p.balanceIssued ?? 0);
        const paid = Number(p.balancePaid ?? 0);
        // the three amounts of one card share its balance stamp
        return { patientId: p.id, fullName: p.fullName, phone: p.phone, balanceIssued: issued, balancePaid: paid, debt: Math.round((issued - paid) * 100) / 100, currency: p.balanceCurrency, lastVisitAt: date(p.lastVisitAt) };
      })
      .filter((r) => (r.debt as number) > 0.01)
      .sort((a, b) => (b.debt as number) - (a.debt as number));
  }

  private async revenue(clinicId: string, days: number): Promise<Row[]> {
    const since = new Date(Date.now() - days * DAY);
    const [invoices, payments, clinicCur] = await Promise.all([
      this.prisma.invoice.findMany({ where: { clinicId, issuedAt: { gte: since } }, select: { issuedAt: true, amount: true, currency: true } }),
      this.prisma.payment.findMany({ where: { clinicId, paidAt: { gte: since } }, select: { paidAt: true, amount: true, currency: true } }),
      clinicMoneyCurrency(this.prisma, clinicId),
    ]);
    // one row per month AND currency: amounts with different stamps are never added up
    const months = new Map<string, { month: string; currency: Cur; invoiced: number; paid: number; paymentsCount: number }>();
    const slot = (d: Date, currency: Cur) => {
      const key = `${clinicMonth(d)}|${currency ?? ''}`;
      const m = months.get(key) ?? { month: clinicMonth(d), currency, invoiced: 0, paid: 0, paymentsCount: 0 };
      months.set(key, m);
      return m;
    };
    for (const i of invoices) slot(i.issuedAt, effectiveCurrency(i.currency, clinicCur)).invoiced += Number(i.amount);
    for (const p of payments) {
      const m = slot(p.paidAt, effectiveCurrency(p.currency, clinicCur));
      m.paid += Number(p.amount);
      m.paymentsCount++;
    }
    return [...months.values()]
      .sort((a, b) => b.month.localeCompare(a.month) || String(a.currency ?? '~').localeCompare(String(b.currency ?? '~')))
      .map((m) => ({ month: m.month, invoiced: Math.round(m.invoiced), paid: Math.round(m.paid), paymentsCount: m.paymentsCount, currency: m.currency }));
  }

  // The figures of one period [since, end) for the weekly and monthly reports to managers and their page in the workspace: ONE calculation, so
  // the numbers in Telegram and in LANKA are the same for the same dates.
  // - completed: visits with the status "visited" by their time;
  // - newPatients: patient cards created in Cliniccards in the period (createdAtExt), removed cards not counted (the digest's and the funnel's
  //   definition);
  // - cancelled / noShow out of `scheduled`: the visits with a known result (visit-outcome.ts: visited, in the clinic, in the chair, no-show,
  //   cancelled, moved), the same lists as the signal "Cancellations and no-shows"; visits with no result mark (planned, confirmed, not
  //   confirmed, a booking) are NOT in the share and are counted apart (`unclosed`);
  // - paid: received payments by their payment date, per currency stamp (never one sum across currencies), the "Paid" of the "Revenue" report.
  async periodSummary(clinicId: string, since: Date, end: Date) {
    const clinicCur = await clinicMoneyCurrency(this.prisma, clinicId);
    const [byStatus, newPatients, pay] = await Promise.all([
      this.prisma.visit.groupBy({ by: ['status'], where: { clinicId, startsAt: { gte: since, lt: end } }, _count: true }),
      this.prisma.patient.count({ where: { clinicId, removedAt: null, createdAtExt: { gte: since, lt: end } } }),
      this.prisma.payment.findMany({ where: { clinicId, paidAt: { gte: since, lt: end } }, select: { amount: true, currency: true } }),
    ]);
    const c = (...st: string[]) => byStatus.filter((x) => st.includes(x.status)).reduce((n, x) => n + x._count, 0);
    return {
      completed: c('VISITED'),
      cancelled: c(MISSED_STATUSES[0]),
      noShow: c(MISSED_STATUSES[1]),
      scheduled: c(...KNOWN_RESULT_STATUSES),
      unclosed: c(...NO_RESULT_STATUSES),
      newPatients,
      paid: sumByCurrency(pay.map((x) => ({ currency: effectiveCurrency(x.currency, clinicCur), amount: x.amount }))).map((x) => ({ currency: x.currency, amount: Math.round(x.amount) })),
      paymentsCount: pay.length,
    };
  }

  // Free time. If Cliniccards has doctor shifts: the shift minus the doctor's appointments minus the reserved time
  // of their cabinet. If there are no shifts (the clinic keeps no doctor profiles): the clinic's working hours minus the appointments
  // of the cabinet minus the grey blocks of the cabinet (blocks in the schedule mean "book nobody here").
  // Days and hours are calculated in the clinic's time zone.
  // Why the report of free time may be empty: no shifts in Cliniccards and no working hours set. Null when there is a reliable schedule.
  async freeSlotsNotice(clinicId: string, from = startOfClinicDay(new Date()), days = 7): Promise<'no_schedule' | null> {
    const [shifts, clinic] = await Promise.all([
      this.prisma.shift.count({ where: { clinicId, startsAt: { gte: from, lt: new Date(from.getTime() + days * DAY) } } }),
      this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { workHours: true } }),
    ]);
    const hoursSet = !!clinic?.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    return !shifts && !hoursSet ? 'no_schedule' : null;
  }

  async freeSlots(clinicId: string, days: number): Promise<Row[]> {
    const from = startOfClinicDay(new Date());
    const to = new Date(from.getTime() + days * DAY);
    const [shifts, visits, blocks, cabinets, clinic] = await Promise.all([
      this.prisma.shift.findMany({ where: { clinicId, startsAt: { gte: from, lt: to } }, orderBy: { startsAt: 'asc' } }),
      this.prisma.visit.findMany({
        where: { clinicId, status: { notIn: INACTIVE }, startsAt: { gte: from, lt: new Date(to.getTime() + DAY) } },
        select: { doctorId: true, cabinetId: true, startsAt: true, endsAt: true },
      }),
      this.prisma.reservedBlock.findMany({ where: { clinicId, startsAt: { gte: from, lt: new Date(to.getTime() + DAY) } } }),
      this.prisma.cabinet.findMany({ where: { clinicId } }),
      this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { workHours: true } }),
    ]);
    // Without shifts the only source of hours is the working hours the clinic set (or took from Cliniccards). The default 09:00-20:00 is NOT a
    // schedule, so nothing is offered then (the report says why, see freeSlotsNotice).
    const hoursSet = !!clinic?.workHours && typeof clinic.workHours === 'object' && Object.keys(clinic.workHours as object).length > 0;
    if (!shifts.length && !hoursSet) return [];

    const hhmm = (t: number) => clinicHm(t);
    // Gaps inside [start, end] not taken by the busy segments and not shorter than MIN_GAP_MINUTES
    const freeGaps = (start: number, end: number, busy: [number, number][]) => {
      const clipped = busy
        .map(([a, b]): [number, number] => [Math.max(a, start), Math.min(b, end)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
      const gaps: [number, number][] = [];
      let cursor = start;
      for (const [a, b] of clipped) {
        if (a > cursor) gaps.push([cursor, a]);
        cursor = Math.max(cursor, b);
      }
      if (cursor < end) gaps.push([cursor, end]);
      return gaps.filter(([a, b]) => b - a >= MIN_GAP_MINUTES * MIN);
    };
    const visitBusy = (v: { startsAt: Date; endsAt: Date | null }): [number, number] => [v.startsAt.getTime(), (v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN)).getTime()];
    const rows: Row[] = [];

    if (shifts.length) {
      for (const s of shifts) {
        const busy: [number, number][] = [];
        for (const v of visits) if (v.doctorId === s.doctorId) busy.push(visitBusy(v));
        for (const b of blocks) if (b.cabinetId === s.cabinetId) busy.push([b.startsAt.getTime(), b.endsAt.getTime()]);
        const usable = freeGaps(s.startsAt.getTime(), s.endsAt.getTime(), busy);
        if (!usable.length) continue;
        rows.push({
          dayAt: date(s.startsAt),
          doctor: s.doctorName,
          cabinet: s.cabinetName,
          freeMinutes: usable.reduce((sum, [a, b]) => sum + (b - a) / MIN, 0),
          windows: usable.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(', '),
        });
      }
    } else {
      const hours = readWorkHours(clinic?.workHours);
      const names = new Map(cabinets.map((c) => [c.externalId, c.name]));
      const ids = new Set([...cabinets.map((c) => c.externalId), ...visits.map((v) => v.cabinetId).filter((x): x is string => !!x), ...blocks.map((b) => b.cabinetId)]);
      const [y, m, d0] = clinicDate(from).split('-').map(Number);
      const now = Date.now();
      for (let i = 0; i < days; i++) {
        const day = new Date(Date.UTC(y, m - 1, d0 + i));
        const ymd = day.toISOString().slice(0, 10);
        const h = hours[String(day.getUTCDay() || 7)];
        if (!h) continue; // day off
        const open = Math.max(localToUtc(`${ymd} ${h.from}:00`).getTime(), now); // we do not count time that has passed
        const close = localToUtc(`${ymd} ${h.to}:00`).getTime();
        if (close <= open) continue;
        for (const id of ids) {
          const busy: [number, number][] = [];
          for (const v of visits) if (v.cabinetId === id) busy.push(visitBusy(v));
          for (const b of blocks) if (b.cabinetId === id) busy.push([b.startsAt.getTime(), b.endsAt.getTime()]);
          const usable = freeGaps(open, close, busy);
          if (!usable.length) continue;
          rows.push({
            dayAt: ymd,
            doctor: null,
            cabinet: names.get(id) ?? `#${id}`,
            freeMinutes: usable.reduce((sum, [a, b]) => sum + (b - a) / MIN, 0),
            windows: usable.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(', '),
          });
        }
      }
    }
    return rows.sort((a, b) => String(a.dayAt).localeCompare(String(b.dayAt)) || String(a.doctor ?? '').localeCompare(String(b.doctor ?? '')) || String(a.cabinet).localeCompare(String(b.cabinet)));
  }

  // A patient with a visit that took place in the period and with no future valid appointments.
  // win: the visits of the period (by default the last N days up to now); "no upcoming appointment" is always counted from now
  private async noNextVisit(clinicId: string, win: Window): Promise<Row[]> {
    const now = new Date();
    const { since, until } = win;
    const patients = await this.prisma.patient.findMany({
      where: {
        clinicId,
        removedAt: null,
        visits: {
          some: { status: DONE, startsAt: { gte: since, lte: until } },
          none: { status: { notIn: INACTIVE }, startsAt: { gt: now } },
        },
        reminders: { none: activeReminder() },
      },
      include: {
        visits: {
          where: { status: DONE, startsAt: { gte: since, lte: until } },
          orderBy: { startsAt: 'desc' },
          take: 1,
        },
      },
    });
    return patients
      .map((p) => {
        const v = p.visits[0];
        return {
          patientId: p.id,
          fullName: p.fullName,
          phone: p.phone,
          visitedAt: date(v.startsAt),
          lastService: v.serviceName,
          lastDoctor: v.doctorName,
          daysSince: Math.floor((now.getTime() - v.startsAt.getTime()) / DAY),
        };
      })
      .sort((a, b) => (b.daysSince as number) - (a.daysSince as number));
  }

  // Appointments with the statuses DID_NOT_COME, CANCELLED, MOVED in the period; we mark whether the patient booked again.
  private async missedVisits(clinicId: string, win: Window): Promise<Row[]> {
    const now = new Date();
    const { since, until } = win;
    const visits = await this.prisma.visit.findMany({
      where: { clinicId, status: { in: INACTIVE }, startsAt: { gte: since, lte: until }, patient: { removedAt: null } },
      include: {
        patient: {
          include: {
            visits: { where: { status: { notIn: INACTIVE }, startsAt: { gt: now } }, take: 1 },
          },
        },
      },
      orderBy: { startsAt: 'desc' },
    });
    return visits.map((v) => {
      const rebooked = v.patient.visits.length > 0;
      return {
        patientId: v.patientId,
        fullName: v.patient.fullName,
        phone: v.patient.phone,
        visitAt: date(v.startsAt),
        kind: v.status,
        doctor: v.doctorName,
        service: v.serviceName,
        rebooked,
        actionable: rebooked ? 0 : 1,
      };
    });
  }

  // The date of the last visit is taken from the Cliniccards card (patient.lastVisitAt), not from the sync window.
  // Appointments whose time has passed but whose outcome was never set ("Planned", "Confirmed", "In the clinic"…): it is unknown whether
  // the person came. Because of them the funnel and the no-show reports understate attendance. The appointment has to be closed in Cliniccards (we change nothing there).
  private async unclosedVisits(clinicId: string, win: Window): Promise<Row[]> {
    const now = new Date();
    const { since, until } = win;
    const [visits, cabinets] = await Promise.all([
      this.prisma.visit.findMany({
        where: {
          clinicId,
          status: { in: UNCLOSED },
          startsAt: { gte: since, lte: until },
          patient: { removedAt: null },
        },
        include: { patient: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { startsAt: 'desc' },
      }),
      this.prisma.cabinet.findMany({ where: { clinicId } }),
    ]);
    const names = new Map(cabinets.map((c) => [c.externalId, c.name]));
    return visits
      // the appointment is still going or has just ended: it is too early to demand an outcome
      .filter((v) => (v.endsAt ?? new Date(v.startsAt.getTime() + 30 * MIN)).getTime() < now.getTime() - 2 * 3600_000)
      .map((v) => ({
        patientId: v.patient.id,
        fullName: v.patient.fullName,
        phone: v.patient.phone,
        visitAt: date(v.startsAt),
        visitTime: clinicHm(v.startsAt),
        visitStatus: v.status,
        cabinet: v.cabinetId ? names.get(v.cabinetId) ?? null : null,
        daysSince: Math.floor((now.getTime() - v.startsAt.getTime()) / DAY),
      }));
  }

  // Patients who have not been for a long time: the last visit between days and maxDays days ago (very old ones hardly ever return).
  // Order of calls: first those with unfinished treatment (by sum), then by the sum of payments over all time.
  private async lapsed(clinicId: string, days: number, maxDays: number, lang: Lang): Promise<Row[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * DAY);
    const oldest = new Date(now.getTime() - maxDays * DAY);
    const patients = await this.prisma.patient.findMany({
      where: {
        clinicId,
        removedAt: null,
        lastVisitAt: { not: null, lte: cutoff, gte: oldest },
        visits: { none: { status: { notIn: INACTIVE }, startsAt: { gt: now } } },
        reminders: { none: activeReminder() },
      },
    });
    const open = await this.openTreatment(clinicId, patients.map((p) => p.id));
    return patients
      .map((p) => ({
        patientId: p.id,
        fullName: p.fullName,
        phone: p.phone,
        lastVisitAt: date(p.lastVisitAt),
        daysSince: Math.floor((now.getTime() - p.lastVisitAt!.getTime()) / DAY),
        source: p.source,
        ...moneyCells({ openSum: sumByCurrency(open.get(p.id) ?? []), lifetimePaid: [{ currency: p.balanceCurrency, amount: Number(p.balancePaid ?? 0) }] }, p.balanceCurrency, lang),
      }))
      .sort((a, b) => Number(num0(b.openSum) > 0) - Number(num0(a.openSum) > 0) || num0(b.openSum) - num0(a.openSum) || num0(b.lifetimePaid) - num0(a.lifetimePaid) || b.daysSince - a.daysSince);
  }

  // How much is left to do under patients' treatment plans: the plan totals with their currency stamps (the clinic's main currency of Cliniccards, with
  // the plan's rate and discount). Item prices may be in another currency, so a plan without a total adds nothing. Only patients with incomplete items.
  private async openTreatment(clinicId: string, patientIds: string[]): Promise<Map<string, MoneyTotal[]>> {
    const out = new Map<string, MoneyTotal[]>();
    if (!patientIds.length) return out;
    const items = await this.prisma.planItem.findMany({
      where: { clinicId, patientId: { in: patientIds }, status: { in: ['NEW', 'PLANNED_TO_DO'] } },
      select: { patientId: true, planId: true, price: true },
    });
    const byPlan = new Map<string, { patientId: string; itemsSum: number }>();
    for (const i of items) {
      const p = byPlan.get(i.planId) ?? { patientId: i.patientId, itemsSum: 0 };
      p.itemsSum += Number(i.price ?? 0);
      byPlan.set(i.planId, p);
    }
    const totals = new Map(
      (await this.prisma.treatmentPlan.findMany({ where: { clinicId, externalId: { in: [...byPlan.keys()] } } })).map((t) => [t.externalId, { currency: t.currency, amount: Math.max(0, Number(t.total) - Number(t.totalDone)) }]),
    );
    for (const [planId, p] of byPlan) {
      const tot = totals.get(planId);
      if (tot) out.set(p.patientId, [...(out.get(p.patientId) ?? []), tot]);
    }
    return out;
  }

  private async sources(clinicId: string, days: number): Promise<Row[]> {
    const since = new Date(Date.now() - days * DAY);
    const patients = await this.prisma.patient.findMany({
      where: { clinicId, removedAt: null },
      select: {
        source: true,
        visits: { where: { status: DONE, startsAt: { gte: since } }, select: { amount: true } },
      },
    });
    // An empty source stays null: the label "not specified" is added by the client in its own language
    const agg = new Map<string | null, { patients: number; active: number; visits: number; revenue: number }>();
    for (const p of patients) {
      const key = p.source || null;
      const a = agg.get(key) ?? { patients: 0, active: 0, visits: 0, revenue: 0 };
      a.patients++;
      if (p.visits.length) a.active++;
      a.visits += p.visits.length;
      a.revenue += p.visits.reduce((s, v) => s + Number(v.amount ?? 0), 0);
      agg.set(key, a);
    }
    return [...agg.entries()]
      .map(([source, a]) => ({ source, patients: a.patients, active: a.active, visits: a.visits, revenue: Math.round(a.revenue) }))
      .sort((a, b) => b.patients - a.patients);
  }

  // BOM and the ";" separator for correct opening in Excel
  toCsv(report: Report, lang: Lang) {
    const text = (key: string, value: Cell): string => {
      const label = cellLabel(lang, key, value);
      // Names and notes come from an external system: a cell starting with = or @ (or + / - followed by text) turns
      // into a formula in Excel. Such values are marked with an apostrophe; ordinary phones and numbers stay as they are.
      if (typeof value === 'string' && /^([=@\t\r]|[+-](?![\d\s().-]*$))/.test(value)) return `'${label}`;
      return label;
    };
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const head = report.columns.map((c) => esc(headLabel(c, lang))).join(';');
    const lines = report.rows.map((r) => report.columns.map((c) => esc(text(c.key, r[c.key]))).join(';'));
    // a separate section after an empty line: its title, rule, totals and its own table (never mixed into the rows above)
    const parts = (report.sections ?? []).flatMap((sec) => [
      '',
      esc(sec.title),
      esc(sec.rule),
      ...sec.summary.map((x) => `${esc(x.label)};${x.value}`),
      ...(sec.note ? [esc(sec.note)] : []),
      sec.columns.map((c) => esc(headLabel(c, lang))).join(';'),
      ...sec.rows.map((r) => sec.columns.map((c) => esc(text(c.key, r[c.key]))).join(';')),
    ]);
    return '﻿' + [head, ...lines, ...parts].join('\r\n');
  }
}
