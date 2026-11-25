import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DigestService } from '../src/automations/digest.service';
import { TelegramApi } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PeriodReportService } from '../src/insights/period-report.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Three formats (daily digest, weekly report, monthly report) and the explicit move from the old rolling 7-day weekly digest (2026-11-25)
jest.setTimeout(120_000);

class FakeTelegram {
  sent: { token: string; chatId: string; text: string }[] = [];
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (token: string, chatId: string | number, text: string) => void this.sent.push({ token, chatId: String(chatId), text });
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}
const SERVICE = '999:AAServiceBotTokenForTestsOnly_abcdefghijk';
const CLINIC_BOT = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const tg = new FakeTelegram();
let app: INestApplication;
let prisma: PrismaService;
let digest: DigestService;
let reports: PeriodReportService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
// Monday 23.11.2026, 10:00 in Kyiv: last week's report was due at 09:00
const MON = new Date('2026-11-23T08:00:00Z');

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = SERVICE;
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  digest = app.get(DigestService);
  reports = app.get(PeriodReportService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tg.sent.length = 0;
});

async function clinic(legacy = false) {
  const email = `df${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  // legacy: a clinic still on the old rolling weekly digest (as the migration leaves it), Friday 08:00
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 60 * 86_400_000), legacyWeeklyOn: legacy, legacyWeeklyWeekday: 5, legacyWeeklyHour: 8 } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id };
}
async function member(ownerToken: string, role: string) {
  const email = `dm${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
const connect = (clinicId: string, userId: string, chatId: string, sub: { digest?: boolean; legacyWeekly?: boolean; weekly?: boolean } = {}) =>
  prisma.leaderTelegram.create({ data: { clinicId, userId, chatId, tgName: 'T', digest: !!sub.digest, legacyWeekly: !!sub.legacyWeekly, weekly: !!sub.weekly, weeklySince: sub.weekly ? new Date('2026-11-01T00:00:00Z') : null } });
const row = (clinicId: string, chatId: string) => prisma.leaderTelegram.findFirstOrThrow({ where: { clinicId, chatId } });
const to = (token = SERVICE) => tg.sent.filter((x) => x.token === token).map((x) => x.chatId).sort();
// Friday 27.11.2026 in Kyiv (UTC+2): 08:30 and 10:00
const FRI_0830 = new Date('2026-11-27T06:30:00Z');
const FRI_1000 = new Date('2026-11-27T08:00:00Z');

describe('три формати й старий тижневий дайджест окремо', () => {
  it('новий користувач: старий тижневий не вибрати ні в розкладі, ні особисто; щоденний як раніше; найближчі відправки видно', async () => {
    const c = await clinic();
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY' }).expect(400);
    const d = (await http().patch('/digest').set(auth(c.token)).send({ frequency: 'DAILY', hour: 9 }).expect(200)).body;
    expect(d).toMatchObject({ frequency: 'DAILY', hour: 9, legacy: null });
    expect(Date.parse(d.nextAt)).toBeGreaterThan(Date.now() - 60_000);
    const s = (await http().get('/period-reports/settings').set(auth(c.token)).expect(200)).body;
    expect(s).toMatchObject({ weekly: { on: false, weekday: 1, hour: 9 }, monthly: { on: false, hour: 9 } });
    await connect(c.clinicId, c.userId, '7001');
    await http().patch('/leader-telegram').set(auth(c.token)).send({ legacyWeekly: true }).expect(400);
    await http().patch('/leader-telegram').set(auth(c.token)).send({ digest: true }).expect(200);
    expect(await row(c.clinicId, '7001')).toMatchObject({ digest: true, legacyWeekly: false });
    expect(await digest.send(c.clinicId, 'DAILY')).toBe(1);
    expect((await http().get('/period-reports/legacy-weekly').set(auth(c.token)).expect(200)).body).toMatchObject({ legacy: false, old: null });
  });

  it('щоденний і старий тижневий незалежні: увімкнення щоденного не змінює старий розклад і його одержувачів; кожен отримує лише своє', async () => {
    const c = await clinic(true);
    const m = await member(c.token, 'MANAGER');
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: CLINIC_BOT }).expect(201);
    await connect(c.clinicId, c.userId, '7101', { legacyWeekly: true }); // still on the old weekly
    await connect(c.clinicId, m.userId, '7102', { digest: true }); // chose the daily digest
    await prisma.digestRecipient.create({ data: { clinicId: c.clinicId, chatId: '7199', name: 'Старий чат', legacyWeekly: true } });
    const legacyBefore = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { legacyWeeklyOn: true, legacyWeeklyWeekday: true, legacyWeeklyHour: true } });
    // the daily digest is switched on: no question about the old weekly, nothing of it changes
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'DAILY', hour: 9 }).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { legacyWeeklyOn: true, legacyWeeklyWeekday: true, legacyWeeklyHour: true } })).toEqual(legacyBefore);
    expect(await row(c.clinicId, '7101')).toMatchObject({ legacyWeekly: true, digest: false });
    // Friday 08:30: the old weekly's hour (08:00) has come, the daily one's (09:00) not yet
    await digest.tick(FRI_0830, { clinicId: c.clinicId });
    expect(to()).toEqual(['7101']);
    expect(to(CLINIC_BOT)).toEqual(['7199']);
    // 10:00: now the daily one, to its own people only (not to the old weekly's person or chat); the old weekly is not repeated
    tg.sent.length = 0;
    await digest.tick(FRI_1000, { clinicId: c.clinicId });
    expect(to()).toEqual(['7102']);
    expect(to(CLINIC_BOT)).toEqual([]);
    expect(tg.sent.every((x) => x.text.includes('Дайджест клініки'))).toBe(true);
    // the daily digest switched off again: the old weekly stays on
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'OFF' }).expect(200);
    expect((await http().get('/digest').set(auth(c.token)).expect(200)).body).toMatchObject({ frequency: 'OFF', legacy: { on: true, weekday: 5, hour: 8 } });
  });

  it('перехід однієї людини вимикає лише її старий тижневий; інші й старі чати отримують далі; повтор без дублів; щоденний і місячний не змінюються', async () => {
    const c = await clinic(true);
    const m = await member(c.token, 'MANAGER');
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: CLINIC_BOT }).expect(201);
    await connect(c.clinicId, c.userId, '7201', { legacyWeekly: true, digest: true });
    await connect(c.clinicId, m.userId, '7202', { legacyWeekly: true });
    await prisma.digestRecipient.create({ data: { clinicId: c.clinicId, chatId: '7299', name: 'Старий чат', legacyWeekly: true } });
    const pre = (await http().get('/period-reports/legacy-weekly').set(auth(c.token)).expect(200)).body;
    expect(pre).toMatchObject({ legacy: true, old: { weekday: 5, hour: 8 }, weekly: { on: false, othersSubscribed: 0 }, me: { receivesOld: true, moved: false }, legacyChats: 1 });
    await http().post('/period-reports/legacy-weekly/move').set(auth(c.token)).send({}).expect(400); // the weekly schedule is off: asked explicitly
    await http().post('/period-reports/legacy-weekly/move').set(auth(c.token)).send({ enableSchedule: true }).expect(200);
    expect(await row(c.clinicId, '7201')).toMatchObject({ legacyWeekly: false, weekly: true, digest: true, monthly: false });
    expect(await row(c.clinicId, '7202')).toMatchObject({ legacyWeekly: true, weekly: false });
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(2);
    expect(to()).toEqual(['7202']);
    expect(to(CLINIC_BOT)).toEqual(['7299']);
    const first = await row(c.clinicId, '7201');
    await http().post('/period-reports/legacy-weekly/move').set(auth(c.token)).send({ enableSchedule: true }).expect(200);
    expect((await row(c.clinicId, '7201')).weeklySince?.getTime()).toBe(first.weeklySince?.getTime());
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'digest.legacy_weekly_moved' } })).toBe(1);
    // switching one's old weekly off personally is the same kind of change; switching it on again is refused
    await http().patch('/leader-telegram').set(auth(m.token)).send({ legacyWeekly: false }).expect(200);
    await http().patch('/leader-telegram').set(auth(m.token)).send({ legacyWeekly: true }).expect(400);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId }, select: { legacyWeeklyOn: true, digestFrequency: true, monthlyReportOn: true } })).toEqual({ legacyWeeklyOn: true, digestFrequency: 'OFF', monthlyReportOn: false });
  });

  it('тижневий розклад вимкнено, але інші вже підписані: перехід із його увімкненням відновлює їм звіт; їхні підписки не змінюються; попередження це каже', async () => {
    const c = await clinic(true);
    const o = await member(c.token, 'MANAGER');
    await prisma.integration.upsert({ where: { clinicId_provider: { clinicId: c.clinicId, provider: 'CLINICCARDS' } }, create: { clinicId: c.clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x', lastSyncAt: new Date('2026-11-30T01:00:00Z') }, update: {} });
    await connect(c.clinicId, c.userId, '7301', { legacyWeekly: true });
    await connect(c.clinicId, o.userId, '7302', { weekly: true }); // subscribed long ago; the clinic's schedule is off
    const before = await row(c.clinicId, '7302');
    const MON = new Date('2026-11-23T08:00:00Z');
    const pre = await reports.legacyWeekly(c.clinicId, c.userId, MON);
    expect(pre.weekly).toMatchObject({ on: false, othersSubscribed: 1 });
    await reports.moveLegacyWeekly(c.clinicId, c.userId, { enableSchedule: true }, MON);
    expect(await row(c.clinicId, '7302')).toMatchObject({ weekly: true, weeklySince: before.weeklySince, legacyWeekly: false });
    // the next weekly report (due next Monday 09:00) reaches the mover and the person already subscribed; nothing older is sent
    await reports.tick(new Date(MON.getTime() + 60_000), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(0);
    await reports.tick(new Date('2026-11-30T07:01:00Z'), { clinicId: c.clinicId });
    const run = await prisma.periodReportRun.findFirstOrThrow({ where: { clinicId: c.clinicId }, include: { deliveries: true } });
    expect(run).toMatchObject({ periodFrom: '2026-11-23', periodTo: '2026-11-29' });
    expect(run.deliveries.map((d) => d.userId).sort()).toEqual([c.userId, o.userId].sort());
    // the deliveries are sent (with the real clock: the simulated Monday is ahead of the rows' creation time)
    await reports.deliverPending(c.clinicId);
    expect(to()).toEqual(['7301', '7302']);
  });

  it('ролі й клініки: адміністратор і лікар без доступу; перехід в одній клініці не чіпає іншу; без старого формату чи Telegram — відмова', async () => {
    const a = await clinic(true);
    const b = await clinic(true);
    await connect(a.clinicId, a.userId, '7401', { legacyWeekly: true });
    await connect(b.clinicId, b.userId, '7402', { legacyWeekly: true });
    const admin = await member(a.token, 'ADMIN');
    const doctor = await member(a.token, 'DOCTOR');
    await http().get('/period-reports/legacy-weekly').set(auth(admin.token)).expect(403);
    await http().post('/period-reports/legacy-weekly/move').set(auth(doctor.token)).send({ enableSchedule: true }).expect(403);
    await http().patch('/digest').set(auth(admin.token)).send({ frequency: 'DAILY' }).expect(403);
    await http().post('/period-reports/legacy-weekly/move').set(auth(a.token)).send({ enableSchedule: true }).expect(200);
    expect(await row(b.clinicId, '7402')).toMatchObject({ weekly: false, legacyWeekly: true });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: b.clinicId }, select: { weeklyReportOn: true } })).toEqual({ weeklyReportOn: false });
    const none = await clinic(false);
    await connect(none.clinicId, none.userId, '7403');
    await http().post('/period-reports/legacy-weekly/move').set(auth(none.token)).send({ enableSchedule: true }).expect(400);
    const off = await clinic(true);
    await http().post('/period-reports/legacy-weekly/move').set(auth(off.token)).send({ enableSchedule: true }).expect(400);
  });
});
