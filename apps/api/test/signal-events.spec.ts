import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { InsightsService } from '../src/insights/insights.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Signals as events (2026-11-25): the rule's state apart from what deserves a message; the texts; the details page; the current state.
jest.setTimeout(120_000);

// A fake Telegram: nothing leaves the machine; a chat can refuse (400), fail on the network, or block the bot (403)
class FakeTelegram {
  sent: { token: string; chatId: string; text: string }[] = [];
  refuse = new Set<string>();
  network = new Set<string>();
  blocked = new Set<string>();
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (token: string, chatId: string | number, text: string) => {
    const id = String(chatId);
    if (this.blocked.has(id)) throw new TelegramError('Forbidden: bot was blocked by the user', 403);
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
let insights: InsightsService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const day = 86_400_000;
const hour = 3_600_000;

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = SERVICE;
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  process.env.WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  insights = app.get(InsightsService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tg.sent.length = 0;
  tg.refuse.clear();
  tg.network.clear();
  tg.blocked.clear();
});

async function clinic(plan = 'PRO') {
  const email = `se${rnd()}@example.com`;
  const name = `Клініка ${rnd()}`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: name, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan, billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * day) } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, name };
}
async function member(ownerToken: string, role: string) {
  const email = `sr${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
// a person's connection to the LANKA service bot (the linking itself is covered by leader-telegram.spec)
const connect = (clinicId: string, userId: string, chatId: string, signals = true, lang = 'uk') => prisma.leaderTelegram.create({ data: { clinicId, userId, chatId, tgName: 'T', lang, signals } });
const synced = (clinicId: string, hoursAgo = 1) =>
  prisma.integration.upsert({ where: { clinicId_provider: { clinicId, provider: 'CLINICCARDS' } }, create: { clinicId, provider: 'CLINICCARDS', lastSyncAt: new Date(Date.now() - hoursAgo * hour) }, update: { lastSyncAt: new Date(Date.now() - hoursAgo * hour) } });
const overdue = (clinicId: string, n: number) => Promise.all(Array.from({ length: n }, () => prisma.task.create({ data: { clinicId, title: 'T', dueDate: new Date(Date.now() - 3 * day), status: 'OPEN' } })));
const rule = (clinicId: string, kind: string) => prisma.alertRule.findUniqueOrThrow({ where: { clinicId_kind: { clinicId, kind } } });
const signalTexts = (chatId?: string) => tg.sent.filter((x) => x.text.includes('Потрібна увага') && (!chatId || x.chatId === chatId));
const patient = (clinicId: string, name = `Пацієнт ${rnd()}`) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: name } });
const visit = (clinicId: string, patientId: string, status: string, daysAgo: number) => prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - daysAgo * day), status } });

describe('сигнали як події', () => {
  it('вихідний стан: накопичене відхилення не розсилається ні при першій перевірці, ні після підключення Telegram, ні після впровадження', async () => {
    const c = await clinic();
    await overdue(c.clinicId, 4);
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);
    // a rule as it was before this change: channel on, never sent, no state yet (the migration adds no state)
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' } }, data: { telegramSentAt: null, evalState: null } });
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(await rule(c.clinicId, 'OVERDUE_TASKS')).toMatchObject({ evalState: 'FIRED', evalValue: 4 });
    // the person connects and chooses signals afterwards: still nothing accumulated arrives
    await connect(c.clinicId, c.userId, '7001');
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(signalTexts()).toHaveLength(0);
    expect(await prisma.signalEvent.count({ where: { clinicId: c.clinicId } })).toBe(0);
    // switching a channel on again also starts from a new baseline
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ enabled: true }).expect(200);
    expect((await rule(c.clinicId, 'OVERDUE_TASKS')).evalState).toBeNull();
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(signalTexts()).toHaveLength(0);
  });

  it('перший перетин порогу: одна подія, по одному повідомленню; текст — клініка, що сталося, умова, зміна, дія й посилання; без порогу й без імен', async () => {
    const c = await clinic();
    await connect(c.clinicId, c.userId, '7101');
    await overdue(c.clinicId, 1);
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 3, telegram: true }).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual([]); // 1 < 3: normal, the baseline
    expect((await rule(c.clinicId, 'OVERDUE_TASKS')).evalState).toBe('OK');
    await overdue(c.clinicId, 3);
    expect(await insights.evaluate(c.clinicId)).toEqual(['OVERDUE_TASKS']);
    const ev = await prisma.signalEvent.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(ev).toMatchObject({ kind: 'OVERDUE_TASKS', value: 4, prevValue: 1 });
    const [m] = signalTexts('7101');
    expect(signalTexts()).toHaveLength(1);
    expect(m.token).toBe(SERVICE);
    expect(m.text.split('\n')[0]).toBe(`${c.name} · Потрібна увага`);
    expect(m.text).toContain('4 завдання команди прострочено');
    expect(m.text).toContain('найдавніше прострочене на');
    expect(m.text).toMatch(/Попередня перевірка \(.+\): 1\./);
    expect(m.text).toContain('Що зробити: відкрити завдання');
    expect(m.text).toContain(`/signals/OVERDUE_TASKS?c=${c.clinicId}&e=${ev.id}`);
    expect(m.text).not.toMatch(/поріг/i);
    expect(m.text).not.toContain('Олена');
    // the same deviation, recalculated: nothing more
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    await http().get('/signals').set(auth(c.token)).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(signalTexts()).toHaveLength(1);
  });

  it('відновлення й нове відхилення — нова подія; повторне перетинання протягом доби записується, але не надсилається', async () => {
    const c = await clinic();
    await connect(c.clinicId, c.userId, '7201');
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);
    expect(await insights.evaluate(c.clinicId)).toEqual([]); // 0: normal
    const tasks = await overdue(c.clinicId, 2);
    expect(await insights.evaluate(c.clinicId)).toEqual(['OVERDUE_TASKS']);
    // recovered: the state follows, nothing is sent
    await prisma.task.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { status: 'DONE' } });
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect((await rule(c.clinicId, 'OVERDUE_TASKS')).evalState).toBe('OK');
    // crossing again within the day: recorded, not sent (a value hovering at the threshold does not message every half hour)
    await overdue(c.clinicId, 2);
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect((await rule(c.clinicId, 'OVERDUE_TASKS')).evalState).toBe('FIRED');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'alert.repeat_suppressed' } })).toBe(1);
    // recovered and crossed again after a day: a new event
    await prisma.task.updateMany({ where: { clinicId: c.clinicId }, data: { status: 'DONE' } });
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' } }, data: { lastFiredAt: new Date(Date.now() - 25 * hour) } });
    await overdue(c.clinicId, 3);
    expect(await insights.evaluate(c.clinicId)).toEqual(['OVERDUE_TASKS']);
    expect(signalTexts('7201')).toHaveLength(2);
    expect(await prisma.signalEvent.count({ where: { clinicId: c.clinicId } })).toBe(2);
  });

  it('мало даних, застаріле завантаження або помилка між успішними розрахунками — не відновлення й не нове відхилення', async () => {
    const c = await clinic();
    await connect(c.clinicId, c.userId, '7301');
    await synced(c.clinicId);
    for (let i = 0; i < 2; i++) {
      const p = await patient(c.clinicId);
      await visit(c.clinicId, p.id, 'CANCELLED', 10);
    }
    await http().patch('/alerts/NO_REBOOK').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'NO_REBOOK' } }, data: { evalState: 'OK', evalValue: 1, evalAt: new Date(Date.now() - hour) } });
    expect(await insights.evaluate(c.clinicId)).toEqual(['NO_REBOOK']);
    // the load gets old: "needs a load" is not a recovery
    await synced(c.clinicId, 72);
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(await rule(c.clinicId, 'NO_REBOOK')).toMatchObject({ evalState: 'FIRED', evalValue: 2 });
    // a failing calculation changes nothing either
    await synced(c.clinicId);
    const spy = jest.spyOn(insights, 'explain').mockRejectedValueOnce(new Error('db down'));
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    spy.mockRestore();
    // fresh again and still deviating: no second message
    expect(await insights.evaluate(c.clinicId)).toEqual([]);
    expect(signalTexts('7301')).toHaveLength(1);
    expect(await prisma.signalEvent.count({ where: { clinicId: c.clinicId } })).toBe(1);
  });

  it('конкурентні перевірки й частковий збій: одна подія; хто отримав — не отримує вдруге; відмова повторюється лише їй і не більше трьох разів; «можливо доставлено» не повторюється', async () => {
    const c = await clinic();
    const m1 = await member(c.token, 'MANAGER');
    const m2 = await member(c.token, 'MANAGER');
    await connect(c.clinicId, c.userId, '7401');
    await connect(c.clinicId, m1.userId, '7402');
    await connect(c.clinicId, m2.userId, '7403');
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' } }, data: { evalState: 'OK', evalValue: 0, evalAt: new Date(Date.now() - hour) } });
    await overdue(c.clinicId, 3);
    tg.refuse.add('7402');
    tg.network.add('7403');
    const runs = await Promise.all([insights.evaluate(c.clinicId), insights.evaluate(c.clinicId), insights.evaluate(c.clinicId)]);
    expect(runs.flat()).toEqual(['OVERDUE_TASKS']);
    expect(await prisma.signalEvent.count({ where: { clinicId: c.clinicId } })).toBe(1);
    expect(signalTexts('7401')).toHaveLength(1);
    const status = async () => Object.fromEntries((await prisma.signalDelivery.findMany({ where: { clinicId: c.clinicId } })).map((d) => [d.target, [d.status, d.attempts]]));
    const lt = Object.fromEntries((await prisma.leaderTelegram.findMany({ where: { clinicId: c.clinicId } })).map((l) => [l.chatId, l.id]));
    expect(await status()).toEqual({ [lt['7401']]: ['SENT', 1], [lt['7402']]: ['FAILED', 1], [lt['7403']]: ['UNKNOWN', 1] });
    // the next run: only the refused one is tried again, the others are not touched
    tg.sent.length = 0;
    await insights.evaluate(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    expect((await status())[lt['7402']]).toEqual(['FAILED', 2]);
    await insights.evaluate(c.clinicId);
    await insights.evaluate(c.clinicId);
    expect((await status())[lt['7402']]).toEqual(['FAILED', 3]);
    // it works again, but the limit is reached: no more tries
    tg.refuse.clear();
    tg.network.clear();
    await insights.evaluate(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    // a person who loses the role before a retry receives nothing (dropped)
    await prisma.signalDelivery.updateMany({ where: { target: lt['7402'] }, data: { attempts: 1 } });
    await prisma.membership.update({ where: { userId_clinicId: { userId: m1.userId, clinicId: c.clinicId } }, data: { role: 'ADMIN' } });
    await insights.evaluate(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    expect((await status())[lt['7402']]).toEqual(['DROPPED', 1]);
  });

  it('новий одержувач після події не отримує її; отримує лише наступну', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, c.userId, '7501');
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);
    await prisma.alertRule.update({ where: { clinicId_kind: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' } }, data: { evalState: 'OK', evalValue: 0, evalAt: new Date(Date.now() - hour) } });
    await overdue(c.clinicId, 2);
    tg.refuse.add('7501'); // the event stays "due" for its own recipient
    expect(await insights.evaluate(c.clinicId)).toEqual(['OVERDUE_TASKS']);
    await connect(c.clinicId, m.userId, '7502');
    tg.refuse.clear();
    await insights.evaluate(c.clinicId);
    expect(signalTexts('7501')).toHaveLength(1);
    expect(signalTexts('7502')).toHaveLength(0);
  });

  it('подробиці сигналу: той самий список, що порахував сигнал; переходи в картки; подія повідомлення; ролі, клініки й тариф перевіряє сервер', async () => {
    const c = await clinic();
    await synced(c.clinicId);
    const counted = [await patient(c.clinicId, 'Іван Перший'), await patient(c.clinicId, 'Марія Друга')];
    for (const p of counted) await visit(c.clinicId, p.id, 'CANCELLED', 12);
    const rebooked = await patient(c.clinicId, 'Вже Записаний');
    await visit(c.clinicId, rebooked.id, 'CANCELLED', 12);
    await visit(c.clinicId, rebooked.id, 'PLANNED', -3);
    const recent = await patient(c.clinicId, 'Нещодавно Скасував');
    await visit(c.clinicId, recent.id, 'DID_NOT_COME', 2);
    const d = (await http().get('/signals/NO_REBOOK').set(auth(c.token)).expect(200)).body;
    expect(d).toMatchObject({ inPlan: true, kind: 'NO_REBOOK', state: 'ok', value: 2, total: 2, windowDays: 7, lookbackDays: 30, event: null });
    expect(d.patients.map((p: { id: string }) => p.id).sort()).toEqual(counted.map((p) => p.id).sort());
    expect(d.patients[0]).toMatchObject({ name: expect.any(String), days: expect.any(Number) });
    // the list is the signal's number, also in the section
    const s = (await http().get('/signals').set(auth(c.token)).expect(200)).body.signals.find((x: { kind: string }) => x.kind === 'NO_REBOOK');
    expect(s.value).toBe(d.total);
    // the event of a message: its value is shown with the current list; another clinic's event id is ignored
    const ev = await prisma.signalEvent.create({ data: { clinicId: c.clinicId, kind: 'NO_REBOOK', value: 3, facts: {}, settings: {} } });
    expect((await http().get(`/signals/NO_REBOOK?e=${ev.id}`).set(auth(c.token)).expect(200)).body.event).toMatchObject({ value: 3 });
    const other = await clinic();
    await synced(other.clinicId);
    expect((await http().get(`/signals/NO_REBOOK?e=${ev.id}`).set(auth(other.token)).expect(200)).body).toMatchObject({ event: null, total: 0, patients: [] });
    expect((await http().get(`/signals/OVERDUE_TASKS?e=${ev.id}`).set(auth(c.token)).expect(200)).body.event).toBeNull();
    // roles: the owner and the manager; an administrator and a doctor are refused; unknown rule 404; Start gets no numbers
    const manager = await member(c.token, 'MANAGER');
    await http().get('/signals/NO_REBOOK').set(auth(manager.token)).expect(200);
    const admin = await member(c.token, 'ADMIN');
    const doctor = await member(c.token, 'DOCTOR');
    await http().get('/signals/NO_REBOOK').set(auth(admin.token)).expect(403);
    await http().get('/signals/NO_REBOOK').set(auth(doctor.token)).expect(403);
    await http().get('/signals/NOPE').set(auth(c.token)).expect(404);
    const start = await clinic('START');
    expect((await http().get('/signals/NO_REBOOK').set(auth(start.token)).expect(200)).body).toEqual({ inPlan: false, kind: 'NO_REBOOK' });
    // the unfinished-treatment list is the same calculation as its number
    const u = (await http().get('/signals/UNFINISHED_NO_NEXT').set(auth(c.token)).expect(200)).body;
    expect(u.total).toBe(u.value);
    // a non-patient rule has no list, only its section
    const t = (await http().get('/signals/STALE_REQUESTS').set(auth(c.token)).expect(200)).body;
    expect(t).toMatchObject({ link: '/inbox?tab=requests' });
    expect(t.patients).toBeUndefined();
  });

  it('«Поточний стан сигналів»: перегляд нічого не шле; надсилання — лише собі, лише з підключенням, не частіше разу на хвилину', async () => {
    const c = await clinic();
    await overdue(c.clinicId, 6);
    const pre = (await http().get('/signals/overview?lang=uk').set(auth(c.token)).expect(200)).body;
    expect(pre.text.split('\n')[0]).toBe(`${c.name} · Поточний стан сигналів`);
    expect(pre.text).toContain('Потребують уваги: 1');
    expect(pre.text).toContain('6 завдань команди прострочено');
    expect(pre.text).toContain(`/signals?c=${c.clinicId}`);
    expect((await http().get('/signals/overview?lang=en').set(auth(c.token)).expect(200)).body.text).toContain('Current state of signals');
    expect(tg.sent).toHaveLength(0);
    // not connected: refused
    await http().post('/signals/overview/send').set(auth(c.token)).send({ lang: 'uk' }).expect(400);
    const m = await member(c.token, 'MANAGER');
    await connect(c.clinicId, m.userId, '7602');
    await connect(c.clinicId, c.userId, '7601', false); // signals off: the summary on request still goes to the person's own chat
    await http().post('/signals/overview/send').set(auth(c.token)).send({ lang: 'uk' }).expect(200);
    expect(tg.sent.map((x) => x.chatId)).toEqual(['7601']);
    await http().post('/signals/overview/send').set(auth(c.token)).send({ lang: 'uk' }).expect(400); // a minute has not passed
    expect(tg.sent).toHaveLength(1);
    // a blocked bot: refused, nothing sent
    await prisma.leaderTelegram.updateMany({ where: { chatId: '7602' }, data: { blockedAt: new Date() } });
    await http().post('/signals/overview/send').set(auth(m.token)).send({ lang: 'uk' }).expect(400);
    // an administrator cannot ask for it
    const admin = await member(c.token, 'ADMIN');
    await http().get('/signals/overview').set(auth(admin.token)).expect(403);
    await http().post('/signals/overview/send').set(auth(admin.token)).send({}).expect(403);
    expect(tg.sent).toHaveLength(1);
  });
});
