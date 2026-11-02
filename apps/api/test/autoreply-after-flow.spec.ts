import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, clinicHm } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// A fake AI: nothing goes to the internet
const fake = {
  configured: true,
  calls: 0,
  complete: async () => {
    fake.calls++;
    return { text: JSON.stringify({ intent: 'info', reply: 'Добрий день! Чим можемо допомогти?', summary: '', options: [] }), inputTokens: 100, outputTokens: 20 };
  },
};
const sent: { chatId: string; text: string }[] = [];
let failNext = false;

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
let mid = 0;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fake).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string) => {
    if (failNext) {
      failNext = false;
      throw new Error('send failed');
    }
    sent.push({ chatId, text });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
});
beforeEach(() => {
  sent.length = 0;
  fake.calls = 0;
});

async function ready() {
  const email = `r${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // the AI autoreply is a Pro feature
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO' } });
  await http().patch('/ai').set(auth(token)).send({ enabled: true, autoReply: true }).expect(200);
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true } });
  return { token, clinicId, chat: `ig${rnd()}` };
}
const write = (c: { clinicId: string; chat: string }, text: string, payload?: string) =>
  app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const aiReplies = (chat: string) => sent.filter((m) => m.chatId === chat && m.text.startsWith('Добрий день')).length;
const tomorrow = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(9, 0, 0, 0);
  return { date: clinicDate(d), time: clinicHm(d) };
};

describe('автовідповідь ШІ після сценарію запису (відтворення збою)', () => {
  it('після підтвердження адміністратором ШІ не вимовкає: підтвердження системи не вважається відповіддю людини', async () => {
    const c = await ready();
    const s = tomorrow();
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'x', service: 'Чистка' } });
    await write(c, '', `slot|${s.date}|${s.time}`);
    await write(c, `Олена Сидоренко 0971234567`);
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
    // the confirmation is a message of the system: it carries no author and does not pause the AI
    const msg = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: `bookconfirm:${req.id}` } });
    expect(msg).toMatchObject({ authorUserId: null, byAi: false });
    const thread = (await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body;
    expect(thread.botPausedUntil).toBeNull();

    sent.length = 0;
    await write(c, 'Дякую! А скажіть, де ви знаходитесь');
    expect(aiReplies(c.chat)).toBe(1);
  });

  it('службові повідомлення сценарію не з’їдають добовий ліміт відповідей ШІ і не заглушають чат', async () => {
    const c = await ready();
    const s = tomorrow();
    // a dialog that went through the booking flow several times in one day
    for (let i = 0; i < 3; i++) {
      await prisma.bookingRequest.deleteMany({ where: { clinicId: c.clinicId } });
      await write(c, '', `slot|${s.date}|${s.time}`);
      await write(c, `Олена Сидоренко 097123456${i}`);
    }
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT', byAi: true } })).toBe(0);
    sent.length = 0;
    await write(c, 'Добрий день, підкажіть адресу');
    expect(aiReplies(c.chat)).toBe(1);
  });

  it('питання під час збору даних іде до ШІ, а не мовчить; нерозпізнана відповідь питається знову, а не губиться', async () => {
    const c = await ready();
    const s = tomorrow();
    await write(c, '', `slot|${s.date}|${s.time}`);
    sent.length = 0;
    await write(c, 'А скільки триває прийом?');
    expect(aiReplies(c.chat)).toBe(1);
    sent.length = 0;
    await write(c, 'ок');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/підкажіть/i);
  });

  it('забутий запит на збір даних (старший за 6 годин) не перехоплює діалог', async () => {
    const c = await ready();
    const s = tomorrow();
    await write(c, '', `slot|${s.date}|${s.time}`);
    await prisma.bookingRequest.updateMany({ where: { clinicId: c.clinicId }, data: { updatedAt: new Date(Date.now() - 7 * 3_600_000) } });
    sent.length = 0;
    await write(c, 'ок');
    expect(aiReplies(c.chat)).toBe(1);
  });

  it('передбачена пауза після відповіді людини видна адміністратору, діалог можна повернути боту, пауза не вимикається глобально', async () => {
    const c = await ready();
    await write(c, 'Добрий день');
    expect(aiReplies(c.chat)).toBe(1);
    // a person answers in the chat
    await http().post(`/conversations/INSTAGRAM/${c.chat}/reply`).set(auth(c.token)).send({ text: 'Вітаю, це адміністратор' }).expect(200);
    sent.length = 0;
    await write(c, 'Дякую');
    expect(aiReplies(c.chat)).toBe(0);
    const paused = (await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body;
    expect(new Date(paused.botPausedUntil).getTime()).toBeGreaterThan(Date.now());

    await http().post(`/conversations/INSTAGRAM/${c.chat}/resume-bot`).set(auth(c.token)).expect(200);
    expect((await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body.botPausedUntil).toBeNull();
    sent.length = 0;
    await write(c, 'А ще питання');
    expect(aiReplies(c.chat)).toBe(1);
    // a new answer of a person pauses the AI again
    await http().post(`/conversations/INSTAGRAM/${c.chat}/reply`).set(auth(c.token)).send({ text: 'Ще раз я' }).expect(200);
    sent.length = 0;
    await write(c, 'Гаразд');
    expect(aiReplies(c.chat)).toBe(0);
  });

  it('відповідь людини, яка не пішла (помилка відправки), не ставить паузу', async () => {
    const c = await ready();
    await write(c, 'Добрий день');
    failNext = true;
    await http().post(`/conversations/INSTAGRAM/${c.chat}/reply`).set(auth(c.token)).send({ text: 'Не дійде' }).expect(400);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT', authorUserId: { not: null }, error: { not: null } } })).toBe(1);
    sent.length = 0;
    await write(c, 'Дякую');
    expect(aiReplies(c.chat)).toBe(1);
    expect((await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body.botPausedUntil).toBeNull();
  });

  it('ліміт відповідей на чат і пауза налаштовуються: більший ліміт пропускає, нуль вимикає паузу, межі перевіряються', async () => {
    const c = await ready();
    expect((await http().get('/ai').set(auth(c.token)).expect(200)).body).toMatchObject({ repliesPerChatDay: 20, pauseMinutes: 30 });
    await http().patch('/ai').set(auth(c.token)).send({ repliesPerChatDay: 0 }).expect(400);
    await http().patch('/ai').set(auth(c.token)).send({ pauseMinutes: 9999 }).expect(400);
    // eight AI replies already today in this chat: the default limit of 20 lets the ninth through, a limit of 8 does not
    for (let i = 0; i < 8; i++) await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: `Відповідь ${i}`, byAi: true } });
    await write(c, 'Добрий день');
    expect(aiReplies(c.chat)).toBe(1);
    await http().patch('/ai').set(auth(c.token)).send({ repliesPerChatDay: 8 }).expect(200);
    sent.length = 0;
    await write(c, 'Ще питання');
    expect(aiReplies(c.chat)).toBe(0);
    await http().patch('/ai').set(auth(c.token)).send({ repliesPerChatDay: 50 }).expect(200);

    // a pause of 0 minutes: a person's answer does not silence the AI
    await http().patch('/ai').set(auth(c.token)).send({ pauseMinutes: 0 }).expect(200);
    await http().post(`/conversations/INSTAGRAM/${c.chat}/reply`).set(auth(c.token)).send({ text: 'Це людина' }).expect(200);
    sent.length = 0;
    await write(c, 'Дякую');
    expect(aiReplies(c.chat)).toBe(1);
    expect((await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body.botPausedUntil).toBeNull();
  });

  it('повернення боту належить своїй клініці', async () => {
    const a = await ready();
    const b = await ready();
    await write(a, 'Добрий день');
    await http().post(`/conversations/INSTAGRAM/${a.chat}/resume-bot`).set(auth(b.token)).expect(404);
  });
});
