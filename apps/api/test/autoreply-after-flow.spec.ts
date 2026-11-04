import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { contactReply, formatHours, wantsContacts } from '../src/ai/contacts';
import { parseTypedTime } from '../src/automations/typed-time';
import { MessengerService } from '../src/automations/messenger.service';
import { ReportsService } from '../src/reports/reports.service';
import { clinicDate, clinicHm } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// A fake AI: nothing goes to the internet
const fake = {
  configured: true,
  calls: 0,
  reply: null as string | null,
  seq: [] as string[],
  system: '',
  complete: async (system?: string) => {
    fake.calls++;
    fake.system = system ?? '';
    if (fake.seq.length) return { text: fake.seq.shift()!, inputTokens: 100, outputTokens: 20 };
    if (fake.reply) return { text: fake.reply, inputTokens: 100, outputTokens: 20 };
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
    await write(c, `Прізвище Сидоренко, ім’я Олена, телефон 0971234567`);
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
    // the confirmation is a message of the system: it carries no author and does not pause the AI
    const msg = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: `bookconfirm:${req.id}` } });
    expect(msg).toMatchObject({ authorUserId: null, byAi: false });
    const thread = (await http().get(`/conversations/INSTAGRAM/${c.chat}`).set(auth(c.token)).expect(200)).body;
    expect(thread.botPausedUntil).toBeNull();

    sent.length = 0;
    await write(c, 'Дякую! А скажіть, де ви знаходитесь');
    // the clinic entered no address: the answer is written by the code (it says the address is to be clarified; no invented ban, no promise)
    expect(sent.filter((m) => m.chatId === c.chat && m.text.includes('потрібно уточнити в адміністратора клініки')).length).toBe(1);
  });

  it('службові повідомлення сценарію не з’їдають добовий ліміт відповідей ШІ і не заглушають чат', async () => {
    const c = await ready();
    const s = tomorrow();
    // a dialog that went through the booking flow several times in one day
    for (let i = 0; i < 3; i++) {
      await prisma.bookingRequest.deleteMany({ where: { clinicId: c.clinicId } });
      await write(c, '', `slot|${s.date}|${s.time}`);
      await write(c, `Прізвище Сидоренко, ім’я Олена, телефон 097123456${i}`);
    }
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT', byAi: true } })).toBe(0);
    sent.length = 0;
    await write(c, 'Добрий день, підкажіть адресу');
    expect(sent.filter((m) => m.chatId === c.chat && m.text.includes('потрібно уточнити в адміністратора клініки')).length).toBe(1);
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

  it('«хочу записатися» отримує відповідь ШІ, а не передачу людині, і в нормальному діалозі, і коли в чаті багато тестових повідомлень', async () => {
    const c = await ready();
    fake.reply = JSON.stringify({ intent: 'booking', reply: 'Добрий день! На яку послугу бажаєте записатися?', summary: 'запис', options: [] });
    // ten patient messages in the last day (a testing session): the default limit of 20 does not cut the dialog
    for (let i = 0; i < 10; i++) await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: `тест ${i}` } });
    await write(c, 'хочу записатися');
    expect(sent.at(-1)!.text).toBe('Добрий день! На яку послугу бажаєте записатися?');
    expect(sent.at(-1)!.text).not.toContain('Передаю');
    fake.reply = null;
  });

  it('нажаття кнопки часу, що прийшло звичайним текстом, вважається вибором часу, а не питанням до ШІ', async () => {
    const c = await ready();
    const s = tomorrow();
    const label = `пн ${s.date.slice(8)}.${s.date.slice(5, 7)}, ${s.time}`;
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: 'Оберіть час', byAi: true, buttons: [{ label, payload: `slot|${s.date}|${s.time}` }] } });
    const calls = fake.calls;
    await write(c, label);
    expect(fake.calls).toBe(calls);
    expect(sent.at(-1)!.text).toContain('прізвище, ім’я та номер телефону');
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ stage: 'COLLECT' });
    // a typed time that fits exactly one offered button is that button; a question about a time is not
    const c2 = await ready();
    await prisma.chatMessage.create({ data: { clinicId: c2.clinicId, channel: 'INSTAGRAM', chatId: c2.chat, direction: 'OUT', text: 'Оберіть час', byAi: true, buttons: [{ label: `пн 02.11, 12:00`, payload: `slot|${s.date}|12:00` }, { label: `пн 02.11, 15:30`, payload: `slot|${s.date}|15:30` }] } });
    await write(c2, 'на 15:30');
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c2.clinicId } })).toMatchObject({ stage: 'COLLECT' });
    expect((await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c2.clinicId } })).slotAt?.toISOString()).toContain('T');
    const c3 = await ready();
    await prisma.chatMessage.create({ data: { clinicId: c3.clinicId, channel: 'INSTAGRAM', chatId: c3.chat, direction: 'OUT', text: 'Оберіть час', byAi: true, buttons: [{ label: `пн 02.11, 12:00`, payload: `slot|${s.date}|12:00` }] } });
    await write(c3, 'а 12:00 буде лікар?');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c3.clinicId } })).toBe(0);
    await write(c3, '17:45');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c3.clinicId } })).toBe(0);
    // ordinary text that is not a button title still goes to the AI
    sent.length = 0;
    await write(c, 'Добрий день, а які ще є вікна?');
    expect(fake.calls).toBeGreaterThanOrEqual(calls);
  });

  it('модель повторила той самий час: кнопка одна', async () => {
    const c = await ready();
    const s = tomorrow();
    jest.spyOn(app.get(ReportsService), 'freeSlots').mockResolvedValue([{ dayAt: s.date, doctor: null, cabinet: 'Терапія', freeMinutes: 540, windows: '09:00–18:00' }] as never);
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: Object.fromEntries(days.map((d) => [d, { from: '09:00', to: '20:00' }])) } });
    fake.reply = JSON.stringify({ intent: 'booking', reply: 'Оберіть, будь ласка, зручний час кнопкою нижче.', summary: 'x', options: [{ date: s.date, time: '12:00' }, { date: s.date, time: '12:00' }, { date: s.date, time: '14:00' }] });
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: 'вікна на лікування?' } });
    const d = await app.get(ChatAssistantService).draft(c.clinicId, 'INSTAGRAM', c.chat);
    expect(d.options.map((o) => o.time)).toEqual(['12:00', '14:00']);
    fake.reply = null;
  });

  describe('стоматологічні слова і гострий стан', () => {
    it('модель отримує словник пацієнтів (чистка, вісімка, панорама), а гострий біль і флюс не доходять до моделі: найближчий час кнопками і термінова заявка', async () => {
      const c = await ready();
      const s = tomorrow();
      jest.spyOn(app.get(ReportsService), 'freeSlots').mockResolvedValue([{ dayAt: s.date, doctor: null, cabinet: 'Терапія', freeMinutes: 540, windows: '09:00–18:00' }] as never);
      const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: Object.fromEntries(days.map((d) => [d, { from: '09:00', to: '20:00' }])) } });
      await write(c, 'Хочу видалити вісімку і зробити панораму');
      expect(fake.system).toContain('вісімка');
      expect(fake.system).toContain('панорамний рентгенівський знімок');
      expect(fake.system).toContain('чистка');

      const calls = fake.calls;
      sent.length = 0;
      const c2 = await ready();
      await write(c2, 'У мене гострий біль і флюс');
      expect(fake.calls).toBe(calls); // the model was not asked
      const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c2.clinicId } });
      expect(req.summary).toContain('ТЕРМІНОВО');
      expect(sent.at(-1)!.text).toContain('103');
      expect(sent.at(-1)!.text).not.toMatch(/полощ|приймайте|таблетк|антибіот/i);
    });

    it('питання про ліки, діагноз, ціну чи скаргу при болі, як і раніше, іде людині без ШІ', async () => {
      const c = await ready();
      const calls = fake.calls;
      for (const t of ['Болить зуб, який антибіотик пити?', 'Болить зуб, поставте діагноз', 'Болить зуб, скільки коштує лікування?', 'Болить зуб, я буду скаржитися']) {
        sent.length = 0;
        await write(c, t);
        expect(sent.at(-1)!.text).not.toContain('термінове');
      }
      expect(fake.calls).toBe(calls);
    });
  });

  it('мова розмови не перемикається сама: російською спитали — російською передача людині; помилка перевірки відповіді спершу повторюється', async () => {
    const c = await ready();
    // a Russian question whose answer fails the check (a time outside the free windows) is asked again once; the second answer passes
    const s = tomorrow();
    jest.spyOn(app.get(ReportsService), 'freeSlots').mockResolvedValue([{ dayAt: s.date, doctor: null, cabinet: 'Терапія', freeMinutes: 540, windows: '09:00–18:00' }] as never);
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: Object.fromEntries(days.map((d) => [d, { from: '09:00', to: '20:00' }])) } });
    const answers = [JSON.stringify({ intent: 'booking', reply: 'Свободно в 23:00', summary: 'x', options: [] }), JSON.stringify({ intent: 'booking', reply: 'Выберите, пожалуйста, время кнопкой ниже.', summary: 'x', options: [{ date: s.date, time: '12:00' }] })];
    const calls = fake.calls;
    fake.seq = answers;
    await write(c, 'какие есть окошки на завтра?');
    expect(fake.calls).toBe(calls + 2);
    expect(sent.at(-1)!.text).toBe('Выберите, пожалуйста, время кнопкой ниже.');
    // both answers fail: a hand-over in the language of the patient, not in Ukrainian
    fake.seq = [JSON.stringify({ intent: 'booking', reply: 'В 23:00', summary: '', options: [] }), JSON.stringify({ intent: 'booking', reply: 'В 22:00', summary: '', options: [] })];
    sent.length = 0;
    await write(c, 'а на послезавтра какие есть окошки?');
    expect(sent.at(-1)!.text).toContain('Передали ваш вопрос администратору клиники');
    fake.seq = [];
  });

  it('розбір набраного часу: «на 11», «давай на 11», «в 19-30», «11 годин»; питання й довгі повідомлення не вибір', () => {
    expect(parseTypedTime('давай на 11')).toBe('11:00');
    expect(parseTypedTime('на 11')).toBe('11:00');
    expect(parseTypedTime('пн 02-11 на 19-30')).toBe('19:30');
    expect(parseTypedTime('в 15.30')).toBe('15:30');
    expect(parseTypedTime('11 годин')).toBe('11:00');
    expect(parseTypedTime('11')).toBe('11:00');
    expect(parseTypedTime('о 9:30, будь ласка')).toBe('09:30');
    expect(parseTypedTime('а на 11 буде лікар?')).toBeNull();
    expect(parseTypedTime('на 25')).toBeNull();
    expect(parseTypedTime('2 зуби болять')).toBeNull();
    expect(parseTypedTime('Хочу записатися на чистку зубів на наступному тижні, коли зручно')).toBeNull();
  });

  it('«давай на 11» у відповідь на запропоновані кнопки — це вибір часу, а не передача людині', async () => {
    const c = await ready();
    const s = tomorrow();
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: 'Оберіть час', byAi: true, buttons: [{ label: 'вт 03.11, 09:00', payload: `slot|${s.date}|09:00` }, { label: 'вт 03.11, 11:00', payload: `slot|${s.date}|11:00` }] } });
    const calls = fake.calls;
    await write(c, 'давай на 11');
    expect(fake.calls).toBe(calls);
    expect(sent.at(-1)!.text).toContain('прізвище, ім’я та номер телефону');
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Передаю');
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(req.stage).toBe('COLLECT');
    expect(clinicHm(req.slotAt!)).toBe('11:00');
    // the next messages give the data and the request is complete
    await write(c, 'Прізвище Петренко, ім’я Іван, телефон 0971234567');
    expect(sent.at(-1)!.text).toContain('Передали заявку');
  });

  describe('адреса, телефон, графік', () => {
    it('розбір питань і форматування годин', () => {
      expect(wantsContacts('Дякую, а де ви знаходитесь?')).toEqual({ address: true, phone: false, hours: false });
      expect(wantsContacts('какой у вас номер телефона?')).toMatchObject({ phone: true });
      expect(wantsContacts('до котрої ви працюєте')).toMatchObject({ hours: true });
      expect(wantsContacts('де ви знаходитесь і хочу записатися')).toBeNull();
      expect(wantsContacts('Добрий день')).toBeNull();
      const wk = { '1': { from: '09:00', to: '20:00' }, '2': { from: '09:00', to: '20:00' }, '3': { from: '09:00', to: '20:00' }, '4': { from: '09:00', to: '20:00' }, '5': { from: '09:00', to: '20:00' }, '6': { from: '10:00', to: '15:00' }, '7': null };
      expect(formatHours(wk, 'uk')).toBe('пн–пт 09:00–20:00, сб 10:00–15:00, нд вихідний');
      expect(formatHours(wk, 'ru')).toBe('пн–пт 09:00–20:00, сб 10:00–15:00, вс выходной');
      expect(contactReply('де ви знаходитесь?', 'uk', { address: null, phone: null, directions: null, hours: null })).toContain('потрібно уточнити в адміністратора клініки');
      // the address kept in the knowledge base is answered by the model from there: the code stays silent
      expect(contactReply('де ви знаходитесь?', 'uk', { address: null, phone: null, directions: null, hours: null, inKnowledgeBase: true })).toBeNull();
    });

    it('«де ви знаходитесь» і «який телефон»: відповідь із контактів клініки без моделі й без передачі людині; порожніх полів бот не називає', async () => {
      const c = await ready();
      // nothing entered yet: the question still goes on its normal way (no invented address)
      await http().get('/clinic/contacts').set(auth(c.token)).expect(200);
      const calls = fake.calls;
      sent.length = 0;
      await write(c, 'Дякую, а де ви знаходитесь?');
      expect(fake.calls).toBe(calls); // no model, no hand-over: the code says plainly that the address is to be clarified
      expect(sent.at(-1)!.text).toContain('адреса клініки');
      expect(sent.at(-1)!.text).toContain('потрібно уточнити в адміністратора клініки');
      expect(sent.at(-1)!.text).not.toMatch(/не можемо|в цьому чаті/);
      expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } })).toBe(0); // nothing is promised, so nothing is created

      await http().put('/clinic/contacts').set(auth(c.token)).send({ address: 'м. Київ, вул. Тестова, 12, 2 поверх', phone: '+380441234567', directions: 'Вхід із двору, ліворуч від аптеки.' }).expect(200);
      const after = fake.calls;
      sent.length = 0;
      await write(c, 'Дякую, а де ви знаходитесь?');
      expect(fake.calls).toBe(after);
      expect(sent.at(-1)!.text).toContain('Наша адреса: м. Київ, вул. Тестова, 12, 2 поверх.');
      expect(sent.at(-1)!.text).toContain('Вхід із двору');
      expect(sent.at(-1)!.text).not.toContain('Передаю');

      sent.length = 0;
      await write(c, 'а какой у вас номер телефона?');
      expect(sent.at(-1)!.text).toContain('Телефон администратора: +380441234567.');
      expect(fake.calls).toBe(after);

      await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: { '1': { from: '09:00', to: '20:00' }, '2': { from: '09:00', to: '20:00' }, '3': { from: '09:00', to: '20:00' }, '4': { from: '09:00', to: '20:00' }, '5': { from: '09:00', to: '20:00' }, '6': { from: '10:00', to: '15:00' }, '7': null } } });
      sent.length = 0;
      await write(c, 'до котрої ви працюєте?');
      expect(sent.at(-1)!.text).toContain('Графік роботи: пн–пт 09:00–20:00, сб 10:00–15:00, нд вихідний.');
      // the contacts are also known to the model, for a message that asks for a booking and the address at once
      await write(c, 'хочу записатися і де ви знаходитесь');
      expect(fake.system).toContain('вул. Тестова, 12');
    });

    it('контакти змінюють лише власник і керуючий, чужа клініка їх не бачить, межі довжини', async () => {
      const a = await ready();
      const b = await ready();
      await http().put('/clinic/contacts').set(auth(a.token)).send({ address: 'Адреса А' }).expect(200);
      expect((await http().get('/clinic/contacts').set(auth(b.token)).expect(200)).body).toEqual({ address: '', phone: '', directions: '' });
      await http().put('/clinic/contacts').set(auth(a.token)).send({ phone: '1'.repeat(41) }).expect(400);
      const inv = await http().post('/team/invitations').set(auth(a.token)).send({ email: `an${rnd()}@example.com`, role: 'ANALYST' }).expect(201);
      const analyst = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ан', password: PASSWORD }).expect(201)).body.accessToken as string;
      await http().put('/clinic/contacts').set(auth(analyst)).send({ address: 'Хакер' }).expect(403);
      expect((await http().get('/clinic/contacts').set(auth(a.token))).body.address).toBe('Адреса А');
    });
  });

  it('повернення боту належить своїй клініці', async () => {
    const a = await ready();
    const b = await ready();
    await write(a, 'Добрий день');
    await http().post(`/conversations/INSTAGRAM/${a.chat}/resume-bot`).set(auth(b.token)).expect(404);
  });
});
