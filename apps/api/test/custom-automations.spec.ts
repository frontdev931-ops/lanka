import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { CustomAutomationsService } from '../src/automations/custom-automations.service';
import { OutboxService } from '../src/automations/outbox.service';
import { TelegramApi } from '../src/automations/telegram.api';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const sent: { chatId: string; text: string }[] = [];
const tg = { getMe: async () => ({ id: 1, username: 'auto_bot' }), sendMessage: async (_t: string, chatId: string | number, text: string) => void sent.push({ chatId: String(chatId), text }), answerCallbackQuery: async () => true, getUpdates: async () => [], setWebhook: async () => true, deleteWebhook: async () => true };
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
let app: INestApplication;
let prisma: PrismaService;
let svc: CustomAutomationsService;
let outbox: OutboxService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const HOUR = 3_600_000;

// The test database is shared: unsent messages of these tests must not be picked up by the queue tests of other files
const drop = () => prisma.outboundMessage.updateMany({ where: { ruleKey: { startsWith: 'auto' }, status: { in: ['APPROVED', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED' } });
beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(LlmClient).useValue({ configured: false, complete: async () => { throw new Error('no AI'); } }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  svc = app.get(CustomAutomationsService);
  outbox = app.get(OutboxService);
  await drop();
});
afterAll(async () => {
  await drop();
  await app.close();
});
beforeEach(() => {
  sent.length = 0;
});

async function clinic(over: Record<string, unknown> = {}) {
  const email = `a${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true, ...over } });
  await http().post('/automations/telegram').set(auth(res.body.accessToken)).send({ token: TOKEN }).expect(201);
  return { token: res.body.accessToken as string, clinicId };
}
async function patient(clinicId: string, over: Record<string, unknown> = {}) {
  const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Коваль Олена${rnd()}`, ...over } });
  await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
  return p;
}
const visit = (clinicId: string, patientId: string, status: string, hoursAgo: number, over: Record<string, unknown> = {}) =>
  prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - hoursAgo * HOUR), endsAt: new Date(Date.now() - hoursAgo * HOUR + 1800_000), status, ...over } });
const thanks = { name: 'Подяка', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 20 }, action: { type: 'SEND_MESSAGE', text: '{name}, дякуємо, що були в клініці «{clinic}».' } };
const create = (token: string, body: object) => http().post('/custom-automations').set(auth(token)).send(body);
const noon = () => localToUtc(`${clinicDate(new Date())} 12:00:00`);
// make queued messages due and send them in the daytime of the clinic
async function deliver(clinicId: string) {
  await prisma.outboundMessage.updateMany({ where: { clinicId, ruleKey: { startsWith: 'auto' }, status: 'APPROVED' }, data: { scheduledFor: new Date(Date.now() - 86_400_000) } });
  return outbox.process(noon());
}

describe('конструктор автоматизацій: визначення', () => {
  it('права, перевірка параметрів, шаблони, ліміт; чужа клініка нічого не бачить; зміна змісту вимикає автоматизацію', async () => {
    const c = await clinic();
    const other = await clinic();
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `r${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/custom-automations').set(auth(admin)).expect(403);
    const list = (await http().get('/custom-automations').set(auth(c.token)).expect(200)).body;
    expect(list.templates.map((t: { key: string }) => t.key)).toEqual(['confirm-3h', 'thanks-after', 'no-show-ask', 'treatment-3w', 'lapsed-instagram', 'first-visit-call']);
    // every template is itself a valid automation
    for (const t of list.templates as { key: string; name: string }[]) await create(c.token, { ...t, templateKey: t.key }).expect(201);
    await create(c.token, { ...thanks, trigger: { type: 'NOPE' } }).expect(400);
    await create(c.token, { ...thanks, trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 999 } }).expect(400);
    await create(c.token, { ...thanks, action: { type: 'SEND_MESSAGE', text: '{name}, ваш код {secret}' } }).expect(400);
    await create(c.token, { ...thanks, action: { type: 'SEND_MESSAGE', text: 'коротко' } }).expect(400);
    await create(c.token, { ...thanks, trigger: { type: 'BIRTHDAY' }, action: { type: 'SEND_MESSAGE', text: '{name}, чекаємо вас {date} о {time}.' } }).expect(400);
    await create(c.token, { ...thanks, trigger: { type: 'NO_VISIT', days: 100 }, conditions: { doctor: 'Іваненко' } }).expect(400);
    const id = (await create(c.token, thanks).expect(201)).body.id;
    expect((await http().get('/custom-automations').set(auth(other.token))).body.automations).toHaveLength(0);
    await http().patch(`/custom-automations/${id}`).set(auth(other.token)).send({ enabled: true }).expect(404);
    await http().delete(`/custom-automations/${id}`).set(auth(other.token)).expect(404);
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    const get = async () => (await http().get('/custom-automations').set(auth(c.token))).body.automations.find((a: { id: string }) => a.id === id);
    expect((await get()).enabled).toBe(true);
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ action: { type: 'SEND_MESSAGE', text: '{name}, дякуємо за візит до «{clinic}»!' } }).expect(200);
    expect((await get()).enabled).toBe(false); // changed: look again, then switch on on purpose
    for (let i = 0; i < 20; i++) await create(c.token, thanks);
    await create(c.token, thanks).expect(400); // the limit
  });
});

describe('конструктор автоматизацій: робота', () => {
  it('перегляд аудиторії нічого не пише; увімкнена автоматизація ставить повідомлення в чергу один раз; журнал показує причини пропусків', async () => {
    const c = await clinic();
    const ok = await patient(c.clinicId, { source: 'Instagram' });
    const wrongSource = await patient(c.clinicId, { source: 'Google' });
    await visit(c.clinicId, ok.id, 'VISITED', 22);
    await visit(c.clinicId, wrongSource.id, 'VISITED', 22);
    await visit(c.clinicId, (await patient(c.clinicId, { source: 'Instagram' })).id, 'VISITED', 2); // too recent for a 20 hour delay
    const id = (await create(c.token, { ...thanks, conditions: { source: 'instagram' } }).expect(201)).body.id;

    const draft = (await http().post('/custom-automations/preview').set(auth(c.token)).send({ ...thanks, conditions: { source: 'instagram' } }).expect(200)).body;
    expect(draft).toMatchObject({ candidates: 2, toDo: 1, skipped: { source: 1 } });
    expect(draft.sample[0].text).toContain('дякуємо');
    expect((await http().get(`/custom-automations/${id}/preview`).set(auth(c.token))).body).toMatchObject({ candidates: 2, toDo: 1 });
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(0); // a preview writes nothing

    // switched off: the periodic check does nothing; switched on: it queues one message for approval
    await svc.planClinic(c.clinicId);
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    await svc.planClinic(c.clinicId);
    await svc.planClinic(c.clinicId);
    const msgs = await prisma.outboundMessage.findMany({ where: { clinicId: c.clinicId } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ ruleKey: `auto:${id}`, status: 'PENDING_APPROVAL', patientId: ok.id });
    const j = (await http().get(`/custom-automations/${id}/journal`).set(auth(c.token)).expect(200)).body;
    expect(j.runs.find((r: { queued: number }) => r.queued === 1)).toMatchObject({ candidates: 2, queued: 1, skipped: { source: 1 } });
    expect(j.runs).toHaveLength(2); // the check that found nothing new is in the journal too
    expect(j.messages).toEqual({ PENDING_APPROVAL: 1 });
    expect((await http().get('/custom-automations').set(auth(c.token))).body.automations[0].lastRun).toMatchObject({ queued: 0 }); // the last check found nothing new
  });

  it('служебне повідомлення уходить само, якщо клініка дозволила; після відправлення повторно не шлеться', async () => {
    const c = await clinic({ autoSendService: true });
    const p = await patient(c.clinicId);
    await visit(c.clinicId, p.id, 'VISITED', 22);
    const id = (await create(c.token, thanks).expect(201)).body.id;
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    await svc.planClinic(c.clinicId);
    expect((await deliver(c.clinicId)).sent).toBe(1);
    expect(sent.at(-1)!.text).toContain('Олена'.slice(0, 4));
    await svc.planClinic(c.clinicId);
    expect((await deliver(c.clinicId)).sent).toBe(0);
  });

  it('напередодні візиту: нагадування за N годин; лікар і послуга у фільтрі', async () => {
    const c = await clinic({ autoSendService: true });
    const a = await patient(c.clinicId);
    const b = await patient(c.clinicId);
    await visit(c.clinicId, a.id, 'PLANNED', -2, { doctorName: 'Іваненко Олег', serviceName: 'Гігієна', bookedAt: new Date(Date.now() - 48 * HOUR) });
    await visit(c.clinicId, b.id, 'PLANNED', -2, { doctorName: 'Петренко Ірина', serviceName: 'Гігієна', bookedAt: new Date(Date.now() - 48 * HOUR) });
    const body = { name: 'Нагадування', kind: 'service', trigger: { type: 'VISIT_BEFORE', hours: 3 }, conditions: { doctor: 'іванен' }, action: { type: 'SEND_MESSAGE', text: '{name}, чекаємо о {time}.' } };
    const r = (await http().post('/custom-automations/preview').set(auth(c.token)).send(body).expect(200)).body;
    expect(r).toMatchObject({ candidates: 2, toDo: 1, skipped: { doctor: 1 } });
    expect(r.sample[0].text).toMatch(/чекаємо о \d\d:\d\d\./);
  });

  it('маркетингова: потрібна згода і не частіше разу на 14 днів; службова не потребує', async () => {
    const c = await clinic();
    const p = await patient(c.clinicId, { consent: 'UNKNOWN' });
    const q = await patient(c.clinicId, { consent: 'GIVEN' });
    for (const x of [p, q]) await prisma.patient.update({ where: { id: x.id }, data: { lastVisitAt: new Date(Date.now() - 372 * 86_400_000) } });
    const body = { name: 'Повернення', kind: 'marketing', trigger: { type: 'NO_VISIT', days: 365 }, action: { type: 'SEND_MESSAGE', text: '{name}, давно не бачили вас у клініці «{clinic}».' } };
    expect((await http().post('/custom-automations/preview').set(auth(c.token)).send(body).expect(200)).body).toMatchObject({ candidates: 2, toDo: 1, skipped: { noConsent: 1 } });
    await prisma.outboundMessage.create({ data: { clinicId: c.clinicId, patientId: q.id, ruleKey: 'campaign:x', channel: 'TELEGRAM', text: 'x', status: 'SENT', scheduledFor: new Date(), dedupeKey: `c${rnd()}` } });
    expect((await http().post('/custom-automations/preview').set(auth(c.token)).send(body).expect(200)).body).toMatchObject({ toDo: 0, skipped: { noConsent: 1, tooSoon: 1 } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { assumeConsent: true } });
    expect((await http().post('/custom-automations/preview').set(auth(c.token)).send(body).expect(200)).body).toMatchObject({ toDo: 1, skipped: { tooSoon: 1 } });
  });

  it('дія «заявка адміністратору» створює заявку один раз, без повідомлення пацієнту', async () => {
    const c = await clinic();
    const p = await patient(c.clinicId);
    await visit(c.clinicId, p.id, 'VISITED', 50);
    const id = (await create(c.token, { name: 'Після першого візиту', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 48 }, conditions: { maxVisits: 1 }, action: { type: 'CREATE_REQUEST', text: 'Зв’язатися з пацієнтом після першого візиту.' } }).expect(201)).body.id;
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    await svc.planClinic(c.clinicId);
    await svc.planClinic(c.clinicId);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, patientId: p.id } })).toBe(1);
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
    // a patient with several visits does not fit "the first visit only"
    const r = await patient(c.clinicId);
    await visit(c.clinicId, r.id, 'VISITED', 50);
    await visit(c.clinicId, r.id, 'VISITED', 24 * 30);
    expect((await svc.preview(c.clinicId, id)).skipped).toMatchObject({ maxVisits: 1 });
  });

  it('умови зупинки перевіряються перед самою відправкою: записався, відповів, автоматизацію вимкнули чи видалили', async () => {
    const c = await clinic({ autoSendService: true });
    const body = { ...thanks, name: 'Зі зупинкою', stop: { ifBooked: true, ifReplied: true } };
    const id = (await create(c.token, body).expect(201)).body.id;
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    const [booked, replied, plain, off] = [await patient(c.clinicId), await patient(c.clinicId), await patient(c.clinicId), await patient(c.clinicId)];
    for (const p of [booked, replied, plain, off]) await visit(c.clinicId, p.id, 'VISITED', 22);
    await svc.planClinic(c.clinicId);
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(4);
    // after queuing: one books a new visit, one writes to us
    await visit(c.clinicId, booked.id, 'PLANNED', -48);
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, patientId: replied.id, channel: 'TELEGRAM', chatId: 'x', direction: 'IN', text: 'Дякую, все чудово', createdAt: new Date(Date.now() + 1000) } });
    await prisma.outboundMessage.updateMany({ where: { clinicId: c.clinicId, patientId: off.id }, data: { status: 'CANCELLED' } });
    await deliver(c.clinicId);
    const status = async (patientId: string) => prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, patientId } });
    expect(await status(plain.id)).toMatchObject({ status: 'SENT' });
    expect(await status(booked.id)).toMatchObject({ status: 'CANCELLED', error: 'Пацієнт уже записаний' });
    expect(await status(replied.id)).toMatchObject({ status: 'CANCELLED', error: 'Пацієнт уже відповів' });

    // switched off before sending: the message does not go
    const x = await patient(c.clinicId);
    await visit(c.clinicId, x.id, 'VISITED', 22);
    await svc.planClinic(c.clinicId);
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: false }).expect(200);
    await deliver(c.clinicId);
    expect(await status(x.id)).toMatchObject({ status: 'CANCELLED', error: 'Автоматизацію вимкнено або видалено' });
    // deleting cancels what still waits
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    const y = await patient(c.clinicId);
    await visit(c.clinicId, y.id, 'VISITED', 22);
    await svc.planClinic(c.clinicId);
    await http().delete(`/custom-automations/${id}`).set(auth(c.token)).expect(200);
    expect(await status(y.id)).toMatchObject({ status: 'CANCELLED', error: 'Автоматизацію видалено' });
  });

  it('призупинена клініка, демо й закритий доступ: автоматизації не працюють; пацієнт на паузі або без Telegram пропускається', async () => {
    const c = await clinic();
    const paused = await patient(c.clinicId, { automationPaused: true });
    const noTg = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Без Телеграму' } });
    for (const p of [paused, noTg]) await visit(c.clinicId, p.id, 'VISITED', 22);
    expect((await http().post('/custom-automations/preview').set(auth(c.token)).send(thanks).expect(200)).body).toMatchObject({ candidates: 2, toDo: 0, skipped: { paused: 1, noChannel: 1 } });
    const id = (await create(c.token, thanks).expect(201)).body.id;
    await http().patch(`/custom-automations/${id}`).set(auth(c.token)).send({ enabled: true }).expect(200);
    for (const over of [{ suspendedAt: new Date() }, { isDemo: true }]) {
      const q = await clinic();
      const p = await patient(q.clinicId);
      await visit(q.clinicId, p.id, 'VISITED', 22);
      const qid = (await create(q.token, thanks).expect(201)).body.id;
      await prisma.automation.update({ where: { id: qid }, data: { enabled: true } });
      await prisma.clinic.update({ where: { id: q.clinicId }, data: over });
      expect(await svc.planClinic(q.clinicId)).toEqual([]);
      expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId } })).toBe(0);
    }
  });
});
