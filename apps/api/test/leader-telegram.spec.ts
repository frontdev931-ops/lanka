import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DigestService } from '../src/automations/digest.service';
import { LeaderTelegramService } from '../src/automations/leader-telegram.service';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { TelegramService } from '../src/automations/telegram.service';
import { hashToken, newToken } from '../src/auth/tokens';
import { I18nExceptionFilter } from '../src/common/i18n';
import { InsightsService } from '../src/insights/insights.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

// A fake Telegram: nothing goes to the internet, every send is recorded with the token it used
class FakeTelegram {
  sent: { token: string; chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  blocked = new Set<string>();
  getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
  getMe = async () => ({ id: 1, username: 'clinic_test_bot' });
  sendMessage = async (token: string, chatId: string | number, text: string, extra?: Record<string, unknown>) => {
    if (this.blocked.has(String(chatId))) throw new TelegramError('Forbidden: bot was blocked by the user', 403);
    this.sent.push({ token, chatId: String(chatId), text, extra });
  };
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}

const SERVICE = '999:AAServiceBotTokenForTestsOnly_abcdefghijk';
const CLINIC_BOT = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const SECRET = 'service-webhook-secret-for-tests';
const tg = new FakeTelegram();
let app: INestApplication;
let prisma: PrismaService;
let leader: LeaderTelegramService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

const start = (chat: number, token: string, type = 'private') => ({ update_id: 1, message: { chat: { id: chat, type }, from: { id: chat, first_name: 'Ольга', language_code: 'uk' }, text: `/start l_${token}` } });
const press = (chat: number, token: string, from = chat) => ({ update_id: 2, callback_query: { id: 'q', from: { id: from, first_name: 'Ольга', language_code: 'uk' }, message: { chat: { id: chat } }, data: `lc:${token}` } });
const tokenOf = (url: string) => url.split('start=l_')[1];

beforeAll(async () => {
  process.env.LANKA_TG_BOT_TOKEN = SERVICE;
  process.env.LANKA_TG_BOT_USERNAME = 'lanka_test_bot';
  process.env.LANKA_TG_WEBHOOK_SECRET = SECRET;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  leader = app.get(LeaderTelegramService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tg.sent.length = 0;
  tg.blocked.clear();
});

async function clinic() {
  const email = `lt${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * 86_400_000) } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, email };
}
async function member(ownerToken: string, role: string) {
  const email = `lr${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const token = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
// the whole flow: a link from the session, Start in a private chat, the button
async function connect(token: string, chat: number) {
  const url = (await http().post('/leader-telegram/link').set(auth(token)).expect(201)).body.url as string;
  await leader.handle(start(chat, tokenOf(url)));
  await leader.handle(press(chat, tokenOf(url)));
  return url;
}

describe('Telegram керівника через службовий бот LANKA', () => {
  it('підключення: одноразове посилання без особистих даних; Start лише питає; кнопка в особистому чаті підключає; повтор, підробка, група й прострочене не працюють', async () => {
    const c = await clinic();
    const url = (await http().post('/leader-telegram/link').set(auth(c.token)).expect(201)).body.url as string;
    expect(url).toMatch(/^https:\/\/t\.me\/lanka_test_bot\?start=l_[A-Za-z0-9_-]{20,}$/);
    expect(url).not.toContain(c.email);
    expect(url).not.toContain(c.clinicId);
    expect(url).not.toContain(c.userId);
    const tok = tokenOf(url);

    // opening the link (Start) only asks; nothing is linked yet
    await leader.handle(start(5001, tok));
    expect(tg.sent.at(-1)).toMatchObject({ token: SERVICE, chatId: '5001' });
    expect(tg.sent.at(-1)!.text).toContain('Підключити цей Telegram');
    expect((await http().get('/leader-telegram').set(auth(c.token)).expect(200)).body.me).toBeNull();
    // a group, and a button pressed from another chat, do nothing
    await leader.handle(start(-100500, tok, 'group'));
    expect(tg.sent.at(-1)!.text).toContain('особистому чаті');
    await leader.handle(press(5001, tok, 7777));
    expect((await http().get('/leader-telegram').set(auth(c.token))).body.me).toBeNull();

    // the button links it; switches start off; nothing else is sent
    tg.sent.length = 0;
    await leader.handle(press(5001, tok));
    const v = (await http().get('/leader-telegram').set(auth(c.token))).body;
    expect(v.me).toMatchObject({ tgName: 'Ольга', digest: false, signals: false, blocked: false });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain('Готово');
    // one-time: the same link again (a repeated tap or a replayed update)
    await leader.handle(press(5002, tok));
    await leader.handle(start(5002, tok));
    expect(tg.sent.at(-1)!.text).toContain('недійсне');
    expect(await prisma.leaderTelegram.count({ where: { clinicId: c.clinicId } })).toBe(1);
    // a forged and an expired link
    await leader.handle(press(5003, 'forged-token-value-forged-token-value'));
    const raw = newToken();
    await prisma.channelLink.create({ data: { clinicId: c.clinicId, purpose: 'LEADER', createdById: c.userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() - 1000) } });
    await leader.handle(press(5004, raw));
    expect(tg.sent.at(-1)!.text).toContain('застаріло');
    // a patient-bot link token is not a leader link
    const pat = newToken();
    await prisma.channelLink.create({ data: { clinicId: c.clinicId, purpose: 'DIGEST', tokenHash: hashToken(pat), expiresAt: new Date(Date.now() + 60_000) } });
    await leader.handle(press(5005, pat));
    expect(await prisma.leaderTelegram.count({ where: { clinicId: c.clinicId } })).toBe(1);
  });

  it('заміна: інший Telegram для того ж користувача й той самий Telegram для іншого користувача відхиляються; відключення', async () => {
    const c = await clinic();
    await connect(c.token, 6001);
    // another Telegram for the same account: refused until the first one is disconnected
    await connect(c.token, 6002);
    expect(tg.sent.at(-1)!.text).toContain('уже підключено інший Telegram');
    expect((await prisma.leaderTelegram.findFirstOrThrow({ where: { clinicId: c.clinicId } })).chatId).toBe('6001');
    // the same Telegram for another user of the clinic: refused
    const m = await member(c.token, 'MANAGER');
    await connect(m.token, 6001);
    expect(tg.sent.at(-1)!.text).toContain('іншого користувача');
    expect((await http().get('/leader-telegram').set(auth(m.token))).body.me).toBeNull();
    // disconnect, then a new Telegram works
    await http().delete('/leader-telegram').set(auth(c.token)).expect(200);
    await connect(c.token, 6002);
    expect((await http().get('/leader-telegram').set(auth(c.token))).body.me).toMatchObject({ digest: false });
    expect((await prisma.leaderTelegram.findFirstOrThrow({ where: { clinicId: c.clinicId, userId: c.userId } })).chatId).toBe('6002');
  });

  it('права й ізоляція: лише власник і керуючий; своя клініка з сесії; без сервера бота — зрозумілий стан, не зламана кнопка', async () => {
    const a = await clinic();
    const b = await clinic();
    const admin = await member(a.token, 'ADMIN');
    const doctor = await member(a.token, 'DOCTOR');
    for (const t of [admin.token, doctor.token]) {
      await http().get('/leader-telegram').set(auth(t)).expect(403);
      await http().post('/leader-telegram/link').set(auth(t)).expect(403);
      await http().patch('/leader-telegram').set(auth(t)).send({ digest: true }).expect(403);
    }
    await connect(a.token, 6101);
    await http().patch('/leader-telegram').set(auth(a.token)).send({ digest: true, signals: true }).expect(200);
    // clinic B sees nothing of A and cannot change it
    const vb = (await http().get('/leader-telegram').set(auth(b.token))).body;
    expect(vb.me).toBeNull();
    expect(vb.digestTo).toEqual([]);
    await http().patch('/leader-telegram').set(auth(b.token)).send({ digest: false }).expect(404);
    expect((await prisma.leaderTelegram.findFirstOrThrow({ where: { clinicId: a.clinicId } })).digest).toBe(true);
    // A's link bound A, never B
    expect(await prisma.leaderTelegram.count({ where: { clinicId: b.clinicId } })).toBe(0);

    // the service bot is not set up on this server
    const saved = process.env.LANKA_TG_BOT_TOKEN;
    delete process.env.LANKA_TG_BOT_TOKEN;
    try {
      expect((await http().get('/leader-telegram').set(auth(a.token))).body).toMatchObject({ available: false, bot: null });
      await http().post('/leader-telegram/link').set(auth(a.token)).expect(400);
    } finally {
      process.env.LANKA_TG_BOT_TOKEN = saved;
    }
  });

  it('webhook: лише з правильним секретом у заголовку', async () => {
    const c = await clinic();
    const url = (await http().post('/leader-telegram/link').set(auth(c.token))).body.url as string;
    await http().post('/telegram-lanka/webhook').set('x-telegram-bot-api-secret-token', 'wrong').send(start(6201, tokenOf(url))).expect(200);
    await http().post('/telegram-lanka/webhook').send(start(6201, tokenOf(url))).expect(200);
    expect(tg.sent).toHaveLength(0);
    await http().post('/telegram-lanka/webhook').set('x-telegram-bot-api-secret-token', SECRET).send(start(6201, tokenOf(url))).expect(200);
    expect(tg.sent.at(-1)).toMatchObject({ token: SERVICE, chatId: '6201' });
  });

  it('дайджест без пацієнтського бота; лише за особистим вибором; втрата ролі, видалення, відключення й блокування зупиняють надсилання', async () => {
    const c = await clinic();
    expect(await prisma.integration.count({ where: { clinicId: c.clinicId, provider: 'TELEGRAM' } })).toBe(0);
    const digest = app.get(DigestService);
    const m = await member(c.token, 'MANAGER');
    await connect(c.token, 6301);
    await connect(m.token, 6302);
    tg.sent.length = 0;
    // connected but not chosen: nothing
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(0);
    await http().patch('/leader-telegram').set(auth(c.token)).send({ digest: true }).expect(200);
    await http().patch('/leader-telegram').set(auth(m.token)).send({ digest: true }).expect(200);
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(2);
    expect(tg.sent.map((x) => [x.token, x.chatId]).sort()).toEqual([[SERVICE, '6301'], [SERVICE, '6302']]);
    expect(tg.sent[0].text).toContain('Дайджест клініки');
    // the manager lost the role: nothing to them (the stored switch stays, the check is at sending)
    await prisma.membership.update({ where: { userId_clinicId: { userId: m.userId, clinicId: c.clinicId } }, data: { role: 'ADMIN' } });
    tg.sent.length = 0;
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(1);
    expect(tg.sent.map((x) => x.chatId)).toEqual(['6301']);
    // removed from the team: nothing either
    await prisma.membership.delete({ where: { userId_clinicId: { userId: m.userId, clinicId: c.clinicId } } });
    expect((await leader.recipients(c.clinicId, 'digest')).map((r) => r.chatId)).toEqual(['6301']);
    // the bot was blocked: marked, skipped afterwards
    tg.blocked.add('6301');
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(0);
    expect((await http().get('/leader-telegram').set(auth(c.token))).body.me).toMatchObject({ blocked: true });
    tg.blocked.clear();
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(0);
    // disconnected: nothing
    await http().delete('/leader-telegram').set(auth(c.token)).expect(200);
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(0);
  });

  it('старі отримувачі зберігаються й отримують через бот клініки до переподключення; після нього — лише новим шляхом, без дублів', async () => {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: CLINIC_BOT }).expect(201);
    const telegram = app.get(TelegramService);
    // two legacy recipients linked through the clinic's patient bot before the change
    for (const chat of [6401, 6402]) {
      const raw = newToken();
      await prisma.channelLink.create({ data: { clinicId: c.clinicId, purpose: 'DIGEST', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 3_600_000) } });
      await telegram.handleUpdate(c.clinicId, CLINIC_BOT, { update_id: 1, message: { chat: { id: chat }, from: { id: chat, first_name: `Старий ${chat}` }, text: `/start owner_${raw}` } });
    }
    expect((await http().get('/digest').set(auth(c.token))).body.recipients).toHaveLength(2);
    const digest = app.get(DigestService);
    tg.sent.length = 0;
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(2);
    expect(tg.sent.every((x) => x.token === CLINIC_BOT)).toBe(true);
    // nothing is moved silently: the leader view shows them as legacy
    expect((await http().get('/leader-telegram').set(auth(c.token))).body.legacy.digest).toHaveLength(2);

    // the owner reconnects the same Telegram (6401) through the service bot: their digest continues there, the old route stops
    await connect(c.token, 6401);
    expect((await http().get('/leader-telegram').set(auth(c.token))).body.me).toMatchObject({ digest: true, signals: false });
    tg.sent.length = 0;
    expect(await digest.send(c.clinicId, 'WEEKLY')).toBe(2);
    expect(tg.sent.filter((x) => x.chatId === '6401')).toEqual([expect.objectContaining({ token: SERVICE })]);
    expect(tg.sent.filter((x) => x.chatId === '6402')).toEqual([expect.objectContaining({ token: CLINIC_BOT })]);
    // the legacy rows are kept, one marked as moved
    expect(await prisma.digestRecipient.count({ where: { clinicId: c.clinicId } })).toBe(2);
    expect((await http().get('/digest').set(auth(c.token))).body.recipients.map((r: { name: string }) => r.name)).toEqual(['Старий 6402']);
    // the /digest command of the moved chat in the clinic bot no longer answers there
    tg.sent.length = 0;
    await telegram.handleUpdate(c.clinicId, CLINIC_BOT, { update_id: 3, message: { chat: { id: 6401 }, from: { id: 6401 }, text: '/digest' } });
    expect(tg.sent.filter((x) => x.token === CLINIC_BOT && x.text.includes('Дайджест клініки'))).toHaveLength(0);
  });

  it('сигнали: особисто через бот LANKA і в стару службову групу; видно, кому; підключення не надсилає накопичене', async () => {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: CLINIC_BOT }).expect(201);
    // a legacy staff group of the clinic bot
    const integ = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'TELEGRAM' } });
    await prisma.integration.update({ where: { id: integ.id }, data: { config: { ...(integ.config as object), staffChat: { id: '-100777', title: 'Команда' } } } });
    for (let i = 0; i < 3; i++) await prisma.task.create({ data: { clinicId: c.clinicId, title: 'T', dueDate: new Date(Date.now() - 3 * 86_400_000), status: 'OPEN' } });
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, telegram: true }).expect(200);

    tg.sent.length = 0;
    await connect(c.token, 6501);
    // connecting sends only the bot's own answers, no signal
    expect(tg.sent.filter((x) => x.text.startsWith('Сигнал'))).toHaveLength(0);
    let s = (await http().get('/signals').set(auth(c.token)).expect(200)).body;
    expect(s.telegram).toMatchObject({ serviceBot: true, people: [], group: 'Команда', me: { signals: false } });

    await http().patch('/leader-telegram').set(auth(c.token)).send({ signals: true }).expect(200);
    s = (await http().get('/signals').set(auth(c.token))).body;
    expect(s.telegram).toMatchObject({ people: ['Олена Власниця'], group: 'Команда', me: { signals: true } });
    tg.sent.length = 0;
    expect(await app.get(InsightsService).evaluate(c.clinicId)).toContain('OVERDUE_TASKS');
    const sig = tg.sent.filter((x) => x.text.startsWith('Сигнал'));
    expect(sig.map((x) => [x.token, x.chatId]).sort()).toEqual([[CLINIC_BOT, '-100777'], [SERVICE, '6501']]);
    // once per day per rule: a second run sends nothing
    tg.sent.length = 0;
    await app.get(InsightsService).evaluate(c.clinicId);
    expect(tg.sent.filter((x) => x.text.startsWith('Сигнал'))).toHaveLength(0);
  });
});
