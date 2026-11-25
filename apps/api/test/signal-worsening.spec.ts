import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { InsightsService, worseEnough } from '../src/insights/insights.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PushSender } from '../src/push/push.service';

// Significant worsening of a signal that has already fired (2026-11-25): criteria, limits, base, events and texts. The rule's value is set
// through a fake of the calculation, so each boundary is exact; Telegram and Push are fakes.
jest.setTimeout(120_000);

class FakeTelegram {
  sent: { chatId: string; text: string }[] = [];
  refuse = new Set<string>();
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (_t: string, chatId: string | number, text: string) => {
    if (this.refuse.has(String(chatId))) throw new TelegramError('Bad Request: chat not found', 400);
    this.sent.push({ chatId: String(chatId), text });
  };
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}
const push = { configured: true, sent: [] as { payload: { title: string; body: string } }[], send: async (_s: unknown, payload: { title: string; body: string }) => void push.sent.push({ payload }) };
const tg = new FakeTelegram();
let app: INestApplication;
let prisma: PrismaService;
let insights: InsightsService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const DAY = 86_400_000;

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = '999:AAServiceBotTokenForTestsOnly_abcdefghijk';
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(PushSender).useValue(push).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  insights = app.get(InsightsService);
});
afterAll(async () => {
  await app.close();
});
let value: Record<string, unknown> | null = null;
let spy: jest.SpyInstance;
beforeEach(() => {
  tg.sent.length = 0;
  tg.refuse.clear();
  push.sent.length = 0;
  value = null;
  // the calculation of the rule returns what the test sets (null: the real one)
  spy = jest.spyOn(insights, 'explain').mockImplementation((async () => value) as never);
});
afterEach(() => spy.mockRestore());

async function clinic() {
  const email = `sw${rnd()}@example.com`;
  const name = `Клініка ${rnd()}`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: name, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 60 * DAY) } });
  await prisma.leaderTelegram.create({ data: { clinicId, userId: user.id, chatId: `c${rnd()}`, tgName: 'T', signals: true } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, name };
}
// one rule on (Telegram and Push), in a lasting deviation with the given base, its last event `ago` days back
async function deviating(c: { clinicId: string }, kind: string, o: { threshold: number; base: number | null; ago?: number }) {
  await insights.alerts(c.clinicId);
  await prisma.alertRule.updateMany({ where: { clinicId: c.clinicId }, data: { active: false } });
  const at = new Date(Date.now() - (o.ago ?? 8) * DAY);
  await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind } }, data: { active: true, telegram: true, push: true, threshold: o.threshold, evalState: 'FIRED', evalValue: o.base, evalAt: at, baseValue: o.base, baseAt: o.base === null ? null : at, lastFiredAt: at, lastWorseAt: null, syncEscalatedAt: null } });
}
const measured = (v: number, extra: Record<string, unknown> = {}) => (value = { state: 'measured', value: v, count: v, base: v, oldestDays: 3, ...extra });
const rule = (c: { clinicId: string }, kind: string) => prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId: c.clinicId, kind } } });
const worse = (c: { clinicId: string }) => prisma.signalEvent.count({ where: { clinicId: c.clinicId, type: 'WORSE' } });
const run = async (c: { clinicId: string }) => insights.evaluate(c.clinicId);

describe('погіршення сигналу', () => {
  it('критерії: кількість — +50% і не менше порогу одночасно; відсотки — +10 п. п., не відносні відсотки', () => {
    // counts: base 30, threshold 5
    expect(worseEnough('NO_REBOOK', 30, 35, 5)).toBe(false);
    expect(worseEnough('NO_REBOOK', 30, 44, 5)).toBe(false);
    expect(worseEnough('NO_REBOOK', 30, 45, 5)).toBe(true); // exactly +50% and +15 ≥ 5
    // +50% reached but the absolute rise is below the threshold
    expect(worseEnough('OVERDUE_TASKS', 6, 9, 5)).toBe(false);
    expect(worseEnough('OVERDUE_TASKS', 6, 11, 5)).toBe(true);
    // percentages: points, not relative percent
    expect(worseEnough('PAYMENTS_DROP', 30, 40, 30)).toBe(true); // 30% → 40%: +10 pp (only +33% relative)
    expect(worseEnough('CANCEL_RATE', 25, 34.9, 25)).toBe(false);
    expect(worseEnough('CANCEL_RATE', 25, 35, 25)).toBe(true);
    expect(worseEnough('RETURN_DROP', 10, 14, 10)).toBe(false); // +40% relative, only +4 pp
    expect(worseEnough('SYNC_OVERDUE', 50, 500, 48)).toBe(false); // its own rule (twice the threshold)
  });

  it('межа й накопичене зростання відносно бази події; одне повідомлення з датою бази; текст, Push і подробиці', async () => {
    const c = await clinic();
    // the owner's device, switched on long before
    await prisma.pushSubscription.create({ data: { clinicId: c.clinicId, userId: c.userId, endpoint: `https://push.example/${rnd()}`, p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), enabledAt: new Date(Date.now() - 30 * DAY) } });
    await deviating(c, 'NO_REBOOK', { threshold: 5, base: 30 });
    measured(35, { lookbackDays: 30, from: new Date(Date.now() - 30 * DAY), to: new Date(Date.now() - 7 * DAY) });
    expect(await run(c)).toEqual([]);
    measured(44, { lookbackDays: 30 });
    expect(await run(c)).toEqual([]); // the gradual rise is still compared with 30, not with 35 or 44
    expect((await rule(c, 'NO_REBOOK')).baseValue).toBe(30);
    measured(45, { lookbackDays: 30, from: new Date(Date.now() - 30 * DAY), to: new Date(Date.now() - 7 * DAY) });
    expect(await run(c)).toEqual(['NO_REBOOK']);
    const ev = await prisma.signalEvent.findFirstOrThrow({ where: { clinicId: c.clinicId, type: 'WORSE' } });
    expect(ev).toMatchObject({ kind: 'NO_REBOOK', value: 45, prevValue: 30 });
    expect(await rule(c, 'NO_REBOOK')).toMatchObject({ baseValue: 45 });
    const text = tg.sent[0].text;
    expect(text.split('\n')[0]).toBe(`${c.name} · Ситуація погіршилася`);
    expect(text).toMatch(/Пацієнтів без повторного запису стало більше: 45 проти 30 станом на \d\d\.\d\d, \d\d:\d\d\./);
    expect(text).toContain('Склад списку міг змінитися');
    expect(text).toContain('Що зробити: переглянути список');
    expect(text).toContain(`/signals/NO_REBOOK?c=${c.clinicId}&e=${ev.id}`);
    expect(text).not.toMatch(/нових пацієнт|поріг/i);
    expect(push.sent[0].payload).toMatchObject({ title: `${c.name} · Сигнал посилився`, body: 'Більше пацієнтів без повторного запису. Перегляньте подробиці.' });
    spy.mockRestore();
    const d = (await http().get(`/signals/NO_REBOOK?e=${ev.id}`).set(auth(c.token)).expect(200)).body;
    expect(d.event).toMatchObject({ type: 'WORSE', value: 45, prevValue: 30 });
  });

  it('відсотки: падіння оплат 30% → 40% — повідомлення в п. п. з обома періодами; мало даних і застарілі дані — без змін', async () => {
    const c = await clinic();
    await deviating(c, 'PAYMENTS_DROP', { threshold: 30, base: 30 });
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'PAYMENTS_DROP' } }, data: { baseFacts: { from: '2026-11-04T22:00:00.000Z', to: '2026-11-18T22:00:00.000Z' } } });
    value = { state: 'insufficient', base: 3, need: 10 };
    expect(await run(c)).toEqual([]);
    value = { state: 'needs_sync' };
    expect(await run(c)).toEqual([]);
    expect(await rule(c, 'PAYMENTS_DROP')).toMatchObject({ evalState: 'FIRED', baseValue: 30 });
    measured(39.9, { from: new Date('2026-11-10T22:00:00Z'), to: new Date('2026-11-24T22:00:00Z'), prevFrom: new Date('2026-10-27T22:00:00Z'), prevTo: new Date('2026-11-10T22:00:00Z') });
    expect(await run(c)).toEqual([]);
    measured(40, { from: new Date('2026-11-10T22:00:00Z'), to: new Date('2026-11-24T22:00:00Z'), prevFrom: new Date('2026-10-27T22:00:00Z'), prevTo: new Date('2026-11-10T22:00:00Z') });
    expect(await run(c)).toEqual(['PAYMENTS_DROP']);
    const text = tg.sent[0].text;
    expect(text).toMatch(/Падіння отриманих оплат посилилося: на 40% проти 30% станом на .+ \(\+10 п\. п\.\)/);
    expect(text).toContain('Періоди ковзні: тоді — 05.11.2026 — 18.11.2026, зараз — 11.11.2026 — 24.11.2026');
    expect(text).not.toMatch(/грн|UAH/);
  });

  it('обмеження 7 діб; покращення до кінця обмеження — давнє погіршення не надсилається; потім — за актуальними даними', async () => {
    const c = await clinic();
    await deviating(c, 'OVERDUE_TASKS', { threshold: 5, base: 30, ago: 2 });
    measured(60);
    expect(await run(c)).toEqual([]); // worse, but within 7 days of the last event
    expect((await rule(c, 'OVERDUE_TASKS')).baseValue).toBe(30);
    measured(32);
    expect(await run(c)).toEqual([]); // it got better meanwhile
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' } }, data: { lastFiredAt: new Date(Date.now() - 8 * DAY) } });
    expect(await run(c)).toEqual([]); // after the limit: the current 32, not the old 60
    expect(await worse(c)).toBe(0);
    measured(45);
    expect(await run(c)).toEqual(['OVERDUE_TASKS']);
    // the next one is again limited from this event
    measured(80);
    expect(await run(c)).toEqual([]);
  });

  it('після впровадження: відхилення без бази — перший розрахунок лише зберігає базу; зміна налаштувань переустановлює її; новий одержувач нічого не скидає', async () => {
    const c = await clinic();
    await deviating(c, 'OVERDUE_TASKS', { threshold: 5, base: null }); // as the migration leaves a deviating rule
    measured(100);
    expect(await run(c)).toEqual([]);
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: 'FIRED', baseValue: 100 });
    expect(tg.sent).toHaveLength(0);
    // a new person subscribes: the rule's state is the same, nothing goes to anybody
    const m = await http().post('/team/invitations').set(auth(c.token)).send({ email: `n${rnd()}@example.com`, role: 'MANAGER' }).expect(201);
    expect(m.body.link).toBeTruthy();
    measured(100);
    expect(await run(c)).toEqual([]);
    expect((await rule(c, 'OVERDUE_TASKS')).baseValue).toBe(100);
    // a changed threshold: a new baseline, no message, the base set again from the next measurement
    spy.mockRestore();
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 6 }).expect(200);
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: null, baseValue: null });
    spy = jest.spyOn(insights, 'explain').mockImplementation((async () => value) as never);
    measured(200);
    expect(await run(c)).toEqual([]);
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: 'FIRED', baseValue: 200 });
    // switched off and on again: the same
    spy.mockRestore();
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ active: false }).expect(200);
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ active: true }).expect(200);
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: null, baseValue: null });
    expect(tg.sent).toHaveLength(0);
  });

  it('відновлення завершує епізод; нове відхилення — новий епізод із новою базою', async () => {
    const c = await clinic();
    await deviating(c, 'OVERDUE_TASKS', { threshold: 5, base: 30 });
    measured(3);
    expect(await run(c)).toEqual([]);
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: 'OK', baseValue: null });
    measured(8);
    expect(await run(c)).toEqual(['OVERDUE_TASKS']);
    const ev = await prisma.signalEvent.findFirstOrThrow({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'desc' } });
    expect(ev.type).toBe('FIRED');
    expect(await rule(c, 'OVERDUE_TASKS')).toMatchObject({ evalState: 'FIRED', baseValue: 8 });
    expect(tg.sent[0].text).toContain('Потрібна увага');
  });

  it('синхронізація: одне додаткове повідомлення при подвійному порозі, далі без повторів до успішного оновлення; 7 діб на нього не діють', async () => {
    const c = await clinic();
    await deviating(c, 'SYNC_OVERDUE', { threshold: 48, base: 50, ago: 1 });
    measured(95, { lastSyncAt: new Date(Date.now() - 95 * 3_600_000) });
    expect(await run(c)).toEqual([]);
    measured(96, { lastSyncAt: new Date(Date.now() - 96 * 3_600_000) });
    expect(await run(c)).toEqual(['SYNC_OVERDUE']); // within a day of the first notice: not limited
    expect(tg.sent[0].text).toContain('Дані з Cliniccards не оновлювалися вже 96 год. — удвічі довше за поріг');
    measured(300, { lastSyncAt: new Date(Date.now() - 300 * 3_600_000) });
    expect(await run(c)).toEqual([]);
    // a successful sync: back to normal, the next episode can escalate again
    measured(2);
    await run(c);
    expect(await rule(c, 'SYNC_OVERDUE')).toMatchObject({ evalState: 'OK', syncEscalatedAt: null });
  });

  it('паралельні перевірки — одна подія; повтор доставки не створює нових подій; кілька рівнів одразу — одне повідомлення', async () => {
    const c = await clinic();
    await deviating(c, 'OVERDUE_TASKS', { threshold: 5, base: 10 });
    const chat = (await prisma.leaderTelegram.findFirstOrThrow({ where: { clinicId: c.clinicId } })).chatId;
    tg.refuse.add(chat);
    measured(100); // several "levels" above the base at once
    const runs = await Promise.all([run(c), run(c), run(c)]);
    expect(runs.flat()).toEqual(['OVERDUE_TASKS']);
    expect(await worse(c)).toBe(1);
    // the refused delivery is retried; no new event
    tg.refuse.clear();
    await run(c);
    expect(await worse(c)).toBe(1);
    expect(tg.sent.filter((x) => x.chatId === chat)).toHaveLength(1);
  });
});
