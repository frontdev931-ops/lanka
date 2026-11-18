import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiService, LIMIT_ALERT_RETRY_MS } from '../src/ai/ai.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// The staff alert "the AI allowance is used up": one per exhaustion episode, only to the staff chat, and the in-app state without Telegram.
// Nothing goes to the internet: the AI and Telegram are fakes.
const llm = { configured: true, complete: async () => ({ text: 'ok', inputTokens: 1, outputTokens: 1 }) };
const tg = {
  sent: [] as { chatId: string; text: string }[],
  // rejected: Telegram answers with a refusal (nothing was delivered). lost: the message is taken but the answer never comes (a timeout)
  fail: false as false | 'rejected' | 'lost',
  getMe: async () => ({ id: 1, username: 'limit_test_bot' }), getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
  sendMessage: async (_t: string, chatId: string | number, text: string) => {
    if (tg.fail === 'rejected') throw new TelegramError('Forbidden: bot was kicked from the supergroup chat', 403);
    tg.sent.push({ chatId: String(chatId), text });
    if (tg.fail === 'lost') throw new TelegramError('Telegram недоступний');
  },
  answerCallbackQuery: async () => undefined,
  getUpdates: async () => [],
  setWebhook: async () => true,
  deleteWebhook: async () => true,
};

let app: INestApplication;
let prisma: PrismaService;
let ai: AiService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const TOKEN = '123456789:AAFakeTokenForLimitAlertOnly_abcdefghijklmn';
const STAFF = '-100777';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(llm).overrideProvider(TelegramApi).useValue(tg).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  ai = app.get(AiService);
});
afterAll(async () => app.close());
beforeEach(() => {
  tg.sent.length = 0;
  tg.fail = false;
});

async function clinic(opts: { limit: number; staffChat?: boolean; bot?: boolean }) {
  const email = `l${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  if (opts.bot !== false) await http().post('/automations/telegram').set(auth(token)).send({ token: TOKEN }).expect(201);
  if (opts.staffChat !== false && opts.bot !== false) await linkStaffChat(clinicId);
  await http().patch('/ai').set(auth(token)).send({ enabled: true, monthlyLimit: opts.limit }).expect(200);
  tg.sent.length = 0;
  return { token, clinicId };
}

async function linkStaffChat(clinicId: string) {
  const i = await prisma.integration.findFirstOrThrow({ where: { clinicId, provider: 'TELEGRAM' } });
  await prisma.integration.update({ where: { id: i.id }, data: { config: { ...(i.config as object), staffChat: { id: STAFF, title: 'Адміністратори' } } } });
}

const call = (clinicId: string) => ai.complete(clinicId, 'draft', 'sys', [{ role: 'user', content: 'x' }]);
const refused = (clinicId: string) => expect(call(clinicId)).rejects.toMatchObject({ message: 'ai_limit' });
const marks = (clinicId: string) => prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiLimitAlertAt: true, aiLimitAlertTryAt: true, aiLimitAlertUnknownAt: true } });
// the retry pause is over: the last attempt is moved into the past
const pauseOver = (clinicId: string) => prisma.clinic.update({ where: { id: clinicId }, data: { aiLimitAlertTryAt: new Date(Date.now() - LIMIT_ALERT_RETRY_MS - 1000) } });

describe('сповіщення про вичерпаний ліміт ШІ', () => {
  it('одне повідомлення персоналу в момент вичерпання; відмови після цього (також одночасні) нових не дають; пацієнтам нічого', async () => {
    const c = await clinic({ limit: 2 });
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(false);

    // the reply that uses the last of the allowance announces it
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chatId).toBe(STAFF);
    expect(tg.sent[0].text).toContain('ліміт ШІ вичерпано');
    expect(tg.sent[0].text).toContain('/settings?tab=billing');
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(true);
    expect((await marks(c.clinicId)).aiLimitAlertAt).not.toBeNull();

    await refused(c.clinicId);
    await Promise.all(Array.from({ length: 8 }, () => refused(c.clinicId)));
    // even after the retry pause a delivered alert is not repeated
    await pauseOver(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent.every((m) => m.chatId === STAFF)).toBe(true);
  });

  it('одночасні запити при вже вичерпаному ліміті дають рівно одне повідомлення', async () => {
    const c = await clinic({ limit: 0 });
    await Promise.all(Array.from({ length: 10 }, () => refused(c.clinicId)));
    expect(tg.sent).toHaveLength(1);
  });

  it('відновлений бюджет (більший ліміт, куплений пакет, новий період) дозволяє нове сповіщення при наступному вичерпанні', async () => {
    const c = await clinic({ limit: 1 });
    await call(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);

    // a raised limit: the episode is closed by the first reply that fits, the next exhaustion alerts again
    await http().patch('/ai').set(auth(c.token)).send({ monthlyLimit: 3 }).expect(200);
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(false);
    await call(c.clinicId);
    expect(await marks(c.clinicId)).toEqual({ aiLimitAlertAt: null, aiLimitAlertTryAt: null, aiLimitAlertUnknownAt: null });
    expect(tg.sent).toHaveLength(1);
    await call(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(2);

    // a bought pack of two replies
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiPurchased: 2 } });
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(2);
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(3);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(3);

    // a new billing period: the counter starts again
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { periodStartsAt: new Date() } });
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(false);
    await call(c.clinicId);
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(3);
    await call(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(4);
  });

  it('новий період з нульовим лімітом: позначка минулого періоду не глушить сповіщення', async () => {
    const c = await clinic({ limit: 0 });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiLimitAlertAt: new Date(Date.now() - 86_400_000), aiLimitAlertTryAt: new Date(Date.now() - 86_400_000), periodStartsAt: new Date() } });
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);
  });

  it('без службового чату та без бота: стан у застосунку є, доставку не позначено; після підключення чату надходить одне повідомлення', async () => {
    const none = await clinic({ limit: 0, bot: false });
    await refused(none.clinicId);
    expect((await http().get('/ai').set(auth(none.token))).body.limitReached).toBe(true);
    expect((await marks(none.clinicId)).aiLimitAlertAt).toBeNull();

    const c = await clinic({ limit: 0, staffChat: false });
    await refused(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(true);
    expect((await marks(c.clinicId)).aiLimitAlertAt).toBeNull();

    await linkStaffChat(c.clinicId);
    // inside the pause nothing is tried
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    await pauseOver(c.clinicId);
    await Promise.all(Array.from({ length: 5 }, () => refused(c.clinicId)));
    expect(tg.sent).toHaveLength(1);
    expect((await marks(c.clinicId)).aiLimitAlertAt).not.toBeNull();
  });

  it('явна відмова Telegram не вважається доставкою: повтор після паузи, потім тиша', async () => {
    const c = await clinic({ limit: 0 });
    tg.fail = 'rejected';
    await refused(c.clinicId);
    expect(await marks(c.clinicId)).toMatchObject({ aiLimitAlertAt: null, aiLimitAlertUnknownAt: null });
    tg.fail = false;
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(0);
    await pauseOver(c.clinicId);
    await refused(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect((await marks(c.clinicId)).aiLimitAlertAt).not.toBeNull();
  });

  it('невідомий результат (Telegram прийняв, відповідь загубилась): не позначено доставленим і в цьому епізоді не повторюється', async () => {
    const c = await clinic({ limit: 0 });
    tg.fail = 'lost';
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    const m = await marks(c.clinicId);
    expect(m.aiLimitAlertAt).toBeNull();
    expect(m.aiLimitAlertUnknownAt).not.toBeNull();

    // Telegram works again and the pause is over: still no second message, also under concurrent refusals
    tg.fail = false;
    await pauseOver(c.clinicId);
    await refused(c.clinicId);
    await pauseOver(c.clinicId);
    await Promise.all(Array.from({ length: 6 }, () => refused(c.clinicId)));
    expect(tg.sent).toHaveLength(1);
    expect((await marks(c.clinicId)).aiLimitAlertAt).toBeNull();
    // the in-app state does not depend on it
    expect((await http().get('/ai').set(auth(c.token))).body.limitReached).toBe(true);
  });

  it('новий епізод після невідомого результату сповіщає знову: відновлений бюджет і новий період', async () => {
    const c = await clinic({ limit: 1 });
    tg.fail = 'lost';
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect((await marks(c.clinicId)).aiLimitAlertUnknownAt).not.toBeNull();
    tg.fail = false;

    // a raised limit that still leaves the clinic over it restores nothing: the episode goes on, silent
    await prisma.aiUsage.create({ data: { clinicId: c.clinicId, kind: 'draft', ok: true, billable: true } });
    await http().patch('/ai').set(auth(c.token)).send({ monthlyLimit: 2 }).expect(200);
    await pauseOver(c.clinicId);
    await refused(c.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect((await marks(c.clinicId)).aiLimitAlertUnknownAt).not.toBeNull();

    // the budget is really back: the marks are cleared and the next exhaustion is announced and confirmed
    await http().patch('/ai').set(auth(c.token)).send({ monthlyLimit: 3 }).expect(200);
    await call(c.clinicId);
    expect(tg.sent).toHaveLength(2);
    const m = await marks(c.clinicId);
    expect(m.aiLimitAlertAt).not.toBeNull();
    expect(m.aiLimitAlertUnknownAt).toBeNull();

    // a new period with a zero limit: an unknown mark of the past period does not silence the alert
    const z = await clinic({ limit: 0 });
    await prisma.clinic.update({ where: { id: z.clinicId }, data: { aiLimitAlertUnknownAt: new Date(Date.now() - 86_400_000), aiLimitAlertTryAt: new Date(Date.now() - 86_400_000), periodStartsAt: new Date() } });
    await refused(z.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect((await marks(z.clinicId)).aiLimitAlertAt).not.toBeNull();
  });

  it('ізоляція: вичерпаний ліміт однієї клініки не видно в іншій і не дає їй повідомлень; неоплачувані виклики не сповіщають', async () => {
    const a = await clinic({ limit: 0 });
    const b = await clinic({ limit: 5 });
    await refused(a.clinicId);
    expect(tg.sent).toHaveLength(1);
    expect((await http().get('/ai').set(auth(b.token))).body.limitReached).toBe(false);
    expect(await marks(b.clinicId)).toEqual({ aiLimitAlertAt: null, aiLimitAlertTryAt: null, aiLimitAlertUnknownAt: null });

    // a free retry of an already counted request passes the limit and stays silent
    const z = await clinic({ limit: 0 });
    await ai.complete(z.clinicId, 'draft', 'sys', [{ role: 'user', content: 'x' }], undefined, 'chat', false);
    expect(tg.sent).toHaveLength(0);
  });
});
