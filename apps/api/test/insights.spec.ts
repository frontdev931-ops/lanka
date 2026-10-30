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

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
  insights = app.get(InsightsService);
});
afterAll(async () => {
  await app.close();
});

async function clinic(plan = 'PRO') {
  const email = `i${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
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
  async function visits(clinicId: string, n: number, status: string, daysAgo: number) {
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
    await prisma.visit.createMany({ data: Array.from({ length: n }, (_, i) => ({ clinicId, patientId: p.id, externalId: `v${rnd()}${i}`, startsAt: new Date(Date.now() - daysAgo * day - i * 60_000), status })) });
  }

  it('за замовчуванням вимкнені; вмикає власник і керуючий на «Про»; значення перевіряються', async () => {
    const c = await clinic();
    const list = (await http().get('/alerts').set(auth(c.token)).expect(200)).body as { kind: string; enabled: boolean; threshold: number }[];
    expect(list.map((a) => a.kind)).toEqual(['CANCEL_RATE', 'RETURN_DROP', 'STALE_REQUESTS']);
    expect(list.every((a) => !a.enabled)).toBe(true);
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ enabled: true, threshold: 30 }).expect(200);
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ threshold: -1 }).expect(400);
    await http().patch('/alerts/NOPE').set(auth(c.token)).send({ enabled: true }).expect(404);
    const admin = await member(c.token, 'ADMIN');
    await http().patch('/alerts/CANCEL_RATE').set(auth(admin.token)).send({ enabled: false }).expect(403);
    const start = await clinic('START');
    await http().patch('/alerts/CANCEL_RATE').set(auth(start.token)).send({ enabled: true }).expect(400);
    expect((await http().get('/alerts').set(auth(clinicOther())).expect(200)).body).toHaveLength(3);
    function clinicOther() {
      return c.token;
    }
  });

  it('частка скасувань і неявок: спрацьовує від порогу, не на малій вибірці, і лише раз на добу; власник отримує лист', async () => {
    const c = await clinic();
    await http().patch('/alerts/CANCEL_RATE').set(auth(c.token)).send({ enabled: true, threshold: 30 }).expect(200);
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
    await visits(a.clinicId, 12, 'CANCELLED', 2);
    expect(await insights.evaluate(b.clinicId)).toEqual([]);
    expect(await prisma.alertRule.count({ where: { clinicId: a.clinicId, enabled: true } })).toBe(0);
  });
});
