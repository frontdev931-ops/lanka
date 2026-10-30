import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { clinicDate } from '../src/common/clinic-time';
import { AiService } from '../src/ai/ai.service';
import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { handoffText, incomingHandoff, parseModelJson, replyViolates, timesOutsideWindows } from '../src/ai/guardrails';
import { LlmClient, LlmError } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { TelegramApi } from '../src/automations/telegram.api';
import { TelegramService } from '../src/automations/telegram.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// Поддельный ИИ: в интернет ничего не уходит
const fake = { configured: true, calls: 0, fail: false, next: 'Добрий день!', seq: [] as string[], systems: [] as string[], turns: [] as { role: string; content: string }[][], system: '', complete: async (system?: string, messages?: { role: string; content: string }[]): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
  fake.calls++;
  fake.system = system ?? '';
  fake.systems.push(system ?? '');
  fake.turns.push(JSON.parse(JSON.stringify(messages ?? [])));
  if (fake.fail) throw new LlmError('boom');
  return { text: fake.seq.length ? fake.seq.shift()! : fake.next, inputTokens: 100, outputTokens: 20 };
} };

// Поддельный Telegram: ничего не уходит в интернет
const tg = {
  sent: [] as { chatId: string; text: string; extra?: Record<string, unknown> }[],
  answered: [] as string[],
  answerCallbackQuery: async (_t: string, id: string) => void tg.answered.push(id),
  getMe: async () => ({ id: 1, username: 'ai_test_bot' }),
  sendMessage: async (_t: string, chatId: string | number, text: string, extra?: Record<string, unknown>) => void tg.sent.push({ chatId: String(chatId), text, ...(extra && Object.keys(extra).length ? { extra } : {}) }),
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
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fake).overrideProvider(TelegramApi).useValue(tg).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  ai = app.get(AiService);
});
afterAll(async () => app.close());
beforeEach(() => {
  fake.calls = 0;
  fake.fail = false;
  fake.configured = true;
  fake.next = 'Добрий день!';
  fake.seq.length = 0;
  fake.systems.length = 0;
  fake.turns.length = 0;
  tg.sent.length = 0;
  tg.answered.length = 0;
});

async function clinic() {
  const email = `a${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // features of the Pro plan are on by default in these tests; the plan rules have their own tests
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO' } });
  return { token: res.body.accessToken as string, clinicId };
}

describe('ИИ-помощник: включение, лимит, расход', () => {
  it('по умолчанию выключен; без ключа на сервере включить нельзя; включает только владелец и управляющий', async () => {
    const c = await clinic();
    expect((await http().get('/ai').set(auth(c.token)).expect(200)).body).toMatchObject({ available: true, enabled: false, monthlyLimit: 500, used: 0 });
    fake.configured = false;
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true }).expect(400);
    fake.configured = true;
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `r${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().patch('/ai').set(auth(admin)).send({ enabled: true }).expect(403);
    expect((await http().patch('/ai').set(auth(c.token)).send({ enabled: true, monthlyLimit: 2 }).expect(200)).body).toMatchObject({ enabled: true, monthlyLimit: 2 });
    await http().patch('/ai').set(auth(c.token)).send({ monthlyLimit: -1 }).expect(400);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'ai.settings' } })).toBe(1);
  });

  it('самостоятельная запись ИИ: по умолчанию выключена, включить нельзя, пока запись в систему клиники не подключена', async () => {
    const c = await clinic();
    expect((await http().get('/ai').set(auth(c.token))).body).toMatchObject({ autoBooking: false, autoBookingSupported: false });
    await http().patch('/ai').set(auth(c.token)).send({ autoBooking: true }).expect(400);
    expect((await http().patch('/ai').set(auth(c.token)).send({ autoBooking: false }).expect(200)).body.autoBooking).toBe(false);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).aiAutoBooking).toBe(false);
  });

  it('вызов возможен только при включённом ИИ; месячный лимит останавливает; расход пишется без текста; сбой не считается ответом', async () => {
    const c = await clinic();
    await expect(ai.complete(c.clinicId, 'draft', 'sys', [{ role: 'user', content: 'привіт' }])).rejects.toMatchObject({ message: 'ai_disabled' });
    expect(fake.calls).toBe(0);

    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, monthlyLimit: 2 }).expect(200);
    const r = await ai.complete(c.clinicId, 'draft', 'sys', [{ role: 'user', content: 'секретний текст пацієнта' }]);
    expect(r.text).toBe('Добрий день!');
    fake.fail = true;
    await expect(ai.complete(c.clinicId, 'draft', 'sys', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ message: 'ai_failed' });
    fake.fail = false;
    expect((await http().get('/ai').set(auth(c.token))).body).toMatchObject({ used: 1, tokens: 120 });

    await ai.complete(c.clinicId, 'draft', 'sys', [{ role: 'user', content: 'x' }]);
    await expect(ai.complete(c.clinicId, 'draft', 'sys', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ message: 'ai_limit' });
    expect(fake.calls).toBe(3);
    expect(JSON.stringify(await prisma.aiUsage.findMany({ where: { clinicId: c.clinicId } }))).not.toContain('секретний');
  });

  it('счётчик и настройки изолированы по клиникам', async () => {
    const a = await clinic();
    const b = await clinic();
    await http().patch('/ai').set(auth(a.token)).send({ enabled: true }).expect(200);
    await ai.complete(a.clinicId, 'draft', 's', [{ role: 'user', content: 'x' }]);
    expect((await http().get('/ai').set(auth(b.token))).body).toMatchObject({ enabled: false, used: 0 });
    await expect(ai.complete(b.clinicId, 'draft', 's', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ message: 'ai_disabled' });
  });
});

describe('ИИ-помощник в переписке: границы', () => {
  it('опасные темы распознаются до модели, нормальные просьбы проходят', () => {
    for (const t of ['У мене болить зуб', 'болит десна', 'кровить після видалення', 'Скільки коштує чистка?', 'сколько стоит имплант', 'Який антибіотик пити', 'Буду скаржитися']) expect(incomingHandoff(t)).not.toBeNull();
    for (const t of ['Хочу записатися на чистку', 'Можна перенести на п’ятницю?', 'Добрий день', 'Скасуйте запис на завтра']) expect(incomingHandoff(t)).toBeNull();
  });

  it('прежнее опасное сообщение не отправляет все следующие человеку: смотрим только последнее', async () => {
    const assistant = app.get(ChatAssistantService);
    const c = await clinic();
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true }).expect(200);
    const say = async (text: string, direction = 'IN') => {
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'h1', direction, text } });
      await new Promise((r) => setTimeout(r, 15));
    };
    await say('сколько стоит чистка?');
    await say('Передаю ваш вопрос администратору', 'OUT');
    await say('мне пора на чистку?');
    fake.next = '{"intent":"info","reply":"Підкажіть, будь ласка, коли була остання чистка?"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'h1')).toMatchObject({ handoff: false, intent: 'info' });
  });

  it('фраза о передаче человеку — на языке пациента', () => {
    expect(handoffText('Добрий день, у мене болить зуб')).toContain('адміністратору');
    expect(handoffText('Здравствуйте, у меня болит зуб')).toContain('администратору клиники, он ответит');
    expect(handoffText('мне пора на чистку?')).toContain('администратору клиники, он ответит');
    expect(handoffText('Сколько стоит чистка?')).toContain('администратору клиники, он ответит');
    expect(handoffText('???')).toContain('адміністратору');
  });

  it('время в ответе должно лежать в посчитанных свободных окнах', () => {
    const w: [number, number][] = [[9 * 60, 12 * 60 + 30], [14 * 60, 18 * 60]];
    expect(timesOutsideWindows('Є 10:00 або 15:30', w)).toBe(false);
    expect(timesOutsideWindows('Є 13:00', w)).toBe(true);
    expect(timesOutsideWindows('Є 21:00', w)).toBe(true);
    expect(timesOutsideWindows('Який день вам зручний?', w)).toBe(false);
    expect(timesOutsideWindows('Приходьте о 10:00', [])).toBe(true);
  });

  it('ИИ получает свободные окна из расписания и не может назвать время вне их', async () => {
    const assistant = app.get(ChatAssistantService);
    const c = await clinic();
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true }).expect(200);
    const say = (chatId: string, text: string) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId, direction: 'IN', text } });

    await say('s1', 'Хочу записатися на чистку');
    fake.next = '{"intent":"booking","reply":"Можемо запропонувати 10:00"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 's1')).toMatchObject({ handoff: true, reason: 'reply_check' }); // окон нет: время называть нельзя
    expect(fake.system).toContain('Вільні вікна тобі невідомі');

    await prisma.cabinet.create({ data: { clinicId: c.clinicId, externalId: 'cab1', name: 'Терапія' } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: { mon: { from: '09:00', to: '20:00' }, tue: { from: '09:00', to: '20:00' }, wed: { from: '09:00', to: '20:00' }, thu: { from: '09:00', to: '20:00' }, fri: { from: '09:00', to: '20:00' }, sat: { from: '09:00', to: '20:00' }, sun: { from: '09:00', to: '20:00' } } } });
    fake.next = '{"intent":"booking","reply":"Можемо запропонувати 12:00"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 's1')).toMatchObject({ handoff: false, reply: 'Можемо запропонувати 12:00' });
    expect(fake.system).toContain('Орієнтовні вільні вікна');
    expect(fake.system).toMatch(/\d\d\.\d\d \(\d{4}-\d\d-\d\d\): (09:00|\d\d:\d\d)–20:00/);
    fake.next = '{"intent":"booking","reply":"Можемо запропонувати 23:00"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 's1')).toMatchObject({ handoff: true, reason: 'reply_check' });
  });

  it('ответ с суммой, дозировкой, лекарством или советом не пропускается', () => {
    for (const r of ['Чистка коштує 1200 грн', 'Прийміть 2 таблетки по 500 мг', 'Приймайте ібупрофен', 'Це схоже на діагноз пульпіт', 'Полощіть содовим розчином']) expect(replyViolates(r)).toBe(true);
    expect(replyViolates('Підкажіть, будь ласка, який день вам зручний?')).toBe(false);
    expect(parseModelJson('текст {"intent":"booking","reply":"Привіт"} ще')).toEqual({ intent: 'booking', reply: 'Привіт', summary: null, options: [] });
    expect(parseModelJson('не json')).toBeNull();
    expect(parseModelJson('{"intent":"booking"}')).toBeNull();
  });

  it('черновик: опасная тема не доходит до модели; ответ-нарушение заменяется передачей; доступ ограничен', async () => {
    const assistant = app.get(ChatAssistantService);
    const c = await clinic();
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true }).expect(200);
    const say = (chatId: string, text: string, direction = 'IN') => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId, direction, text } });

    await say('c1', 'У мене болить зуб');
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'c1')).toMatchObject({ handoff: true, reason: 'medical' });
    expect(fake.calls).toBe(0);

    await say('c2', 'Хочу записатися');
    fake.next = '{"intent":"booking","reply":"Добрий день! Який день вам зручний?"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'c2')).toMatchObject({ handoff: false, intent: 'booking', reply: 'Добрий день! Який день вам зручний?' });

    fake.next = '{"intent":"info","reply":"Чистка коштує 800 грн"}';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'c2')).toMatchObject({ handoff: true, reason: 'reply_check' });
    fake.next = 'це не json';
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'c2')).toMatchObject({ handoff: true, reason: 'model' });

    // затянувшийся диалог: больше 8 сообщений пациента за сутки
    for (let i = 0; i < 9; i++) await say('c3', `повідомлення ${i}`);
    const calls = fake.calls;
    expect(await assistant.draft(c.clinicId, 'TELEGRAM', 'c3')).toMatchObject({ handoff: true, reason: 'long' });
    expect(fake.calls).toBe(calls);

    // последним ответил сотрудник: отвечать нечего
    await say('c4', 'Привіт');
    await new Promise((r) => setTimeout(r, 20));
    await say('c4', 'Добрий день!', 'OUT');
    await expect(assistant.draft(c.clinicId, 'TELEGRAM', 'c4')).rejects.toMatchObject({ message: 'nothing_to_answer' });

    // HTTP: врачу нельзя, чужая клиника диалога не видит, выключенный ИИ не вызывается
    const other = await clinic();
    await http().post('/conversations/TELEGRAM/c2/draft').set(auth(other.token)).expect(404);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: false }).expect(200);
    await http().post('/conversations/TELEGRAM/c2/draft').set(auth(c.token)).expect(400);
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `d${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
    const doctor = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лікар', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().post('/conversations/TELEGRAM/c2/draft').set(auth(doctor)).expect(403);
  });
});

describe('ШІ сам отвечает пациентам в Telegram', () => {
  const TOKEN = '123456789:AAFakeTokenForAiTestsOnly_abcdefghijklmnop';
  const msg = (chatId: number, text: string) => ({ update_id: 1, message: { chat: { id: chatId }, from: { id: chatId, username: 'u', first_name: 'Олена' }, text } });

  async function setup(opts: { auto?: boolean; sending?: boolean; linked?: boolean; hygieneMonthsAgo?: number } = {}) {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true }).expect(200);
    if (opts.auto !== false) await http().patch('/ai').set(auth(c.token)).send({ autoReply: true }).expect(200);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: opts.sending !== false } });
    const chat = Math.floor(Math.random() * 1e9);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Секретна Прізвище', phone: '+380987001234' } });
    if (opts.linked !== false) await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: String(chat) } });
    if (opts.hygieneMonthsAgo !== undefined) {
      const at = new Date(Date.now() - opts.hygieneMonthsAgo * 30.4 * 86_400_000);
      await prisma.planItem.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Гігієна', status: 'DONE', groupName: 'Профілактика', createdAtExt: at, markedDoneAt: at } });
    }
    return { ...c, chat, p };
  }

  it('автоответ по умолчанию выключен; включается только при включённом ШІ; выключение ШІ выключает и его', async () => {
    const c = await clinic();
    expect((await http().get('/ai').set(auth(c.token))).body.autoReply).toBe(false);
    await http().patch('/ai').set(auth(c.token)).send({ autoReply: true }).expect(400);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, autoReply: true }).expect(200);
    expect((await http().get('/ai').set(auth(c.token))).body.autoReply).toBe(true);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: false }).expect(200);
    expect((await http().get('/ai').set(auth(c.token))).body).toMatchObject({ enabled: false, autoReply: false });
  });

  it('«мне пора на чистку?»: ШІ получает факты из базы (без имени и телефона), отвечает сам', async () => {
    const q = await setup({ hygieneMonthsAgo: 8 });
    fake.next = '{"intent":"info","reply":"За нашими даними, остання гігієна була близько 8 місяців тому. Запишемо вас?"}';
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'мне пора на чистку?'));
    expect(tg.sent).toEqual([{ chatId: String(q.chat), text: 'За нашими даними, остання гігієна була близько 8 місяців тому. Запишемо вас?' }]);
    expect(fake.system).toMatch(/гігієна[^\n]*~8 міс/);
    expect(fake.system).toContain('раз на 6 міс');
    expect(fake.system).not.toContain('Секретна');
    expect(fake.system).not.toContain('987001234');
    expect(await prisma.chatMessage.count({ where: { clinicId: q.clinicId, chatId: String(q.chat), byAi: true } })).toBe(1);
  });

  it('пациент не опознан: ШІ не видит историю и просит уточнить; опасная тема сразу уходит человеку', async () => {
    const q = await setup({ linked: false });
    fake.next = '{"intent":"info","reply":"Підкажіть, будь ласка, приблизно коли була чистка?"}';
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'мне пора на чистку?'));
    expect(fake.system).toContain('не ідентифіковано');
    expect(tg.sent).toHaveLength(1);

    const calls = fake.calls;
    tg.sent.length = 0;
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'У мене болить зуб'));
    expect(fake.calls).toBe(calls); // до модели не дошло
    expect(tg.sent[0].text).toContain('адміністратору');
  });

  it('выключены отправка или автоответ, сотрудник подхватил диалог, дневной лимит: ШІ молчит, остаётся обычный ответ', async () => {
    const off = await setup({ sending: false });
    await app.get(TelegramService).handleUpdate(off.clinicId, TOKEN, msg(off.chat, 'Хочу записатися'));
    expect(fake.calls).toBe(0);
    expect(tg.sent[0].text).toContain('отримано');

    const manual = await setup({ auto: false });
    tg.sent.length = 0;
    await app.get(TelegramService).handleUpdate(manual.clinicId, TOKEN, msg(manual.chat, 'Хочу записатися'));
    expect(fake.calls).toBe(0);

    const taken = await setup();
    await prisma.chatMessage.create({ data: { clinicId: taken.clinicId, patientId: taken.p.id, channel: 'TELEGRAM', chatId: String(taken.chat), direction: 'OUT', text: 'Добрий день, це адміністратор', authorUserId: 'someone' } });
    tg.sent.length = 0;
    await app.get(TelegramService).handleUpdate(taken.clinicId, TOKEN, msg(taken.chat, 'Хочу записатися'));
    expect(fake.calls).toBe(0);

    const busy = await setup();
    for (let i = 0; i < 6; i++) await prisma.chatMessage.create({ data: { clinicId: busy.clinicId, patientId: busy.p.id, channel: 'TELEGRAM', chatId: String(busy.chat), direction: 'OUT', text: `ШІ ${i}`, byAi: true } });
    await app.get(TelegramService).handleUpdate(busy.clinicId, TOKEN, msg(busy.chat, 'Хочу записатися'));
    expect(fake.calls).toBe(0);
  });
});

describe('кнопки со временем и заявки администратору', () => {
  const TOKEN = '123456789:AAFakeTokenForButtonsOnly_abcdefghijklmnop';
  const msg = (chatId: number, text: string) => ({ update_id: 1, message: { chat: { id: chatId }, from: { id: chatId, username: 'u', first_name: 'Олена' }, text } });
  const tomorrow = () => clinicDate(new Date(Date.now() + 86_400_000));

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, autoReply: true }).expect(200);
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true, workHours: Object.fromEntries(days.map((d) => [d, { from: '09:00', to: '20:00' }])) } });
    await prisma.cabinet.create({ data: { clinicId: c.clinicId, externalId: 'k1', name: 'Терапія' } });
    const chat = Math.floor(Math.random() * 1e9);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Кнопка Іван' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: String(chat) } });
    return { ...c, chat, p };
  }

  it('ШІ предлагает время кнопками, заявка администратору создаётся; нажатие кнопки обновляет заявку и благодарит', async () => {
    const q = await ready();
    fake.next = JSON.stringify({ intent: 'booking', reply: 'Оберіть, будь ласка, зручний час кнопкою нижче. Запис підтвердить адміністратор.', summary: 'Чистка, завтра вдень', options: [{ date: tomorrow(), time: '12:00' }, { date: tomorrow(), time: '15:30' }] });
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Хочу на чистку завтра'));
    const sent = tg.sent.at(-1)!;
    const kb = (sent.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard;
    expect(kb.map((r) => r[0].callback_data)).toEqual([`slot|${tomorrow()}|12:00`, `slot|${tomorrow()}|15:30`]);
    expect(kb[0][0].text).toMatch(/\d\d\.\d\d, 12:00$/);
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId } });
    expect(req).toMatchObject({ kind: 'BOOKING', status: 'NEW', summary: 'Чистка, завтра вдень', patientId: q.p.id, contactName: 'Олена' });

    tg.sent.length = 0;
    const [y, m, d] = tomorrow().split('-');
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, { update_id: 2, callback_query: { id: 'cb1', from: { id: q.chat }, message: { chat: { id: q.chat } }, data: `slot|${tomorrow()}|15:30` } });
    expect(tg.answered).toEqual(['cb1']);
    expect(tg.sent[0].text).toContain(`${d}.${m} 15:30`);
    expect(await prisma.bookingRequest.count({ where: { clinicId: q.clinicId } })).toBe(1); // та же заявка, не дубль
    expect((await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId } })).summary).toContain(`Обрано час: ${d}.${m} 15:30`);
    expect(y).toBeTruthy();
    // подделанные данные кнопки игнорируются
    tg.sent.length = 0;
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, { update_id: 3, callback_query: { id: 'cb2', from: { id: q.chat }, message: { chat: { id: q.chat } }, data: 'slot|абв|99' } });
    expect(tg.sent).toHaveLength(0);
  });

  it('время вне свободных окон: кнопок нет, пациент получает передачу человеку, администратору создаётся заявка', async () => {
    const q = await ready();
    fake.next = JSON.stringify({ intent: 'booking', reply: 'Оберіть час кнопкою.', summary: 'x', options: [{ date: tomorrow(), time: '23:00' }] });
    await app.get(TelegramService).handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Хочу на чистку завтра'));
    expect(tg.sent.at(-1)!.extra).toBeUndefined();
    expect(tg.sent.at(-1)!.text).toContain('адміністратору');
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId } })).toMatchObject({ kind: 'HANDOFF', status: 'NEW' });
  });

  it('список заявок, закрытие и права; чужая клиника заявок не видит', async () => {
    const q = await ready();
    await prisma.bookingRequest.create({ data: { clinicId: q.clinicId, channel: 'TELEGRAM', chatId: '1', kind: 'RESCHEDULE', summary: 'Перенести на п’ятницю' } });
    const list = (await http().get('/requests?status=NEW').set(auth(q.token)).expect(200)).body;
    expect(list.newCount).toBe(1);
    const id = list.rows[0].id;
    const inv = await http().post('/team/invitations').set(auth(q.token)).send({ email: `an${rnd()}@example.com`, role: 'ANALYST' }).expect(201);
    const analyst = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ан', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/requests').set(auth(analyst)).expect(200);
    await http().patch(`/requests/${id}`).set(auth(analyst)).send({ status: 'DONE' }).expect(403);
    await http().patch(`/requests/${id}`).set(auth(q.token)).send({ status: 'BAD' }).expect(400);
    const other = await clinic();
    expect((await http().get('/requests').set(auth(other.token))).body.rows).toHaveLength(0);
    await http().patch(`/requests/${id}`).set(auth(other.token)).send({ status: 'DONE' }).expect(404);
    await http().patch(`/requests/${id}`).set(auth(q.token)).send({ status: 'DONE' }).expect(200);
    expect((await http().get('/requests?status=NEW').set(auth(q.token))).body.newCount).toBe(0);
    expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DONE' });
  });
});

describe('служебный чат для заявок', () => {
  const TOKEN = '123456789:AAFakeTokenForStaffChatOnly_abcdefghijklmnop';
  const upd = (chatId: number, text: string, title?: string) => ({ update_id: 1, message: { chat: { id: chatId, type: title ? 'supergroup' : 'private', title }, from: { id: 42, username: 'admin', first_name: 'Адмін' }, text } });
  const tomorrow = () => clinicDate(new Date(Date.now() + 86_400_000));

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    return c;
  }

  it('чат привязывается одноразовым кодом: неверный и просроченный коды не работают; отключить и проверить может только владелец и управляющий', async () => {
    const c = await ready();
    const tgs = app.get(TelegramService);
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBeNull();

    const { code, command } = (await http().post('/automations/telegram/staff-chat').set(auth(c.token)).expect(201)).body;
    expect(command).toBe(`/chat ${code}`);
    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-1001, '/chat WRONG000', 'Адміністратори'));
    expect(tg.sent.at(-1)!.text).toContain('недійсний');
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBeNull();

    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-1001, `/chat@my_bot ${code.toLowerCase()}`, 'Адміністратори'));
    expect(tg.sent.at(-1)!.text).toContain('підключено');
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBe('Адміністратори');
    // код одноразовый
    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-1002, `/chat ${code}`, 'Інший'));
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBe('Адміністратори');

    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `st${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ад', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().post('/automations/telegram/staff-chat').set(auth(admin)).expect(403);
    await http().post('/automations/telegram/staff-chat/test').set(auth(admin)).expect(403);
    await http().delete('/automations/telegram/staff-chat').set(auth(admin)).expect(403);

    tg.sent.length = 0;
    expect((await http().post('/automations/telegram/staff-chat/test').set(auth(c.token)).expect(200)).body.sent).toBe(true);
    expect(tg.sent[0]).toMatchObject({ chatId: '-1001' });

    // просроченный код
    const second = (await http().post('/automations/telegram/staff-chat').set(auth(c.token)).expect(201)).body.code;
    const integ = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'TELEGRAM' } });
    const cfg = integ.config as { staffCode: { hash: string; expiresAt: number } };
    await prisma.integration.update({ where: { id: integ.id }, data: { config: { ...cfg, staffCode: { ...cfg.staffCode, expiresAt: Date.now() - 1000 } } } });
    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-1003, `/chat ${second}`, 'Опоздал'));
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBe('Адміністратори');

    await http().delete('/automations/telegram/staff-chat').set(auth(c.token)).expect(200);
    expect((await http().get('/automations').set(auth(c.token))).body.telegram.staffChat).toBeNull();
    tg.sent.length = 0;
    expect((await http().post('/automations/telegram/staff-chat/test').set(auth(c.token))).body.sent).toBe(false);
  });

  it('новая заявка и выбор времени приходят в служебный чат; сообщения из него не считаются пациентскими; уведомления не зависят от отправки пациентам', async () => {
    const c = await ready();
    const tgs = app.get(TelegramService);
    const code = (await http().post('/automations/telegram/staff-chat').set(auth(c.token))).body.code;
    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-2001, `/chat ${code}`, 'Заявки'));

    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, autoReply: true }).expect(200);
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true, workHours: Object.fromEntries(days.map((d) => [d, { from: '09:00', to: '20:00' }])) } });
    await prisma.cabinet.create({ data: { clinicId: c.clinicId, externalId: 'k1', name: 'Терапія' } });
    const chat = Math.floor(Math.random() * 1e9);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Сповіщення Марія', phone: '+380501112233' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: String(chat) } });

    tg.sent.length = 0;
    fake.next = JSON.stringify({ intent: 'booking', reply: 'Оберіть час кнопкою.', summary: 'Чистка завтра вдень', options: [{ date: tomorrow(), time: '12:00' }] });
    await tgs.handleUpdate(c.clinicId, TOKEN, { update_id: 5, message: { chat: { id: chat }, from: { id: chat, first_name: 'Марія' }, text: 'Хочу на чистку' } });
    const note = tg.sent.find((s) => s.chatId === '-2001')!;
    expect(note.text).toContain('Нова заявка: Запис');
    expect(note.text).toContain('Сповіщення Марія, +380501112233');
    expect(note.text).toContain('Чистка завтра вдень');
    expect(note.text).toContain('/inbox');

    tg.sent.length = 0;
    await tgs.handleUpdate(c.clinicId, TOKEN, { update_id: 6, callback_query: { id: 'x', from: { id: chat }, message: { chat: { id: chat } }, data: `slot|${tomorrow()}|12:00` } });
    expect(tg.sent.find((s) => s.chatId === '-2001')!.text).toContain('Оновлення заявки');
    expect(tg.sent.find((s) => s.chatId === '-2001')!.text).toContain('Обрано час');

    // сообщение в служебном чате: ничего не сохраняется и бот не отвечает
    tg.sent.length = 0;
    const before = await prisma.chatMessage.count({ where: { clinicId: c.clinicId } });
    await tgs.handleUpdate(c.clinicId, TOKEN, upd(-2001, 'Привіт, команда', 'Заявки'));
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(before);
    expect(tg.sent).toHaveLength(0);

    // отправка пациентам выключена: заявка всё равно сообщается сотрудникам
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'zz', kind: 'CANCEL', summary: 'x' } });
    // прямое создание строки не уведомляет (уведомляет сервис при upsert); проверяем через сервис
    const svc = app.get((await import('../src/automations/requests.service')).RequestsService);
    await svc.upsert(c.clinicId, { channel: 'TELEGRAM', chatId: 'zz2', patientId: null, contactName: 'Хтось', kind: 'HANDOFF', summary: 'Питання' });
    expect(tg.sent.find((s) => s.chatId === '-2001')!.text).toContain('Потрібна відповідь людини');
  });
});

describe('окна по врачам (клиники со сменами)', () => {
  const TOKEN = '123456789:AAFakeTokenForDoctorsOnly_abcdefghijklmnop';
  const tomorrow = () => clinicDate(new Date(Date.now() + 86_400_000));

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, autoReply: true }).expect(200);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true } });
    const { localToUtc } = await import('../src/common/clinic-time');
    const day = tomorrow();
    await prisma.shift.create({ data: { clinicId: c.clinicId, externalId: 'sh1', doctorId: 'd1', doctorName: 'Петренко Олег', cabinetId: 'k1', cabinetName: 'Терапія', startsAt: localToUtc(`${day} 10:00:00`), endsAt: localToUtc(`${day} 14:00:00`) } });
    await prisma.shift.create({ data: { clinicId: c.clinicId, externalId: 'sh2', doctorId: 'd2', doctorName: 'Сидоренко Анна', cabinetId: 'k2', cabinetName: 'Хірургія', startsAt: localToUtc(`${day} 15:00:00`), endsAt: localToUtc(`${day} 19:00:00`) } });
    const chat = Math.floor(Math.random() * 1e9);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Лікарі Тест' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: String(chat) } });
    return { ...c, chat };
  }
  const msg = (chat: number, text: string) => ({ update_id: 1, message: { chat: { id: chat }, from: { id: chat }, text } });
  const reply = (opts: object[]) => JSON.stringify({ intent: 'booking', reply: 'Оберіть час кнопкою.', summary: 'Чистка', options: opts });

  it('ШІ видит окна по врачам; вариант с врачом проверяется по его смене; врач попадает в кнопку и в заявку', async () => {
    const q = await ready();
    const tgs = app.get(TelegramService);
    fake.next = reply([{ date: tomorrow(), time: '11:00' }]);
    await tgs.handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Хочу на чистку завтра'));
    expect(fake.system).toContain('Будь-який лікар:');
    expect(fake.system).toContain('Лікар Петренко Олег:');
    expect(fake.system).toContain('Лікар Сидоренко Анна:');
    expect(tg.sent.at(-1)!.extra).toBeDefined(); // общий вариант 11:00 есть у любого врача (у Петренка)

    tg.sent.length = 0;
    fake.next = reply([{ date: tomorrow(), time: '11:00', doctor: 'Сидоренко Анна' }]); // у Сидоренко в 11:00 смены нет
    await tgs.handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Хочу до Сидоренко завтра зранку'));
    expect(tg.sent.at(-1)!.extra).toBeUndefined();
    expect(tg.sent.at(-1)!.text).toContain('адміністратору');

    tg.sent.length = 0;
    fake.next = reply([{ date: tomorrow(), time: '16:00', doctor: 'Сидоренко Анна' }]);
    await tgs.handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Хочу до Сидоренко завтра ввечері'));
    const kb = (tg.sent.at(-1)!.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard;
    expect(kb[0][0].text).toContain('· Сидоренко');
    expect(kb[0][0].callback_data).toBe(`slot|${tomorrow()}|16:00|Сидоренко Анна`);
    expect(Buffer.byteLength(kb[0][0].callback_data)).toBeLessThanOrEqual(64);

    await tgs.handleUpdate(q.clinicId, TOKEN, { update_id: 9, callback_query: { id: 'd1', from: { id: q.chat }, message: { chat: { id: q.chat } }, data: kb[0][0].callback_data } });
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId, kind: 'BOOKING' } });
    expect(req.summary).toContain('лікар Сидоренко Анна');
  });
});

describe('ШІ-помічник керівника: вопрос → отчёт', () => {
  async function ready(enabled = true) {
    const c = await clinic();
    await http().patch('/ai').set(auth(c.token)).send({ assistant: enabled }).expect(200);
    const mk = (name: string, over: Record<string, unknown>) => prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: name, ...over } });
    await mk('Секретна Людина Один', { source: 'Instagram', lastVisitAt: new Date(Date.now() - 400 * 86_400_000), balanceIssued: 3000, balancePaid: 1000 });
    await mk('Секретна Людина Два', { source: 'Google', lastVisitAt: new Date(Date.now() - 10 * 86_400_000) });
    return c;
  }
  const ask = (token: string, question: string, history: object[] = []) => http().post('/assistant/ask').set(auth(token)).send({ question, history });
  const J = (o: object) => JSON.stringify(o);

  it('по умолчанию выключен; включает владелец; без ключа включить нельзя', async () => {
    const c = await ready(false);
    await ask(c.token, 'покажи пацієнтів, які давно не були').expect(400);
    fake.configured = false;
    await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(400);
    fake.configured = true;
    await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(200);
    expect((await http().get('/ai').set(auth(c.token))).body.assistant).toBe(true);
    expect(fake.calls).toBe(0);
  });

  it('вопрос превращается в описание отчёта, считает код; в модель уходят каталог и вопрос, но не люди', async () => {
    const c = await ready();
    fake.next = J({ answer: 'Побудував список пацієнтів без візитів понад рік.', title: 'Давно не були', spec: { dataset: 'patients', columns: ['patientName', 'lastVisitAt', 'debt'], filters: [{ field: 'lastVisitAt', op: 'lte', value: '-365d' }] } });
    const res = (await ask(c.token, 'покажи пацієнтів, які не були понад рік').expect(200)).body;
    expect(res.report.rows).toHaveLength(1);
    expect(res.report.rows[0].patientName).toBe('Секретна Людина Один');
    expect(res.report.rows[0].debt).toBe(2000);
    expect(res.title).toBe('Давно не були');
    expect(res.answer).toContain('Знайдено рядків: 1');
    expect(fake.calls).toBe(1); // список людей не пояснюється моделью
    expect(JSON.stringify(fake.turns)).not.toContain('Секретна');
    expect(fake.systems[0]).toContain('debt');
  });

  it('итоги поясняются по числам; группировка по человеку не передаётся модели; ошибочное описание исправляется с подсказкой', async () => {
    const c = await ready();
    fake.seq = [
      J({ answer: 'Порахував пацієнтів за джерелами.', title: 'Джерела', spec: { dataset: 'patients', groupBy: { field: 'source' }, aggregates: [{ fn: 'count' }] } }),
      'Найбільше пацієнтів з Instagram та Google порівну.',
    ];
    const res = (await ask(c.token, 'скільки пацієнтів по джерелах').expect(200)).body;
    expect(res.answer).toBe('Найбільше пацієнтів з Instagram та Google порівну.');
    expect(fake.turns[1][0].content).toContain('Instagram');
    expect(fake.turns[1][0].content).not.toContain('Секретна');

    fake.calls = 0;
    fake.seq = [
      J({ answer: 'Ок', title: 'x', spec: { dataset: 'patients', groupBy: { field: 'patientName' }, aggregates: [{ fn: 'count' }] } }),
    ];
    fake.systems.length = 0;
    fake.turns.length = 0;
    const personal = (await ask(c.token, 'порахуй по пацієнтах').expect(200)).body;
    expect(personal.answer).toContain('Знайдено рядків: 2'); // без пояснення моделью
    expect(fake.calls).toBe(1);

    fake.calls = 0;
    fake.turns.length = 0;
    fake.seq = [
      J({ answer: 'Спроба', title: 'x', spec: { dataset: 'patients', columns: ['nonexistent'] } }),
      J({ answer: 'Виправив', title: 'Виправлено', spec: { dataset: 'patients', columns: ['patientName'] } }),
    ];
    const fixed = (await ask(c.token, 'покажи пацієнтів').expect(200)).body;
    expect(fixed.report.rows).toHaveLength(2);
    expect(fake.calls).toBe(2);
    expect(fake.turns[1].at(-1)!.content).toContain('field: nonexistent'); // причина ошибки показана модели

    fake.calls = 0;
    fake.seq = [J({ spec: { dataset: 'patients', columns: ['zzz'] }, answer: 'a' }), J({ spec: { dataset: 'patients', columns: ['zzz'] }, answer: 'a' }), J({ spec: { dataset: 'patients', columns: ['zzz'] }, answer: 'a' })];
    const failed = (await ask(c.token, 'щось незрозуміле').expect(200)).body;
    expect(failed.report).toBeNull();
    expect(failed.answer).toContain('Не вдалося');
    expect(fake.calls).toBe(3);
  });

  it('вопрос не по данным получает вежливый отказ без отчёта; итог без группировки работает; роли и лимит', async () => {
    const c = await ready();
    fake.next = J({ answer: 'Я будую звіти за даними клініки, наприклад: «скільки пацієнтів».', title: null, spec: null });
    const off = (await ask(c.token, 'розкажи анекдот').expect(200)).body;
    expect(off.report).toBeNull();
    expect(off.spec).toBeNull();

    fake.seq = [J({ answer: 'Загальна кількість.', title: 'Усього', spec: { dataset: 'patients', aggregates: [{ fn: 'count' }, { fn: 'sum', field: 'balanceIssued' }] } }), 'Усього два пацієнти.'];
    const total = (await ask(c.token, 'скільки всього пацієнтів і на яку суму виставлено').expect(200)).body;
    expect(total.report.rows).toEqual([{ a0: 2, a1: 3000 }]);

    // администратору деньги недоступны: в каталоге модели их нет, а описание с деньгами отклоняется
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `ad${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ад', password: PASSWORD }).expect(201)).body.accessToken as string;
    fake.systems.length = 0;
    fake.next = J({ answer: 'Ок', title: 'x', spec: { dataset: 'patients', columns: ['patientName', 'debt'] } });
    const denied = (await ask(admin, 'покажи борги').expect(200)).body;
    expect(denied.report).toBeNull();
    expect(fake.systems[0]).not.toContain('debt');
    const doctorInv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `dc${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
    const doctor = (await http().post(`/invites/${(doctorInv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лік', password: PASSWORD }).expect(201)).body.accessToken as string;
    await ask(doctor, 'покажи пацієнтів').expect(403);

    // чужая клиника: свои данные, отчёт считается только по её пациентам
    const other = await ready();
    fake.next = J({ answer: 'Ок', title: 't', spec: { dataset: 'patients', columns: ['patientName'] } });
    expect((await ask(other.token, 'покажи пацієнтів').expect(200)).body.report.rows).toHaveLength(2);
    await prisma.patient.deleteMany({ where: { clinicId: other.clinicId } });
    expect((await ask(other.token, 'покажи пацієнтів').expect(200)).body.report.rows).toHaveLength(0);

    // месячный лимит
    await http().patch('/ai').set(auth(c.token)).send({ enabled: true, monthlyLimit: 0 }).expect(200);
    await ask(c.token, 'покажи пацієнтів').expect(400);
  });
});
