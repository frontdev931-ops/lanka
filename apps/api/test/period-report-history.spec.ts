import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { periodOf } from '../src/insights/period-report-text';
import { PeriodReportService } from '../src/insights/period-report.service';
import { PrismaService } from '../src/prisma/prisma.service';

// The history of weekly and monthly reports (2026-11-25): saved snapshots, kept texts, delivery states, visibility
jest.setTimeout(120_000);

class FakeTelegram {
  sent: { chatId: string; text: string }[] = [];
  refuse = new Set<string>();
  network = new Set<string>();
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (_token: string, chatId: string | number, text: string) => {
    const id = String(chatId);
    if (this.refuse.has(id)) throw new TelegramError('Bad Request: chat not found', 400);
    if (this.network.has(id)) throw new Error('socket hang up');
    this.sent.push({ chatId: id, text });
  };
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}
const tg = new FakeTelegram();
let app: INestApplication;
let prisma: PrismaService;
let svc: PeriodReportService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const HOUR = 3_600_000;
const MON = new Date('2026-11-23T08:00:00Z');
const DUE = new Date('2026-11-23T07:00:00Z');
const BEFORE = new Date('2026-11-20T10:00:00Z');
const W = periodOf('WEEKLY', '2026-11-16')!;

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = '999:AAServiceBotTokenForTestsOnly_abcdefghijk';
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  process.env.WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).compile()).createNestApplication();
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

async function clinic() {
  const email = `ph${rnd()}@example.com`;
  const name = `Клініка ${rnd()}`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: name, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 60 * 86_400_000), weeklyReportOn: true, weeklyReportSince: BEFORE } });
  await prisma.integration.upsert({ where: { clinicId_provider: { clinicId, provider: 'CLINICCARDS' } }, create: { clinicId, provider: 'CLINICCARDS', apiKeyEnc: 'x', lastSyncAt: new Date(W.end.getTime() + HOUR) }, update: {} });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, name };
}
async function member(ownerToken: string, role: string) {
  const email = `pm${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
const connect = (clinicId: string, userId: string, chatId: string, lang = 'uk') => prisma.leaderTelegram.create({ data: { clinicId, userId, chatId, tgName: 'T', lang, weekly: true, weeklySince: BEFORE } });
const visits = async (clinicId: string, n: number) => {
  const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
  for (let i = 0; i < n; i++) await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: new Date(W.since.getTime() + 86_400_000 + i * 60_000), status: 'VISITED' } });
};
const get = async (token: string, path: string, code = 200) => (await http().get(path).set(auth(token)).expect(code)).body;

describe('історія звітів', () => {
  it('збережений звіт не змінюється після нових даних; актуальний перегляд — змінюється; посилання веде на збережений звіт; повтор доставки — той самий текст, другого знімка немає', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, c.userId, '9001');
    await connect(c.clinicId, m.userId, '9002', 'en');
    await visits(c.clinicId, 5);
    tg.refuse.add('9002');
    await svc.tick(MON, { clinicId: c.clinicId });
    const run = await prisma.periodReportRun.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    const first = tg.sent.find((x) => x.chatId === '9001')!.text;
    expect(first).toContain('Завершені візити: 5');
    expect(first).toContain(`/period-report/r/${run.id}?c=${c.clinicId}`);
    // the source data changes afterwards
    await visits(c.clinicId, 3);
    const saved = await get(c.token, `/period-reports/runs/${run.id}`);
    expect(saved).toMatchObject({ kind: 'WEEKLY', source: 'SCHEDULED', state: 'READY', clinic: c.name, period: { from: '2026-11-16', to: '2026-11-22' }, missing: [] });
    expect(saved.facts.cur.completed).toBe(5);
    // the English text was fixed at the first (refused) attempt: kept for the retry, not yet accepted by Telegram
    expect(saved.texts.find((x: { lang: string }) => x.lang === 'uk')).toEqual({ lang: 'uk', text: first, sentCount: 1 });
    expect(saved.texts.find((x: { lang: string }) => x.lang === 'en')).toMatchObject({ sentCount: 0 });
    const enKept = saved.texts.find((x: { lang: string }) => x.lang === 'en').text;
    const live = await get(c.token, '/period-reports/preview?kind=WEEKLY&from=2026-11-16');
    expect(live.facts.cur.completed).toBe(8);
    // the retry of the refused delivery: the saved snapshot, its own kept text in English, still one report
    tg.refuse.clear();
    tg.sent.length = 0;
    await svc.tick(new Date(MON.getTime() + 5 * 60_000), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe(enKept);
    expect(tg.sent[0].text).toContain('Completed visits: 5');
    expect(await prisma.periodReportRun.count({ where: { clinicId: c.clinicId } })).toBe(1);
    const again = await get(c.token, `/period-reports/runs/${run.id}`);
    expect(again.texts.map((x: { lang: string; sentCount: number }) => [x.lang, x.sentCount]).sort()).toEqual([['en', 1], ['uk', 1]]);
    expect(again).toMatchObject({ status: 'sent', counts: { total: 2, sent: 2 }, mine: { status: 'SENT', lang: 'uk' } });
    // the kept text is never rewritten, even when the template would render differently now
    await prisma.periodReportRun.update({ where: { id: run.id }, data: { facts: { ...(run.facts as object), clinicName: 'Інша назва' } } });
    expect((await get(c.token, `/period-reports/runs/${run.id}`)).texts.find((x: { lang: string }) => x.lang === 'uk').text).toBe(first);
  });

  it('стани доставки: частково, помилка, невідомо, очікує, скасовано, без одержувачів; «не сформовано» окремо', async () => {
    const c = await clinic();
    const ms = await Promise.all([member(c.token, 'MANAGER'), member(c.token, 'MANAGER'), member(c.token, 'MANAGER')]);
    await connect(c.clinicId, c.userId, '9101');
    await connect(c.clinicId, ms[0].userId, '9102');
    await connect(c.clinicId, ms[1].userId, '9103');
    await connect(c.clinicId, ms[2].userId, '9104');
    tg.refuse.add('9102');
    tg.network.add('9103');
    await prisma.leaderTelegram.updateMany({ where: { chatId: '9104' }, data: { weekly: false } }); // switched off before the sending: cancelled
    await svc.tick(MON, { clinicId: c.clinicId });
    const run = await prisma.periodReportRun.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    // the subscription was off already at the preparation, so 3 deliveries: sent, refused (retry pending), unknown
    expect((await get(c.token, `/period-reports/runs/${run.id}`))).toMatchObject({ status: 'pending', counts: { total: 3, sent: 1, pending: 1, unknown: 1 } });
    for (let i = 1; i <= 3; i++) await svc.tick(new Date(MON.getTime() + i * 15 * 60_000), { clinicId: c.clinicId });
    expect((await get(c.token, `/period-reports/runs/${run.id}`))).toMatchObject({ status: 'partial', counts: { total: 3, sent: 1, failed: 1, unknown: 1, pending: 0 } });
    // the manager's own view says nothing about who failed (counts only)
    const view = await get(ms[0].token, `/period-reports/runs/${run.id}`);
    expect(JSON.stringify(view)).not.toMatch(/9101|9102|9103|chatId|userId/);
    expect(view.mine).toMatchObject({ status: 'FAILED' });
    // the summary rules on their own
    const mk = async (deliveries: { status: string; attempts: number }[], state = 'READY', at = new Date()) => {
      const r = await prisma.periodReportRun.create({ data: { clinicId: c.clinicId, kind: 'MONTHLY', periodFrom: `2026-0${deliveries.length + 1}-01`, periodTo: '2026-01-31', scheduledAt: at, state, facts: { state, preparedAt: at.toISOString(), connected: true, lastSyncAt: null, issues: [] }, createdAt: at } });
      for (const [i, d] of deliveries.entries()) await prisma.periodReportDelivery.create({ data: { runId: r.id, clinicId: c.clinicId, userId: [c.userId, ...ms.map((x) => x.userId)][i], kind: 'MONTHLY', periodFrom: r.periodFrom, status: d.status, attempts: d.attempts } });
      return (await get(c.token, `/period-reports/runs/${r.id}`)).status;
    };
    expect(await mk([])).toBe('no_recipients');
    expect(await mk([{ status: 'FAILED', attempts: 3 }])).toBe('failed');
    expect(await mk([{ status: 'UNKNOWN', attempts: 1 }, { status: 'FAILED', attempts: 3 }])).toBe('unknown');
    expect(await mk([{ status: 'DROPPED', attempts: 0 }, { status: 'DROPPED', attempts: 0 }, { status: 'DROPPED', attempts: 0 }])).toBe('cancelled');
    // a refusal of yesterday is no longer "waiting"
    expect(await mk([{ status: 'FAILED', attempts: 1 }, { status: 'SENT', attempts: 1 }, { status: 'SENT', attempts: 1 }, { status: 'SENT', attempts: 1 }], 'READY', new Date(Date.now() - 2 * 86_400_000))).toBe('partial');
  });

  it('ручне «Надіслати собі»: власний збережений знімок, видно лише автору; планового не блокує; без повторів за розкладом', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, c.userId, '9201');
    await connect(c.clinicId, m.userId, '9202');
    await svc.sendToMe(c.clinicId, m.userId, 'WEEKLY', '2026-11-16', 'uk', MON);
    const manual = await prisma.periodReportRun.findFirstOrThrow({ where: { clinicId: c.clinicId, source: 'MANUAL' } });
    expect(tg.sent.map((x) => x.chatId)).toEqual(['9202']);
    expect(tg.sent[0].text).toContain(`/period-report/r/${manual.id}`);
    // the scheduled report of the same period is still prepared and sent to both
    tg.sent.length = 0;
    await svc.tick(MON, { clinicId: c.clinicId });
    expect(tg.sent.map((x) => x.chatId).sort()).toEqual(['9201', '9202']);
    // visibility: the manager sees both, the owner only the scheduled one; the owner cannot open the manager's manual send
    const mine = await get(m.token, '/period-reports/runs');
    expect(mine.items.map((x: { source: string }) => x.source).sort()).toEqual(['MANUAL', 'SCHEDULED']);
    const owner = await get(c.token, '/period-reports/runs');
    expect(owner.items.map((x: { source: string }) => x.source)).toEqual(['SCHEDULED']);
    await get(c.token, `/period-reports/runs/${manual.id}`, 404);
    expect(await get(m.token, `/period-reports/runs/${manual.id}`)).toMatchObject({ source: 'MANUAL', status: 'sent', mine: { status: 'SENT' } });
    // a failed manual send is not retried by the schedule
    tg.refuse.add('9202');
    await http().post('/period-reports/send-to-me').set(auth(m.token)).send({ kind: 'MONTHLY' }).expect(400);
    tg.refuse.clear();
    tg.sent.length = 0;
    await svc.tick(new Date(MON.getTime() + 10 * 60_000), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(0);
  });

  it('старий неповний знімок: сказано, чого не збережено; нічого не відновлюється з поточних даних; «не сформовано» окремим станом', async () => {
    const c = await clinic();
    // as prepared before the history: no clinic name, no checks, no text
    const old = await prisma.periodReportRun.create({ data: { clinicId: c.clinicId, kind: 'WEEKLY', periodFrom: '2026-11-09', periodTo: '2026-11-15', scheduledAt: new Date(), state: 'READY', facts: { state: 'READY', preparedAt: '2026-11-16T07:00:00.000Z', connected: true, lastSyncAt: '2026-11-16T01:00:00.000Z', cur: { completed: 4, cancelled: 0, noShow: 0, scheduled: 4, unclosed: 0, newPatients: 1, paid: [], paymentsCount: 0 }, prev: { completed: 2, cancelled: 0, noShow: 0, scheduled: 2, unclosed: 0, newPatients: 0, paid: [], paymentsCount: 0 }, issues: [] } } });
    await visits(c.clinicId, 9);
    const r = await get(c.token, `/period-reports/runs/${old.id}`);
    expect(r).toMatchObject({ clinic: null, texts: [], preparedAt: '2026-11-16T07:00:00.000Z', status: 'no_recipients' });
    expect(r.missing.sort()).toEqual(['checks', 'clinicName', 'text']);
    expect(r.facts.cur.completed).toBe(4);
    const stale = await prisma.periodReportRun.create({ data: { clinicId: c.clinicId, kind: 'MONTHLY', periodFrom: '2026-10-01', periodTo: '2026-10-31', scheduledAt: new Date(), state: 'STALE', facts: { state: 'STALE', preparedAt: '2026-11-01T13:00:00.000Z', clinicName: c.name, connected: true, lastSyncAt: '2026-10-29T01:00:00.000Z', issues: [] }, texts: {} } });
    const list = await get(c.token, '/period-reports/runs');
    expect(list.items.find((x: { id: string }) => x.id === stale.id)).toMatchObject({ state: 'STALE', kind: 'MONTHLY' });
    expect(list.items.find((x: { id: string }) => x.id === old.id)).toMatchObject({ state: 'READY' });
  });

  it('ролі, клініки, фільтр, сторінки й порожній стан', async () => {
    const c = await clinic();
    const other = await clinic();
    expect(await get(c.token, '/period-reports/runs')).toEqual({ total: 0, page: 1, pages: 1, items: [] });
    for (let i = 0; i < 23; i++) await prisma.periodReportRun.create({ data: { clinicId: c.clinicId, kind: i % 2 ? 'MONTHLY' : 'WEEKLY', periodFrom: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, periodTo: '2025-12-31', scheduledAt: new Date(), state: 'READY', facts: { state: 'READY', preparedAt: new Date(Date.now() - i * HOUR).toISOString(), connected: true, lastSyncAt: null, issues: [] }, createdAt: new Date(Date.now() - i * HOUR) } });
    const p1 = await get(c.token, '/period-reports/runs?page=1');
    const p2 = await get(c.token, '/period-reports/runs?page=2');
    expect([p1.total, p1.pages, p1.items.length, p2.items.length]).toEqual([23, 2, 20, 3]);
    expect(new Set([...p1.items, ...p2.items].map((x: { id: string }) => x.id)).size).toBe(23);
    expect((await get(c.token, '/period-reports/runs?kind=MONTHLY')).total).toBe(11);
    // another clinic: nothing of it, and its id is "not found"
    const foreign = p1.items[0].id;
    expect((await get(other.token, '/period-reports/runs')).total).toBe(0);
    await get(other.token, `/period-reports/runs/${foreign}`, 404);
    // roles: an administrator and a doctor are refused
    const admin = await member(c.token, 'ADMIN');
    const doctor = await member(c.token, 'DOCTOR');
    await get(admin.token, '/period-reports/runs', 403);
    await get(doctor.token, `/period-reports/runs/${foreign}`, 403);
    await http().get('/period-reports/runs?kind=YEARLY').set(auth(c.token)).expect(400);
  });
});
