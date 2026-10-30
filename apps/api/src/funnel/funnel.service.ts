import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { clinicDate, clinicMonth, localToUtc } from '../common/clinic-time';

const DAY = 86_400_000;
// Пациент считается ушедшим, если не был дольше этого срока (решение владелицы, 28.10.2026)
export const LOST_AFTER_DAYS = 180;
// Группы прайса, выполнение которых не считается началом лечения (диагностика, осмотр, материалы, седация, гигиена)
const NOT_TREATMENT = /^(обстеження|огляди|матеріали|седація|профілактика)/i;
const NO_SOURCE = '(не вказано)';
const NO_DIRECTION = '(без лікування)';
const DONE_ITEM = ['DONE', 'INVOICED'];
const CLOSED_BAD = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];
const OPEN_PAST = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'IN_CLINIC', 'IN_CHAIR'];

// Этапы пути к лечению (каждый следующий включает предыдущий) и ветка возвращения (от «пришёл»)
export const PATH = ['card', 'booked', 'came', 'started', 'paid'] as const;
export const RETURN = ['came', 'repeat', 'active'] as const;
export type StageKey = (typeof PATH)[number] | (typeof RETURN)[number];

// Причины, по которым пациент остановился (нужны для списка «кого вернуть»)
export const REASONS = [
  'no-booking', // карточка есть, записи нет
  'upcoming', // записан, приём ещё впереди
  'unclosed', // запись прошла, итог не выставлен
  'cancelled', // последняя запись отменена
  'no-show', // не пришёл
  'moved', // перенесена
  'not-started', // пришёл, лечение не начал
  'not-paid', // начал, ничего не оплатил
  'no-return', // был один раз
  'lost', // пришёл, но дальше не появлялся дольше срока
] as const;
export type Reason = (typeof REASONS)[number];

// Направление лечения по группе услуг: две группы эндодонтии и две хирургии объединяем
export function directionOf(group?: string | null): string | null {
  const g = (group ?? '').trim();
  if (!g || NOT_TREATMENT.test(g)) return null;
  if (/ендодонт|эндодонт|ендодонтія/i.test(g)) return 'Ендодонтія';
  if (/хірург/i.test(g)) return 'Хірургія';
  return g.replace(/^\d+\.\s*/, '');
}

export type { P as PatientStages };

export interface FunnelFilter {
  months: number;
  source?: string;
  direction?: string;
}

interface P {
  id: string;
  fullName: string;
  phone: string | null;
  source: string;
  createdAt: Date;
  lastVisitAt: Date | null;
  paid: number;
  firstBookedAt?: Date;
  firstVisitedAt?: Date;
  firstDoneAt?: Date;
  hasVisits: boolean;
  visitedDays: number;
  lastVisited?: Date;
  hasFutureActive: boolean;
  lastStatus?: string;
  lastStatusEnded?: boolean;
  direction: string;
  openPlanSum: number;
  // этапы
  booked: boolean;
  came: boolean;
  started: boolean;
  paidStage: boolean;
  repeat: boolean;
  active: boolean;
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const days = (a?: Date, b?: Date) => (a && b ? Math.round((b.getTime() - a.getTime()) / DAY) : undefined);

@Injectable()
export class FunnelService {
  constructor(private prisma: PrismaService) {}

  // Начало первого месяца когорты (по часовому поясу клиники)
  private from(months: number) {
    const [y, m] = clinicDate(new Date()).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
    return localToUtc(`${d.toISOString().slice(0, 7)}-01 00:00:00`);
  }

  private readonly patientSelect = { id: true, fullName: true, phone: true, source: true, createdAtExt: true, lastVisitAt: true, balancePaid: true } as const;

  // Загружает когорту (карточки, созданные за период) и считает этапы каждого пациента
  private async load(clinicId: string, months: number): Promise<P[]> {
    const patients = await this.prisma.patient.findMany({
      where: { clinicId, removedAt: null, createdAtExt: { gte: this.from(months) } },
      select: this.patientSelect,
    });
    return this.compute(clinicId, patients);
  }

  // Этапы пути для конкретных пациентов (нужны журналу обращений: дошло ли обращение до записи и прихода)
  async stagesOf(clinicId: string, ids: string[]): Promise<Map<string, P>> {
    if (!ids.length) return new Map();
    const patients = await this.prisma.patient.findMany({ where: { clinicId, id: { in: ids } }, select: this.patientSelect });
    return new Map((await this.compute(clinicId, patients)).map((p) => [p.id, p]));
  }

  private async compute(
    clinicId: string,
    patients: { id: string; fullName: string; phone: string | null; source: string | null; createdAtExt: Date | null; lastVisitAt: Date | null; balancePaid: unknown }[],
  ): Promise<P[]> {
    const now = new Date();
    if (!patients.length) return [];
    const ids = patients.map((p) => p.id);
    const [visits, items] = await Promise.all([
      this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids } }, select: { patientId: true, status: true, startsAt: true, endsAt: true, bookedAt: true } }),
      this.prisma.planItem.findMany({ where: { clinicId, patientId: { in: ids } }, select: { patientId: true, status: true, markedDoneAt: true, groupName: true, price: true } }),
    ]);
    const vBy = new Map<string, typeof visits>();
    for (const v of visits) (vBy.get(v.patientId) ?? vBy.set(v.patientId, []).get(v.patientId)!).push(v);
    const iBy = new Map<string, typeof items>();
    for (const i of items) (iBy.get(i.patientId) ?? iBy.set(i.patientId, []).get(i.patientId)!).push(i);

    return patients.map((p) => {
      const vs = (vBy.get(p.id) ?? []).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const its = iBy.get(p.id) ?? [];
      const visited = vs.filter((v) => v.status === 'VISITED');
      const doneTreat = its.filter((i) => DONE_ITEM.includes(i.status) && i.markedDoneAt && !NOT_TREATMENT.test(i.groupName ?? ''));
      const doneAny = its.filter((i) => DONE_ITEM.includes(i.status));
      const paid = Number(p.balancePaid ?? 0);
      // Направление: группа с наибольшей суммой цен среди лечебных
      const sums = new Map<string, number>();
      for (const i of its) {
        const d = directionOf(i.groupName);
        if (d) sums.set(d, (sums.get(d) ?? 0) + Number(i.price ?? 0));
      }
      const direction = [...sums].sort((a, b) => b[1] - a[1])[0]?.[0] ?? NO_DIRECTION;
      const openPlanSum = its.filter((i) => i.status === 'NEW' || i.status === 'PLANNED_TO_DO').reduce((s, i) => s + Number(i.price ?? 0), 0);

      const visitedDays = new Set(visited.map((v) => clinicDate(v.startsAt))).size;
      const lastVisited = visited.length ? visited[visited.length - 1].startsAt : undefined;
      // «Пришёл» подтверждается любым из признаков: визит со статусом «был», выполненная услуга или оплата.
      // Так незакрытые администратором записи не выбрасывают из воронки тех, кто на самом деле лечится.
      const came = visited.length > 0 || doneAny.length > 0 || paid > 0;
      const booked = came || vs.length > 0;
      const started = came && doneTreat.length > 0;
      const paidStage = started && paid > 0;
      const repeat = came && visitedDays >= 2;
      const lastEvidence = [lastVisited, ...doneAny.map((i) => i.markedDoneAt ?? undefined)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      const hasFutureActive = vs.some((v) => v.startsAt > now && !CLOSED_BAD.includes(v.status));
      const active = came && (hasFutureActive || (!!lastEvidence && now.getTime() - lastEvidence.getTime() <= LOST_AFTER_DAYS * DAY));
      const last = vs[vs.length - 1];
      return {
        id: p.id,
        fullName: p.fullName,
        phone: p.phone,
        source: p.source?.trim() || NO_SOURCE,
        createdAt: p.createdAtExt ?? new Date(0),
        lastVisitAt: p.lastVisitAt,
        paid,
        firstBookedAt: vs.map((v) => v.bookedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0],
        firstVisitedAt: visited[0]?.startsAt,
        firstDoneAt: doneTreat.map((i) => i.markedDoneAt!).sort((a, b) => a.getTime() - b.getTime())[0],
        hasVisits: vs.length > 0,
        visitedDays,
        lastVisited: lastEvidence ?? lastVisited,
        hasFutureActive,
        lastStatus: last?.status,
        lastStatusEnded: last ? (last.endsAt ?? new Date(last.startsAt.getTime() + 30 * 60_000)).getTime() < now.getTime() - 2 * 3600_000 : undefined,
        direction,
        openPlanSum,
        booked,
        came,
        started,
        paidStage,
        repeat,
        active,
      };
    });
  }

  private pick(all: P[], f: FunnelFilter) {
    return all.filter((p) => (!f.source || p.source === f.source) && (!f.direction || p.direction === f.direction));
  }

  private stageCounts(ps: P[]) {
    return {
      card: ps.length,
      booked: ps.filter((p) => p.booked).length,
      came: ps.filter((p) => p.came).length,
      started: ps.filter((p) => p.started).length,
      paid: ps.filter((p) => p.paidStage).length,
      repeat: ps.filter((p) => p.repeat).length,
      active: ps.filter((p) => p.active).length,
    };
  }

  // Пациенты, остановившиеся по причине reason. Считается только по пациентам когорты.
  private whoStopped(ps: P[], reason: Reason): P[] {
    switch (reason) {
      case 'no-booking':
        return ps.filter((p) => !p.booked);
      case 'upcoming':
        return ps.filter((p) => p.booked && !p.came && p.hasFutureActive);
      case 'unclosed':
        return ps.filter((p) => p.booked && !p.came && !p.hasFutureActive && !!p.lastStatus && OPEN_PAST.includes(p.lastStatus) && p.lastStatusEnded);
      case 'cancelled':
        return ps.filter((p) => p.booked && !p.came && !p.hasFutureActive && p.lastStatus === 'CANCELLED');
      case 'no-show':
        return ps.filter((p) => p.booked && !p.came && !p.hasFutureActive && p.lastStatus === 'DID_NOT_COME');
      case 'moved':
        return ps.filter((p) => p.booked && !p.came && !p.hasFutureActive && p.lastStatus === 'MOVED');
      case 'not-started':
        return ps.filter((p) => p.came && !p.started);
      case 'not-paid':
        return ps.filter((p) => p.started && !p.paidStage);
      case 'no-return':
        return ps.filter((p) => p.came && !p.repeat);
      case 'lost':
        return ps.filter((p) => p.came && !p.active);
    }
  }

  async overview(clinicId: string, f: FunnelFilter, withMoney = false) {
    const all = await this.load(clinicId, f.months);
    const ps = this.pick(all, f);
    const counts = this.stageCounts(ps);

    // Время между этапами (медиана, дней)
    const gap = (fn: (p: P) => number | undefined) => median(ps.map(fn).filter((x): x is number => x !== undefined && x >= 0));
    const medians = {
      cardToBooked: gap((p) => days(p.createdAt, p.firstBookedAt)),
      bookedToCame: gap((p) => days(p.firstBookedAt, p.firstVisitedAt)),
      cameToStarted: gap((p) => days(p.firstVisitedAt, p.firstDoneAt)),
    };

    // По месяцам создания карточки (когорты)
    const byMonth = new Map<string, P[]>();
    for (const p of ps) {
      const k = clinicMonth(p.createdAt);
      (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(p);
    }
    const cohorts = [...byMonth].sort((a, b) => b[0].localeCompare(a[0])).map(([month, list]) => ({ month, ...this.stageCounts(list) }));

    // Сравнение источников и направлений (по всей когорте периода, без выбранного среза)
    const groupBy = (key: (p: P) => string, base: P[]) => {
      const m = new Map<string, P[]>();
      for (const p of base) (m.get(key(p)) ?? m.set(key(p), []).get(key(p))!).push(p);
      return [...m].sort((a, b) => b[1].length - a[1].length).map(([name, list]) => ({ name, ...this.stageCounts(list), paidSum: Math.round(list.reduce((s, p) => s + p.paid, 0)) }));
    };
    const bySource = groupBy((p) => p.source, all.filter((p) => !f.direction || p.direction === f.direction));
    const byDirection = groupBy((p) => p.direction, all.filter((p) => !f.source || p.source === f.source)).filter((r) => r.name !== NO_DIRECTION);

    const leaks = Object.fromEntries(REASONS.map((r) => [r, this.whoStopped(ps, r).length]));
    // Money of the selected cohort (only for roles that may see money): what was paid and how much planned treatment is still open
    const sum = (list: P[], pick: (p: P) => number) => Math.round(list.reduce((a, p) => a + pick(p), 0));
    const money = withMoney
      ? {
          paid: sum(ps, (p) => p.paid),
          payers: ps.filter((p) => p.paid > 0).length,
          openPlanNotStarted: sum(ps.filter((p) => p.came && !p.started), (p) => p.openPlanSum),
          openPlanStarted: sum(ps.filter((p) => p.started), (p) => p.openPlanSum),
        }
      : null;
    return {
      money,
      months: f.months,
      lostAfterDays: LOST_AFTER_DAYS,
      from: this.from(f.months),
      counts,
      medians,
      cohorts,
      bySource,
      byDirection,
      leaks,
      sources: [...new Set(all.map((p) => p.source))].sort(),
      directions: [...new Set(all.map((p) => p.direction))].filter((d) => d !== NO_DIRECTION).sort(),
    };
  }

  // Верх воронки: обращения за период → карточка → запись → пришёл. Вернувшиеся (пациент уже был) считаются отдельно.
  async inquiryFunnel(clinicId: string, months: number, channel?: string) {
    const inquiries = await this.prisma.inquiry.findMany({
      where: { clinicId, occurredAt: { gte: this.from(months) }, ...(channel ? { channel } : {}) },
      orderBy: { occurredAt: 'desc' },
    });
    const stages = await this.stagesOf(clinicId, [...new Set(inquiries.map((i) => i.patientId).filter((x): x is string => !!x))]);
    const fresh = inquiries.filter((i) => !i.returning);
    const flag = (i: (typeof inquiries)[number], k: 'booked' | 'came' | 'started') => (i.patientId ? !!stages.get(i.patientId)?.[k] : false);
    const sum = (list: typeof inquiries) => ({
      total: list.length,
      card: list.filter((i) => !!i.patientId).length,
      booked: list.filter((i) => flag(i, 'booked')).length,
      came: list.filter((i) => flag(i, 'came')).length,
      started: list.filter((i) => flag(i, 'started')).length,
      lost: list.filter((i) => i.status === 'LOST' && !i.patientId).length,
    });
    const byChannel = new Map<string, typeof inquiries>();
    for (const i of fresh) (byChannel.get(i.channel) ?? byChannel.set(i.channel, []).get(i.channel)!).push(i);
    return {
      months,
      counts: sum(fresh),
      returning: inquiries.length - fresh.length,
      byChannel: [...byChannel].sort((a, b) => b[1].length - a[1].length).map(([name, list]) => ({ name, ...sum(list) })),
    };
  }

  // Конкретные люди, остановившиеся на переходе (до 300 самых свежих карточек)
  async people(clinicId: string, f: FunnelFilter, reason: Reason) {
    const ps = this.pick(await this.load(clinicId, f.months), f);
    const list = this.whoStopped(ps, reason).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      reason,
      total: list.length,
      rows: list.slice(0, 300).map((p) => ({
        patientId: p.id,
        fullName: p.fullName,
        phone: p.phone,
        source: p.source,
        direction: p.direction === NO_DIRECTION ? null : p.direction,
        createdAt: clinicDate(p.createdAt),
        lastEvidenceAt: p.lastVisited ? clinicDate(p.lastVisited) : null,
        lastStatus: p.lastStatus ?? null,
        openPlanSum: Math.round(p.openPlanSum),
      })),
    };
  }

  // Work of the team by OUR data (Cliniccards cannot tell administrators apart): inquiries logged and how many of them came,
  // requests from chats handled, contacts logged by outcome
  async staff(clinicId: string, months: number) {
    const since = this.from(months);
    const [members, inquiries, requests, contacts] = await Promise.all([
      this.prisma.membership.findMany({ where: { clinicId }, include: { user: { select: { id: true, name: true } } } }),
      this.prisma.inquiry.findMany({ where: { clinicId, occurredAt: { gte: since }, createdById: { not: null } }, select: { createdById: true, patientId: true, occurredAt: true } }),
      this.prisma.bookingRequest.groupBy({ by: ['handledById'], where: { clinicId, status: 'DONE', handledAt: { gte: since }, handledById: { not: null } }, _count: true }),
      this.prisma.contactLog.findMany({ where: { clinicId, contactedAt: { gte: since }, userId: { not: null } }, select: { userId: true, outcome: true } }),
    ]);
    const patientIds = [...new Set(inquiries.map((i) => i.patientId).filter((x): x is string => !!x))];
    const visits = patientIds.length ? await this.prisma.visit.findMany({ where: { clinicId, patientId: { in: patientIds }, status: 'VISITED' }, select: { patientId: true, startsAt: true } }) : [];
    const cameAfter = (patientId: string, at: Date) => visits.some((v) => v.patientId === patientId && v.startsAt >= at);
    return members
      .filter((m) => m.role !== 'DOCTOR')
      .map((m) => {
        const mine = inquiries.filter((i) => i.createdById === m.user.id);
        const outcomes: Record<string, number> = {};
        const mineContacts = contacts.filter((c) => c.userId === m.user.id);
        for (const c of mineContacts) outcomes[c.outcome ?? 'NONE'] = (outcomes[c.outcome ?? 'NONE'] ?? 0) + 1;
        return {
          userId: m.user.id,
          name: m.user.name,
          role: m.role,
          inquiries: mine.length,
          inquiriesCame: mine.filter((i) => i.patientId && cameAfter(i.patientId, i.occurredAt)).length,
          requestsHandled: requests.find((r) => r.handledById === m.user.id)?._count ?? 0,
          contacts: mineContacts.length,
          contactOutcomes: outcomes,
        };
      })
      .sort((a, b) => b.inquiries + b.requestsHandled + b.contacts - (a.inquiries + a.requestsHandled + a.contacts));
  }
}
