import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { OutboxService } from '../src/automations/outbox.service';
import { TelegramApi } from '../src/automations/telegram.api';
import { encrypt } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// Gaps of existing workflows closed on 2026-11-16: a staff resend of a failed message (only when it certainly did not reach the patient), the channel
// filter of the history, and the "who answers next" label of the dialogue list. Telegram is a fake; nothing goes out.
const sent: { chatId: string; text: string }[] = [];
const tg = {
  getMe: async () => ({ id: 1, username: 'clinic_test_bot' }), getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
  sendMessage: async (_t: string, chatId: string | number, text: string) => void sent.push({ chatId: String(chatId), text }),
  getUpdates: async () => [],
  answerCallbackQuery: async () => true,
  setWebhook: async () => true,
  deleteWebhook: async () => true,
};
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(LlmClient).useValue({ configured: false, complete: async () => { throw new Error('no model in tests'); } }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => app.close());

async function clinic() {
  const email = `w${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true } });
  await prisma.integration.create({ data: { clinicId, provider: 'TELEGRAM', apiKeyEnc: encrypt('123:fake') } });
  const patient = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Пацієнт Тестовий', consent: 'GIVEN' } });
  const chatId = `tg${rnd()}`;
  await prisma.patientChannel.create({ data: { clinicId, patientId: patient.id, channel: 'TELEGRAM', externalId: chatId } });
  return { token: res.body.accessToken as string, clinicId, patient, chatId };
}
const failed = (c: Awaited<ReturnType<typeof clinic>>, error: string, over: object = {}) =>
  prisma.outboundMessage.create({ data: { clinicId: c.clinicId, patientId: c.patient.id, ruleKey: 'lapsed', channel: 'TELEGRAM', text: `Текст ${rnd()}`, status: 'FAILED', error, scheduledFor: new Date(Date.now() - 3600_000), dedupeKey: `d${rnd()}`, ...over } });
const member = async (owner: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(owner)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201)).body.accessToken as string;
};

describe('повторне надсилання повідомлення, що не дійшло', () => {
  it('лише явна відмова до доставки: повертається в чергу, проходить усі перевірки й надсилається; мережеві й невідомі — ні; не більше двох разів; чужа клініка — 404', async () => {
    const c = await clinic();
    const sure = await failed(c, 'Bad Request: message is too long');
    const network = await failed(c, 'Telegram недоступний');
    const unknown = await failed(c, 'Результат доставки невідомий: повторно не надсилається', { status: 'UNKNOWN' });
    const expired = await failed(c, 'Telegram-бот не підключено', { expiresAt: new Date(Date.now() - 1000) });

    const list = (await http().get('/messages?status=FAILED').set(auth(c.token)).expect(200)).body.rows as { id: string; retryable: boolean }[];
    expect(Object.fromEntries(list.map((r) => [r.id, r.retryable]))).toEqual({ [sure.id]: true, [network.id]: false, [expired.id]: false });

    await http().post(`/messages/${network.id}/retry`).set(auth(c.token)).expect(400);
    await http().post(`/messages/${unknown.id}/retry`).set(auth(c.token)).expect(400);
    await http().post(`/messages/${expired.id}/retry`).set(auth(c.token)).expect(400);
    const other = await clinic();
    await http().post(`/messages/${sure.id}/retry`).set(auth(other.token)).expect(404);
    const doctor = await member(c.token, 'DOCTOR');
    await http().post(`/messages/${sure.id}/retry`).set(auth(doctor)).expect(403);

    await http().post(`/messages/${sure.id}/retry`).set(auth(c.token)).expect(200);
    expect(await prisma.outboundMessage.findUniqueOrThrow({ where: { id: sure.id } })).toMatchObject({ status: 'APPROVED', error: null });
    await app.get(OutboxService).process(new Date(), { clinicId: c.clinicId });
    expect(sent.filter((x) => x.chatId === c.chatId)).toHaveLength(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: sure.id } })).status).toBe('SENT');
    await http().post(`/messages/${sure.id}/retry`).set(auth(c.token)).expect(400); // SENT is not a failure

    // the checks run again: with sending off nothing goes out
    const again = await failed(c, 'Too Many Requests: retry after 5');
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
    await http().post(`/messages/${again.id}/retry`).set(auth(c.token)).expect(200);
    await app.get(OutboxService).process(new Date(), { clinicId: c.clinicId });
    expect(sent.filter((x) => x.chatId === c.chatId)).toHaveLength(1);
    // at most two manual resends of one message
    await prisma.outboundMessage.update({ where: { id: again.id }, data: { status: 'FAILED', error: 'Too Many Requests' } });
    await http().post(`/messages/${again.id}/retry`).set(auth(c.token)).expect(200);
    await prisma.outboundMessage.update({ where: { id: again.id }, data: { status: 'FAILED', error: 'Too Many Requests' } });
    await http().post(`/messages/${again.id}/retry`).set(auth(c.token)).expect(400);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'messages.retry' } })).toBe(3);
  });

  it('історія з фільтром за каналом', async () => {
    const c = await clinic();
    await failed(c, 'Bad Request');
    await failed(c, 'Помилка', { channel: 'INSTAGRAM' });
    const ig = (await http().get('/messages?status=FAILED&channel=INSTAGRAM').set(auth(c.token)).expect(200)).body.rows as { channel: string }[];
    expect(ig.map((r) => r.channel)).toEqual(['INSTAGRAM']);
    expect((await http().get('/messages?status=FAILED').set(auth(c.token)).expect(200)).body.rows).toHaveLength(2);
    expect((await http().get('/messages?status=FAILED&channel=XYZ').set(auth(c.token)).expect(200)).body.rows).toHaveLength(2);
  });
});

describe('хто відповідає в діалозі', () => {
  it('без автоматичних відповідей — співробітник; автовідповідь — ШІ, але не під час паузи після відповіді людини і не в діалозі, який узяла людина', async () => {
    const c = await clinic();
    const say = (chatId: string, text: string, extra: object = {}) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId, direction: 'IN', text, ...extra } });
    await say(c.chatId, 'Добрий день');
    await say('tg-other', 'Привіт');
    await say('tg-human', 'Агов');
    const answers = async () => Object.fromEntries(((await http().get('/conversations').set(auth(c.token)).expect(200)).body as { chatId: string; answers: string }[]).map((x) => [x.chatId, x.answers]));
    expect(await answers()).toEqual({ [c.chatId]: 'STAFF', 'tg-other': 'STAFF', 'tg-human': 'STAFF' });

    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true, aiAutoReply: true, aiPauseMinutes: 30 } });
    const staff = (await prisma.membership.findFirstOrThrow({ where: { clinicId: c.clinicId } })).userId;
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'tg-other', direction: 'OUT', text: 'Відповідь людини', authorUserId: staff } });
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'tg-human', owner: 'HUMAN' } });
    expect(await answers()).toEqual({ [c.chatId]: 'AI', 'tg-other': 'STAFF', 'tg-human': 'STAFF' });
    // the dialogue given back to the bot
    await http().post('/conversations/TELEGRAM/tg-other/resume-bot').set(auth(c.token)).expect(200);
    expect((await answers())['tg-other']).toBe('AI');
  });
});
