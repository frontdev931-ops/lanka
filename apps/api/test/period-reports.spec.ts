import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DigestService } from '../src/automations/digest.service';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { attentionLines, dueAt, lastCompleted, periodOf, previousPeriod } from '../src/insights/period-report-text';
import { InsightsService } from '../src/insights/insights.service';
import { PeriodReportService } from '../src/insights/period-report.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';

// Weekly and monthly reports to managers (2026-11-25): periods, figures, schedule, delivery, preview
jest.setTimeout(120_000);

class FakeTelegram {
  sent: { token: string; chatId: string; text: string }[] = [];
  refuse = new Set<string>();
  network = new Set<string>();
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (token: string, chatId: string | number, text: string) => {
    const id = String(chatId);
    if (this.refuse.has(id)) throw new TelegramError('Bad Request: chat not found', 400);
    if (this.network.has(id)) throw new Error('socket hang up');
    this.sent.push({ token, chatId: id, text });
  };
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}

const SERVICE = '999:AAServiceBotTokenForTestsOnly_abcdefghijk';
const tg = new FakeTelegram();
let app: INestApplication;
let prisma: PrismaService;
let svc: PeriodReportService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const HOUR = 3_600_000;
// Monday 23.11.2026, 10:00 in Kyiv (UTC+2): the week 16–22.11 is completed, its report is due at 09:00 Kyiv = 07:00 UTC
const MON = new Date('2026-11-23T08:00:00Z');
const DUE = new Date('2026-11-23T07:00:00Z');
const BEFORE = new Date('2026-11-20T10:00:00Z');

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = SERVICE;
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  svc = app.get(PeriodReportService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tg.sent.length = 0;
  tg.refuse.clear();
  tg.network.clear();
});

async function clinic(plan = 'PRO') {
  const email = `pr${rnd()}@example.com`;
  const name = `Клініка ${rnd()}`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: name, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan, billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 60 * 86_400_000) } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, name };
}
async function member(ownerToken: string, role: string) {
  const email = `pm${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
// a connection to the service bot with the personal subscriptions switched on before `since`
const connect = (clinicId: string, userId: string, chatId: string, sub: { weekly?: boolean; monthly?: boolean; digest?: boolean } = { weekly: true }, since = BEFORE) =>
  prisma.leaderTelegram.create({ data: { clinicId, userId, chatId, tgName: 'T', lang: 'uk', digest: !!sub.digest, weekly: !!sub.weekly, weeklySince: sub.weekly ? since : null, monthly: !!sub.monthly, monthlySince: sub.monthly ? since : null } });
const synced = (clinicId: string, at: Date) =>
  prisma.integration.upsert({ where: { clinicId_provider: { clinicId, provider: 'CLINICCARDS' } }, create: { clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x', lastSyncAt: at }, update: { apiKeyEnc: 'x', lastSyncAt: at } });
const schedule = (clinicId: string, data: Record<string, unknown>) => prisma.clinic.update({ where: { id: clinicId }, data });
async function visits(clinicId: string, status: string, at: Date, n = 1) {
  const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
  for (let i = 0; i < n; i++) await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: new Date(at.getTime() + i * 60_000), status } });
}
const reports = (chatId?: string) => tg.sent.filter((x) => x.text.includes('Звіт за') && (!chatId || x.chatId === chatId));

describe('календар', () => {
  it('тиждень пн–нд і місяць за часом Києва: Новий рік, лютий, переходи на літній і зимовий час; час відправки', () => {
    // a Wednesday: the completed week is the previous Monday–Sunday
    expect(lastCompleted('WEEKLY', new Date('2026-11-25T10:00:00Z'))).toMatchObject({ from: '2026-11-16', to: '2026-11-22', days: 7 });
    // Monday 00:30 in Kyiv (Sunday 22:30 UTC): the week that has just ended
    expect(lastCompleted('WEEKLY', new Date('2026-11-22T22:30:00Z'))).toMatchObject({ from: '2026-11-16', to: '2026-11-22' });
    // Sunday 23:30 in Kyiv: that week is not completed yet
    expect(lastCompleted('WEEKLY', new Date('2026-11-22T21:30:00Z'))).toMatchObject({ from: '2026-11-09', to: '2026-11-15' });
    // across the New Year
    expect(lastCompleted('WEEKLY', new Date('2027-01-05T10:00:00Z'))).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
    expect(lastCompleted('MONTHLY', new Date('2027-01-01T08:00:00Z'))).toMatchObject({ from: '2026-12-01', to: '2026-12-31', days: 31 });
    expect(previousPeriod(periodOf('MONTHLY', '2027-01-01')!)).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
    // February: 28 days, 29 in a leap year
    expect(periodOf('MONTHLY', '2027-02-01')).toMatchObject({ to: '2027-02-28', days: 28 });
    expect(periodOf('MONTHLY', '2028-02-01')).toMatchObject({ to: '2028-02-29', days: 29 });
    // the 1st at 01:00 in Kyiv is already the new month (23:00 UTC of the previous day)
    expect(lastCompleted('MONTHLY', new Date('2026-11-30T23:00:00Z'))).toMatchObject({ from: '2026-11-01', to: '2026-11-30' });
    // the clock changes: the spring week has 167 hours, the autumn one 169, both are 7 days from midnight to midnight in Kyiv
    const spring = periodOf('WEEKLY', '2026-03-23')!;
    expect(spring.since.toISOString()).toBe('2026-03-22T22:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T21:00:00.000Z');
    expect(spring.days).toBe(7);
    const autumn = periodOf('WEEKLY', '2026-10-19')!;
    expect((autumn.end.getTime() - autumn.since.getTime()) / HOUR).toBe(169);
    // 09:00 in Kyiv: 06:00 UTC in summer, 07:00 UTC in winter
    expect(dueAt(periodOf('WEEKLY', '2026-03-23')!, { weekday: 1, hour: 9 }).toISOString()).toBe('2026-03-30T06:00:00.000Z');
    expect(dueAt(periodOf('WEEKLY', '2026-11-16')!, { weekday: 1, hour: 9 }).toISOString()).toBe('2026-11-23T07:00:00.000Z');
    expect(dueAt(periodOf('WEEKLY', '2026-11-16')!, { weekday: 3, hour: 18 }).toISOString()).toBe('2026-11-25T16:00:00.000Z');
    expect(dueAt(periodOf('MONTHLY', '2026-10-01')!, { weekday: 1, hour: 9 }).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    // not a Monday / not the 1st: not a period
    expect(periodOf('WEEKLY', '2026-11-17')).toBeNull();
    expect(periodOf('MONTHLY', '2026-11-02')).toBeNull();
  });
});

describe('звіти за тиждень і місяць', () => {
  it('цифри: ті самі, що в звітах застосунку; нуль — без відсотка; частка в п. п.; валюти окремо', async () => {
    const c = await clinic();
    const reportsSvc = app.get(ReportsService);
    const w = periodOf('WEEKLY', '2026-11-16')!;
    const prev = previousPeriod(w);
    const mid = new Date(w.since.getTime() + 2 * 86_400_000);
    await visits(c.clinicId, 'VISITED', mid, 8);
    await visits(c.clinicId, 'CANCELLED', mid, 1);
    await visits(c.clinicId, 'DID_NOT_COME', mid, 1);
    await visits(c.clinicId, 'PLANNED', mid, 2); // without an outcome: not in the share
    await visits(c.clinicId, 'VISITED', new Date(prev.since.getTime() + 86_400_000), 4);
    await visits(c.clinicId, 'CANCELLED', new Date(prev.since.getTime() + 86_400_000), 1);
    for (const [amount, currency] of [[1000, 'UAH'], [500, null], [40, 'USD']] as const) await prisma.payment.create({ data: { clinicId: c.clinicId, externalId: `pay${rnd()}`, paidAt: mid, amount, currency } });
    await prisma.payment.create({ data: { clinicId: c.clinicId, externalId: `pay${rnd()}`, paidAt: new Date(prev.since.getTime() + HOUR), amount: 1200, currency: 'UAH' } });
    await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `n${rnd()}`, fullName: 'Нова', createdAtExt: mid } });
    await synced(c.clinicId, new Date(w.end.getTime() + 3 * HOUR));
    const f = await svc.facts(c.clinicId, w, MON);
    expect(f.state).toBe('READY');
    expect(f.cur).toMatchObject({ completed: 8, cancelled: 1, noShow: 1, scheduled: 10, unclosed: 2, paymentsCount: 3 });
    expect(f.cur!.paid).toEqual([{ currency: 'UAH', amount: 1500 }, { currency: 'USD', amount: 40 }]);
    expect(f.prev).toMatchObject({ completed: 4, cancelled: 1, scheduled: 5, newPatients: 0 });
    // the month's payments equal the "Paid" of the "Revenue" report for that month
    const month = periodOf('MONTHLY', '2026-11-01')!;
    const m = await reportsSvc.periodSummary(c.clinicId, month.since, month.end);
    const rev = await reportsSvc.build(c.clinicId, 'revenue', 400, 'uk', 'OWNER' as never);
    const row = (cur: string) => rev.rows.find((r) => r.month === '2026-11' && r.currency === cur);
    expect(m.paid.find((x) => x.currency === 'UAH')!.amount).toBe(Number(row('UAH')!.paid));
    expect(m.paid.find((x) => x.currency === 'USD')!.amount).toBe(Number(row('USD')!.paid));
    // the text
    const text = (await svc.preview(c.clinicId, 'WEEKLY', undefined, 'uk')).text;
    expect(text).toContain(c.name);
    const v = await svc.preview(c.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON);
    expect(v.text).toContain('16.11.2026 — 22.11.2026');
    expect(v.text).toContain('Завершені візити: 8 (попер.: 4; +4, +100,0%)');
    expect(v.text).toContain('Нові пацієнти (нові картки в Cliniccards): 1 (попер.: 0; +1)'); // a zero base: no percentage
    expect(v.text).toContain('2 з 10 візитів із відомим результатом — 20,0% (попер.: 20,0%; ±0,0 п. п.)');
    expect(v.text).toContain('Отримані оплати: 1 500 грн (попер.: 1 200 грн; +25,0%)');
    expect(v.text).toContain('Отримані оплати: 40 USD (попер.: 0 USD)'); // never added to hryvnias, no percentage from zero
    expect(v.text).toContain('Візитів без відмітки, чи прийшов пацієнт: 2 (у частку не входять)');
    expect(v.text).toContain('Порівняння з попереднім тижнем 09.11.2026 — 15.11.2026.');
    expect(v.text).toContain(`/period-report?kind=WEEKLY&from=2026-11-16&c=${c.clinicId}`);
    expect(v.text).not.toMatch(/∞|NaN|Infinity|Пацієнт /);
    // the month names both periods and their lengths, with no conclusion drawn from them
    const mv = await svc.preview(c.clinicId, 'MONTHLY', '2026-10-01', 'uk', new Date('2026-12-01T08:00:00Z'));
    expect(mv.text).toContain('01.10.2026 — 31.10.2026 (31 дн.)');
    expect(mv.text).toContain('Порівняння з попереднім місяцем 01.09.2026 — 30.09.2026 (30 дн.; цей місяць — 31 дн.).');
    expect(mv.text).toContain('візитів із відомим результатом не було — частку не рахуємо');
    expect(mv.text).toContain('оплат не було');
    expect((await svc.preview(c.clinicId, 'WEEKLY', '2026-11-16', 'en', MON)).text).toContain('Weekly report');
  });

  it('немає даних: Cliniccards не підключено або дані не за весь період — без цифр; поточні проблеми — не «нові за період»', async () => {
    const c = await clinic();
    const w = periodOf('WEEKLY', '2026-11-16')!;
    const none = await svc.preview(c.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON);
    expect(none.facts).toMatchObject({ state: 'STALE', connected: false });
    expect(none.text).toContain('Cliniccards не підключено');
    expect(none.text).not.toContain('Завершені візити');
    await synced(c.clinicId, new Date(w.end.getTime() - 5 * HOUR)); // the last load before the end of the period
    const old = await svc.preview(c.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON);
    expect(old.facts.state).toBe('STALE');
    expect(old.text).toContain('Неповні цифри не надсилаємо');
    // ready: the current issues are labelled as the state now
    await synced(c.clinicId, new Date(w.end.getTime() + HOUR));
    for (let i = 0; i < 2; i++) await prisma.task.create({ data: { clinicId: c.clinicId, title: 'T', dueDate: new Date(Date.now() - 3 * 86_400_000), status: 'OPEN' } });
    const ok = await svc.preview(c.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON);
    expect(ok.text).toMatch(/Зараз потребує уваги \(стан на .+; це не нові випадки за період\):\n1\. Прострочених завдань команди: 2/);
    const calm = await clinic();
    await synced(calm.clinicId, new Date(w.end.getTime() + HOUR));
    expect((await svc.preview(calm.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON)).text).toContain('За доступними даними немає пунктів, що потребують уваги');
  });

  it('за розкладом: один раз у час відправки; новий підписник і пізно ввімкнений звіт не отримують старого; простій до 12 год наздоганяється, давніше — ні', async () => {
    const c = await clinic();
    const w = periodOf('WEEKLY', '2026-11-16')!;
    await synced(c.clinicId, new Date(w.end.getTime() + HOUR));
    await connect(c.clinicId, c.userId, '8001');
    // after the deploy everything is off: nothing happens
    await svc.tick(MON, { clinicId: c.clinicId });
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId } })).toBe(0);
    // switched on after the due time: not for this week
    await http().patch('/period-reports/settings').set(auth(c.token)).send({ weeklyOn: true }).expect(200);
    await svc.tick(MON, { clinicId: c.clinicId });
    expect(reports()).toHaveLength(0);
    // switched on before: before the due hour nothing, then exactly once
    await schedule(c.clinicId, { weeklyReportSince: BEFORE });
    await svc.tick(new Date(DUE.getTime() - 60_000), { clinicId: c.clinicId });
    expect(reports()).toHaveLength(0);
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, m.userId, '8002', { weekly: true }, new Date(DUE.getTime() + 60_000)); // subscribed after the due time
    await svc.tick(MON, { clinicId: c.clinicId });
    await svc.tick(new Date(MON.getTime() + 60_000), { clinicId: c.clinicId });
    expect(reports('8001')).toHaveLength(1);
    expect(reports('8002')).toHaveLength(0);
    // a server down for longer than the catch-up window: the period is skipped, never sent later
    const late = await clinic();
    await synced(late.clinicId, new Date(w.end.getTime() + HOUR));
    await connect(late.clinicId, late.userId, '8003');
    await schedule(late.clinicId, { weeklyReportOn: true, weeklyReportSince: BEFORE });
    await svc.tick(new Date(DUE.getTime() + 13 * HOUR), { clinicId: late.clinicId });
    expect(reports('8003')).toHaveLength(0);
    // within it: caught up
    await svc.tick(new Date(DUE.getTime() + 11 * HOUR), { clinicId: late.clinicId });
    expect(reports('8003')).toHaveLength(1);
  });

  it('застарілі дані: спершу чекаємо ранкового завантаження; не дочекалися — коротке повідомлення без цифр', async () => {
    const c = await clinic();
    const w = periodOf('WEEKLY', '2026-11-16')!;
    await synced(c.clinicId, new Date(w.end.getTime() - 2 * HOUR));
    await connect(c.clinicId, c.userId, '8101');
    await schedule(c.clinicId, { weeklyReportOn: true, weeklyReportSince: BEFORE });
    await svc.tick(MON, { clinicId: c.clinicId });
    expect(reports()).toHaveLength(0);
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId } })).toBe(0);
    await svc.tick(new Date(DUE.getTime() + 7 * HOUR), { clinicId: c.clinicId });
    expect(reports('8101')).toHaveLength(1);
    expect(reports('8101')[0].text).toContain('Звіт не сформовано');
    expect(reports('8101')[0].text).not.toContain('Завершені візити');
  });

  it('паралельні прогони й частковий збій: один звіт, по одному повідомленню; відмова повторюється лише їй; «можливо дійшло» — ні; вимкнення перед відправкою', async () => {
    const c = await clinic();
    const w = periodOf('WEEKLY', '2026-11-16')!;
    await synced(c.clinicId, new Date(w.end.getTime() + HOUR));
    const m1 = await member(c.token, 'MANAGER');
    const m2 = await member(c.token, 'MANAGER');
    const m3 = await member(c.token, 'MANAGER');
    await connect(c.clinicId, c.userId, '8201');
    await connect(c.clinicId, m1.userId, '8202');
    await connect(c.clinicId, m2.userId, '8203');
    await connect(c.clinicId, m3.userId, '8204');
    await schedule(c.clinicId, { weeklyReportOn: true, weeklyReportSince: BEFORE });
    tg.refuse.add('8202');
    tg.network.add('8203');
    // the last one loses the role between the preparation and the sending
    const realDeliver = svc.deliverPending.bind(svc);
    const spy = jest.spyOn(svc, 'deliverPending').mockImplementationOnce(async (clinicId, now) => {
      await prisma.membership.update({ where: { userId_clinicId: { userId: m3.userId, clinicId: c.clinicId } }, data: { role: 'ADMIN' } });
      return realDeliver(clinicId, now);
    });
    await Promise.all([svc.tick(MON, { clinicId: c.clinicId }), svc.tick(MON, { clinicId: c.clinicId }), svc.tick(MON, { clinicId: c.clinicId })]);
    spy.mockRestore();
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId } })).toBe(1);
    expect(reports('8201')).toHaveLength(1);
    const st = async () => Object.fromEntries((await prisma.periodReportDelivery.findMany({ where: { clinicId: c.clinicId } })).map((d) => [d.userId, [d.status, d.attempts]]));
    expect(await st()).toEqual({ [c.userId]: ['SENT', 1], [m1.userId]: ['FAILED', 1], [m2.userId]: ['UNKNOWN', 1], [m3.userId]: ['DROPPED', 0] });
    // a repeated job: only the refused one is tried again
    tg.sent.length = 0;
    tg.refuse.clear();
    tg.network.clear();
    await svc.tick(new Date(MON.getTime() + 5 * 60_000), { clinicId: c.clinicId });
    expect(tg.sent.map((x) => x.chatId)).toEqual(['8202']);
    await svc.tick(new Date(MON.getTime() + 10 * 60_000), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(1);
    // a person who switched the subscription off before the sending gets nothing
    const d = await clinic();
    await synced(d.clinicId, new Date(w.end.getTime() + HOUR));
    await connect(d.clinicId, d.userId, '8205');
    await schedule(d.clinicId, { weeklyReportOn: true, weeklyReportSince: BEFORE });
    const spy2 = jest.spyOn(svc, 'deliverPending').mockImplementationOnce(async (clinicId, now) => {
      await http().patch('/leader-telegram').set(auth(d.token)).send({ weekly: false }).expect(200);
      return realDeliver(clinicId, now);
    });
    await svc.tick(MON, { clinicId: d.clinicId });
    spy2.mockRestore();
    expect(reports('8205')).toHaveLength(0);
    expect((await prisma.periodReportDelivery.findFirstOrThrow({ where: { clinicId: d.clinicId } })).status).toBe('DROPPED');
  });

  it('підписки незалежні; щоденний дайджест і його одержувачі не змінюються; розклад клініки — лише власник і керуючий', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    await prisma.leaderTelegram.create({ data: { clinicId: c.clinicId, userId: c.userId, chatId: '8301', tgName: 'O', digest: true } });
    await prisma.leaderTelegram.create({ data: { clinicId: c.clinicId, userId: m.userId, chatId: '8302', tgName: 'M', digest: true } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { digestFrequency: 'DAILY', digestHour: 8 } });
    // the owner's own switches change nothing of the manager's
    await http().patch('/leader-telegram').set(auth(c.token)).send({ weekly: true }).expect(200);
    await http().patch('/leader-telegram').set(auth(m.token)).send({ monthly: true }).expect(200);
    const row = (u: string) => prisma.leaderTelegram.findUniqueOrThrow({ where: { clinicId_userId: { clinicId: c.clinicId, userId: u } } });
    expect(await row(c.userId)).toMatchObject({ digest: true, weekly: true, monthly: false });
    expect(await row(m.userId)).toMatchObject({ digest: true, weekly: false, monthly: true });
    expect((await row(c.userId)).weeklySince).not.toBeNull();
    // the clinic's schedule: owner and manager; the new reports never touch the digest
    const s = (await http().patch('/period-reports/settings').set(auth(m.token)).send({ weeklyOn: true, weeklyWeekday: 2, weeklyHour: 18, monthlyOn: true }).expect(200)).body;
    expect(s).toMatchObject({ weekly: { on: true, weekday: 2, hour: 18, to: ['Олена Власниця'] }, monthly: { on: true, hour: 9, to: ['Роль MANAGER'] } });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { digestFrequency: true, digestHour: true } })).toEqual({ digestFrequency: 'DAILY', digestHour: 8 });
    await http().patch('/period-reports/settings').set(auth(m.token)).send({ weeklyHour: 30 }).expect(400);
    // the daily digest still goes to both, as before
    tg.sent.length = 0;
    expect(await app.get(DigestService).send(c.clinicId, 'DAILY')).toBe(2);
    expect(tg.sent.every((x) => x.text.includes('Дайджест клініки'))).toBe(true);
    // roles and clinics: an administrator and a doctor are refused; another clinic sees only its own settings
    const admin = await member(c.token, 'ADMIN');
    const doctor = await member(c.token, 'DOCTOR');
    await http().get('/period-reports/settings').set(auth(admin.token)).expect(403);
    await http().get('/period-reports/preview?kind=WEEKLY').set(auth(doctor.token)).expect(403);
    await http().patch('/period-reports/settings').set(auth(admin.token)).send({ weeklyOn: false }).expect(403);
    const other = await clinic();
    expect((await http().get('/period-reports/settings').set(auth(other.token)).expect(200)).body).toMatchObject({ weekly: { on: false, to: [] }, monthly: { on: false, to: [] } });
    // a wrong period: not a Monday, not completed, too old
    await http().get('/period-reports/preview?kind=WEEKLY&from=2026-11-17').set(auth(c.token)).expect(400);
    await http().get('/period-reports/preview?kind=MONTHLY&from=2020-01-01').set(auth(c.token)).expect(400);
  });

  it('перегляд нічого не шле; «Надіслати собі» — лише власний Telegram, раз на хвилину, не змінює розкладу', async () => {
    const c = await clinic();
    await synced(c.clinicId, new Date());
    const v = (await http().get('/period-reports/preview?kind=MONTHLY&lang=uk').set(auth(c.token)).expect(200)).body;
    expect(v.text).toContain('Звіт за місяць');
    expect(v.periods).toHaveLength(12);
    expect(tg.sent).toHaveLength(0);
    await http().post('/period-reports/send-to-me').set(auth(c.token)).send({ kind: 'WEEKLY' }).expect(400); // not connected
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, m.userId, '8402');
    await connect(c.clinicId, c.userId, '8401', {});
    await http().post('/period-reports/send-to-me').set(auth(c.token)).send({ kind: 'WEEKLY', lang: 'uk' }).expect(200);
    expect(tg.sent.map((x) => x.chatId)).toEqual(['8401']);
    await http().post('/period-reports/send-to-me').set(auth(c.token)).send({ kind: 'MONTHLY' }).expect(400);
    expect(tg.sent).toHaveLength(1);
    // saved as the person's own MANUAL report with its one delivery; no scheduled report is created by it
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId, source: 'SCHEDULED' } })).toBe(0);
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId, source: 'MANUAL', createdById: c.userId } })).toBe(1);
    expect(await prisma.periodReportDelivery.findMany({ where: { clinicId: c.clinicId }, select: { userId: true, status: true } })).toEqual([{ userId: c.userId, status: 'SENT' }]);
  });

  it('знаменник: усі 10 статусів Cliniccards; частка звіту й сигналу «Скасування й неявки» — один розрахунок', async () => {
    const c = await clinic();
    const statuses = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'BOOKING', 'VISITED', 'IN_CLINIC', 'IN_CHAIR', 'DID_NOT_COME', 'CANCELLED', 'MOVED'];
    // two of each within the last 7 complete days (the signal's default window)
    const at = new Date(Date.now() - 3 * 86_400_000);
    for (const st of statuses) await visits(c.clinicId, st, at, 2);
    const ins = app.get(InsightsService);
    await prisma.integration.upsert({ where: { clinicId_provider: { clinicId: c.clinicId, provider: 'CLINICCARDS' } }, create: { clinicId: c.clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x', lastSyncAt: new Date() }, update: { lastSyncAt: new Date() } });
    const e = await ins.explain(c.clinicId, { kind: 'CANCEL_RATE', windowDays: 7, hours: 4 }, new Date());
    if (e?.state !== 'measured') throw new Error('not measured');
    const sum = await app.get(ReportsService).periodSummary(c.clinicId, e.from!, e.to!);
    // numerator: cancelled + did not come; denominator: visited, in the clinic, in the chair, did not come, cancelled, moved; apart: planned,
    // confirmed, not confirmed, booking
    expect(sum).toMatchObject({ completed: 2, cancelled: 2, noShow: 2, scheduled: 12, unclosed: 8 });
    expect([e.count, e.base]).toEqual([sum.cancelled + sum.noShow, sum.scheduled]);
    expect(e.value).toBe(33.3);
    // the same visits without a result mark are the "needs attention" fact once they are in the past
    expect((await svc.issues(c.clinicId)).issues.find((i) => i.kind === 'UNCLOSED_NOW')).toMatchObject({ count: 8 });
  });

  it('«потребує уваги»: успішні перевірки — нейтрально; тариф, вимкнені правила, непораховані й невдалі — з обмеженням; нічого не виконано — «невідомо»', async () => {
    const at = '2026-11-23T07:00:00Z';
    const lines = (checks: object, issues: object[] = []) => attentionLines({ preparedAt: at, issues: issues as never, checks: checks as never }, 'uk').join('\n');
    const ok = { signals: 'checked', notMeasured: 0, failed: 0, factsFailed: 0 };
    expect(lines(ok)).toBe('За доступними даними немає пунктів, що потребують уваги (стан на 23.11, 09:00).');
    expect(lines({ ...ok, signals: 'not_in_plan' })).toContain('Сигнали керівнику недоступні за тарифом: перевірено лише заявки');
    expect(lines({ ...ok, signals: 'all_off' })).toContain('Усі сигнали вимкнено в налаштуваннях');
    expect(lines({ ...ok, notMeasured: 4 })).toContain('Не пораховано сигналів: 4 (мало даних або застарілі дані Cliniccards)');
    expect(lines({ ...ok, failed: 1, factsFailed: 1 })).toContain('Не вдалося виконати перевірок: 2, тож список може бути неповним.');
    expect(lines({ ...ok, signals: 'not_in_plan', factsFailed: 3 })).toBe('Перевірки не виконано (стан на 23.11, 09:00), тому що зараз потребує уваги, невідомо.');
    expect(lines({ ...ok, failed: 2 }, [{ kind: 'OVERDUE', count: 3 }])).toMatch(/^Зараз потребує уваги[\s\S]*1\. Прострочених завдань команди: 3[\s\S]*Не вдалося виконати перевірок: 2/);
    expect(attentionLines({ preparedAt: at, issues: [], checks: ok as never }, 'en').join()).toContain('By the available data, nothing needs attention');
    expect(attentionLines({ preparedAt: at, issues: [], checks: ok as never }, 'ru').join()).toContain('По доступным данным нет пунктов, требующих внимания');

    // the real checks: Start (no signals), Pro with every rule off, a failing check
    const start = await clinic('START');
    expect((await svc.issues(start.clinicId)).checks).toEqual({ signals: 'not_in_plan', notMeasured: 0, failed: 0, factsFailed: 0 });
    const pro = await clinic();
    const ins = app.get(InsightsService);
    await ins.alerts(pro.clinicId);
    await prisma.alertRule.updateMany({ where: { clinicId: pro.clinicId }, data: { active: false } });
    expect((await svc.issues(pro.clinicId)).checks.signals).toBe('all_off');
    // switched-off rules are not errors and are not switched on
    expect(await prisma.alertRule.count({ where: { clinicId: pro.clinicId, active: true } })).toBe(0);
    await prisma.alertRule.updateMany({ where: { clinicId: pro.clinicId }, data: { active: true } });
    const spy = jest.spyOn(ins, 'explain').mockRejectedValueOnce(new Error('db down'));
    const r = await svc.issues(pro.clinicId);
    spy.mockRestore();
    expect(r.checks.failed).toBe(1);
    // no Cliniccards load: the Cliniccards rules are "not calculated", never "all clear"
    expect(r.checks.notMeasured).toBeGreaterThan(0);
    const w = periodOf('WEEKLY', '2026-11-16')!;
    await synced(pro.clinicId, new Date(w.end.getTime() + HOUR));
    const text = (await svc.preview(pro.clinicId, 'WEEKLY', '2026-11-16', 'uk', MON)).text;
    expect(text).toContain('Не пораховано сигналів');
  });
});
