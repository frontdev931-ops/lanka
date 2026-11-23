import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { InsightsService } from '../src/insights/insights.service';
import { nextRun } from '../src/insights/schedule';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

let app: INestApplication;
let prisma: PrismaService;
let mail: MailService;
let insights: InsightsService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const day = 86_400_000;
// the clinics created by this file (the only ones whose schedules runDue() may see)
const own = new Set<string>();

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
  insights = app.get(InsightsService);
  // Isolation: the test database is shared and never emptied, and runDue() works on EVERY due schedule of the database (at most 50 per call). Rows left by earlier runs and other files
  // become due again as days pass, so the checks "nothing else is due" and "one more mail" would depend on how old the database is. Instead of switching those rows off, the reads of
  // schedules WITHOUT a clinic filter (only the runDue() batch) are narrowed to the clinics this file creates (`own`); the rows of everybody else are neither read, sent nor modified.
  // Mail goes to the in-process outbox of this app instance (no provider is configured in tests), which starts empty. Production code is untouched.
  const original = prisma.scheduledReport.findMany.bind(prisma.scheduledReport);
  jest.spyOn(prisma.scheduledReport, 'findMany').mockImplementation(((args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    return original({ ...args, where: 'clinicId' in where ? where : { ...where, clinicId: { in: [...own] } } } as never);
  }) as never);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
});

async function clinic(plan = 'PRO') {
  const email = `i${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  own.add(clinicId);
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan } });
  return { token: res.body.accessToken as string, clinicId, email, userId: user.id };
}
async function member(ownerToken: string, role: string) {
  const email = `r${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, email, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
async function saved(token: string, spec: object = { dataset: 'patients', columns: ['patientName'] }) {
  return (await http().post('/report-builder/saved').set(auth(token)).send({ name: `Звіт ${rnd()}`, spec }).expect(201)).body as { id: string; name: string };
}
const body = (savedReportId: string, recipientIds: string[], over: Record<string, unknown> = {}) => ({ savedReportId, frequency: 'WEEKLY', hour: 8, weekday: 1, monthDay: 1, format: 'XLSX', recipientIds, ...over });

describe('розклад відправки', () => {
  it('наступний запуск рахується за часом клініки: щодня, щотижня в потрібний день, щомісяця', () => {
    const base = new Date('2026-11-04T10:00:00Z'); // Wednesday
    expect(nextRun({ frequency: 'DAILY', hour: 8, weekday: 1, monthDay: 1 }, base).toISOString()).toBe('2026-11-05T06:00:00.000Z'); // 08:00 Kyiv winter
    expect(nextRun({ frequency: 'DAILY', hour: 15, weekday: 1, monthDay: 1 }, base).toISOString()).toBe('2026-11-04T13:00:00.000Z');
    expect(nextRun({ frequency: 'WEEKLY', hour: 8, weekday: 1, monthDay: 1 }, base).toISOString()).toBe('2026-11-09T06:00:00.000Z'); // Monday
    expect(nextRun({ frequency: 'MONTHLY', hour: 8, weekday: 1, monthDay: 5 }, base).toISOString()).toBe('2026-11-05T06:00:00.000Z');
    expect(nextRun({ frequency: 'MONTHLY', hour: 8, weekday: 1, monthDay: 3 }, base).toISOString()).toBe('2026-12-03T06:00:00.000Z');
  });

  it('створення: лише власник і керуючий; одержувачі лише зі співробітників клініки; щоденно лише на «Про»; чужі звіти недоступні', async () => {
    const c = await clinic();
    const other = await clinic();
    const s = await saved(c.token);
    const admin = await member(c.token, 'ADMIN');
    const stranger = await member(other.token, 'ADMIN');
    await http().post('/scheduled-reports').set(auth(admin.token)).send(body(s.id, [c.userId])).expect(403);
    await http().post('/scheduled-reports').set(auth(c.token)).send(body(s.id, [stranger.userId])).expect(400);
    await http().post('/scheduled-reports').set(auth(c.token)).send(body(s.id, [])).expect(400);
    await http().post('/scheduled-reports').set(auth(c.token)).send(body(s.id, [c.userId], { hour: 30 })).expect(400);
    await http().post('/scheduled-reports').set(auth(other.token)).send(body(s.id, [other.userId])).expect(404);
    const ok = await http().post('/scheduled-reports').set(auth(c.token)).send(body(s.id, [c.userId, admin.userId])).expect(201);
    expect((await http().get('/scheduled-reports').set(auth(c.token))).body.schedules).toHaveLength(1);
    expect((await http().get('/scheduled-reports').set(auth(other.token))).body.schedules).toHaveLength(0);
    await http().delete(`/scheduled-reports/${ok.body.id}`).set(auth(other.token)).expect(404);
    const start = await clinic('START');
    const ss = await saved(start.token);
    await http().post('/scheduled-reports').set(auth(start.token)).send(body(ss.id, [start.userId], { frequency: 'DAILY' })).expect(400);
    await http().post('/scheduled-reports').set(auth(start.token)).send(body(ss.id, [start.userId], { frequency: 'MONTHLY' })).expect(201);
  });

  it('«Надіслати зараз» шле файл кожному одержувачу з його правами; звіт із грошима не доходить до ролі без доступу, але й не ламає решту', async () => {
    const c = await clinic();
    const manager = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    const money = await saved(c.token, { dataset: 'payments', columns: ['amount'] });
    const id = (await http().post('/scheduled-reports').set(auth(c.token)).send(body(money.id, [c.userId, manager.userId, admin.userId], { format: 'PDF' })).expect(201)).body.id;
    const before = mail.outbox.length;
    const r = (await http().post(`/scheduled-reports/${id}/run`).set(auth(c.token)).expect(200)).body;
    expect(r).toEqual({ sent: 2, failed: 1 });
    const sent = mail.outbox.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual([c.email, manager.email].sort());
    expect(sent[0].attachments![0].filename).toMatch(/\.pdf$/);
    expect(mail.outbox.some((m) => m.to === admin.email)).toBe(false);
    const row = await prisma.scheduledReport.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ lastStatus: 'PARTIAL' });
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'report.scheduled_sent' } })).toBe(2);
    // an ordinary report goes to everyone
    const plain = await saved(c.token);
    const id2 = (await http().post('/scheduled-reports').set(auth(c.token)).send(body(plain.id, [admin.userId])).expect(201)).body.id;
    expect((await http().post(`/scheduled-reports/${id2}/run`).set(auth(c.token)).expect(200)).body).toEqual({ sent: 1, failed: 0 });
    expect(mail.outbox.at(-1)!.attachments![0].filename).toMatch(/\.xlsx$/);
  });

  it('по розкладу: час настав — відправка один раз і наступний запуск зсувається; вимкнений і призупинений не відправляються; видалений звіт не ламає', async () => {
    const c = await clinic();
    const s = await saved(c.token);
    const id = (await http().post('/scheduled-reports').set(auth(c.token)).send(body(s.id, [c.userId])).expect(201)).body.id;
    const due = new Date(Date.now() - 60_000);
    await prisma.scheduledReport.update({ where: { id }, data: { nextRunAt: due } });
    const before = mail.outbox.length;
    expect(await insights.runDue()).toBeGreaterThanOrEqual(1);
    expect(await insights.runDue()).toBe(0);
    expect(mail.outbox.length).toBe(before + 1);
    const row = await prisma.scheduledReport.findUniqueOrThrow({ where: { id } });
    expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastStatus).toBe('OK');

    await prisma.scheduledReport.update({ where: { id }, data: { nextRunAt: due, enabled: false } });
    await insights.runDue();
    expect(mail.outbox.length).toBe(before + 1);
    await prisma.scheduledReport.update({ where: { id }, data: { enabled: true } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { suspendedAt: new Date() } });
    await insights.runDue();
    expect(mail.outbox.length).toBe(before + 1);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { suspendedAt: null } });
    await http().delete(`/report-builder/saved/${s.id}`).set(auth(c.token)).expect(200);
    await prisma.scheduledReport.update({ where: { id }, data: { nextRunAt: due } });
    await insights.runDue();
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id } })).lastStatus).toBe('FAILED');
  });
});

describe('сигнали керівнику', () => {
  // our copy of Cliniccards was loaded `hoursAgo` hours ago (visit-based signals need a recent load)
  const synced = (clinicId: string, hoursAgo = 1) => prisma.integration.upsert({
    where: { clinicId_provider: { clinicId, provider: 'CLINICCARDS' } },
    create: { clinicId, provider: 'CLINICCARDS', lastSyncAt: new Date(Date.now() - hoursAgo * 3_600_000) },
    update: { lastSyncAt: new Date(Date.now() - hoursAgo * 3_600_000) },
  });
  async function visits(clinicId: string, n: number, status: string, daysAgo: number) {
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
    await prisma.visit.createMany({ data: Array.from({ length: n }, (_, i) => ({ clinicId, patientId: p.id, externalId: `v${rnd()}${i}`, startsAt: new Date(Date.now() - daysAgo * day - i * 60_000), status })) });
  }

  it('за замовчуванням вимкнені; вмикає власник і керуючий на «Про»; значення перевіряються', async () => {
    const c = await clinic();
    const list = (await http().get('/alerts').set(auth(c.token)).expect(200)).body as { kind: string; enabled: boolean; threshold: number }[];
    expect(list.map((a) => a.kind)).toEqual(['CANCEL_RATE', 'NO_REBOOK', 'OVERDUE_TASKS', 'PAYMENTS_DROP', 'RETURN_DROP', 'STALE_REQUESTS', 'SYNC_OVERDUE', 'UNFINISHED_NO_NEXT']);
    expect(list.every((a) => !a.enabled)).toBe(true);
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ enabled: true, threshold: 30 }).expect(200);
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ threshold: -1 }).expect(400);
    await http().patch('/alerts/NOPE').set(auth(c.token)).send({ enabled: true }).expect(404);
    const admin = await member(c.token, 'ADMIN');
    await http().patch('/alerts/CANCEL_RATE').set(auth(admin.token)).send({ enabled: false }).expect(403);
    const start = await clinic('START');
    await http().patch('/alerts/CANCEL_RATE').set(auth(start.token)).send({ enabled: true }).expect(400);
    expect((await http().get('/alerts').set(auth(clinicOther())).expect(200)).body).toHaveLength(8);
    function clinicOther() {
      return c.token;
    }
  });

  it('частка скасувань і неявок: спрацьовує від порогу, не на малій вибірці, і лише раз на добу; власник отримує лист', async () => {
    const c = await clinic();
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ enabled: true, threshold: 30 }).expect(200);
    await synced(c.clinicId);
    await visits(c.clinicId, 6, 'VISITED', 2);
    await visits(c.clinicId, 3, 'CANCELLED', 2); // 3 of 9: a small sample
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    await visits(c.clinicId, 3, 'DID_NOT_COME', 3); // 6 of 12 = 50%
    const before = mail.outbox.length;
    expect(await insights.evaluate(c.clinicId)).toEqual(['CANCEL_RATE']);
    expect(mail.outbox.length).toBe(before + 1);
    expect(mail.outbox.at(-1)).toMatchObject({ to: c.email });
    expect(mail.outbox.at(-1)!.text).toContain('50%');
    expect(await insights.evaluate(c.clinicId)).toEqual([]); // quiet for a day
    await prisma.alertRule.updateMany({ where: { clinicId: c.clinicId }, data: { lastFiredAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(await insights.evaluate(c.clinicId)).toEqual(['CANCEL_RATE']);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'alert.fired' } })).toBe(2);
  });

  it('падіння завершених візитів проти попереднього періоду і заявки, що чекають довго', async () => {
    const c = await clinic();
    await http().patch('/alerts/RETURN_DROP').set(auth(c.token)).send({ enabled: true, threshold: 30, windowDays: 7 }).expect(200);
    await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ enabled: true, threshold: 2, hours: 4 }).expect(200);
    await synced(c.clinicId);
    await visits(c.clinicId, 20, 'VISITED', 10); // previous week
    await visits(c.clinicId, 8, 'VISITED', 2); // this week: down 60%
    for (let i = 0; i < 2; i++) await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: `c${i}`, kind: 'BOOKING', summary: 'x', createdAt: new Date(Date.now() - 6 * 3_600_000) } });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'fresh', kind: 'BOOKING', summary: 'x' } });
    expect((await insights.evaluate(c.clinicId)).sort()).toEqual(['RETURN_DROP', 'STALE_REQUESTS']);
    expect((await prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'RETURN_DROP' } } })).lastValue).toBe(60);
  });

  it('клініки ізольовані: сигнал однієї не бачить даних іншої', async () => {
    const a = await clinic();
    const b = await clinic();
    await http().patch('/alerts/CANCEL_RATE').set(auth(b.token)).send({ enabled: true, threshold: 10 }).expect(200);
    await synced(a.clinicId);
    await synced(b.clinicId);
    await visits(a.clinicId, 12, 'CANCELLED', 2);
    expect(await insights.evaluate(b.clinicId)).toEqual([]);
    expect(await prisma.alertRule.count({ where: { clinicId: a.clinicId, enabled: true } })).toBe(0);
    // the section of B shows nothing of A
    const sb = (await http().get('/signals').set(auth(b.token)).expect(200)).body;
    expect(sb.signals.find((x: { kind: string }) => x.kind === 'CANCEL_RATE')).toMatchObject({ state: 'insufficient', base: 0 });
  });

  it('розділ «Сигнали»: значення, період, з чим порівняно й посилання; мало даних — не значення; без свіжої синхронізації — «потрібна синхронізація» і без сповіщень', async () => {
    const c = await clinic();
    // no load yet: the visit signals are not computed, requests are
    let s = (await http().get('/signals').set(auth(c.token)).expect(200)).body;
    expect(s).toMatchObject({ inPlan: true, sync: { lastSyncAt: null, fresh: false } });
    const by = (k: string) => s.signals.find((x: { kind: string }) => x.kind === k);
    expect(by('CANCEL_RATE')).toMatchObject({ state: 'needs_sync', link: '/reports?report=missed-visits' });
    expect(by('RETURN_DROP')).toMatchObject({ state: 'needs_sync' });
    expect(by('STALE_REQUESTS')).toMatchObject({ state: 'ok', value: 0, link: '/inbox?tab=requests' });
    await visits(c.clinicId, 12, 'CANCELLED', 2);
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ enabled: true, threshold: 30 }).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual([]); // old or missing data never fires

    // a load three days ago is not recent enough either
    await synced(c.clinicId, 72);
    s = (await http().get('/signals').set(auth(c.token)).expect(200)).body;
    expect(by('CANCEL_RATE').state).toBe('needs_sync');

    // a fresh load: 12 of 18 visits cancelled or missed in the last 7 complete days = 66.7%, over 30%
    await synced(c.clinicId);
    await visits(c.clinicId, 6, 'VISITED', 3);
    s = (await http().get('/signals').set(auth(c.token)).expect(200)).body;
    expect(by('CANCEL_RATE')).toMatchObject({ state: 'fired', value: 66.7, count: 12, base: 18, threshold: 30, windowDays: 7, emailOn: true, pushOn: false, telegramOn: false });
    expect(Date.parse(by('CANCEL_RATE').to) - Date.parse(by('CANCEL_RATE').from)).toBe(7 * day);
    // the comparison period has too few completed visits: no percentage is shown
    expect(by('RETURN_DROP')).toMatchObject({ state: 'insufficient', base: 0, need: 10, link: null });
    expect(by('RETURN_DROP')).not.toHaveProperty('value');
  });

  it('падіння до нуля: достатня база попереднього періоду і нуль завершених візитів зараз — це падіння на 100%, не «мало даних»; обидва періоди й числа в сигналі', async () => {
    const c = await clinic();
    await synced(c.clinicId);
    await visits(c.clinicId, 20, 'VISITED', 20); // the previous 14 days
    const s = (await http().get('/signals').set(auth(c.token)).expect(200)).body;
    const drop = s.signals.find((x: { kind: string }) => x.kind === 'RETURN_DROP');
    expect(drop).toMatchObject({ state: 'fired', value: 100, count: 0, base: 20, threshold: 30, windowDays: 14, link: null });
    expect(Date.parse(drop.prevTo)).toBe(Date.parse(drop.from));
    expect(Date.parse(drop.to) - Date.parse(drop.from)).toBe(14 * day);
    await http().patch('/alerts/RETURN_DROP').set(auth(c.token)).send({ enabled: true }).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual(['RETURN_DROP']);
  });

  const sig = async (token: string, kind: string) => ((await http().get('/signals').set(auth(token)).expect(200)).body.signals as Record<string, unknown>[]).find((x) => x.kind === kind)!;
  const patient = (clinicId: string) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
  const visit = (clinicId: string, patientId: string, status: string, daysAgo: number) => prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - daysAgo * day), status } });

  it('спад оплат: дві рівні половини повних днів; нуль зараз — справжній спад; мало оплат або змішані валюти — «мало даних»; без синхронізації — не рахується', async () => {
    const c = await clinic();
    const pay = (daysAgo: number, amount: number, currency: string | null = 'UAH') => prisma.payment.create({ data: { clinicId: c.clinicId, externalId: `pay${rnd()}`, paidAt: new Date(Date.now() - daysAgo * day), amount, currency } });
    for (let i = 0; i < 10; i++) await pay(20, 1000); // the previous 14 days: 10 000
    expect(await sig(c.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'needs_sync' });
    await synced(c.clinicId);
    expect(await sig(c.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'fired', value: 100, amount: 0, prevAmount: 10000, currency: 'UAH', threshold: 30, windowDays: 14 });
    await pay(3, 8000);
    expect(await sig(c.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'ok', value: 20, amount: 8000 });
    // a payment without a currency is the clinic's currency (UAH here), not "too little data"
    await pay(2, 1000, null);
    expect(await sig(c.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'ok', value: 10, amount: 9000, currency: 'UAH' });
    // a known foreign amount is never added to hryvnias
    await pay(4, 50, 'USD');
    expect(await sig(c.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'insufficient', reason: 'currency' });
    const small = await clinic();
    await synced(small.clinicId);
    await prisma.payment.create({ data: { clinicId: small.clinicId, externalId: `pay${rnd()}`, paidAt: new Date(Date.now() - 20 * day), amount: 5000, currency: 'UAH' } });
    expect(await sig(small.token, 'PAYMENTS_DROP')).toMatchObject({ state: 'insufficient', base: 1, need: 10 });
  });

  it('незавершене лікування без наступного запису: лише розпочате лікування з відкритими позиціями, завершеним візитом і без майбутнього запису; план сам по собі — ні', async () => {
    const c = await clinic();
    await synced(c.clinicId);
    const item = (patientId: string, plan: string, status: string, doneDaysAgo?: number) => prisma.planItem.create({ data: { clinicId: c.clinicId, patientId, externalId: `i${rnd()}`, planId: plan, name: `Послуга ${rnd()}`, status, createdAtExt: new Date(Date.now() - 90 * day), markedDoneAt: doneDaysAgo === undefined ? null : new Date(Date.now() - doneDaysAgo * day) } });
    const waiting = await patient(c.clinicId); // counted
    await item(waiting.id, 'pl1', 'DONE', 40); await item(waiting.id, 'pl1', 'NEW'); await visit(c.clinicId, waiting.id, 'VISITED', 40);
    const booked = await patient(c.clinicId); // a future visit: excluded
    await item(booked.id, 'pl2', 'DONE', 40); await item(booked.id, 'pl2', 'NEW'); await visit(c.clinicId, booked.id, 'VISITED', 40); await visit(c.clinicId, booked.id, 'PLANNED', -5);
    const planOnly = await patient(c.clinicId); // a plan nobody started: not unfinished treatment
    await item(planOnly.id, 'pl3', 'NEW'); await visit(c.clinicId, planOnly.id, 'VISITED', 40);
    const finished = await patient(c.clinicId); // everything done
    await item(finished.id, 'pl4', 'DONE', 40); await visit(c.clinicId, finished.id, 'VISITED', 40);
    const recent = await patient(c.clinicId); // last work 10 days ago: not waiting long enough
    await item(recent.id, 'pl5', 'DONE', 10); await item(recent.id, 'pl5', 'PLANNED_TO_DO'); await visit(c.clinicId, recent.id, 'VISITED', 10);
    const s = await sig(c.token, 'UNFINISHED_NO_NEXT');
    expect(s).toMatchObject({ state: 'ok', value: 1, count: 1, base: 2, threshold: 5, windowDays: 30, link: '/reports?report=unfinished-treatment&days=180' });
    await http().patch('/alerts/UNFINISHED_NO_NEXT').set(auth(c.token)).send({ threshold: 1 }).expect(200);
    expect(await sig(c.token, 'UNFINISHED_NO_NEXT')).toMatchObject({ state: 'fired', value: 1 });
  });

  it('скасування чи неявка без повторного запису: унікальні пацієнти в межах 30 днів; пізніший завершений або майбутній візит знімає пацієнта', async () => {
    const c = await clinic();
    await synced(c.clinicId);
    const a = await patient(c.clinicId); await visit(c.clinicId, a.id, 'CANCELLED', 10); await visit(c.clinicId, a.id, 'DID_NOT_COME', 12); // twice: counted once
    const b = await patient(c.clinicId); await visit(c.clinicId, b.id, 'CANCELLED', 10); await visit(c.clinicId, b.id, 'VISITED', 5); // came later
    const f = await patient(c.clinicId); await visit(c.clinicId, f.id, 'DID_NOT_COME', 10); await visit(c.clinicId, f.id, 'CONFIRMED', -3); // booked again
    const d = await patient(c.clinicId); await visit(c.clinicId, d.id, 'CANCELLED', 3); // too recent (7 days)
    const e = await patient(c.clinicId); await visit(c.clinicId, e.id, 'CANCELLED', 40); // outside the 30 days
    const s = await sig(c.token, 'NO_REBOOK');
    expect(s).toMatchObject({ state: 'ok', value: 1, base: 3, lookbackDays: 30, windowDays: 7, threshold: 5 });
    await http().patch('/alerts/NO_REBOOK').set(auth(c.token)).send({ windowDays: 40 }).expect(400);
  });

  it('прострочені завдання й синхронізація: дані LANKA не залежать від Cliniccards; «не підключено», «ще не синхронізовано» і «давно» розрізняються', async () => {
    const c = await clinic();
    const task = (daysDue: number, status: 'OPEN' | 'DONE' | 'CANCELLED') => prisma.task.create({ data: { clinicId: c.clinicId, title: 'T', dueDate: new Date(Date.now() + daysDue * day), status } });
    await task(-3, 'OPEN'); await task(-2, 'OPEN'); await task(-5, 'DONE'); await task(-5, 'CANCELLED'); await task(2, 'OPEN');
    const t = await sig(c.token, 'OVERDUE_TASKS'); // no Cliniccards load at all
    expect(t).toMatchObject({ state: 'ok', value: 2, base: 3 });
    expect(t.oldestDays as number).toBeGreaterThanOrEqual(3);
    expect(await sig(c.token, 'SYNC_OVERDUE')).toMatchObject({ state: 'not_connected' });
    await prisma.integration.upsert({ where: { clinicId_provider: { clinicId: c.clinicId, provider: 'CLINICCARDS' } }, create: { clinicId: c.clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x' }, update: { apiKeyEnc: 'x', lastSyncAt: null } });
    expect(await sig(c.token, 'SYNC_OVERDUE')).toMatchObject({ state: 'never' });
    await http().patch('/alerts/SYNC_OVERDUE').set(auth(c.token)).send({ enabled: true }).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual([]); // "never loaded" is not alerted
    await synced(c.clinicId, 60);
    expect(await sig(c.token, 'SYNC_OVERDUE')).toMatchObject({ state: 'fired', value: 60, threshold: 48 });
    await http().patch('/alerts/SYNC_OVERDUE').set(auth(c.token)).send({ threshold: 12 }).expect(400);
  });

  it('бейдж меню «Сигнали»: лише увімкнені з відхиленням; кеш скидається зміною правила й новим завантаженням; «Старт», інші ролі й клініки — без числа', async () => {
    const c = await clinic();
    const summary = async (token = c.token) => (await http().get('/signals/summary').set(auth(token)).expect(200)).body;
    // nothing loaded from Cliniccards: "not connected", "needs a load" and too little data are not deviations
    expect(await summary()).toMatchObject({ inPlan: true, fired: 0 });
    for (let i = 0; i < 3; i++) await prisma.task.create({ data: { clinicId: c.clinicId, title: 'T', dueDate: new Date(Date.now() - 3 * day), status: 'OPEN' } });
    // the measurement is kept a few minutes: moving around the menu does not measure again
    expect((await summary()).fired).toBe(0);
    // a changed rule drops it: 3 overdue tasks against the threshold 2 is one fired rule (a rule, not three tasks)
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2 }).expect(200);
    expect((await summary()).fired).toBe(1);
    // switched off: not counted; on again: counted
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ active: false }).expect(200);
    expect((await summary()).fired).toBe(0);
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ active: true }).expect(200);
    expect((await summary()).fired).toBe(1);
    // a new Cliniccards load (another lastSyncAt) measures again: the load 60 hours ago is itself a deviation
    await prisma.integration.upsert({ where: { clinicId_provider: { clinicId: c.clinicId, provider: 'CLINICCARDS' } }, create: { clinicId: c.clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x', lastSyncAt: new Date(Date.now() - 60 * 3_600_000) }, update: { apiKeyEnc: 'x', lastSyncAt: new Date(Date.now() - 60 * 3_600_000) } });
    expect((await summary()).fired).toBe(2);
    // the section measures and the badge takes the same number
    const s = (await http().get('/signals').set(auth(c.token)).expect(200)).body as { signals: { active: boolean; state: string }[] };
    expect(s.signals.filter((x) => x.active && x.state === 'fired')).toHaveLength(2);
    // the manager sees it; the administrator and a doctor are refused (the same roles as the section)
    const manager = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    const doctor = await member(c.token, 'DOCTOR');
    expect((await summary(manager.token)).fired).toBe(2);
    await http().get('/signals/summary').set(auth(admin.token)).expect(403);
    await http().get('/signals/summary').set(auth(doctor.token)).expect(403);
    // another clinic: its own number only
    const other = await clinic();
    expect(await summary(other.token)).toMatchObject({ inPlan: true, fired: 0 });
    // Start: no signals in the plan, no number at all
    const start = await clinic('START');
    expect(await summary(start.token)).toEqual({ inPlan: false });
  });

  it('Telegram для кожного сигналу: окремо від пошти й push; відкриття і збереження нічого не шлють; невдала доставка не записується; раз на добу; два прогони не шлють двічі', async () => {
    const { StaffNotifierService } = await import('../src/automations/staff-notifier.service');
    const staff = app.get(StaffNotifierService);
    const deliver = jest.spyOn(staff, 'deliver');
    try {
      const c = await clinic();
      for (let i = 0; i < 3; i++) await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: `t${i}`, kind: 'BOOKING', summary: 'x', createdAt: new Date(Date.now() - 6 * 3_600_000) } });
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ telegram: true }).expect(200);
      await http().get('/signals').set(auth(c.token)).expect(200);
      expect(deliver).not.toHaveBeenCalled();
      const rule = () => prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } } });
      expect(await rule()).toMatchObject({ telegram: true, enabled: false });
      // a failed delivery is not recorded as sent
      deliver.mockResolvedValueOnce('rejected');
      expect(await insights.evaluate(c.clinicId)).toEqual([]);
      expect(await rule()).toMatchObject({ telegramSentAt: null, telegramClaimAt: null });
      expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'alert.telegram_failed' } })).toBe(1);
      // two runs at once: one message; the text is aggregate only, with the link
      deliver.mockResolvedValue('sent');
      const [x, y] = await Promise.all([insights.evaluate(c.clinicId), insights.evaluate(c.clinicId)]);
      expect([...x, ...y]).toEqual(['STALE_REQUESTS']);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls.at(-1)![1]).toMatch(/заявок.*: 3[\s\S]*\/signals/);
      expect((await rule()).telegramSentAt).not.toBeNull();
      expect(await insights.evaluate(c.clinicId)).toEqual([]); // quiet for a day
      // switched off: no delivery even when due again; email/push stay as they were
      await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } }, data: { telegramSentAt: new Date(Date.now() - 25 * 3_600_000) } });
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ telegram: false }).expect(200);
      expect(await insights.evaluate(c.clinicId)).toEqual([]);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await rule()).toMatchObject({ enabled: false, telegram: false });
      // only the owner and the manager change it; Start cannot switch it on
      const admin = await member(c.token, 'ADMIN');
      await http().patch('/alerts/STALE_REQUESTS').set(auth(admin.token)).send({ telegram: true }).expect(403);
      const start = await clinic('START');
      await http().patch('/alerts/STALE_REQUESTS').set(auth(start.token)).send({ telegram: true }).expect(400);
    } finally {
      deliver.mockRestore();
    }
  });

  it('пошта й Push окремо: кожен канал лише за своїм перемикачем; Telegram не зачеплено', async () => {
    const { PushService } = await import('../src/push/push.service');
    const push = jest.spyOn(app.get(PushService), 'notify').mockResolvedValue(undefined as never);
    try {
      const c = await clinic();
      for (let i = 0; i < 3; i++) await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: `e${i}`, kind: 'BOOKING', summary: 'x', createdAt: new Date(Date.now() - 6 * 3_600_000) } });
      const rule = () => prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } } });
      // email only
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ enabled: true }).expect(200);
      let mails = mail.outbox.length;
      expect(await insights.evaluate(c.clinicId)).toEqual(['STALE_REQUESTS']);
      expect(mail.outbox.length).toBe(mails + 1);
      expect(push).not.toHaveBeenCalled();
      expect(await rule()).toMatchObject({ enabled: true, push: false, telegram: false });
      // Push only
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ enabled: false, push: true }).expect(200);
      await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } }, data: { lastFiredAt: new Date(Date.now() - 25 * 3_600_000) } });
      mails = mail.outbox.length;
      expect(await insights.evaluate(c.clinicId)).toEqual(['STALE_REQUESTS']);
      expect(push).toHaveBeenCalledTimes(1);
      expect(mail.outbox.length).toBe(mails);
      expect(await rule()).toMatchObject({ enabled: false, push: true, telegram: false });
      expect((await sig(c.token, 'STALE_REQUESTS'))).toMatchObject({ emailOn: false, pushOn: true, telegramOn: false });
      // Start cannot switch Push on
      const start = await clinic('START');
      await http().patch('/alerts/STALE_REQUESTS').set(auth(start.token)).send({ push: true }).expect(400);
    } finally {
      push.mockRestore();
    }
  });

  it('головний перемикач: вимкнений сигнал не рахується, не входить у підсумки мережі й нічого не шле; канали зберігаються після вимкнення й увімкнення', async () => {
    const { StaffNotifierService } = await import('../src/automations/staff-notifier.service');
    const { PushService } = await import('../src/push/push.service');
    const { NetworkService } = await import('../src/network/network.service');
    const deliver = jest.spyOn(app.get(StaffNotifierService), 'deliver').mockResolvedValue('sent');
    const push = jest.spyOn(app.get(PushService), 'notify').mockResolvedValue(undefined as never);
    const network = app.get(NetworkService);
    let access: jest.SpyInstance | undefined;
    try {
      const c = await clinic();
      const other = await clinic();
      for (let i = 0; i < 3; i++) await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: `m${i}`, kind: 'BOOKING', summary: 'x', createdAt: new Date(Date.now() - 6 * 3_600_000) } });
      const rule = () => prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } } });
      // new rules: on (monitored), every channel off
      expect((await http().get('/alerts').set(auth(c.token)).expect(200)).body.every((a: { active: boolean; enabled: boolean; push: boolean; telegram: boolean }) => a.active && !a.enabled && !a.push && !a.telegram)).toBe(true);
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ enabled: true, push: true, telegram: true, threshold: 2 }).expect(200);
      // off: no assessment in the section, nothing in the network view, nothing sent on any channel
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ active: false }).expect(200);
      const off = await sig(c.token, 'STALE_REQUESTS');
      expect(off).toMatchObject({ state: 'off', active: false, emailOn: true, pushOn: true, telegramOn: true, threshold: 2 });
      expect(off.value).toBeUndefined();
      access = jest.spyOn(network as never as { access: () => unknown }, 'access').mockResolvedValue({ branches: [{ id: c.clinicId, name: 'A', role: 'OWNER' }] } as never);
      expect((await network.signals(c.userId, 'n')).signals.map((x) => x.kind)).not.toContain('STALE_REQUESTS');
      const mails = mail.outbox.length;
      expect(await insights.evaluate(c.clinicId)).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(mail.outbox.length).toBe(mails);
      // a channel cannot be changed while the rule is off; the saved channels are kept
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ telegram: false }).expect(400);
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ active: false, push: false }).expect(400);
      expect(await rule()).toMatchObject({ active: false, enabled: true, push: true, telegram: true });
      // switched off between the check and the claim (a run already in progress): still nothing sent
      const realFind = prisma.alertRule.findMany.bind(prisma.alertRule);
      const findSpy = jest.spyOn(prisma.alertRule, 'findMany').mockImplementationOnce((async () => (await realFind({ where: { clinicId: c.clinicId, kind: 'STALE_REQUESTS' } })).map((r) => ({ ...r, active: true }))) as never);
      expect(await insights.evaluate(c.clinicId)).toEqual([]);
      findSpy.mockRestore();
      expect(deliver).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      // back on (a fresh read, as after a refresh): the earlier channels apply again
      await http().patch('/alerts/STALE_REQUESTS').set(auth(c.token)).send({ active: true }).expect(200);
      expect(await sig(c.token, 'STALE_REQUESTS')).toMatchObject({ state: 'fired', active: true, value: 3, emailOn: true, pushOn: true, telegramOn: true });
      expect((await network.signals(c.userId, 'n')).signals.find((x) => x.kind === 'STALE_REQUESTS')).toMatchObject({ fired: true });
      const before = mail.outbox.length;
      expect(await insights.evaluate(c.clinicId)).toEqual(['STALE_REQUESTS']);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledTimes(1);
      expect(mail.outbox.length).toBe(before + 1);
      // permissions and isolation: an administrator cannot switch it; another clinic's rules are untouched
      const admin = await member(c.token, 'ADMIN');
      await http().patch('/alerts/STALE_REQUESTS').set(auth(admin.token)).send({ active: false }).expect(403);
      await http().patch('/alerts/STALE_REQUESTS').set(auth(other.token)).send({ active: false }).expect(200);
      expect(await rule()).toMatchObject({ active: true });
      expect((await prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: other.clinicId, kind: 'STALE_REQUESTS' } } }))).toMatchObject({ active: false, enabled: false, push: false, telegram: false });
      // Start cannot switch a rule on
      const start = await clinic('START');
      await http().patch('/alerts/STALE_REQUESTS').set(auth(start.token)).send({ active: false }).expect(200);
      await http().patch('/alerts/STALE_REQUESTS').set(auth(start.token)).send({ active: true }).expect(400);
    } finally {
      deliver.mockRestore();
      push.mockRestore();
      access?.mockRestore();
    }
  });

  it('розділ «Сигнали»: лише «Про» отримує числа; лише власник і керуючий', async () => {
    const start = await clinic('START');
    expect((await http().get('/signals').set(auth(start.token)).expect(200)).body).toMatchObject({ inPlan: false, signals: [] });
    const c = await clinic();
    const admin = await member(c.token, 'ADMIN');
    const manager = await member(c.token, 'MANAGER');
    await http().get('/signals').set(auth(admin.token)).expect(403);
    await http().get('/signals').set(auth(manager.token)).expect(200);
  });
});
