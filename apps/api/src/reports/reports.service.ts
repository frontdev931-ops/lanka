import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clinicDate, clinicHm, clinicMonth, localToUtc, startOfClinicDay } from '../common/clinic-time';
import { readWorkHours } from '../clinic/work-hours';
import { COLUMN_LABEL, Lang, REPORT_RULE, REPORT_TEXT, ReportId, VALUE_LABEL } from '../common/i18n';
import { cellLabel } from './report-export';

// Статусы Cliniccards: посещение состоялось / запись больше не действует.
const DONE = 'VISITED';
// Статусы записи, которые к концу приёма должны смениться на итог (пришёл, не пришёл, отмена, перенос)
const UNCLOSED = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'IN_CLINIC', 'IN_CHAIR'];
const INACTIVE = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];
const DAY = 86_400_000;

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export interface Report {
  id: string;
  title: string;
  rule: string;
  days: number;
  maxDays: number | null;
  dataUpdatedAt: Date | null;
  generatedAt: string;
  columns: { key: string; label: string }[];
  canCreateTasks: boolean;
  // Значения kind (код статуса), rebooked (boolean) и пустой source подписывает клиент на своём языке
  rows: Row[];
}

interface Meta {
  id: ReportId;
  defaultDays: number;
  // Верхняя граница периода (для «давно не бывавших»): не старше стольких дней; null — без границы
  defaultMaxDays?: number;
  // false — период в отчёте не применяется (поле скрывается в интерфейсе)
  usesDays: boolean;
  canCreateTasks: boolean;
  // Если задано, отчёт доступен только этим ролям (финансовые показатели клиники)
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

// Пациент, о котором уже есть действующее напоминание (NEW) на сегодня или позже, в списках «вернуть пациента» не нужен
const activeReminder = () => ({ status: 'NEW', dueDate: { gte: new Date(clinicDate(new Date()) + 'T00:00:00Z') } });

const date = (d: Date | null | undefined) => (d ? clinicDate(d) : null);

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

  async build(clinicId: string, id: string, days: number | undefined, lang: Lang, role?: Role, maxDays?: number): Promise<Report> {
    const meta = META.find((m) => m.id === id);
    if (!meta) throw new NotFoundException('report_not_found');
    if (!allowed(meta, role)) throw new ForbiddenException('report_forbidden');
    const d = days ?? meta.defaultDays;
    const integration = await this.prisma.integration.findFirst({
      where: { clinicId },
      select: { lastSyncAt: true },
    });
    const max = meta.defaultMaxDays ? Math.max(maxDays ?? meta.defaultMaxDays, d + 1) : undefined;
    const rows = await this.rows(meta.id, clinicId, d, max);
    return {
      id,
      title: REPORT_TEXT[meta.id].title[lang],
      rule: REPORT_RULE[meta.id][lang](d, max),
      days: d,
      maxDays: max ?? null,
      dataUpdatedAt: integration?.lastSyncAt ?? null,
      generatedAt: new Date().toISOString(),
      canCreateTasks: meta.canCreateTasks,
      // Свободные окна по часам кабинета не привязаны к врачу: колонка «Лікар» тогда не нужна
      columns: meta.columns.filter((key) => !(id === 'free-slots' && key === 'doctor' && rows.every((r) => !r.doctor))).map((key) => ({ key, label: COLUMN_LABEL[lang][key] ?? key })),
      rows,
    };
  }

  private rows(id: ReportId, clinicId: string, days: number, maxDays?: number): Promise<Row[]> {
    switch (id) {
      case 'no-next-visit':
        return this.noNextVisit(clinicId, days);
      case 'missed-visits':
        return this.missedVisits(clinicId, days);
      case 'unclosed-visits':
        return this.unclosedVisits(clinicId, days);
      case 'lapsed-patients':
        return this.lapsed(clinicId, days, maxDays ?? 730);
      case 'unfinished-treatment':
        return this.unfinishedTreatment(clinicId, days);
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

  // Лечение начато (за период выполнен пункт плана), но в том же плане остались невыполненные пункты;
  // пациенты с будущей действующей записью не включаются.
  private async unfinishedTreatment(clinicId: string, days: number): Promise<Row[]> {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const items = await this.prisma.planItem.findMany({
      where: { clinicId, OR: [{ status: { in: ['NEW', 'PLANNED_TO_DO'] } }, { markedDoneAt: { gte: since } }] },
      select: { patientId: true, planId: true, name: true, status: true, price: true, markedDoneAt: true },
    });

    // open — число разных услуг (у зубных услуг одна строка плана на зуб, считаем по названию)
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
      if (!p.open || !p.lastDone) continue; // лечение не начато или уже всё выполнено
      const a = byPatient.get(p.patientId) ?? { open: 0, openSum: 0, lastDone: p.lastDone };
      a.open += p.open;
      a.openSum += p.openSum;
      if (p.lastDone > a.lastDone) a.lastDone = p.lastDone;
      byPatient.set(p.patientId, a);
    }
    if (!byPatient.size) return [];

    // Остаток лечения берём из итогов плана (в валюте клиники, с фиксированным курсом и скидкой):
    // цены пунктов могут быть в другой валюте, и складывать их нельзя
    const planIds = [...new Set([...plans.values()].map((p) => p.planId))];
    const totals = new Map(
      (await this.prisma.treatmentPlan.findMany({ where: { clinicId, externalId: { in: planIds } } })).map((t) => [t.externalId, Math.max(0, Number(t.total) - Number(t.totalDone))]),
    );
    for (const a of byPatient.values()) a.openSum = 0;
    for (const p of plans.values()) {
      if (!p.open || !p.lastDone) continue;
      byPatient.get(p.patientId)!.openSum += totals.get(p.planId) ?? p.openSum;
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
        return {
          patientId: p.id,
          fullName: p.fullName,
          phone: p.phone,
          openItems: a.open,
          openSum: Math.round(a.openSum),
          lastDoneAt: date(a.lastDone),
          daysSince: Math.floor((now.getTime() - a.lastDone.getTime()) / DAY),
        };
      })
      .sort((a, b) => (b.daysSince as number) - (a.daysSince as number));
  }

  // Долг считается по карточке Cliniccards: выставлено к оплате минус оплачено
  private async debtors(clinicId: string): Promise<Row[]> {
    const patients = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, balanceIssued: { gt: 0 } } });
    return patients
      .map((p) => {
        const issued = Number(p.balanceIssued ?? 0);
        const paid = Number(p.balancePaid ?? 0);
        return { patientId: p.id, fullName: p.fullName, phone: p.phone, balanceIssued: issued, balancePaid: paid, debt: Math.round((issued - paid) * 100) / 100, lastVisitAt: date(p.lastVisitAt) };
      })
      .filter((r) => (r.debt as number) > 0.01)
      .sort((a, b) => (b.debt as number) - (a.debt as number));
  }

  private async revenue(clinicId: string, days: number): Promise<Row[]> {
    const since = new Date(Date.now() - days * DAY);
    const [invoices, payments] = await Promise.all([
      this.prisma.invoice.findMany({ where: { clinicId, issuedAt: { gte: since } }, select: { issuedAt: true, amount: true } }),
      this.prisma.payment.findMany({ where: { clinicId, paidAt: { gte: since } }, select: { paidAt: true, amount: true } }),
    ]);
    const months = new Map<string, { invoiced: number; paid: number; paymentsCount: number }>();
    const slot = (d: Date) => {
      const key = clinicMonth(d);
      const m = months.get(key) ?? { invoiced: 0, paid: 0, paymentsCount: 0 };
      months.set(key, m);
      return m;
    };
    for (const i of invoices) slot(i.issuedAt).invoiced += Number(i.amount);
    for (const p of payments) {
      const m = slot(p.paidAt);
      m.paid += Number(p.amount);
      m.paymentsCount++;
    }
    return [...months.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, m]) => ({ month, invoiced: Math.round(m.invoiced), paid: Math.round(m.paid), paymentsCount: m.paymentsCount }));
  }

  // Свободное время. Если в Cliniccards есть смены врачей: смена минус записи врача минус зарезервированное время
  // его кабинета. Если смен нет (клиника не заводит профили врачей): рабочие часы клиники минус записи
  // кабинета минус серые блоки кабинета (блоки в расписании обозначают «здесь никого не записывать»).
  // Дни и часы считаются в часовом поясе клиники.
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

    const hhmm = (t: number) => clinicHm(t);
    // Промежутки внутри [start, end], не занятые отрезками busy, не короче MIN_GAP_MINUTES
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
        if (!h) continue; // выходной
        const open = Math.max(localToUtc(`${ymd} ${h.from}:00`).getTime(), now); // прошедшее время не считаем
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

  // Пациент с состоявшимся посещением за период и без будущих действующих записей.
  private async noNextVisit(clinicId: string, days: number): Promise<Row[]> {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const patients = await this.prisma.patient.findMany({
      where: {
        clinicId,
        removedAt: null,
        visits: {
          some: { status: DONE, startsAt: { gte: since, lte: now } },
          none: { status: { notIn: INACTIVE }, startsAt: { gt: now } },
        },
        reminders: { none: activeReminder() },
      },
      include: {
        visits: {
          where: { status: DONE, startsAt: { gte: since, lte: now } },
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

  // Записи со статусами DID_NOT_COME, CANCELLED, MOVED за период; отмечаем, записался ли пациент заново.
  private async missedVisits(clinicId: string, days: number): Promise<Row[]> {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const visits = await this.prisma.visit.findMany({
      where: { clinicId, status: { in: INACTIVE }, startsAt: { gte: since, lte: now }, patient: { removedAt: null } },
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

  // Дата последнего визита берётся из карточки Cliniccards (patient.lastVisitAt), а не из окна синхронизации.
  // Записи, время которых прошло, но итог так и не выставлен («Заплановано», «Підтверджено», «У клініці»…): неизвестно, пришёл
  // ли человек. Из-за них воронка и отчёты о неявках занижают приход. Закрыть запись нужно в Cliniccards (мы ничего там не меняем).
  private async unclosedVisits(clinicId: string, days: number): Promise<Row[]> {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const [visits, cabinets] = await Promise.all([
      this.prisma.visit.findMany({
        where: {
          clinicId,
          status: { in: UNCLOSED },
          startsAt: { gte: since, lte: now },
          patient: { removedAt: null },
        },
        include: { patient: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { startsAt: 'desc' },
      }),
      this.prisma.cabinet.findMany({ where: { clinicId } }),
    ]);
    const names = new Map(cabinets.map((c) => [c.externalId, c.name]));
    return visits
      // запись ещё идёт или только что закончилась: итог рано требовать
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

  // Пациенты, которых давно не было: последний визит от days до maxDays дней назад (давнишние почти не возвращаются).
  // Порядок звонков: сначала те, у кого есть незавершённое лечение (по сумме), потом по сумме оплат за всё время.
  private async lapsed(clinicId: string, days: number, maxDays: number): Promise<Row[]> {
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
        openSum: open.get(p.id) ?? 0,
        lifetimePaid: Math.round(Number(p.balancePaid ?? 0)),
      }))
      .sort((a, b) => Number(b.openSum > 0) - Number(a.openSum > 0) || b.openSum - a.openSum || b.lifetimePaid - a.lifetimePaid || b.daysSince - a.daysSince);
  }

  // Сколько осталось выполнить по планам лечения пациентов: итог плана в валюте клиники (с курсом и скидкой),
  // а если итогов плана нет, сумма цен невыполненных пунктов. Только пациенты, у которых есть невыполненные пункты.
  private async openTreatment(clinicId: string, patientIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
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
      (await this.prisma.treatmentPlan.findMany({ where: { clinicId, externalId: { in: [...byPlan.keys()] } } })).map((t) => [t.externalId, Math.max(0, Number(t.total) - Number(t.totalDone))]),
    );
    for (const [planId, p] of byPlan) out.set(p.patientId, (out.get(p.patientId) ?? 0) + Math.round(totals.get(planId) ?? p.itemsSum));
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
    // Пустой источник остаётся null: подпись «не указан» ставит клиент на своём языке
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

  // BOM и разделитель «;» для корректного открытия в Excel
  toCsv(report: Report, lang: Lang) {
    const text = (key: string, value: Cell): string => {
      const label = cellLabel(lang, key, value);
      // Имена и заметки приходят из внешней системы: ячейка, начинающаяся с = или @ (или + / - с текстом), в Excel
      // превращается в формулу. Такие значения помечаются апострофом, обычные телефоны и числа остаются как есть.
      if (typeof value === 'string' && /^([=@\t\r]|[+-](?![\d\s().-]*$))/.test(value)) return `'${label}`;
      return label;
    };
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const head = report.columns.map((c) => esc(c.label)).join(';');
    const lines = report.rows.map((r) => report.columns.map((c) => esc(text(c.key, r[c.key]))).join(';'));
    return '﻿' + [head, ...lines].join('\r\n');
  }
}
