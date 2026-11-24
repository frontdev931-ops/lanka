import { MoneyTotal, clinicMoneyCurrency, effectiveCurrency, formatMoney, formatTotals, sumByCurrency } from '../common/money';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { lankaMoves } from '../reports/lanka-moves';
import { clinicDate, clinicHm, startOfClinicDay } from '../common/clinic-time';
import { decrypt } from '../common/crypto';
import { hashToken } from '../auth/tokens';
import { Lang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { TelegramApi } from './telegram.api';
import { LeaderTelegramService } from './leader-telegram.service';

const DAY = 86_400_000;
const ACTIVE = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'];

export interface DigestNumbers {
  from: string;
  to: string;
  visited: number;
  noShow: number;
  cancelled: number;
  // confirmed rescheduling OPERATIONS through LANKA by their date (not patients, not distinct visits; not the MOVED status: lanka-moves.ts)
  lankaMoves: number;
  booked: number;
  newPatients: number;
  // payments of the period per currency stamp (never one number across currencies; common/money.ts)
  paid: MoneyTotal[];
  upcoming: number;
  upcomingConfirmed: number;
  requestsNew: number;
  requestsOpen: number;
  sent: number;
  failed: number;
  replies: number;
  unclosed: number;
  reviews: { count: number; avg: number | null; low: number };
  syncDaysAgo: number | null;
  prev: { visited: number; noShow: number; cancelled: number; lankaMoves: number; booked: number; newPatients: number; paid: MoneyTotal[] };
}

const T: Record<Lang, Record<string, string>> = {
  uk: { moves: 'Перенесень через LANKA (операцій, не пацієнтів): {v}{p}', head: 'Дайджест клініки «{c}»', week: 'Тиждень {a}–{b}', day: 'День {a}', visits: 'Прийоми: проведено {v}{pv}, неявки {n}{pn}, скасування та перенесення {x}{px}', booked: 'Нових записів створено: {v}{p}', pats: 'Нових пацієнтів: {v}{p}', paid: 'Оплати: {v}{p}', upcoming: 'Записано на найближчі 7 днів: {v} (підтвердили пацієнти: {c})', bot: 'Бот і переписка', req: 'Заявок від пацієнтів: нових {n}, не опрацьовано {o}', msgs: 'Повідомлень надіслано: {s}, відповіли пацієнти: {r}', rev: 'Оцінки пацієнтів: середня {a} з 5 ({n}), низьких {l}', attention: 'Увага', unclosed: 'Записів минулих днів без підсумку: {v}', failed: 'Не вдалося надіслати повідомлень: {v}', stale: 'Дані з Cliniccards не оновлювались {d} дн.', openReq: 'Є заявки без відповіді: {o}', was: 'було', open: 'Відкрити', calm: 'Усе спокійно, нічого термінового.' },
  ru: { moves: 'Переносов через LANKA (операций, не пациентов): {v}{p}', head: 'Дайджест клиники «{c}»', week: 'Неделя {a}–{b}', day: 'День {a}', visits: 'Приёмы: проведено {v}{pv}, неявки {n}{pn}, отмены и переносы {x}{px}', booked: 'Новых записей создано: {v}{p}', pats: 'Новых пациентов: {v}{p}', paid: 'Оплаты: {v}{p}', upcoming: 'Записано на ближайшие 7 дней: {v} (подтвердили пациенты: {c})', bot: 'Бот и переписка', req: 'Заявок от пациентов: новых {n}, не обработано {o}', msgs: 'Сообщений отправлено: {s}, ответили пациенты: {r}', rev: 'Оценки пациентов: средняя {a} из 5 ({n}), низких {l}', attention: 'Внимание', unclosed: 'Записей прошлых дней без итога: {v}', failed: 'Не удалось отправить сообщений: {v}', stale: 'Данные из Cliniccards не обновлялись {d} дн.', openReq: 'Есть заявки без ответа: {o}', was: 'было', open: 'Открыть', calm: 'Всё спокойно, ничего срочного.' },
  en: { moves: 'Rescheduling operations through LANKA (operations, not patients): {v}{p}', head: 'Clinic digest “{c}”', week: 'Week {a}–{b}', day: 'Day {a}', visits: 'Appointments: completed {v}{pv}, no-shows {n}{pn}, cancelled and rescheduled {x}{px}', booked: 'New bookings created: {v}{p}', pats: 'New patients: {v}{p}', paid: 'Payments: {v}{p}', upcoming: 'Booked for the next 7 days: {v} (confirmed by patients: {c})', bot: 'Bot and chats', req: 'Patient requests: new {n}, open {o}', msgs: 'Messages sent: {s}, patients replied: {r}', rev: 'Patient ratings: average {a} of 5 ({n}), low {l}', attention: 'Attention', unclosed: 'Past appointments without an outcome: {v}', failed: 'Messages that failed to send: {v}', stale: 'Cliniccards data has not been updated for {d} days', openReq: 'Requests waiting for a reply: {o}', was: 'was', open: 'Open', calm: 'All quiet, nothing urgent.' },
};

const fmt = (n: number) => Math.round(n).toLocaleString('uk-UA').replace(/ /g, ' ');
const dm = (iso: string) => iso.slice(8, 10) + '.' + iso.slice(5, 7);

// The manager's digest: totals of a period, calculated by the code (the AI takes no part). It contains money, so the recipients are only the owner and the manager.
@Injectable()
export class DigestService {
  private readonly log = new Logger(DigestService.name);

  constructor(
    private prisma: PrismaService,
    private api: TelegramApi,
    private leaders: LeaderTelegramService,
  ) {}

  private async bot(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
    return { connected: !!i?.apiKeyEnc, username: ((i?.config ?? {}) as { username?: string }).username ?? null };
  }

  async settings(clinicId: string) {
    const [c, recipients, st] = await Promise.all([
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { digestFrequency: true, digestHour: true, digestWeekday: true } }),
      this.prisma.digestRecipient.findMany({ where: { clinicId, migratedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, lang: true } }),
      this.bot(clinicId),
    ]);
    // recipients: the LEGACY chats of the clinic's patient bot that nobody reconnected yet; the people receiving it through the LANKA service bot
    // are in GET /leader-telegram (digestTo)
    return { frequency: c.digestFrequency, hour: c.digestHour, weekday: c.digestWeekday, recipients, botConnected: st.connected, serviceBot: this.leaders.available };
  }

  async update(clinicId: string, patch: { frequency?: string; hour?: number; weekday?: number }) {
    if (patch.frequency === 'DAILY' && !hasFeature((await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan, 'daily_digest')) throw new BadRequestException('plan_feature');
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { ...(patch.frequency ? { digestFrequency: patch.frequency } : {}), ...(patch.hour !== undefined ? { digestHour: patch.hour } : {}), ...(patch.weekday !== undefined ? { digestWeekday: patch.weekday } : {}) },
    });
    return this.settings(clinicId);
  }

  // New recipients connect their own Telegram through the LANKA service bot (LeaderTelegramService); the clinic's patient bot issues no new
  // digest links (2026-11-23). Links issued before still work until they expire (bind below).

  // Called by the bot from the "owner_…" link
  async bind(clinicId: string, payload: string, chat: { id: string; name: string; lang: string }): Promise<boolean> {
    const link = await this.prisma.channelLink.findUnique({ where: { tokenHash: hashToken(payload) } });
    if (!link || link.clinicId !== clinicId || link.purpose !== 'DIGEST' || link.usedAt || link.expiresAt < new Date()) return false;
    // this Telegram already receives the digest through the service bot: no second route
    if (await this.prisma.leaderTelegram.count({ where: { clinicId, chatId: chat.id } })) return false;
    if ((await this.prisma.digestRecipient.count({ where: { clinicId } })) >= 5) return false;
    await this.prisma.channelLink.update({ where: { id: link.id }, data: { usedAt: new Date() } });
    await this.prisma.digestRecipient.upsert({ where: { clinicId_chatId: { clinicId, chatId: chat.id } }, create: { clinicId, chatId: chat.id, name: chat.name, lang: chat.lang }, update: { name: chat.name, lang: chat.lang } });
    return true;
  }

  async isRecipient(clinicId: string, chatId: string) {
    return !!(await this.prisma.digestRecipient.findFirst({ where: { clinicId, chatId, migratedAt: null }, select: { id: true } }));
  }

  async remove(clinicId: string, id: string) {
    const r = await this.prisma.digestRecipient.deleteMany({ where: { id, clinicId } });
    if (!r.count) throw new NotFoundException('not_found');
    return { ok: true };
  }

  // Figures for the period [from, to) in clinic time and for the same previous period
  async numbers(clinicId: string, kind: 'DAILY' | 'WEEKLY', now = new Date()): Promise<DigestNumbers> {
    const to = startOfClinicDay(now);
    const len = (kind === 'WEEKLY' ? 7 : 1) * DAY;
    const from = new Date(to.getTime() - len);
    const prevFrom = new Date(from.getTime() - len);
    const clinicCur = await clinicMoneyCurrency(this.prisma, clinicId);
    const count = async (a: Date, b: Date) => {
      const [byStatus, booked, pats, pay, moves] = await Promise.all([
        this.prisma.visit.groupBy({ by: ['status'], where: { clinicId, startsAt: { gte: a, lt: b } }, _count: true }),
        this.prisma.visit.count({ where: { clinicId, bookedAt: { gte: a, lt: b } } }),
        this.prisma.patient.count({ where: { clinicId, removedAt: null, createdAtExt: { gte: a, lt: b } } }),
        this.prisma.payment.groupBy({ by: ['currency'], where: { clinicId, paidAt: { gte: a, lt: b } }, _sum: { amount: true } }),
        lankaMoves(this.prisma, clinicId, a, b),
      ]);
      const c = (...st: string[]) => byStatus.filter((x) => st.includes(x.status)).reduce((s, x) => s + x._count, 0);
      return { visited: c('VISITED'), noShow: c('DID_NOT_COME'), cancelled: c('CANCELLED', 'MOVED'), lankaMoves: moves.operations.length, booked, newPatients: pats, paid: sumByCurrency(pay.map((x) => ({ currency: effectiveCurrency(x.currency, clinicCur), amount: x._sum.amount }))) };
    };
    const [cur, prev, upcoming, upcomingConfirmed, reqNew, reqOpen, sent, failed, replies, unclosed, integ, revs] = await Promise.all([
      count(from, to),
      count(prevFrom, from),
      this.prisma.visit.count({ where: { clinicId, status: { in: ACTIVE }, startsAt: { gte: now, lt: new Date(now.getTime() + 7 * DAY) } } }),
      this.prisma.visit.count({ where: { clinicId, status: { in: ACTIVE }, patientConfirmedAt: { not: null }, startsAt: { gte: now, lt: new Date(now.getTime() + 7 * DAY) } } }),
      this.prisma.bookingRequest.count({ where: { clinicId, createdAt: { gte: from, lt: to } } }),
      this.prisma.bookingRequest.count({ where: { clinicId, status: 'NEW' } }),
      this.prisma.outboundMessage.count({ where: { clinicId, status: 'SENT', sentAt: { gte: from, lt: to } } }),
      this.prisma.outboundMessage.count({ where: { clinicId, status: 'FAILED', createdAt: { gte: from, lt: to } } }),
      this.prisma.chatMessage.count({ where: { clinicId, direction: 'IN', createdAt: { gte: from, lt: to } } }),
      this.prisma.visit.count({ where: { clinicId, status: { in: ACTIVE }, startsAt: { lt: to } } }),
      this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } }, select: { lastSyncAt: true } }),
      this.prisma.review.findMany({ where: { clinicId, createdAt: { gte: from, lt: to } }, select: { rating: true } }),
    ]);
    return {
      from: clinicDate(from),
      to: clinicDate(new Date(to.getTime() - DAY)),
      ...cur,
      upcoming,
      upcomingConfirmed,
      requestsNew: reqNew,
      requestsOpen: reqOpen,
      sent,
      failed,
      replies,
      unclosed,
      reviews: { count: revs.length, avg: revs.length ? Math.round((revs.reduce((x, r) => x + r.rating, 0) / revs.length) * 10) / 10 : null, low: revs.filter((r) => r.rating <= 3).length },
      syncDaysAgo: integ?.lastSyncAt ? Math.floor((now.getTime() - integ.lastSyncAt.getTime()) / DAY) : null,
      prev,
    };
  }

  // Digest text (no markup: it arrives as a plain message)
  format(n: DigestNumbers, clinicName: string, kind: 'DAILY' | 'WEEKLY', lang: Lang, link: string): string {
    const t = T[lang];
    const was = (cur: number, prev: number, money = false) => ` (${t.was} ${money ? fmt(prev) : prev})`;
    const f = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
    const lines: string[] = [f(t.head, { c: clinicName }), kind === 'WEEKLY' ? f(t.week, { a: dm(n.from), b: dm(n.to) }) : f(t.day, { a: dm(n.from) }), ''];
    lines.push(f(t.visits, { v: n.visited, pv: was(n.visited, n.prev.visited), n: n.noShow, pn: was(n.noShow, n.prev.noShow), x: n.cancelled, px: was(n.cancelled, n.prev.cancelled) }));
    // a separate count: operations through LANKA, never added to the cancelled and moved appointments above
    if (n.lankaMoves || n.prev.lankaMoves) lines.push(f(t.moves, { v: n.lankaMoves, p: was(n.lankaMoves, n.prev.lankaMoves) }));
    lines.push(f(t.booked, { v: n.booked, p: was(n.booked, n.prev.booked) }));
    lines.push(f(t.pats, { v: n.newPatients, p: was(n.newPatients, n.prev.newPatients) }));
    // each currency with the previous period of the SAME currency; an unconfirmed currency is said as such
    const paidLine = n.paid.length
      ? n.paid.map((x) => `${formatMoney(x, lang)} (${t.was} ${fmt(n.prev.paid.find((y) => y.currency === x.currency)?.amount ?? 0)})`).join('; ')
      : `0 (${t.was} ${n.prev.paid.length ? formatTotals(n.prev.paid, lang) : '0'})`;
    lines.push(f(t.paid, { v: paidLine, p: '' }));
    lines.push(f(t.upcoming, { v: n.upcoming, c: n.upcomingConfirmed }), '', t.bot);
    lines.push(f(t.req, { n: n.requestsNew, o: n.requestsOpen }));
    lines.push(f(t.msgs, { s: n.sent, r: n.replies }));
    if (n.reviews.count) lines.push(f(t.rev, { a: n.reviews.avg ?? '', n: n.reviews.count, l: n.reviews.low }));
    const warn: string[] = [];
    if (n.requestsOpen > 0) warn.push(f(t.openReq, { o: n.requestsOpen }));
    if (n.unclosed > 0) warn.push(f(t.unclosed, { v: n.unclosed }));
    if (n.failed > 0) warn.push(f(t.failed, { v: n.failed }));
    if (n.syncDaysAgo !== null && n.syncDaysAgo >= 2) warn.push(f(t.stale, { d: n.syncDaysAgo }));
    lines.push('', warn.length ? t.attention : t.calm, ...warn.map((w) => `• ${w}`), '', `${t.open}: ${link}`);
    return lines.join('\n');
  }

  private async token(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
    return i?.apiKeyEnc ? decrypt(i.apiKeyEnc) : null;
  }

  // Sends the digest: to the managers who switched it on in their LANKA service bot connection (their role is checked again right before), and
  // to the legacy chats of the clinic's patient bot nobody reconnected yet. A chat that has a service bot connection never gets the legacy copy,
  // so one person never receives it twice. only: the chat ids of a manual request (the /digest command). Returns the number delivered.
  async send(clinicId: string, kind: 'DAILY' | 'WEEKLY', only?: string[]): Promise<number> {
    const [clinic, numbers] = await Promise.all([
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } }),
      this.numbers(clinicId, kind),
    ]);
    const link = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/analytics`;
    let ok = await this.leaders.send(clinicId, 'digest', (lang) => this.format(numbers, clinic.name, kind, lang, link), only);
    const token = await this.token(clinicId);
    if (!token) return ok;
    const viaService = new Set((await this.prisma.leaderTelegram.findMany({ where: { clinicId }, select: { chatId: true } })).map((x) => x.chatId));
    const legacy = await this.prisma.digestRecipient.findMany({ where: { clinicId, migratedAt: null, ...(only ? { chatId: { in: only } } : {}) } });
    for (const r of legacy) {
      if (viaService.has(r.chatId)) continue;
      try {
        await this.api.sendMessage(token, r.chatId, this.format(numbers, clinic.name, kind, (r.lang as Lang) ?? 'uk', link));
        ok++;
      } catch (e) {
        this.log.warn(`Дайджест не доставлено: ${(e as Error).message}`);
      }
    }
    return ok;
  }

  // Once a minute: if the clinic's digest hour has come and it has not been sent today yet, we send it
  // scope: only one clinic is looked at (the scheduler never passes it; a test uses it so that other clinics of a shared database do not take part)
  async tick(now = new Date(), scope?: { clinicId: string }) {
    const clinics = await this.prisma.clinic.findMany({ where: { digestFrequency: { in: ['DAILY', 'WEEKLY'] }, suspendedAt: null, ...(scope ? { id: scope.clinicId } : {}) }, select: { id: true, digestFrequency: true, digestHour: true, digestWeekday: true, lastDigestAt: true } });
    for (const c of clinics) {
      const today = clinicDate(now);
      if (c.lastDigestAt && clinicDate(c.lastDigestAt) === today) continue;
      if (Number(clinicHm(now).slice(0, 2)) < c.digestHour) continue;
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
      if (c.digestFrequency === 'WEEKLY' && weekday !== c.digestWeekday) continue;
      // we mark it first, so that a sending failure does not turn into repeated digests every minute
      await this.prisma.clinic.update({ where: { id: c.id }, data: { lastDigestAt: now } });
      await this.send(c.id, c.digestFrequency as 'DAILY' | 'WEEKLY').catch((e) => this.log.warn(`Дайджест: ${(e as Error).message}`));
    }
  }
}
