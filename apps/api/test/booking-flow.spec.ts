import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BookingFlowService, confirmationText, parseLabeledNames, parsePhone, singleNameWord } from '../src/automations/booking-flow.service';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService, SendError } from '../src/automations/messenger.service';
import { BookingService } from '../src/booking/booking.service';
import { clinicDate, clinicHm } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(120_000);

let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

// Every message the bot sends is recorded here instead of going to a messenger; a failure can be switched on
const sent: { clinicId: string; chatId: string; text: string; options: { date: string; time: string; label?: string; payload?: string }[] }[] = [];
let sendFail: SendError | null = null;
// The free schedule is faked: one open cabinet on the day of the test
let freeRows: Record<string, unknown>[] = [];

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (clinicId: string, _channel: string, chatId: string, text: string, options = []) => {
    if (sendFail) throw sendFail;
    sent.push({ clinicId, chatId, text, options });
  });
  jest.spyOn(app.get(ReportsService), 'freeSlots').mockImplementation(async () => freeRows as never);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
});
beforeEach(() => {
  sent.length = 0;
  sendFail = null;
  mock.writes.length = 0;
  mock.control.failWith = undefined;
  mock.control.dropReplyAfterWrite = false;
});

// A day far enough from the made-up visits of the mock (they end 60 days ahead at most); the clinic-local date and time of the slot
let dayOffset = 150;
const nextSlot = () => {
  const d = new Date(Date.now() + ++dayOffset * 86_400_000);
  d.setUTCHours(8, 0, 0, 0);
  return { at: d, date: clinicDate(d), time: clinicHm(d) };
};
const fmt = (ymd: string) => ymd.split('-').reverse().join('.');

async function register() {
  const email = `f${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true } });
  return { token: res.body.accessToken as string, clinicId };
}
// A clinic connected to the mock Cliniccards, with writing switched on by the service owner (here directly)
async function synced(opts: { auto: boolean; write?: boolean }) {
  const c = await register();
  await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(c.token)).expect(201);
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: opts.write ?? true, aiAutoBooking: opts.auto, ...(opts.auto ? { plan: 'PRO' } : {}) } }); // the bot's own booking is a Pro feature (2026-11-23)
  // the length of a visit comes from the approved reference; it is never guessed
  await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 45, active: true, approvedAt: new Date() } });
  const patients = await prisma.patient.findMany({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' }, take: 2 });
  const cabinet = await prisma.cabinet.findFirstOrThrow({ where: { clinicId: c.clinicId }, orderBy: { externalId: 'asc' } });
  return { ...c, patients, cabinet };
}
// One open place on the day, with a doctor and the cabinet of a real shift of the clinic (Cliniccards requires a doctor for every visit)
const openFree = async (day: string, clinicId: string) => {
  const shift = await prisma.shift.findFirstOrThrow({ where: { clinicId }, orderBy: { doctorId: 'asc' } });
  freeRows = [{ dayAt: day, doctor: shift.doctorName, cabinet: shift.cabinetName, freeMinutes: 600, windows: '08:00–18:00' }];
};
const link = (clinicId: string, patientId: string, chatId: string) => prisma.patientChannel.create({ data: { clinicId, patientId, channel: 'INSTAGRAM', externalId: chatId } });

let mid = 0;
const intake = () => app.get(IntakeService);
const say = (clinicId: string, chatId: string, text: string) => intake().handle(clinicId, { channel: 'INSTAGRAM', chatId, mid: `m${++mid}${rnd()}`, text, name: 'Гість' });
const tap = (clinicId: string, chatId: string, s: { date: string; time: string }) => intake().handle(clinicId, { channel: 'INSTAGRAM', chatId, mid: null, text: '', payload: `slot|${s.date}|${s.time}`, name: 'Гість' });
const last = () => sent[sent.length - 1];
const requestOf = (clinicId: string) => prisma.bookingRequest.findFirstOrThrow({ where: { clinicId }, orderBy: { createdAt: 'desc' } });

describe('розбір імені й телефону з вільного тексту', () => {
  it('прізвище й ім’я розрізняються лише за явними підписами або окремими відповідями, ніколи за порядком слів; телефон розпізнається в різних записах', () => {
    expect(parsePhone('097 123 45 67')).toBe('380971234567');
    expect(parsePhone('мій номер +38 (097) 123-45-67')).toBe('380971234567');
    expect(parsePhone('Ірина Коваль')).toBeNull();
    expect(parseLabeledNames('Прізвище Коваль, ім’я Ірина, телефон 0971234567')).toEqual({ lastName: 'Коваль', firstName: 'Ірина' });
    expect(parseLabeledNames('фамилия Ковалёв имя Ирина')).toEqual({ lastName: 'Ковалёв', firstName: 'Ирина' });
    expect(parseLabeledNames("ім'я: Ірина")).toEqual({ firstName: 'Ірина' });
    // two bare words are NOT split into surname and first name, in either order
    expect(parseLabeledNames('Ірина Коваль')).toEqual({});
    expect(parseLabeledNames('Коваль Ірина')).toEqual({});
    expect(singleNameWord('коваль')).toBe('Коваль');
    expect(singleNameWord('Коваль.')).toBe('Коваль');
    expect(singleNameWord('Ірина Коваль')).toBeNull();
    expect(singleNameWord('не знаю')).toBeNull();
    expect(singleNameWord('так')).toBeNull();
    expect(singleNameWord('097 123 45 67')).toBeNull();
  });
  it('підтвердження містить лише відомі дані, без вигаданого', () => {
    const at = new Date('2026-11-20T09:30:00Z');
    const full = confirmationText('uk', { service: 'Чистка', startsAt: at, doctor: 'Коваль Марія', clinic: 'Клініка Тест', address: 'вул. Тестова, 1' });
    expect(full).toBe(`Ваш запис підтверджено ✅\nПослуга: Чистка\nДата: 20.11.2026\nЧас: 11:30\nЛікар: Коваль Марія\nКлініка: Клініка Тест\nАдреса: вул. Тестова, 1`);
    const bare = confirmationText('uk', { service: null, startsAt: at, doctor: null, clinic: 'Клініка Тест', address: null });
    expect(bare).not.toMatch(/Послуга|Лікар|Адреса/);
    expect(confirmationText('ru', { service: null, startsAt: at, doctor: null, clinic: 'К', address: null })).toContain('Ваша запись подтверждена');
  });
});

describe('режим «Заявка адміністратору»', () => {
  it('новий пацієнт: бот питає прізвище, ім’я й телефон окремо, не вгадує їх за порядком слів, збирає одну заявку й лише тоді каже, що передав її', async () => {
    const c = await register();
    const s = nextSlot();
    const chat = `ig${rnd()}`;
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'Чистка, наступного тижня', service: 'Чистка' } });

    await tap(c.clinicId, chat, s);
    expect(last().text).toContain('прізвище, ім’я та номер телефону');
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Передали');
    expect(await requestOf(c.clinicId)).toMatchObject({ stage: 'COLLECT', service: 'Чистка', lastName: null, firstName: null, phone: null });

    // two bare words are not split by their order: ONE short clarification (never a guess), an answer that is neither of the two words is asked again
    await say(c.clinicId, chat, 'Ірина Коваль');
    expect(last().text).toContain('що з цього прізвище — «Ірина» чи «Коваль»');
    expect(await requestOf(c.clinicId)).toMatchObject({ lastName: null, firstName: null });
    await say(c.clinicId, chat, 'Іванов');
    expect(last().text).toContain('що з цього прізвище — «Ірина» чи «Коваль»');
    expect(await requestOf(c.clinicId)).toMatchObject({ lastName: null, firstName: null });
    await say(c.clinicId, chat, 'Коваль');
    expect(last().text).toContain('номер телефону');
    expect(await requestOf(c.clinicId)).toMatchObject({ stage: 'COLLECT', lastName: 'Коваль', firstName: 'Ірина' });

    const before = sent.length;
    await say(c.clinicId, chat, phone());
    expect(sent.length).toBe(before + 1);
    expect(last().text).toBe(`Дякуємо! Передали заявку на Чистка на ${fmt(s.date)} о ${s.time} адміністратору. Очікуйте підтвердження запису.`);
    const req = await requestOf(c.clinicId);
    expect(req).toMatchObject({ stage: 'READY', status: 'NEW', lastName: 'Коваль', firstName: 'Ірина', fullName: 'Коваль Ірина', channel: 'INSTAGRAM', chatId: chat, doctor: null });
    expect(req.summary).toContain('прізвище Коваль, ім’я Ірина');
    expect(req.slotAt?.getTime()).toBe(s.at.getTime());
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);

    // a repeated tap of the same time does not repeat the message or the request
    const n = sent.length;
    await tap(c.clinicId, chat, s);
    expect(sent.length).toBe(n);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);
    // no write to Cliniccards, no visit
    expect(mock.writes).toHaveLength(0);
  });

  it('усе одним повідомленням із підписаними полями: ніяких додаткових питань', async () => {
    const c = await register();
    const s = nextSlot();
    const chat = `ig${rnd()}`;
    await tap(c.clinicId, chat, s);
    await say(c.clinicId, chat, `Прізвище Бойко, ім’я Наталія, телефон ${phone()}`);
    expect(await requestOf(c.clinicId)).toMatchObject({ stage: 'READY', lastName: 'Бойко', firstName: 'Наталія', fullName: 'Бойко Наталія' });
    expect(last().text).toContain('Передали заявку');
  });

  it('пацієнт розпізнаний і дані є: нічого не питаємо, дані не вимагаємо вдруге; телефон з розмови не відкриває історію чужої картки', async () => {
    const c = await synced({ auto: false });
    const known = c.patients[0];
    const chat = `ig${rnd()}`;
    await link(c.clinicId, known.id, chat);
    const s = nextSlot();
    await tap(c.clinicId, chat, s);
    expect(sent).toHaveLength(1);
    expect(last().text).toContain(`${fmt(s.date)} о ${s.time}`);
    expect(await requestOf(c.clinicId)).toMatchObject({ stage: 'READY', patientId: known.id });

    // a stranger types the phone of an existing card: the chat is NOT linked to that card, the phone only goes into the request
    const other = c.patients[1];
    const chat2 = `ig${rnd()}`;
    await prisma.bookingRequest.deleteMany({ where: { clinicId: c.clinicId } });
    await tap(c.clinicId, chat2, nextSlot());
    await say(c.clinicId, chat2, `Прізвище Особа, ім’я Тест, телефон ${other.phone}`);
    expect(await prisma.patientChannel.count({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', externalId: chat2 } })).toBe(0);
    expect(await requestOf(c.clinicId)).toMatchObject({ patientId: null, stage: 'READY' });
  });

  it('сказати нічого корисного кілька разів: заявка передається з тим, що є, і повідомлення не залишається без відповіді', async () => {
    const c = await register();
    const chat = `ig${rnd()}`;
    await tap(c.clinicId, chat, nextSlot());
    for (let i = 0; i < 7; i++) await say(c.clinicId, chat, 'не знаю');
    expect(await requestOf(c.clinicId)).toMatchObject({ stage: 'READY', fullName: null, phone: null });
    expect((await requestOf(c.clinicId)).summary).toContain('ПІБ не отримано');
  });

  it('адміністратор підтверджує з уточненим часом: клієнт отримує фактичні дані один раз; повтор і два одночасні кліки не дублюють повідомлення; запису в Cliniccards немає', async () => {
    const c = await register();
    const chat = `ig${rnd()}`;
    const s = nextSlot();
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    await tap(c.clinicId, chat, s);
    await say(c.clinicId, chat, `Прізвище Сидоренко, ім’я Олена, телефон ${phone()}`);
    const req = await requestOf(c.clinicId);
    sent.length = 0;

    // the administrator booked another time (the form is prefilled with the chosen one and can be changed)
    const actual = { date: s.date, time: '14:30', service: 'Консультація стоматолога', doctor: 'Коваль Марія' };
    const [a, b] = await Promise.all([
      http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send(actual),
      http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send(actual),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.alreadyConfirmed, b.body.alreadyConfirmed].sort()).toEqual([false, true]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`Дата: ${fmt(s.date)}`);
    expect(sent[0].text).toContain('Час: 14:30');
    expect(sent[0].text).toContain('Послуга: Консультація стоматолога');
    expect(sent[0].text).toContain('Лікар: Коваль Марія');
    expect(sent[0].text).not.toContain(`Час: ${s.time}`);
    const done = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(done).toMatchObject({ status: 'DONE', confirmedBy: 'ADMIN', confirmSource: 'MANUAL', noticeStatus: 'SENT' });
    // the message and its result are kept in the conversation
    const msg = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: `bookconfirm:${req.id}` } });
    expect(msg).toMatchObject({ direction: 'OUT', error: null });
    expect(msg.text).toBe(sent[0].text);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking_request.confirmed' } })).toBe(1);

    // a later click, a repeated request: nothing more is sent
    await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ ...actual, time: '16:00' }).expect(200);
    await http().post(`/requests/${req.id}/notice/retry`).set(auth(c.token)).send({}).expect(200);
    expect(sent).toHaveLength(1);
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).confirmedStartsAt?.getTime()).toBe(done.confirmedStartsAt?.getTime());
    // nothing was written to the clinic's system and no booking attempt exists
    expect(mock.writes).toHaveLength(0);
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId } })).toBe(0);
  });

  it('помилка доставки: запис лишається підтвердженим, видно причину, безпечний повтор надсилає рівно один раз', async () => {
    const c = await register();
    const chat = `ig${rnd()}`;
    const s = nextSlot();
    await tap(c.clinicId, chat, s);
    await say(c.clinicId, chat, `Прізвище Петренко, ім’я Марія, телефон ${phone()}`);
    const req = await requestOf(c.clinicId);
    sent.length = 0;

    sendFail = new SendError('window_closed', true, 'window_closed');
    const r = await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
    expect(r.body).toMatchObject({ status: 'DONE', noticeStatus: 'FAILED', noticeError: 'window_closed' });
    expect(sent).toHaveLength(0);
    const failedMsg = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: `bookconfirm:${req.id}` } });
    expect(failedMsg.error).toBe('window_closed');

    // the retry while the channel still refuses leaves it failed; the retry after that delivers once
    await http().post(`/requests/${req.id}/notice/retry`).set(auth(c.token)).send({}).expect(200);
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).noticeStatus).toBe('FAILED');
    sendFail = null;
    const ok = await http().post(`/requests/${req.id}/notice/retry`).set(auth(c.token)).send({}).expect(200);
    expect(ok.body.noticeStatus).toBe('SENT');
    expect(sent).toHaveLength(1);
    await http().post(`/requests/${req.id}/notice/retry`).set(auth(c.token)).send({}).expect(200);
    expect(sent).toHaveLength(1);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, externalId: `bookconfirm:${req.id}` } })).toBe(1);
  });

  it('вимкнена відправка: підтвердження збережено, повідомлення пропущено з причиною, після ввімкнення повтор його надсилає', async () => {
    const c = await register();
    const chat = `ig${rnd()}`;
    const s = nextSlot();
    await tap(c.clinicId, chat, s);
    await say(c.clinicId, chat, `Прізвище Петренко, ім’я Марія, телефон ${phone()}`);
    const req = await requestOf(c.clinicId);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
    sent.length = 0;
    const r = await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
    expect(r.body).toMatchObject({ status: 'DONE', noticeStatus: 'SKIPPED', noticeError: 'sending_off' });
    expect(sent).toHaveLength(0);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true } });
    expect((await http().post(`/requests/${req.id}/notice/retry`).set(auth(c.token)).send({}).expect(200)).body.noticeStatus).toBe('SENT');
    expect(sent).toHaveLength(1);
  });

  it('підтвердження прив’язується до фактичного запису в Cliniccards (лише читання); без нього адміністратор підтверджує вручну', async () => {
    const c = await synced({ auto: false });
    const known = c.patients[0];
    const chat = `ig${rnd()}`;
    await link(c.clinicId, known.id, chat);
    const s = nextSlot();
    await tap(c.clinicId, chat, s);
    const req = await requestOf(c.clinicId);
    // the administrator entered the visit in Cliniccards (here: through the staff booking of the mock), then presses the button
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true } });
    await app.get(BookingService).book(c.clinicId, 'staff', { patientId: known.id, startsAt: s.at, durationMin: 30, cabinetId: c.cabinet.externalId, doctorId: '501' });
    mock.writes.length = 0;
    const m = await http().get(`/requests/${req.id}/match`).set(auth(c.token)).expect(200);
    expect(m.body).toMatchObject({ found: true, source: 'cliniccards' });
    expect(m.body.visits[0]).toMatchObject({ date: s.date, time: s.time });
    const r = await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
    expect(r.body).toMatchObject({ confirmSource: 'CLINICCARDS', noticeStatus: 'SENT' });
    expect((await requestOf(c.clinicId)).externalVisitId).toBeTruthy();
    // the button itself wrote nothing
    expect(mock.writes).toHaveLength(0);

    // another time that is not in Cliniccards: manual confirmation
    const s2 = nextSlot();
    await prisma.bookingRequest.update({ where: { id: req.id }, data: { confirmedAt: null } });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'y', patientId: known.id, slotAt: s2.at } });
    const second = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, confirmedAt: null, kind: 'BOOKING', slotAt: s2.at } });
    expect((await http().post(`/requests/${second.id}/confirm`).set(auth(c.token)).send({ date: s2.date, time: s2.time }).expect(200)).body.confirmSource).toBe('MANUAL');
  });

  it('некоректні дані підтвердження відхиляються; підтвердження чужої клініки неможливе', async () => {
    const a = await register();
    const b = await register();
    const chat = `ig${rnd()}`;
    const s = nextSlot();
    await tap(a.clinicId, chat, s);
    const req = await requestOf(a.clinicId);
    await http().post(`/requests/${req.id}/confirm`).set(auth(a.token)).send({ date: 'вчора', time: '10:00' }).expect(400);
    await http().post(`/requests/${req.id}/confirm`).set(auth(a.token)).send({ date: '2020-01-01', time: '10:00' }).expect(400);
    await http().post(`/requests/${req.id}/confirm`).set(auth(a.token)).send({ date: s.date, time: '25:99' }).expect(400);
    await http().post(`/requests/${req.id}/confirm`).set(auth(b.token)).send({ date: s.date, time: s.time }).expect(404);
    await http().get(`/requests/${req.id}/match`).set(auth(b.token)).expect(404);
    await http().post(`/requests/${req.id}/notice/retry`).set(auth(b.token)).send({}).expect(404);
    expect((await requestOf(a.clinicId)).confirmedAt).toBeNull();
  });
});

describe('режим автоматичного запису (на імітації Cliniccards)', () => {
  it('новий пацієнт: після даних створюється картка й запис, підтвердження йде лише після успішної відповіді Cliniccards, з фактичним часом', async () => {
    const c = await synced({ auto: true });
    const s = nextSlot();
    await openFree(s.date, c.clinicId);
    const chat = `ig${rnd()}`;
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    await tap(c.clinicId, chat, s);
    expect(mock.writes).toHaveLength(0);
    expect(last().text).toContain('номер телефону');
    await say(c.clinicId, chat, `Прізвище Бойко, ім’я Наталія, телефон ${phone()}`);
    // nothing is written until the person says yes in so many words
    expect(last().text).toContain('Підтверджуєте запис на Консультація');
    expect(last().options.map((o) => o.label)).toEqual(['Так, підтверджую', 'Ні, інший час']);
    expect(mock.writes).toHaveLength(0);
    await say(c.clinicId, chat, 'так');

    expect(mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits')).toHaveLength(1);
    const req = await requestOf(c.clinicId);
    expect(req).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', confirmSource: 'AUTO', autoState: 'DONE', noticeStatus: 'SENT' });
    expect(req.externalVisitId).toBeTruthy();
    expect(last().text).toContain('Ваш запис підтверджено ✅');
    expect(last().text).toContain(`Дата: ${fmt(s.date)}`);
    expect(last().text).toContain(`Час: ${s.time}`);
    expect(sent.filter((m) => m.text.includes('підтверджено'))).toHaveLength(1);
    expect(await prisma.patientChannel.count({ where: { clinicId: c.clinicId, patientId: req.patientId!, channel: 'INSTAGRAM' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking_request.confirmed' } })).toBe(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'booking_request.confirmed' } })).details).toMatchObject({ by: 'auto' });
    // a repeated tap or message does not book or tell again
    const n = sent.length;
    await tap(c.clinicId, chat, s);
    expect(sent.length).toBe(n);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(1);
  });

  it('вибраний час зайнятий: запису немає, клієнт отримує актуальні варіанти, а не «ви записані»', async () => {
    const c = await synced({ auto: true });
    const [known, other] = c.patients;
    const chat = `ig${rnd()}`;
    await link(c.clinicId, known.id, chat);
    const s = nextSlot();
    await openFree(s.date, c.clinicId);
    // somebody else got the place first (the schedule we offered from is a little behind)
    await app.get(BookingService).book(c.clinicId, 'staff', { patientId: other.id, startsAt: s.at, durationMin: 30, cabinetId: c.cabinet.externalId, doctorId: '501' });
    mock.writes.length = 0;
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    await tap(c.clinicId, chat, s);
    expect(last().text).toContain('Підтверджуєте запис');
    expect(mock.writes).toHaveLength(0);
    await say(c.clinicId, chat, 'так');
    expect(mock.writes).toHaveLength(0);
    expect(last().text).toContain('зайнятий');
    expect(last().text).not.toContain('підтверджено');
    expect(last().options.length).toBeGreaterThan(0);
    expect(await requestOf(c.clinicId)).toMatchObject({ status: 'NEW', stage: 'NONE', slotAt: null, confirmedAt: null });
  });

  it('відповідь Cliniccards загубилась: спершу перевіряється, чи є запис, дубля немає, підтвердження одне', async () => {
    const c = await synced({ auto: true });
    const known = c.patients[0];
    const chat = `ig${rnd()}`;
    await link(c.clinicId, known.id, chat);
    const s = nextSlot();
    await openFree(s.date, c.clinicId);
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    await tap(c.clinicId, chat, s);
    mock.control.dropReplyAfterWrite = true;
    await say(c.clinicId, chat, 'так');
    mock.control.dropReplyAfterWrite = false;
    expect(mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits')).toHaveLength(1);
    expect(mock.data.visits.filter((v) => String(v.visit_start).startsWith(s.date) && String(v.patient_id) === known.externalId)).toHaveLength(1);
    expect(await requestOf(c.clinicId)).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', noticeStatus: 'SENT' });
    expect(sent.filter((m) => m.text.includes('підтверджено'))).toHaveLength(1);
  });

  it('Cliniccards відмовив: ніякого «ви записані», заявка передається адміністратору з причиною', async () => {
    const c = await synced({ auto: true });
    const known = c.patients[0];
    const chat = `ig${rnd()}`;
    await link(c.clinicId, known.id, chat);
    const s = nextSlot();
    await openFree(s.date, c.clinicId);
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    await tap(c.clinicId, chat, s);
    mock.control.failWith = 400;
    await say(c.clinicId, chat, 'так');
    mock.control.failWith = undefined;
    expect(sent.map((m) => m.text).join('\n')).not.toContain('підтверджено');
    expect(last().text).toContain('Передали заявку');
    expect(last().text).toContain('Очікуйте підтвердження запису');
    const req = await requestOf(c.clinicId);
    expect(req).toMatchObject({ status: 'NEW', stage: 'READY', autoState: 'FAILED', confirmedAt: null });
    expect(req.summary).toContain('автозапис не виконано');
    // the administrator can still confirm it by hand
    await http().post(`/requests/${req.id}/confirm`).set(auth(c.token)).send({ date: s.date, time: s.time }).expect(200);
  });

  it('є картка з таким телефоном, а чат не прив’язаний: автозапису немає, бот не розкриває і не вгадує, заявка йде адміністратору', async () => {
    const c = await synced({ auto: true });
    const owner = c.patients[0];
    const chat = `ig${rnd()}`;
    const s = nextSlot();
    await openFree(s.date, c.clinicId);
    await tap(c.clinicId, chat, s);
    await say(c.clinicId, chat, `Прізвище Інший, ім’я Хтось, телефон ${owner.phone}`);
    expect(mock.writes).toHaveLength(0);
    expect(await prisma.patientChannel.count({ where: { clinicId: c.clinicId, externalId: chat } })).toBe(0);
    expect(last().text).toContain('Передали заявку');
    expect((await requestOf(c.clinicId)).summary).toContain('є картка з таким телефоном');
  });

  it('автозапис вимкнений у клініці, запис не дозволений у клініці або глобальний перемикач вимкнений: нічого не пишеться, працює режим заявки', async () => {
    const s = nextSlot();
    for (const mode of ['clinic-off', 'write-off', 'global-off'] as const) {
      const c = await synced({ auto: mode !== 'clinic-off', write: mode !== 'write-off' });
      await openFree(s.date, c.clinicId);
      const chat = `ig${rnd()}`;
      await link(c.clinicId, c.patients[0].id, chat);
      if (mode === 'global-off') process.env.CLINICCARDS_WRITE_ENABLED = 'false';
      try {
        await tap(c.clinicId, chat, s);
      } finally {
        process.env.CLINICCARDS_WRITE_ENABLED = 'true';
      }
      expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(0);
      expect(last().text).toContain('Передали заявку');
      expect(await requestOf(c.clinicId)).toMatchObject({ status: 'NEW', stage: 'READY', confirmedAt: null });
    }
  });

  it('налаштування «ШІ записує сам» не вмикається без глобального дозволу запису', async () => {
    const c = await register();
    process.env.CLINICCARDS_WRITE_ENABLED = 'false';
    try {
      await http().patch('/ai').set(auth(c.token)).send({ autoBooking: true }).expect(400);
    } finally {
      process.env.CLINICCARDS_WRITE_ENABLED = 'true';
    }
    expect(app.get(BookingFlowService)).toBeTruthy();
  });
});
