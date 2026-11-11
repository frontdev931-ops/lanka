import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { OutboxService } from '../src/automations/outbox.service';
import { PlannerService } from '../src/automations/planner.service';
import { TelegramApi, TelegramError } from '../src/automations/telegram.api';
import { TelegramService } from '../src/automations/telegram.service';
import { clinicDate, clinicHm, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { InstagramAdapter } from '../src/automations/instagram.adapter';
import { SendError } from '../src/automations/channels';
import { encrypt } from '../src/common/crypto';

jest.setTimeout(60_000);

// A fake Telegram: nothing goes to the internet, every send is recorded
class FakeTelegram {
  sent: { token: string; chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  blocked = new Set<string>();
  getMe = async (token: string) => {
    if (token.startsWith('bad')) throw new TelegramError('Unauthorized', 401);
    return { id: 1, username: 'clinic_test_bot' };
  };
  sendMessage = async (token: string, chatId: string | number, text: string, extra?: Record<string, unknown>) => {
    if (this.blocked.has(String(chatId))) throw new TelegramError('Forbidden: bot was blocked by the user', 403);
    this.sent.push({ token, chatId: String(chatId), text, extra });
  };
  getUpdates = async () => [];
  answerCallbackQuery = async () => true;
  setWebhook = async () => true;
  deleteWebhook = async () => true;
}

let app: INestApplication;
let prisma: PrismaService;
let planner: PlannerService;
let outbox: OutboxService;
let telegram: TelegramService;
const tg = new FakeTelegram();
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(LlmClient).useValue({ configured: false, complete: async () => { throw new Error('в тестах настоящий ИИ не вызывается'); } }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  planner = app.get(PlannerService);
  outbox = app.get(OutboxService);
  telegram = app.get(TelegramService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  tg.sent.length = 0;
  tg.blocked.clear();
});

async function clinic() {
  const email = `m${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // features of the Pro plan are on by default in these tests; the plan rules have their own tests
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO' } });
  // sending is on in tests; the switched-off safety is checked separately
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true } });
  return { token: res.body.accessToken as string, clinicId };
}

async function member(ownerToken: string, role: string) {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

// A patient with Telegram connected and an appointment in `h` hours, created in advance
async function patientWithVisit(clinicId: string, h = 20, over: Record<string, unknown> = {}) {
  const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Козир Галина Анатоліївна', phone: '0501112233', phoneNorm: `3805${Math.floor(Math.random() * 1e7)}`, ...over } });
  await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
  const v = await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: hours(h), endsAt: hours(h + 0.5), status: 'PLANNED', bookedAt: hours(-72) } });
  return { p, v };
}

describe('подключение Telegram-бота', () => {
  it('ключ проверяется у Telegram и хранится зашифрованным; настраивать может только владелец и управляющий', async () => {
    const { token, clinicId } = await clinic();
    await http().post('/automations/telegram').set(auth(token)).send({ token: 'bad-token-0123456789abcdef' }).expect(400);
    const ok = await http().post('/automations/telegram').set(auth(token)).send({ token: TOKEN }).expect(201);
    expect(ok.body).toMatchObject({ connected: true, username: 'clinic_test_bot', linkedPatients: 0 });
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
    const stored = await prisma.integration.findFirstOrThrow({ where: { clinicId, provider: 'TELEGRAM' } });
    expect(stored.apiKeyEnc).toBeTruthy();
    expect(stored.apiKeyEnc).not.toContain(TOKEN);
    expect(JSON.stringify(stored.config)).not.toContain(TOKEN);

    const admin = await member(token, 'ADMIN');
    const doctor = await member(token, 'DOCTOR');
    await http().post('/automations/telegram').set(auth(admin)).send({ token: TOKEN }).expect(403);
    await http().get('/automations').set(auth(doctor)).expect(403);
    expect((await http().get('/automations').set(auth(admin)).expect(200)).body.telegram.connected).toBe(true);
    await http().delete('/automations/telegram').set(auth(token)).expect(200);
    expect((await http().get('/automations').set(auth(token)).expect(200)).body.telegram.connected).toBe(false);
  });
});

describe('привязка пациента к Telegram', () => {
  async function connected() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    return c;
  }
  const update = (chatId: number, text?: string, contact?: { phone_number: string; user_id: number }) => ({ update_id: 1, message: { chat: { id: chatId }, from: { id: chatId, username: 'user' }, text, contact } });

  it('персональная ссылка привязывает чат к карточке один раз', async () => {
    const { token, clinicId } = await connected();
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Іваненко Іван' } });
    const link = (await http().post(`/automations/patients/${p.id}/telegram-link`).set(auth(token)).expect(201)).body.url as string;
    expect(link).toMatch(/^https:\/\/t\.me\/clinic_test_bot\?start=/);
    const t = link.split('start=')[1];

    await telegram.handleUpdate(clinicId, TOKEN, update(555, `/start ${t}`));
    expect(await prisma.patientChannel.findUnique({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } })).toMatchObject({ externalId: '555' });
    expect(tg.sent.at(-1)!.text).toContain('Готово');

    // the link is single-use: another person cannot link through it
    await telegram.handleUpdate(clinicId, TOKEN, update(777, `/start ${t}`));
    expect((await prisma.patientChannel.findUnique({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } }))!.externalId).toBe('555');
    expect(tg.sent.at(-1)!.text).toContain('недійсне');
    // only the hash is stored in the database
    expect(await prisma.channelLink.count({ where: { clinicId, tokenHash: t } })).toBe(0);
  });

  it('по номеру: только собственный контакт, найденный по телефону; чужой номер и неизвестный не привязываются', async () => {
    const { clinicId } = await connected();
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Петренко Олена', phoneNorm: '380509998877' } });
    await telegram.handleUpdate(clinicId, TOKEN, update(10, '/start')); // a request to share the number
    expect(tg.sent.at(-1)!.extra).toMatchObject({ reply_markup: { keyboard: [[{ request_contact: true }]] } });

    await telegram.handleUpdate(clinicId, TOKEN, update(11, undefined, { phone_number: '+380509998877', user_id: 99 })); // someone else's contact
    expect(await prisma.patientChannel.count({ where: { patientId: p.id } })).toBe(0);
    await telegram.handleUpdate(clinicId, TOKEN, update(12, undefined, { phone_number: '+380670000000', user_id: 12 })); // unknown number
    expect(await prisma.patientChannel.count({ where: { patientId: p.id } })).toBe(0);
    expect(tg.sent.at(-1)!.text).toContain('Не знайшли');

    await telegram.handleUpdate(clinicId, TOKEN, update(13, undefined, { phone_number: '+38 (050) 999-88-77', user_id: 13 })); // own number, another entry
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } })).externalId).toBe('13');
  });

  it('«Зупинити» отключает рассылку; ссылка из другой клиники не работает; подделанный вебхук игнорируется', async () => {
    const a = await connected();
    const b = await connected();
    const p = await prisma.patient.create({ data: { clinicId: a.clinicId, externalId: `p${rnd()}`, fullName: 'Шевченко Тарас' } });
    await prisma.patientChannel.create({ data: { clinicId: a.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: '321' } });
    await telegram.handleUpdate(a.clinicId, TOKEN, update(321, 'Зупинити'));
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } })).optedOutAt).toBeTruthy();

    const link = (await http().post(`/automations/patients/${p.id}/telegram-link`).set(auth(a.token)).expect(201)).body.url as string;
    await telegram.handleUpdate(b.clinicId, TOKEN, update(888, `/start ${link.split('start=')[1]}`)); // a token of another clinic
    expect(await prisma.patientChannel.count({ where: { clinicId: b.clinicId } })).toBe(0);
    await http().post(`/automations/patients/${p.id}/telegram-link`).set(auth(b.token)).expect(404); // a card of another clinic

    // webhook: a wrong secret, a wrong header: nothing happens; the right ones: it is processed
    const secret = ((await prisma.integration.findFirstOrThrow({ where: { clinicId: a.clinicId, provider: 'TELEGRAM' } })).config as { secret: string }).secret;
    const lines = { update_id: 2, message: { chat: { id: 444 }, from: { id: 444 }, text: `/start ${(await http().post(`/automations/patients/${p.id}/telegram-link`).set(auth(a.token)).expect(201)).body.url.split('start=')[1]}` } };
    await http().post('/telegram/webhook/wrong').set('x-telegram-bot-api-secret-token', 'wrong').send(lines).expect(200);
    await http().post(`/telegram/webhook/${secret}`).set('x-telegram-bot-api-secret-token', 'nope').send(lines).expect(200);
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } })).externalId).toBe('321');
    await http().post(`/telegram/webhook/${secret}`).set('x-telegram-bot-api-secret-token', secret).send(lines).expect(200);
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: p.id, channel: 'TELEGRAM' } } })).externalId).toBe('444');
  });
});

describe('сценарии: кому и что ставится в очередь', () => {
  it('напоминание о записи: выключено по умолчанию; после включения создаётся один раз, текст без медицины', async () => {
    const { token, clinicId } = await clinic();
    const { p, v } = await patientWithVisit(clinicId);
    expect(await planner.plan(clinicId, { dryRun: false })).toEqual([]); // scenarios are off
    const pre = (await http().get('/automations/preview').set(auth(token)).expect(200)).body as { key: string; toQueue: number }[];
    expect(pre.find((r) => r.key === 'visit-reminder')!.toQueue).toBe(1); // the preview shows what will happen
    expect(await prisma.outboundMessage.count({ where: { clinicId } })).toBe(0); // but creates nothing

    await http().patch('/automations/rules/visit-reminder').set(auth(token)).send({ enabled: true }).expect(200);
    const r1 = await planner.plan(clinicId, { dryRun: false });
    expect(r1[0]).toMatchObject({ key: 'visit-reminder', candidates: 1, toQueue: 1, alreadyQueued: 0 });
    const m = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId, patientId: p.id } });
    expect(m).toMatchObject({ status: 'PENDING_APPROVAL', channel: 'TELEGRAM', visitId: v.id });
    expect(m.text).toContain('Галина'); // addressed by the first name, not by the surname
    expect(m.text).toMatch(/\d\d\.\d\d о \d\d:\d\d/);
    expect(m.text).not.toMatch(/\{|\}/);
    expect(m.expiresAt!.getTime()).toBe(v.startsAt.getTime());

    const r2 = await planner.plan(clinicId, { dryRun: false });
    expect(r2[0]).toMatchObject({ toQueue: 0, alreadyQueued: 1 });
    expect(await prisma.outboundMessage.count({ where: { clinicId } })).toBe(1);
  });

  it('не создаёт напоминание тем, кто записался позже момента напоминания, и по отменённым или далёким записям', async () => {
    const { token, clinicId } = await clinic();
    await http().patch('/automations/rules/visit-reminder').set(auth(token)).send({ enabled: true }).expect(200);
    const lateBooked = await patientWithVisit(clinicId, 10); // an appointment in 10 hours...
    await prisma.visit.update({ where: { id: lateBooked.v.id }, data: { bookedAt: hours(-1) } }); // ...made an hour ago: a 24-hour reminder is not needed
    const cancelled = await patientWithVisit(clinicId, 12);
    await prisma.visit.update({ where: { id: cancelled.v.id }, data: { status: 'CANCELLED' } });
    const far = await patientWithVisit(clinicId, 60); // in 60 hours: too early
    const r = await planner.plan(clinicId, { dryRun: false });
    expect(r[0].toQueue).toBe(0);
    expect(far.p.id).toBeTruthy();
    expect(await prisma.outboundMessage.count({ where: { clinicId } })).toBe(0);
  });

  it('согласие и пауза: маркетинг только при согласии, служебное не уходит отказавшимся, без канала в очередь не попадает', async () => {
    const { token, clinicId } = await clinic();
    await http().patch('/automations/rules/visit-reminder').set(auth(token)).send({ enabled: true }).expect(200);
    await http().patch('/automations/rules/hygiene-recall').set(auth(token)).send({ enabled: true, params: { months: 6 } }).expect(200);

    const fine = await patientWithVisit(clinicId, 20); // an ordinary patient: they are due the service reminder
    const withdrawn = await patientWithVisit(clinicId, 20, { consent: 'WITHDRAWN' });
    const paused = await patientWithVisit(clinicId, 20, { automationPaused: true });
    const noChannel = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Без Каналу' } });
    await prisma.visit.create({ data: { clinicId, patientId: noChannel.id, externalId: `v${rnd()}`, startsAt: hours(20), endsAt: hours(21), status: 'PLANNED', bookedAt: hours(-72) } });

    // hygiene 6 months ago (the due date came this week): one with consent, one without
    const dueAt = new Date(Date.now() - 6 * 30 * 86_400_000 - 5 * 86_400_000);
    const hyg = async (name: string, consent: 'GIVEN' | 'UNKNOWN') => {
      const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: name, consent } });
      await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
      await prisma.planItem.create({ data: { clinicId, patientId: p.id, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Гігієна', status: 'DONE', groupName: 'Профілактика', createdAtExt: dueAt, markedDoneAt: dueAt } });
      return p;
    };
    const agreed = await hyg('Згоден Іван', 'GIVEN');
    const unknown = await hyg('Невідомо Петро', 'UNKNOWN');

    const r = await planner.plan(clinicId, { dryRun: false });
    const rem = r.find((x) => x.key === 'visit-reminder')!;
    expect(rem).toMatchObject({ candidates: 4, toQueue: 1, paused: 2, noChannel: 1 }); // opted out and paused = 2
    const hy = r.find((x) => x.key === 'hygiene-recall')!;
    expect(hy).toMatchObject({ candidates: 2, toQueue: 1, blockedConsent: 1 });
    const queued = await prisma.outboundMessage.findMany({ where: { clinicId }, select: { patientId: true, ruleKey: true } });
    expect(queued.filter((q) => q.ruleKey === 'hygiene-recall').map((q) => q.patientId)).toEqual([agreed.id]);
    expect(queued.filter((q) => q.ruleKey === 'visit-reminder').map((q) => q.patientId)).toEqual([fine.p.id]);
    expect(queued.some((q) => q.patientId === unknown.id || q.patientId === withdrawn.p.id || q.patientId === paused.p.id || q.patientId === noChannel.id)).toBe(false);
  });

  it('«не пришёл»: пишем только если человек не записан заново; текст и срок настраиваются, неизвестные переменные отклоняются', async () => {
    const { token, clinicId } = await clinic();
    await http().patch('/automations/rules/no-show').set(auth(token)).send({ enabled: true, text: 'Привіт, {name}! Чекали вас {date}. Клініка «{clinic}».' }).expect(200);
    const mk = async (rebooked: boolean) => {
      const { p, v } = await patientWithVisit(clinicId, -3);
      await prisma.visit.update({ where: { id: v.id }, data: { status: 'DID_NOT_COME' } });
      if (rebooked) await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: hours(48), endsAt: hours(49), status: 'PLANNED' } });
      return p;
    };
    const lost = await mk(false);
    await mk(true);
    const r = await planner.plan(clinicId, { dryRun: false });
    expect(r[0]).toMatchObject({ key: 'no-show', candidates: 1, toQueue: 1 });
    const m = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId, patientId: lost.id } });
    expect(m.text).toMatch(/^Привіт, Галина! Чекали вас \d\d\.\d\d\. Клініка «.+»\.$/);
    await http().patch('/automations/rules/no-show').set(auth(token)).send({ text: 'Привіт, {nickname}!!!' }).expect(400);
    await http().patch('/automations/rules/visit-reminder').set(auth(token)).send({ params: { hoursBefore: [100] } }).expect(400);
    await http().patch('/automations/rules/hygiene-recall').set(auth(token)).send({ params: { months: 99 } }).expect(400);
    await http().patch('/automations/rules/unknown').set(auth(token)).send({ enabled: true }).expect(400);
  });
});

describe('подтверждение и отправка', () => {
  async function queued() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/automations/rules/visit-reminder').set(auth(c.token)).send({ enabled: true }).expect(200);
    const x = await patientWithVisit(c.clinicId, 20);
    await planner.plan(c.clinicId, { dryRun: false });
    const msg = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    const ch = await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: x.p.id, channel: 'TELEGRAM' } } });
    const noon = localToUtc(`${clinicDate(new Date())} 12:00:00`);
    const night = localToUtc(`${clinicDate(new Date())} 23:30:00`);
    // a message "created long ago", so that the send moment depends only on the time passed in
    await prisma.outboundMessage.update({ where: { id: msg.id }, data: { scheduledFor: new Date(0), expiresAt: hours(24 * 5) } });
    return { ...c, ...x, msg, ch, noon, night };
  }

  it('изоляция обработки: сообщения других клиник (в том числе оставшиеся от прежних прогонов в общей базе) не отправляются и не считаются', async () => {
    // another clinic has an approved, due message and sending on (what an earlier run or another test leaves in the shared database)
    const left = await queued();
    await http().post('/messages/approve').set(auth(left.token)).send({ all: true }).expect(200);
    const mine = await queued();
    tg.sent.length = 0;
    // my run: nothing of mine is approved yet, so nothing goes out, and the foreign message is neither sent nor counted
    expect(await outbox.process(mine.noon, { clinicId: mine.clinicId })).toMatchObject({ sent: 0, failed: 0 });
    expect(tg.sent).toHaveLength(0);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: left.msg.id } })).status).toBe('APPROVED');
    // the run of the other clinic sends its own message and only it
    expect(await outbox.process(left.noon, { clinicId: left.clinicId })).toMatchObject({ sent: 1 });
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: mine.msg.id } })).status).not.toBe('SENT');
  });

  it('без подтверждения ничего не уходит; подтверждает оператор; после отправки повторно не шлётся', async () => {
    const q = await queued();
    expect((await outbox.process(q.noon, { clinicId: q.clinicId })).sent).toBe(0);
    expect(tg.sent).toHaveLength(0);

    const analyst = await member(q.token, 'ANALYST');
    await http().post('/messages/approve').set(auth(analyst)).send({ ids: [q.msg.id] }).expect(403);
    await http().post('/messages/approve').set(auth(q.token)).send({}).expect(400);
    expect((await http().post('/messages/approve').set(auth(q.token)).send({ ids: [q.msg.id] }).expect(200)).body.approved).toBe(1);

    const r = await outbox.process(q.noon, { clinicId: q.clinicId });
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(tg.sent).toEqual([{ token: TOKEN, chatId: q.ch.externalId, text: q.msg.text, extra: undefined }]);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).status).toBe('SENT');
    expect((await outbox.process(q.noon, { clinicId: q.clinicId })).sent).toBe(0);
    expect(tg.sent).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { clinicId: q.clinicId, action: 'messages.approved' } })).toBe(1);
  });

  it('главный предохранитель: пока отправка выключена, ничего не уходит, хотя очередь и подтверждение работают; управляет только владелец и управляющий', async () => {
    const q = await queued();
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: false } });
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    expect(await outbox.process(q.noon, { clinicId: q.clinicId })).toMatchObject({ sent: 0, failed: 0 });
    expect(tg.sent).toHaveLength(0);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).status).toBe('APPROVED');
    const admin = await member(q.token, 'ADMIN');
    await http().patch('/automations/settings').set(auth(admin)).send({ sendingEnabled: true }).expect(403);
    await http().patch('/automations/settings').set(auth(q.token)).send({}).expect(400);
    expect((await http().patch('/automations/settings').set(auth(q.token)).send({ sendingEnabled: true }).expect(200)).body.sendingEnabled).toBe(true);
    expect((await outbox.process(q.noon, { clinicId: q.clinicId })).sent).toBe(1);
  });

  it('лимит сообщений по тарифу: сверх лимита сообщение ждёт, а не теряется; приостановленная клиника ничего не отправляет', async () => {
    const q = await queued();
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: true, limitOverrides: { messagesPerMonth: 1 }, plan: 'CUSTOM' } });
    const p2 = await prisma.patient.create({ data: { clinicId: q.clinicId, externalId: `p${rnd()}`, fullName: 'Другий Пацієнт' } });
    await prisma.patientChannel.create({ data: { clinicId: q.clinicId, patientId: p2.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
    await prisma.outboundMessage.create({ data: { clinicId: q.clinicId, patientId: p2.id, ruleKey: 'post-visit-thanks', channel: 'TELEGRAM', text: 'Дякуємо', status: 'APPROVED', scheduledFor: new Date(0), expiresAt: hours(24 * 5), dedupeKey: `lim${rnd()}` } });
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    expect(await outbox.process(q.noon, { clinicId: q.clinicId })).toMatchObject({ sent: 1 });
    expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId, status: 'APPROVED' } })).toBe(1); // the second one waits
    expect((await outbox.process(q.noon, { clinicId: q.clinicId })).sent).toBe(0);
    // a new limit: the waiting one goes out
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { limitOverrides: { messagesPerMonth: 5 } } });
    expect((await outbox.process(q.noon, { clinicId: q.clinicId })).sent).toBe(1);

    const s = await queued();
    await prisma.clinic.update({ where: { id: s.clinicId }, data: { sendingEnabled: true, suspendedAt: new Date() } });
    await http().post('/messages/approve').set(auth(s.token)).send({ all: true }).expect(403); // the clinic is suspended
    await prisma.outboundMessage.updateMany({ where: { clinicId: s.clinicId }, data: { status: 'APPROVED' } });
    tg.sent.length = 0;
    expect((await outbox.process(s.noon, { clinicId: s.clinicId })).sent).toBe(0);
    expect(tg.sent).toHaveLength(0);
  });

  it('ночью не отправляется; запись отменили, пациент отказался, бот заблокирован: сообщение не уходит', async () => {
    const q = await queued();
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    expect((await outbox.process(q.night, { clinicId: q.clinicId })).sent).toBe(0); // night window
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).status).toBe('APPROVED');

    await prisma.visit.update({ where: { id: q.v.id }, data: { status: 'CANCELLED' } });
    await outbox.process(q.noon, { clinicId: q.clinicId });
    expect(await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(tg.sent).toHaveLength(0);
  });

  it('отказ пациента между подтверждением и отправкой; блокировка бота помечает канал; истёкшее не отправляется', async () => {
    const q = await queued();
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    await prisma.patient.update({ where: { id: q.p.id }, data: { consent: 'WITHDRAWN' } });
    await outbox.process(q.noon, { clinicId: q.clinicId });
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).status).toBe('CANCELLED');

    const q2 = await queued();
    tg.blocked.add(q2.ch.externalId);
    await http().post('/messages/approve').set(auth(q2.token)).send({ all: true }).expect(200);
    expect((await outbox.process(q2.noon, { clinicId: q2.clinicId })).failed).toBe(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q2.msg.id } })).status).toBe('FAILED');
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { id: q2.ch.id } })).optedOutAt).toBeTruthy();

    const q3 = await queued();
    await prisma.outboundMessage.update({ where: { id: q3.msg.id }, data: { expiresAt: new Date(q3.noon.getTime() - 1000) } }); // the due date passed before the send moment
    await http().post('/messages/approve').set(auth(q3.token)).send({ all: true }).expect(200);
    await outbox.process(q3.noon, { clinicId: q3.clinicId });
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q3.msg.id } })).status).toBe('EXPIRED');
  });

  it('служебные сообщения идут сразу, если клиника это разрешила; маркетинг всё равно ждёт подтверждения', async () => {
    const { token, clinicId } = await clinic();
    await http().patch('/automations/settings').set(auth(token)).send({ autoSendService: true }).expect(200);
    await http().patch('/automations/rules/visit-reminder').set(auth(token)).send({ enabled: true }).expect(200);
    await http().patch('/automations/rules/hygiene-recall').set(auth(token)).send({ enabled: true }).expect(200);
    await patientWithVisit(clinicId, 20);
    const dueAt = new Date(Date.now() - 6 * 30 * 86_400_000 - 5 * 86_400_000);
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Згода Марія', consent: 'GIVEN' } });
    await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
    await prisma.planItem.create({ data: { clinicId, patientId: p.id, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Гігієна', status: 'DONE', groupName: 'Профілактика', createdAtExt: dueAt, markedDoneAt: dueAt } });
    await planner.plan(clinicId, { dryRun: false });
    const rows = await prisma.outboundMessage.findMany({ where: { clinicId } });
    expect(rows.find((r) => r.ruleKey === 'visit-reminder')!.status).toBe('APPROVED');
    expect(rows.find((r) => r.ruleKey === 'hygiene-recall')!.status).toBe('PENDING_APPROVAL');
  });

  it('очередь изолирована по клиникам; чужие сообщения нельзя ни увидеть, ни подтвердить, ни отменить', async () => {
    const a = await queued();
    const b = await clinic();
    expect((await http().get('/messages').set(auth(b.token)).expect(200)).body.total).toBe(0);
    expect((await http().post('/messages/approve').set(auth(b.token)).send({ ids: [a.msg.id] }).expect(200)).body.approved).toBe(0);
    expect((await http().post('/messages/cancel').set(auth(b.token)).send({ ids: [a.msg.id] }).expect(200)).body.cancelled).toBe(0);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: a.msg.id } })).status).toBe('PENDING_APPROVAL');
    const list = (await http().get('/messages?status=PENDING_APPROVAL').set(auth(a.token)).expect(200)).body;
    expect(list.total).toBe(1);
    expect(list.rows[0].patient.fullName).toBeTruthy();
  });
});

describe('карточка пациента: канал и журнал сообщений', () => {
  it('в карточке видны подключённый Telegram и последние сообщения; врач журнал сообщений не получает', async () => {
    const { token, clinicId } = await clinic();
    const { p } = await patientWithVisit(clinicId, 20);
    await prisma.outboundMessage.create({ data: { clinicId, patientId: p.id, ruleKey: 'visit-reminder', channel: 'TELEGRAM', text: 'Нагадуємо про візит', status: 'SENT', scheduledFor: new Date(), sentAt: new Date(), dedupeKey: `t${rnd()}` } });
    const card = (await http().get(`/patients/${p.id}`).set(auth(token)).expect(200)).body;
    expect(card.channels).toEqual([expect.objectContaining({ channel: 'TELEGRAM', optedOutAt: null })]);
    expect(card.outbox).toEqual([expect.objectContaining({ status: 'SENT', text: 'Нагадуємо про візит' })]);
    const doctor = await member(token, 'DOCTOR');
    const forDoctor = (await http().get(`/patients/${p.id}`).set(auth(doctor)).expect(200)).body;
    expect(forDoctor).not.toHaveProperty('outbox');
    expect(forDoctor.channels).toHaveLength(1);
  });
});

describe('«Листування»: входящие сообщения и ответ сотрудника', () => {
  const msg = (chatId: number, text: string) => ({ update_id: 1, message: { chat: { id: chatId }, from: { id: chatId, username: 'user', first_name: 'Олена' }, text } });
  async function setup() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Коваль Олена' } });
    const chat = String(Math.floor(Math.random() * 1e9));
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: chat } });
    return { ...c, p, chat };
  }

  it('сообщение сохраняется у пациента, один автоответ в сутки; сотрудник читает и отвечает только при включённой отправке', async () => {
    const q = await setup();
    await telegram.handleUpdate(q.clinicId, TOKEN, msg(Number(q.chat), 'Добрий день, можна перенести візит?'));
    await telegram.handleUpdate(q.clinicId, TOKEN, msg(Number(q.chat), 'на п’ятницю'));
    expect(tg.sent.filter((s) => s.text.includes('отримано'))).toHaveLength(1);

    const list = (await http().get('/conversations').set(auth(q.token)).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ chatId: q.chat, unread: 2, patient: { fullName: 'Коваль Олена' } });

    const thread = (await http().get(`/conversations/TELEGRAM/${q.chat}`).set(auth(q.token)).expect(200)).body;
    expect(thread.messages.map((m: { text: string }) => m.text)).toContain('на п’ятницю');
    expect((await http().get('/conversations').set(auth(q.token))).body[0].unread).toBe(0);

    tg.sent.length = 0;
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: false } });
    await http().post(`/conversations/TELEGRAM/${q.chat}/reply`).set(auth(q.token)).send({ text: 'Так, п’ятниця о 15:00' }).expect(400);
    expect(tg.sent).toHaveLength(0);
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: true } });
    await http().post(`/conversations/TELEGRAM/${q.chat}/reply`).set(auth(q.token)).send({ text: 'Так, п’ятниця о 15:00' }).expect(200);
    expect(tg.sent).toEqual([{ token: TOKEN, chatId: q.chat, text: 'Так, п’ятниця о 15:00', extra: undefined }]);
    const doctor = await member(q.token, 'DOCTOR');
    await http().get('/conversations/TELEGRAM/' + q.chat).set(auth(doctor)).expect(403);
  });

  it('отписавшемуся не ответить; неизвестный чат привязывается вручную; чужая клиника диалог не видит', async () => {
    const q = await setup();
    const stranger = String(Math.floor(Math.random() * 1e9));
    await telegram.handleUpdate(q.clinicId, TOKEN, msg(Number(stranger), 'Хочу записатися'));
    const row = (await http().get('/conversations').set(auth(q.token))).body.find((c: { chatId: string }) => c.chatId === stranger);
    expect(row).toMatchObject({ patient: null, contactName: 'Олена' });

    await http().post(`/conversations/TELEGRAM/${stranger}/link`).set(auth(q.token)).send({ patientId: q.p.id }).expect(200);
    expect((await prisma.patientChannel.findUniqueOrThrow({ where: { patientId_channel: { patientId: q.p.id, channel: 'TELEGRAM' } } })).externalId).toBe(stranger);
    expect((await http().get(`/conversations/TELEGRAM/${stranger}`).set(auth(q.token))).body.patient.fullName).toBe('Коваль Олена');

    await telegram.handleUpdate(q.clinicId, TOKEN, msg(Number(stranger), 'Зупинити'));
    await http().post(`/conversations/TELEGRAM/${stranger}/reply`).set(auth(q.token)).send({ text: 'Привіт' }).expect(400);

    const other = await clinic();
    expect((await http().get('/conversations').set(auth(other.token))).body).toHaveLength(0);
    await http().get(`/conversations/TELEGRAM/${stranger}`).set(auth(other.token)).expect(404);
    await http().post(`/conversations/TELEGRAM/${stranger}/reply`).set(auth(other.token)).send({ text: 'x' }).expect(404);
    await http().post(`/conversations/TELEGRAM/${stranger}/link`).set(auth(other.token)).send({ patientId: q.p.id }).expect(404);
  });
});

describe('новые сценарии: благодарность, продолжить лечение, давно не были, день рождения', () => {
  const DAYMS = 86_400_000;
  async function enable(token: string, ...keys: string[]) {
    for (const k of keys) await http().patch(`/automations/rules/${k}`).set(auth(token)).send({ enabled: true }).expect(200);
  }
  async function person(clinicId: string, over: Record<string, unknown> = {}, tgChat = true) {
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Ткач Оксана Петрівна', consent: 'GIVEN', ...over } });
    if (tgChat) await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
    return p;
  }
  const rowsOf = (clinicId: string, key: string) => prisma.outboundMessage.findMany({ where: { clinicId, ruleKey: key } });

  it('благодарность после визита: один раз в день на пациента, только по состоявшемуся визиту', async () => {
    const { token, clinicId } = await clinic();
    await enable(token, 'post-visit-thanks');
    const p = await person(clinicId, { consent: 'UNKNOWN' }); // service: consent is not needed
    const at = new Date(Date.now() - 24 * 3_600_000);
    await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: at, endsAt: new Date(at.getTime() + 1800_000), status: 'VISITED' } });
    await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: new Date(at.getTime() + 1000), endsAt: new Date(at.getTime() + 1900_000), status: 'VISITED' } });
    const q = await person(clinicId);
    await prisma.visit.create({ data: { clinicId, patientId: q.id, externalId: `v${rnd()}`, startsAt: at, endsAt: new Date(at.getTime() + 1800_000), status: 'DID_NOT_COME' } });
    await planner.plan(clinicId, { dryRun: false });
    await planner.plan(clinicId, { dryRun: false });
    const rows = await rowsOf(clinicId, 'post-visit-thanks');
    expect(rows).toHaveLength(1);
    expect(rows[0].patientId).toBe(p.id);
    expect(rows[0].text).toContain('дякуємо');
  });

  it('продолжить лечение и «давно не были»: только с согласием, без будущей записи, срок наступил недавно; повторно не создаётся', async () => {
    const { token, clinicId } = await clinic();
    await enable(token, 'continue-treatment', 'lapsed');
    const ago = (days: number) => new Date(Date.now() - days * DAYMS);
    const item = (patientId: string, status: string, done?: Date) => prisma.planItem.create({ data: { clinicId, patientId, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Лікування', status, groupName: 'Терапія', createdAtExt: ago(100), markedDoneAt: done ?? null } });

    const open = await person(clinicId, { lastVisitAt: ago(35) });
    await item(open.id, 'DONE', ago(35));
    await item(open.id, 'PLANNED_TO_DO');
    const noConsent = await person(clinicId, { lastVisitAt: ago(35), consent: 'UNKNOWN' });
    await item(noConsent.id, 'DONE', ago(35));
    await item(noConsent.id, 'NEW');
    const booked = await person(clinicId, { lastVisitAt: ago(35) });
    await item(booked.id, 'DONE', ago(35));
    await item(booked.id, 'NEW');
    await prisma.visit.create({ data: { clinicId, patientId: booked.id, externalId: `v${rnd()}`, startsAt: new Date(Date.now() + 5 * DAYMS), endsAt: new Date(Date.now() + 5 * DAYMS + 1800_000), status: 'PLANNED' } });
    const lapsed = await person(clinicId, { lastVisitAt: ago(185) });
    const tooOld = await person(clinicId, { lastVisitAt: ago(400) });

    const rep = await planner.plan(clinicId, { dryRun: false });
    const by = (k: string) => rep.find((r) => r.key === k)!;
    expect(by('continue-treatment')).toMatchObject({ candidates: 2, toQueue: 1, blockedConsent: 1 });
    expect(by('lapsed')).toMatchObject({ toQueue: 1 });
    expect((await rowsOf(clinicId, 'continue-treatment')).map((r) => r.patientId)).toEqual([open.id]);
    expect((await rowsOf(clinicId, 'lapsed')).map((r) => r.patientId)).toEqual([lapsed.id]);
    expect(tooOld.id).toBeTruthy();
    // marketing waits for confirmation; a repeated run adds nothing
    expect((await rowsOf(clinicId, 'lapsed'))[0].status).toBe('PENDING_APPROVAL');
    await planner.plan(clinicId, { dryRun: false });
    expect(await prisma.outboundMessage.count({ where: { clinicId } })).toBe(2);
  });

  it('день рождения: сегодняшним с согласием; и не чаще одного маркетингового сообщения в 14 дней (кроме поздравления)', async () => {
    const { token, clinicId } = await clinic();
    await enable(token, 'birthday', 'lapsed');
    const today = clinicDate(new Date());
    const bd = new Date(`1990-${today.slice(5)}T00:00:00Z`);
    const yes = await person(clinicId, { birthDate: bd });
    const other = await person(clinicId, { birthDate: new Date('1990-01-01T00:00:00Z') });
    await planner.plan(clinicId, { dryRun: false });
    expect((await rowsOf(clinicId, 'birthday')).map((r) => r.patientId)).toEqual([yes.id]);
    expect(other.id).toBeTruthy();

    // "long absent" for the same patient: a message already existed, but a birthday greeting does not count towards the frequency
    await prisma.patient.update({ where: { id: yes.id }, data: { lastVisitAt: new Date(Date.now() - 185 * DAYMS) } });
    await planner.plan(clinicId, { dryRun: false });
    expect(await rowsOf(clinicId, 'lapsed')).toHaveLength(1);
    // but a second marketing message in a row does
    await http().patch('/automations/rules/continue-treatment').set(auth(token)).send({ enabled: true }).expect(200);
    await prisma.planItem.create({ data: { clinicId, patientId: yes.id, externalId: `i${rnd()}`, planId: 'plx', name: 'Л', status: 'DONE', groupName: 'Т', createdAtExt: new Date(), markedDoneAt: new Date() } });
    await prisma.planItem.create({ data: { clinicId, patientId: yes.id, externalId: `i${rnd()}`, planId: 'plx', name: 'Л2', status: 'NEW', groupName: 'Т', createdAtExt: new Date() } });
    await prisma.patient.update({ where: { id: yes.id }, data: { lastVisitAt: new Date(Date.now() - 35 * DAYMS) } });
    const rep = await planner.plan(clinicId, { dryRun: false });
    expect(rep.find((r) => r.key === 'continue-treatment')).toMatchObject({ candidates: 1, tooSoon: 1, toQueue: 0 });
  });
});

describe('своя рассылка (акция)', () => {
  const DAYMS = 86_400_000;
  async function setup() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    const mk = async (name: string, over: Record<string, unknown>, tgChat = true) => {
      const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: name, ...over } });
      if (tgChat) await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
      return p;
    };
    const ok = await mk('Іваненко Ірина', { consent: 'GIVEN', lastVisitAt: new Date(Date.now() - 400 * DAYMS) });
    const noConsent = await mk('Без Згоди', { consent: 'UNKNOWN', lastVisitAt: new Date(Date.now() - 400 * DAYMS) });
    const withdrawn = await mk('Відмовився Петро', { consent: 'WITHDRAWN', lastVisitAt: new Date(Date.now() - 400 * DAYMS) });
    const noTg = await mk('Без Телеграму', { consent: 'GIVEN', lastVisitAt: new Date(Date.now() - 400 * DAYMS) }, false);
    const recent = await mk('Нещодавній Візит', { consent: 'GIVEN', lastVisitAt: new Date(Date.now() - 30 * DAYMS) });
    return { ...c, ok, noConsent, withdrawn, noTg, recent };
  }

  it('аудитория считается по фильтрам и согласию; очередь ждёт подтверждения; отправка только с согласием в момент отправки', async () => {
    const q = await setup();
    await http().post('/campaigns').set(auth(q.token)).send({ name: 'Акція', text: 'Є {unknown}, привіт', filters: {} }).expect(400);
    await http().post('/campaigns').set(auth(q.token)).send({ name: 'Акція', text: 'Привіт, {name}! Знижка 20% на гігієну до кінця місяця. Клініка «{clinic}».', filters: { monthsSinceVisitMin: 12, monthsSinceVisitMax: 5 } }).expect(400);
    const c = (await http().post('/campaigns').set(auth(q.token)).send({ name: 'Акція на гігієну', text: 'Привіт, {name}! Знижка 20% на гігієну до кінця місяця. Клініка «{clinic}».', filters: { monthsSinceVisitMin: 12 } }).expect(201)).body;

    const prev = (await http().get(`/campaigns/${c.id}/preview`).set(auth(q.token)).expect(200)).body;
    expect(prev).toMatchObject({ matched: 4, noConsent: 1, paused: 1, noChannel: 1, toQueue: 1 }); // "Recent Visit" is filtered out
    expect(prev.sample[0].text).toContain('Ірина');
    expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId } })).toBe(0); // the preview creates nothing

    const queued = (await http().post(`/campaigns/${c.id}/queue`).set(auth(q.token)).expect(200)).body;
    expect(queued.toQueue).toBe(1);
    await http().post(`/campaigns/${c.id}/queue`).set(auth(q.token)).expect(400); // a second time is not allowed
    const msg = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: q.clinicId } });
    expect(msg).toMatchObject({ patientId: q.ok.id, status: 'PENDING_APPROVAL', ruleKey: `campaign:${c.id}` });

    // does not go out by itself
    await prisma.outboundMessage.update({ where: { id: msg.id }, data: { scheduledFor: new Date(0) } });
    const noon = localToUtc(`${clinicDate(new Date())} 12:00:00`);
    expect((await outbox.process(noon, { clinicId: q.clinicId })).sent).toBe(0);
    // confirmed, but the patient managed to withdraw consent: it does not go out
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    await prisma.patient.update({ where: { id: q.ok.id }, data: { consent: 'UNKNOWN' } });
    await outbox.process(noon, { clinicId: q.clinicId });
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe('CANCELLED');
    expect(tg.sent).toHaveLength(0);

    // the campaign name is visible in the log
    const list = (await http().get('/messages').set(auth(q.token)).expect(200)).body;
    expect(list.rows[0].campaignName).toBe('Акція на гігієну');
  });

  it('рассылку создают владелец и управляющий; чужая клиника её не видит; со согласием и подтверждением сообщение уходит', async () => {
    const q = await setup();
    const admin = await member(q.token, 'ADMIN');
    await http().post('/campaigns').set(auth(admin)).send({ name: 'Тест', text: 'Привіт, {name}! Акція триває. Клініка «{clinic}».', filters: {} }).expect(403);
    await http().get('/campaigns').set(auth(admin)).expect(200);
    const c = (await http().post('/campaigns').set(auth(q.token)).send({ name: 'Тест', text: 'Привіт, {name}! Акція триває. Клініка «{clinic}».', filters: { noFutureVisit: true } }).expect(201)).body;
    const other = await clinic();
    expect((await http().get('/campaigns').set(auth(other.token))).body).toHaveLength(0);
    await http().get(`/campaigns/${c.id}/preview`).set(auth(other.token)).expect(404);
    await http().post(`/campaigns/${c.id}/queue`).set(auth(other.token)).expect(404);
    await http().delete(`/campaigns/${c.id}`).set(auth(other.token)).expect(404);

    await http().post(`/campaigns/${c.id}/queue`).set(auth(q.token)).expect(200);
    const msgs = await prisma.outboundMessage.findMany({ where: { clinicId: q.clinicId } });
    expect(msgs.map((m) => m.patientId).sort()).toEqual([q.ok.id, q.recent.id].sort());
    await prisma.outboundMessage.updateMany({ where: { clinicId: q.clinicId }, data: { scheduledFor: new Date(0) } });
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    const noon = localToUtc(`${clinicDate(new Date())} 12:00:00`);
    expect((await outbox.process(noon, { clinicId: q.clinicId })).sent).toBe(2);
    await http().delete(`/campaigns/${c.id}`).set(auth(q.token)).expect(404); // a sent campaign cannot be deleted
  });
});

describe('результат сообщений для воронки', () => {
  const DAYMS = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * DAYMS);

  it('считает отправленные, ответы, записи после сообщения и пришедших; конверсия только по сообщениям старше 14 дней; записи до сообщения и отменённые не считаются', async () => {
    const { token, clinicId } = await clinic();
    const mk = (name: string) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: name, consent: 'GIVEN' } });
    const send = (patientId: string, ruleKey: string, days: number, visitId?: string) =>
      prisma.outboundMessage.create({ data: { clinicId, patientId, ruleKey, channel: 'TELEGRAM', text: 'x', status: 'SENT', scheduledFor: ago(days), sentAt: ago(days), dedupeKey: `r${rnd()}`, visitId } });
    const visit = (patientId: string, status: string, bookedDaysAgo: number, startsIn = 1) =>
      prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: new Date(Date.now() + startsIn * DAYMS), endsAt: new Date(Date.now() + startsIn * DAYMS + 1800_000), status, bookedAt: ago(bookedDaysAgo) } });

    const camp = await prisma.campaign.create({ data: { clinicId, name: 'Акція', text: 'x', filters: {}, status: 'QUEUED' } });
    const a = await mk('А'); // booked and came, the message is old
    const b = await mk('Б'); // did not book
    const c = await mk('В'); // booked recently, the message is fresh, replied to the bot
    const d = await mk('Г'); // the appointment was BEFORE the message
    const e = await mk('Д'); // записался, но отменил
    for (const p of [a, b, d, e]) await send(p.id, `campaign:${camp.id}`, 20);
    await send(c.id, `campaign:${camp.id}`, 3);
    await visit(a.id, 'VISITED', 18);
    await visit(c.id, 'PLANNED', 1);
    await visit(d.id, 'PLANNED', 25);
    await visit(e.id, 'CANCELLED', 18);
    await prisma.chatMessage.create({ data: { clinicId, patientId: c.id, channel: 'TELEGRAM', chatId: 'cc', direction: 'IN', text: 'Дякую', createdAt: ago(2) } });

    // appointment reminders: the outcome of the appointment itself
    const r1 = await visit(a.id, 'VISITED', 40, -5);
    const r2 = await visit(b.id, 'DID_NOT_COME', 40, -5);
    await send(a.id, 'visit-reminder', 6, r1.id);
    await send(b.id, 'visit-reminder', 6, r2.id);

    const res = (await http().get('/messages/results?months=3').set(auth(token)).expect(200)).body;
    const campRow = res.rows.find((r: { key: string }) => r.key === `campaign:${camp.id}`);
    expect(campRow).toMatchObject({ label: 'Акція', sent: 5, replied: 1, booked: 2, attended: 1, matured: 4, bookedMatured: 1 });
    const rem = res.rows.find((r: { key: string }) => r.key === 'visit-reminder');
    expect(rem).toMatchObject({ sent: 2, attendedVisit: 1, noShowVisit: 1, cancelledVisit: 0 });
    expect(res.attributionDays).toBe(14);

    // a doctor does not see it; another clinic does not see it
    const doctor = await member(token, 'DOCTOR');
    await http().get('/messages/results').set(auth(doctor)).expect(403);
    const other = await clinic();
    expect((await http().get('/messages/results').set(auth(other.token)).expect(200)).body.rows).toEqual([]);
  });
});

describe('согласие на рекламные сообщения', () => {
  it('по умолчанию «Невідомо» не считается согласием; после подтверждения владельцем считается; отказ блокирует всегда', async () => {
    const q = await (async () => {
      const c = await clinic();
      await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
      const mk = async (name: string, consent: 'UNKNOWN' | 'GIVEN' | 'WITHDRAWN') => {
        const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: name, consent, lastVisitAt: new Date(Date.now() - 400 * 86_400_000) } });
        await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
        return p;
      };
      return { ...c, unknown: await mk('Невідомо', 'UNKNOWN'), given: await mk('Згода', 'GIVEN'), withdrawn: await mk('Відмова', 'WITHDRAWN') };
    })();
    const camp = (await http().post('/campaigns').set(auth(q.token)).send({ name: 'Акція', text: 'Привіт, {name}! Акція триває. Клініка «{clinic}».', filters: {} }).expect(201)).body;
    expect((await http().get(`/campaigns/${camp.id}/preview`).set(auth(q.token))).body).toMatchObject({ matched: 3, noConsent: 1, paused: 1, toQueue: 1 });

    const admin = await member(q.token, 'ADMIN');
    await http().patch('/automations/settings').set(auth(admin)).send({ assumeConsent: true }).expect(403); // only the owner and the manager
    expect((await http().patch('/automations/settings').set(auth(q.token)).send({ assumeConsent: true }).expect(200)).body.assumeConsent).toBe(true);
    expect(await prisma.auditLog.count({ where: { clinicId: q.clinicId, action: 'automation.settings' } })).toBe(1);
    expect((await http().get('/automations').set(auth(q.token))).body.settings.assumeConsent).toBe(true);
    expect((await http().get(`/campaigns/${camp.id}/preview`).set(auth(q.token))).body).toMatchObject({ matched: 3, noConsent: 0, paused: 1, toQueue: 2 });

    // consent is re-checked at sending, taking the setting into account
    await http().post(`/campaigns/${camp.id}/queue`).set(auth(q.token)).expect(200);
    await prisma.outboundMessage.updateMany({ where: { clinicId: q.clinicId }, data: { scheduledFor: new Date(0) } });
    await http().post('/messages/approve').set(auth(q.token)).send({ all: true }).expect(200);
    await http().patch('/automations/settings').set(auth(q.token)).send({ assumeConsent: false }).expect(200);
    const noon = localToUtc(`${clinicDate(new Date())} 12:00:00`);
    expect((await outbox.process(noon, { clinicId: q.clinicId })).sent).toBe(1); // "Unknown" no longer counts as consent, only "Consent" is left
    expect(tg.sent).toHaveLength(1);
  });
});

describe('дайджест руководителю в Telegram', () => {
  const DAYMS = 86_400_000;
  const upd = (chatId: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: 1, message: { chat: { id: chatId }, from: { id: chatId, first_name: 'Ольга', language_code: 'uk', ...extra }, text } });
  const ago = (d: number, h = 0) => new Date(Date.now() - d * DAYMS - h * 3_600_000);

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    return c;
  }
  async function bind(token: string, clinicId: string, chat = 9001) {
    const { url } = (await http().post('/digest/link').set(auth(token)).expect(201)).body;
    await telegram.handleUpdate(clinicId, TOKEN, upd(chat, `/start owner_${url.split('owner_')[1]}`));
    return url as string;
  }

  it('руководитель привязывает чат ссылкой (не телефоном); ссылка одноразовая; чужая и просроченная не работают; права только у владельца и управляющего', async () => {
    const c = await ready();
    const url = await bind(c.token, c.clinicId);
    expect(url).toMatch(/^https:\/\/t\.me\/clinic_test_bot\?start=owner_/);
    expect(tg.sent.at(-1)!.text).toContain('Дайджест підключено');
    const s = (await http().get('/digest').set(auth(c.token)).expect(200)).body;
    expect(s.recipients).toEqual([expect.objectContaining({ name: 'Ольга', lang: 'uk' })]);

    // reuse and forgery
    tg.sent.length = 0;
    await telegram.handleUpdate(c.clinicId, TOKEN, upd(9002, `/start owner_${url.split('owner_')[1]}`));
    expect(tg.sent.at(-1)!.text).toContain('недійсне');
    await telegram.handleUpdate(c.clinicId, TOKEN, upd(9002, '/start owner_fake'));
    expect((await http().get('/digest').set(auth(c.token))).body.recipients).toHaveLength(1);
    // a link of another clinic will not work in this one
    const b = await ready();
    const urlB = (await http().post('/digest/link').set(auth(b.token)).expect(201)).body.url as string;
    await telegram.handleUpdate(c.clinicId, TOKEN, upd(9003, `/start owner_${urlB.split('owner_')[1]}`));
    expect((await http().get('/digest').set(auth(c.token))).body.recipients).toHaveLength(1);

    const admin = await member(c.token, 'ADMIN');
    await http().get('/digest').set(auth(admin)).expect(403);
    await http().post('/digest/link').set(auth(admin)).expect(403);
    await http().patch('/digest').set(auth(admin)).send({ frequency: 'DAILY' }).expect(403);
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'MONTHLY' }).expect(400);
    await http().patch('/digest').set(auth(c.token)).send({ hour: 25 }).expect(400);
    expect((await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY', hour: 8, weekday: 5 }).expect(200)).body).toMatchObject({ frequency: 'WEEKLY', hour: 8, weekday: 5 });
    // the recipient's message does not count as a patient's inquiry
    const before = await prisma.chatMessage.count({ where: { clinicId: c.clinicId } });
    await telegram.handleUpdate(c.clinicId, TOKEN, upd(9001, 'привіт'));
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(before);
    const id = s.recipients[0].id;
    await http().delete(`/digest/recipients/${id}`).set(auth(b.token)).expect(404);
    await http().delete(`/digest/recipients/${id}`).set(auth(c.token)).expect(200);
    expect((await http().get('/digest').set(auth(c.token))).body.recipients).toHaveLength(0);
  });

  it('цифры дайджеста: за прошлую неделю против позапрошлой; текст с деньгами и предупреждениями; команда /digest', async () => {
    const c = await ready();
    await bind(c.token, c.clinicId);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Дайджест Тест', createdAtExt: ago(3) } });
    const old = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Давній', createdAtExt: ago(10) } });
    const visit = (patientId: string, status: string, days: number, bookedDays = days + 2) => prisma.visit.create({ data: { clinicId: c.clinicId, patientId, externalId: `v${rnd()}`, startsAt: ago(days), endsAt: ago(days), status, bookedAt: ago(bookedDays) } });
    await visit(p.id, 'VISITED', 2);
    await visit(p.id, 'VISITED', 3);
    await visit(p.id, 'DID_NOT_COME', 4);
    await visit(p.id, 'CANCELLED', 5);
    await visit(old.id, 'VISITED', 9); // last week
    await visit(old.id, 'PLANNED', 20); // long not closed
    await visit(p.id, 'PLANNED', -2); // future
    await prisma.payment.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `pay${rnd()}`, paidAt: ago(2), amount: 12500 } });
    await prisma.payment.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `pay${rnd()}`, paidAt: ago(10), amount: 4000 } });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'x', kind: 'BOOKING', summary: 's', createdAt: ago(2) } });
    const svc = (await import('../src/automations/digest.service')).DigestService;
    const digest = (app as INestApplication).get(svc);
    const n = await digest.numbers(c.clinicId, 'WEEKLY');
    expect(n).toMatchObject({ visited: 2, noShow: 1, cancelled: 1, newPatients: 1, paid: 12500, upcoming: 1, requestsNew: 1, requestsOpen: 1, unclosed: 1 });
    expect(n.prev).toMatchObject({ visited: 1, newPatients: 1, paid: 4000 });

    const text = digest.format(n, 'Моя клініка', 'WEEKLY', 'uk', 'https://x/analytics');
    expect(text).toContain('Дайджест клініки «Моя клініка»');
    expect(text).toContain('проведено 2 (було 1)');
    expect(text).toContain('Оплати: 12 500 (було 4 000)');
    expect(text).toContain('Записів минулих днів без підсумку: 1');
    expect(text).toContain('Є заявки без відповіді: 1');
    expect(digest.format(n, 'Clinic', 'WEEKLY', 'en', 'u')).toContain('Appointments: completed 2 (was 1)');

    tg.sent.length = 0;
    await telegram.handleUpdate(c.clinicId, TOKEN, upd(9001, '/digest'));
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({ chatId: '9001' });
    expect(tg.sent[0].text).toContain('проведено 2');
    expect((await http().post('/digest/test').set(auth(c.token)).expect(200)).body.sent).toBe(1);
  });

  it('расписание: в нужный час и день один раз; без получателей и при выключении молчит; не зависит от отправки пациентам', async () => {
    const c = await ready();
    await bind(c.token, c.clinicId);
    const digest = (app as INestApplication).get((await import('../src/automations/digest.service')).DigestService);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
    const at = (hm: string) => localToUtc(`${clinicDate(new Date())} ${hm}:00`);
    const weekday = new Date(`${clinicDate(new Date())}T00:00:00Z`).getUTCDay() || 7;

    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'OFF' }).expect(200);
    tg.sent.length = 0;
    await digest.tick(at('10:00'), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(0);

    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY', hour: 9, weekday: weekday === 7 ? 1 : weekday + 1 }).expect(200);
    await digest.tick(at('10:00'), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(0); // not the right weekday

    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY', hour: 9, weekday }).expect(200);
    await digest.tick(at('08:00'), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(0); // too early
    await digest.tick(at('10:00'), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(1);
    await digest.tick(at('10:05'), { clinicId: c.clinicId });
    expect(tg.sent).toHaveLength(1); // already sent today
  });

  it('цикл розсилки з областю одної клініки не чіпає чужі: інша клініка, якій дайджест належить цього дня, лишається неторканою', async () => {
    const mine = await ready();
    const other = await ready();
    await bind(mine.token, mine.clinicId);
    await bind(other.token, other.clinicId);
    const digest = (app as INestApplication).get((await import('../src/automations/digest.service')).DigestService);
    const weekday = new Date(`${clinicDate(new Date())}T00:00:00Z`).getUTCDay() || 7;
    for (const c of [mine, other]) {
      await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY', hour: 9, weekday }).expect(200);
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false, lastDigestAt: new Date(Date.now() - 8 * 86_400_000) } }); // due again, as every week
    }
    tg.sent.length = 0;
    await digest.tick(localToUtc(`${clinicDate(new Date())} 10:00:00`), { clinicId: mine.clinicId });
    expect(tg.sent).toHaveLength(1);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: other.clinicId } })).lastDigestAt!.getTime()).toBeLessThan(Date.now() - 7 * 86_400_000);
  });
});

describe('отзывы и качество: оценка после визита', () => {
  const DAYMS = 86_400_000;
  const ago = (d: number, h = 0) => new Date(Date.now() - d * DAYMS - h * 3_600_000);
  const cb = (chat: string, data: string) => ({ update_id: 1, callback_query: { id: `cb${rnd()}`, from: { id: Number(chat) }, message: { chat: { id: Number(chat) } }, data } });
  const msg = (chat: string, text: string) => ({ update_id: 1, message: { chat: { id: Number(chat) }, from: { id: Number(chat), first_name: 'Іра' }, text } });

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/automations/rules/visit-review').set(auth(c.token)).send({ enabled: true }).expect(200);
    const chat = String(Math.floor(Math.random() * 1e9));
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Оцінка Ірина' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: chat } });
    const visit = (days: number, hours = 0, doctor = 'Лікар Перший') => prisma.visit.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: ago(days, hours), endsAt: ago(days, hours), status: 'VISITED', doctorName: doctor } });
    return { ...c, chat, p, visit };
  }

  it('просьба об оценке уходит через несколько часов после визита с кнопками 1-5, один раз', async () => {
    const q = await ready();
    const fresh = await q.visit(0, 1); // an hour ago: too early
    expect((await planner.plan(q.clinicId, { dryRun: false })).find((r) => r.key === 'visit-review')).toMatchObject({ candidates: 0 });
    await prisma.visit.update({ where: { id: fresh.id }, data: { startsAt: ago(0, 5), endsAt: ago(0, 5) } });
    await planner.plan(q.clinicId, { dryRun: false });
    await planner.plan(q.clinicId, { dryRun: false });
    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: q.clinicId, ruleKey: 'visit-review' } });
    expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId } })).toBe(1);
    expect(row.visitId).toBe(fresh.id);
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { status: 'APPROVED', scheduledFor: new Date(0), expiresAt: new Date(Date.now() + DAYMS) } });
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: true } });
    await outbox.process(localToUtc(`${clinicDate(new Date())} 12:00:00`), { clinicId: q.clinicId });
    const kb = (tg.sent.at(-1)!.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard[0];
    expect(kb.map((b) => b.text)).toEqual(['1', '2', '3', '4', '5']);
    expect(kb[4].callback_data).toBe(`rate|${fresh.id}|5`);
  });

  it('высокая оценка: сохраняется, благодарность со ссылкой на отзыв; повторное нажатие меняет оценку, а не создаёт вторую; чужой чат не может оценить', async () => {
    const q = await ready();
    await http().patch('/reviews/settings').set(auth(q.token)).send({ reviewUrl: 'ftp://x' }).expect(400);
    await http().patch('/reviews/settings').set(auth(q.token)).send({ reviewUrl: 'https://g.page/r/test/review' }).expect(200);
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: true } });
    const v = await q.visit(1);
    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `rate|${v.id}|5`));
    expect(tg.sent.at(-1)!.text).toContain('https://g.page/r/test/review');
    expect(await prisma.review.findUniqueOrThrow({ where: { visitId: v.id } })).toMatchObject({ rating: 5, doctorName: 'Лікар Перший', awaitingUntil: null });
    expect(await prisma.bookingRequest.count({ where: { clinicId: q.clinicId } })).toBe(0); // a good rating creates no request

    // the same neutral invitation goes to a low rating too (never only to the satisfied), and the complaint flow still starts
    const low = await q.visit(2, 0, 'Лікар Третій');
    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `rate|${low.id}|2`));
    expect(tg.sent.at(-1)!.text).toContain('Розкажіть одним повідомленням');
    expect(tg.sent.at(-1)!.text).toContain('https://g.page/r/test/review');
    expect(await prisma.bookingRequest.count({ where: { clinicId: q.clinicId, kind: 'REVIEW' } })).toBe(1);
    await prisma.bookingRequest.deleteMany({ where: { clinicId: q.clinicId } });
    await prisma.review.delete({ where: { visitId: low.id } });

    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `rate|${v.id}|4`));
    expect(await prisma.review.count({ where: { clinicId: q.clinicId } })).toBe(1);
    expect((await prisma.review.findUniqueOrThrow({ where: { visitId: v.id } })).rating).toBe(4);

    // another chat and forgery
    const other = await ready();
    await telegram.handleUpdate(other.clinicId, TOKEN, cb(other.chat, `rate|${v.id}|1`));
    await telegram.handleUpdate(q.clinicId, TOKEN, cb('424242', `rate|${v.id}|1`));
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `rate|${v.id}|9`));
    expect((await prisma.review.findUniqueOrThrow({ where: { visitId: v.id } })).rating).toBe(4);
    expect(await prisma.review.count({ where: { clinicId: other.clinicId } })).toBe(0);
  });

  it('низкая оценка: заявка администратору и сообщение в служебный чат; комментарий пациента попадает в отзыв и заявку, ШІ на него не отвечает', async () => {
    const q = await ready();
    await prisma.clinic.update({ where: { id: q.clinicId }, data: { sendingEnabled: true, aiEnabled: true, aiAutoReply: true } });
    const code = (await http().post('/automations/telegram/staff-chat').set(auth(q.token))).body.code;
    await telegram.handleUpdate(q.clinicId, TOKEN, { update_id: 2, message: { chat: { id: -777, type: 'supergroup', title: 'Служба' }, from: { id: 5 }, text: `/chat ${code}` } });
    const v = await q.visit(1, 0, 'Лікар Другий');
    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `rate|${v.id}|2`));
    const note = tg.sent.find((s) => s.chatId === '-777')!;
    expect(note.text).toContain('Низька оцінка візиту');
    expect(note.text).toContain('Оцінка Ірина');
    expect(note.text).toContain('Оцінка 2 з 5, лікар Лікар Другий');
    expect(tg.sent.find((s) => s.chatId === q.chat)!.text).toContain('Розкажіть одним повідомленням');

    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'Довго чекала в черзі, адміністратор була неуважна'));
    const review = await prisma.review.findUniqueOrThrow({ where: { visitId: v.id } });
    expect(review).toMatchObject({ rating: 2, comment: 'Довго чекала в черзі, адміністратор була неуважна', awaitingUntil: null });
    expect(tg.sent.find((s) => s.chatId === q.chat)!.text).toContain('передали керівнику');
    expect(tg.sent.find((s) => s.chatId === '-777')!.text).toContain('Оновлення заявки');
    expect(tg.sent.find((s) => s.chatId === '-777')!.text).toContain('Довго чекала');
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId, kind: 'REVIEW' } });
    expect(req.summary).toContain('Коментар');
    expect(await prisma.bookingRequest.count({ where: { clinicId: q.clinicId } })).toBe(1);
    expect(await prisma.chatMessage.count({ where: { clinicId: q.clinicId, byAi: true } })).toBe(0); // the AI did not answer the complaint
    // the next ordinary message is no longer a comment
    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, msg(q.chat, 'А ще хочу записатися'));
    expect(tg.sent.every((s) => s.chatId !== '-777')).toBe(true);
  });

  it('сводка: средняя, доля довольных, ответившие, по врачам, по месяцам, низкие с комментариями; права; чужая клиника не видна; дайджест', async () => {
    const q = await ready();
    const mk = async (rating: number, doctor: string, days: number, comment?: string) => {
      const v = await q.visit(days, 0, doctor);
      await prisma.review.create({ data: { clinicId: q.clinicId, patientId: q.p.id, visitId: v.id, rating, doctorName: doctor, comment: comment ?? null, createdAt: ago(days) } });
    };
    await mk(5, 'Лікар Перший', 3);
    await mk(5, 'Лікар Перший', 4);
    await mk(4, 'Лікар Другий', 5);
    await mk(2, 'Лікар Другий', 6, 'Довго чекала');
    await prisma.outboundMessage.createMany({ data: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ clinicId: q.clinicId, patientId: q.p.id, ruleKey: 'visit-review', channel: 'TELEGRAM', text: 'x', status: 'SENT', scheduledFor: ago(5), sentAt: ago(5), dedupeKey: `rv${i}-${rnd()}` })) });

    const res = (await http().get('/reviews?months=3').set(auth(q.token)).expect(200)).body;
    expect(res).toMatchObject({ count: 4, average: 4, positivePct: 75, asked: 8, responseRate: 50 });
    expect(res.distribution).toEqual([{ rating: 1, count: 0 }, { rating: 2, count: 1 }, { rating: 3, count: 0 }, { rating: 4, count: 1 }, { rating: 5, count: 2 }]);
    expect(res.byDoctor).toEqual([expect.objectContaining({ doctor: 'Лікар Перший', count: 2, average: 5, low: 0 }), expect.objectContaining({ doctor: 'Лікар Другий', count: 2, average: 3, low: 1 })]);
    expect(res.low).toEqual([expect.objectContaining({ rating: 2, comment: 'Довго чекала', patient: expect.objectContaining({ fullName: 'Оцінка Ірина' }) })]);
    expect(res.settings).toMatchObject({ reviewUrl: null, collecting: true });

    const admin = await member(q.token, 'ADMIN');
    await http().get('/reviews').set(auth(admin)).expect(200);
    await http().patch('/reviews/settings').set(auth(admin)).send({ reviewUrl: 'https://x.example/r' }).expect(403);
    const doctor = await member(q.token, 'DOCTOR');
    await http().get('/reviews').set(auth(doctor)).expect(403);
    const other = await clinic();
    expect((await http().get('/reviews').set(auth(other.token))).body).toMatchObject({ count: 0, average: null });

    // digest: ratings for last week
    const digest = app.get((await import('../src/automations/digest.service')).DigestService);
    const n = await digest.numbers(q.clinicId, 'WEEKLY');
    expect(n.reviews).toMatchObject({ count: 4, avg: 4, low: 1 });
    expect(digest.format(n, 'К', 'WEEKLY', 'uk', 'u')).toContain('Оцінки пацієнтів: середня 4 з 5 (4), низьких 1');
  });
});

describe('подтверждение записи кнопками и сообщение после отмены', () => {
  const DAYMS = 86_400_000;
  const cb = (chat: string, data: string) => ({ update_id: 1, callback_query: { id: `cb${rnd()}`, from: { id: Number(chat) }, message: { chat: { id: Number(chat) } }, data } });

  async function ready() {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true } });
    const chat = String(Math.floor(Math.random() * 1e9));
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Підтвердження Іван' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: chat } });
    return { ...c, chat, p };
  }

  it('напоминание с кнопками: «подтверждаю» запоминается у записи, «перенести» становится заявкой; чужой чат и прошедшая запись не принимаются; без включённой настройки кнопок нет', async () => {
    const q = await ready();
    const v = await prisma.visit.create({ data: { clinicId: q.clinicId, patientId: q.p.id, externalId: `v${rnd()}`, startsAt: new Date(Date.now() + 20 * 3_600_000), endsAt: new Date(Date.now() + 21 * 3_600_000), status: 'PLANNED', bookedAt: new Date(Date.now() - 4 * DAYMS) } });
    const send = async () => {
      await prisma.outboundMessage.deleteMany({ where: { clinicId: q.clinicId } });
      await prisma.outboundMessage.create({ data: { clinicId: q.clinicId, patientId: q.p.id, ruleKey: 'visit-reminder', channel: 'TELEGRAM', text: 'Нагадуємо', status: 'APPROVED', scheduledFor: new Date(0), expiresAt: new Date(Date.now() + DAYMS), dedupeKey: `visit-reminder:${v.id}:24:${v.startsAt.toISOString()}`, visitId: v.id } }); // (made for this time of the visit)
      tg.sent.length = 0;
      await outbox.process(localToUtc(`${clinicDate(new Date())} 12:00:00`), { clinicId: q.clinicId });
      return tg.sent.at(-1)!;
    };
    expect((await send()).extra).toBeUndefined();
    await http().patch('/automations/rules/visit-reminder').set(auth(q.token)).send({ params: { confirmButtons: 'yes' } }).expect(400);
    await http().patch('/automations/rules/visit-reminder').set(auth(q.token)).send({ params: { confirmButtons: true } }).expect(200);
    const sent = await send();
    const kb = (sent.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
    expect(kb.map((b) => b.callback_data)).toEqual([`confirm|${v.id}|y`, `confirm|${v.id}|m`]);

    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, cb('424242', `confirm|${v.id}|y`)); // another chat
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: v.id } })).patientConfirmedAt).toBeNull();
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `confirm|${v.id}|y`));
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: v.id } })).patientConfirmedAt).toBeTruthy();
    expect(tg.sent.at(-1)!.text).toContain('чекаємо на вас');

    const code = (await http().post('/automations/telegram/staff-chat').set(auth(q.token))).body.code;
    await telegram.handleUpdate(q.clinicId, TOKEN, { update_id: 2, message: { chat: { id: -555, type: 'supergroup', title: 'Служба' }, from: { id: 5 }, text: `/chat ${code}` } });
    tg.sent.length = 0;
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `confirm|${v.id}|m`));
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: q.clinicId, kind: 'RESCHEDULE' } });
    expect(req.summary).toContain('просить перенести');
    expect(tg.sent.find((s) => s.chatId === '-555')!.text).toContain('Перенесення');
    // a past appointment is no longer confirmed
    await prisma.visit.update({ where: { id: v.id }, data: { startsAt: new Date(Date.now() - 3_600_000), patientConfirmedAt: null } });
    await telegram.handleUpdate(q.clinicId, TOKEN, cb(q.chat, `confirm|${v.id}|y`));
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: v.id } })).patientConfirmedAt).toBeNull();
  });

  it('после отмены или переноса без новой записи бот спрашивает, когда удобно; если запись уже есть, молчит; повторно не пишет', async () => {
    const q = await ready();
    await http().patch('/automations/rules/cancel-followup').set(auth(q.token)).send({ enabled: true }).expect(200);
    const mkVisit = (patientId: string, status: string, days: number) => prisma.visit.create({ data: { clinicId: q.clinicId, patientId, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - days * DAYMS), endsAt: new Date(Date.now() - days * DAYMS + 1800_000), status } });
    await mkVisit(q.p.id, 'CANCELLED', 2);
    const booked = await prisma.patient.create({ data: { clinicId: q.clinicId, externalId: `p${rnd()}`, fullName: 'Вже Записаний' } });
    await prisma.patientChannel.create({ data: { clinicId: q.clinicId, patientId: booked.id, channel: 'TELEGRAM', externalId: `c${rnd()}` } });
    await mkVisit(booked.id, 'MOVED', 2);
    await prisma.visit.create({ data: { clinicId: q.clinicId, patientId: booked.id, externalId: `v${rnd()}`, startsAt: new Date(Date.now() + 3 * DAYMS), status: 'PLANNED' } });
    await mkVisit(q.p.id, 'CANCELLED', 10); // too long ago
    await planner.plan(q.clinicId, { dryRun: false });
    await planner.plan(q.clinicId, { dryRun: false });
    const rows = await prisma.outboundMessage.findMany({ where: { clinicId: q.clinicId, ruleKey: 'cancel-followup' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].patientId).toBe(q.p.id);
    expect(rows[0].text).toContain('скасовано чи перенесено');
  });
});

describe('напоминания после смены времени записи', () => {
  // an approved, due reminder of a visit in `h` hours (made by the scheduler: its key holds the visit's start)
  async function reminded(h = 20) {
    const c = await clinic();
    await http().post('/automations/telegram').set(auth(c.token)).send({ token: TOKEN }).expect(201);
    await http().patch('/automations/rules/visit-reminder').set(auth(c.token)).send({ enabled: true }).expect(200);
    const x = await patientWithVisit(c.clinicId, h);
    await planner.plan(c.clinicId, { dryRun: false });
    const msg = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(msg.dedupeKey).toBe(`visit-reminder:${x.v.id}:24:${x.v.startsAt.toISOString()}`);
    await http().post('/messages/approve').set(auth(c.token)).send({ all: true }).expect(200);
    await prisma.outboundMessage.update({ where: { id: msg.id }, data: { scheduledFor: new Date(0) } });
    return { ...c, ...x, msg };
  }
  const changed = (clinicId: string, externalId: string, from: Date, to: Date, at = new Date()) =>
    prisma.auditLog.create({ data: { clinicId, action: 'visit.time_changed', details: { visit: externalId, from: from.toISOString(), to: to.toISOString(), source: 'sync' }, createdAt: at } });

  it('старое напоминание после переноса не уходит со старым временем: оно снимается через очередь', async () => {
    const q = await reminded(20);
    await prisma.visit.update({ where: { id: q.v.id }, data: { startsAt: hours(30), endsAt: hours(30.5) } });
    const r = await outbox.process(new Date(), { clinicId: q.clinicId });
    expect(r.sent).toBe(0);
    expect(tg.sent).toHaveLength(0);
    expect(await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('напоминание к новому времени ставится в обычный момент, один раз; не сразу лишь потому, что запись перенесли', async () => {
    const q = await reminded(20);
    const old = q.v.startsAt;
    // moved to 40 hours from now, learned now: the 24-hour reminder of the new time is due in 16 hours, not now
    await prisma.visit.update({ where: { id: q.v.id }, data: { startsAt: hours(40), endsAt: hours(40.5) } });
    await changed(q.clinicId, q.v.externalId, old, hours(40));
    await planner.plan(q.clinicId, { dryRun: false });
    expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId } })).toBe(1); // only the old (stale) one
    const later = hours(17);
    await planner.plan(q.clinicId, { dryRun: false, now: later });
    await planner.plan(q.clinicId, { dryRun: false, now: later });
    const rows = await prisma.outboundMessage.findMany({ where: { clinicId: q.clinicId, ruleKey: 'visit-reminder' }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    const v = await prisma.visit.findUniqueOrThrow({ where: { id: q.v.id } });
    expect(rows[1].dedupeKey).toBe(`visit-reminder:${q.v.id}:24:${v.startsAt.toISOString()}`);
    expect(rows[1].text).toContain(clinicHm(v.startsAt));
    // moved into the window of the reminder, after its moment: no reminder only because of the move
    const q2 = await reminded(20);
    await prisma.visit.update({ where: { id: q2.v.id }, data: { startsAt: hours(22), endsAt: hours(22.5) } });
    await changed(q2.clinicId, q2.v.externalId, q2.v.startsAt, hours(22));
    await planner.plan(q2.clinicId, { dryRun: false });
    expect(await prisma.outboundMessage.count({ where: { clinicId: q2.clinicId } })).toBe(1);
  });

  it('отменённая запись не получает напоминание', async () => {
    const q = await reminded(20);
    await prisma.visit.update({ where: { id: q.v.id }, data: { status: 'CANCELLED' } });
    expect((await outbox.process(new Date(), { clinicId: q.clinicId })).sent).toBe(0);
    expect(tg.sent).toHaveLength(0);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: q.msg.id } })).status).toBe('CANCELLED');
    await planner.plan(q.clinicId, { dryRun: false });
    expect(await prisma.outboundMessage.count({ where: { clinicId: q.clinicId } })).toBe(1);
  });
});

describe('напоминания о записи в привязанный диалог Instagram', () => {
  // the Instagram channel adapter is replaced: nothing leaves the server; the window rule of MessengerService runs for real
  const ig = { calls: [] as { clinicId: string; chatId: string; text: string; options: unknown[] }[], mode: 'ok' as 'ok' | 'ambiguous' | 'refused' };
  beforeAll(() => {
    jest.spyOn(app.get(InstagramAdapter), 'send').mockImplementation(async (clinicId: string, chatId: string, text: string, options: unknown[]) => {
      if (ig.mode === 'ambiguous') throw new SendError('no answer from the provider', false, 'failed', true);
      if (ig.mode === 'refused') throw new SendError('provider refused', false, 'failed', false);
      ig.calls.push({ clinicId, chatId, text, options });
    });
  });
  beforeEach(() => {
    ig.calls.length = 0;
    ig.mode = 'ok';
  });
  const noon = () => localToUtc(`${clinicDate(new Date())} 12:00:00`);
  async function igClinic(o: { connected?: boolean } = {}) {
    const c = await clinic();
    await http().patch('/automations/rules/visit-reminder').set(auth(c.token)).send({ enabled: true }).expect(200);
    if (o.connected !== false) await prisma.integration.create({ data: { clinicId: c.clinicId, provider: 'INSTAGRAM', apiKeyEnc: encrypt('ig-test-token') } });
    return c;
  }
  // a patient whose Instagram conversation (IGSID) is linked to the card, the last message `lastInH` hours ago, a visit in 20 hours booked long ago
  async function igPatient(clinicId: string, lastInH = 2, over: Record<string, unknown> = {}) {
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Мороз Олена', ...over } });
    const igsid = `igsid${rnd()}`;
    await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: igsid } });
    await prisma.chatMessage.create({ data: { clinicId, patientId: p.id, channel: 'INSTAGRAM', chatId: igsid, direction: 'IN', text: 'Дякую', createdAt: hours(-lastInH) } });
    const v = await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: hours(20), endsAt: hours(20.5), status: 'PLANNED', bookedAt: hours(-72) } });
    return { p, v, igsid };
  }
  const approveAll = async (c: { clinicId: string; token: string }) => {
    await http().post('/messages/approve').set(auth(c.token)).send({ all: true }).expect(200);
    await prisma.outboundMessage.updateMany({ where: { clinicId: c.clinicId }, data: { scheduledFor: new Date(0) } });
  };
  const rem = (r: { key: string }[]) => r.find((x) => x.key === 'visit-reminder') as unknown as Record<string, number>;

  it('немає Telegram, діалог Instagram прив’язано, вікно відкрите: одне напоминання в Instagram, лише текст, без кнопок і посилань Telegram; повторний запуск не дублює', async () => {
    const c = await igClinic();
    const x = await igPatient(c.clinicId, 2);
    await http().patch('/automations/rules/visit-reminder').set(auth(c.token)).send({ params: { confirmButtons: true } }).expect(200);
    const r = await planner.plan(c.clinicId, { dryRun: false });
    expect(rem(r)).toMatchObject({ toQueue: 1, noChannel: 0, windowClosed: 0 });
    await planner.plan(c.clinicId, { dryRun: false });
    const rows = await prisma.outboundMessage.findMany({ where: { clinicId: c.clinicId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'INSTAGRAM', visitId: x.v.id });
    expect(rows[0].text).toContain(clinicHm(x.v.startsAt));
    await approveAll(c);
    expect(await outbox.process(noon(), { clinicId: c.clinicId })).toMatchObject({ sent: 1 });
    expect(await outbox.process(noon(), { clinicId: c.clinicId })).toMatchObject({ sent: 0 });
    expect(ig.calls).toEqual([{ clinicId: c.clinicId, chatId: x.igsid, text: rows[0].text, options: [] }]);
    expect(ig.calls[0].text).not.toMatch(/t\.me|callback|Підтверджую/);
    expect(tg.sent).toHaveLength(0);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: rows[0].id } })).status).toBe('SENT');
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: x.igsid, direction: 'OUT', text: rows[0].text } })).toBe(1);
  });

  it('Telegram має пріоритет: пацієнт з Telegram і Instagram отримує напоминання лише в Telegram', async () => {
    const c = await igClinic();
    const x = await igPatient(c.clinicId, 2);
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: x.p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
    await planner.plan(c.clinicId, { dryRun: false });
    expect((await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId } })).channel).toBe('TELEGRAM');
  });

  it('лише нік чи preferredContact = INSTAGRAM без прив’язаного діалогу — нічого; діалог іншої клініки — нічого; Instagram клініки не підключено — окрема причина', async () => {
    const c = await igClinic();
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Нік Без Діалогу', preferredContact: 'INSTAGRAM' } });
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: hours(20), endsAt: hours(20.5), status: 'PLANNED', bookedAt: hours(-72) } });
    // a channel row that names another clinic: not this clinic's link
    const other = await clinic();
    const q = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Чужий Звʼязок' } });
    await prisma.patientChannel.create({ data: { clinicId: other.clinicId, patientId: q.id, channel: 'INSTAGRAM', externalId: `igsid${rnd()}` } });
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: q.id, externalId: `v${rnd()}`, startsAt: hours(20), endsAt: hours(20.5), status: 'PLANNED', bookedAt: hours(-72) } });
    const r = await planner.plan(c.clinicId, { dryRun: false });
    expect(rem(r)).toMatchObject({ toQueue: 0, noChannel: 2 });
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
    const d = await igClinic({ connected: false });
    await igPatient(d.clinicId, 2);
    expect(rem(await planner.plan(d.clinicId, { dryRun: false }))).toMatchObject({ toQueue: 0, channelDisconnected: 1 });
  });

  it('вікно закрите вже при плануванні; вікно закрилося між плануванням і відправкою — скасовано з причиною, без повтору й без іншого каналу', async () => {
    const c = await igClinic();
    await igPatient(c.clinicId, 30);
    expect(rem(await planner.plan(c.clinicId, { dryRun: false }))).toMatchObject({ toQueue: 0, windowClosed: 1 });
    const d = await igClinic();
    const x = await igPatient(d.clinicId, 2);
    await planner.plan(d.clinicId, { dryRun: false });
    await approveAll(d);
    await prisma.chatMessage.updateMany({ where: { clinicId: d.clinicId, chatId: x.igsid, direction: 'IN' }, data: { createdAt: hours(-25) } });
    await outbox.process(noon(), { clinicId: d.clinicId });
    const m = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: d.clinicId } });
    expect(m).toMatchObject({ status: 'CANCELLED' });
    expect(m.error).toContain('Вікно Instagram закрито');
    expect(ig.calls).toHaveLength(0);
    await outbox.process(noon(), { clinicId: d.clinicId });
    expect(ig.calls).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
  });

  it('відмова пацієнта на будь-якому каналі, відкликана згода, вимкнена відправка: напоминання в Instagram немає', async () => {
    const c = await igClinic();
    const a = await igPatient(c.clinicId, 2);
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: a.p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}`, optedOutAt: new Date() } });
    await igPatient(c.clinicId, 2, { consent: 'WITHDRAWN' });
    expect(rem(await planner.plan(c.clinicId, { dryRun: false }))).toMatchObject({ toQueue: 0, optedOut: 1, paused: 1 });
    // queued, then the patient says stop in Telegram: not sent in Instagram
    const d = await igClinic();
    const b = await igPatient(d.clinicId, 2);
    await planner.plan(d.clinicId, { dryRun: false });
    await approveAll(d);
    await prisma.patientChannel.create({ data: { clinicId: d.clinicId, patientId: b.p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}`, optedOutAt: new Date() } });
    await outbox.process(noon(), { clinicId: d.clinicId });
    expect((await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: d.clinicId } })).status).toBe('CANCELLED');
    // the main sending switch off: nothing goes out
    const e = await igClinic();
    await igPatient(e.clinicId, 2);
    await planner.plan(e.clinicId, { dryRun: false });
    await approveAll(e);
    await prisma.clinic.update({ where: { id: e.clinicId }, data: { sendingEnabled: false } });
    expect((await outbox.process(noon(), { clinicId: e.clinicId })).sent).toBe(0);
    expect(ig.calls).toHaveLength(0);
  });

  it('перенесений або скасований візит не отримує старого тексту в Instagram', async () => {
    const c = await igClinic();
    const x = await igPatient(c.clinicId, 2);
    const y = await igPatient(c.clinicId, 2);
    await planner.plan(c.clinicId, { dryRun: false });
    await approveAll(c);
    await prisma.visit.update({ where: { id: x.v.id }, data: { startsAt: hours(30), endsAt: hours(30.5) } });
    await prisma.visit.update({ where: { id: y.v.id }, data: { status: 'CANCELLED' } });
    expect((await outbox.process(noon(), { clinicId: c.clinicId })).sent).toBe(0);
    expect(ig.calls).toHaveLength(0);
    expect((await prisma.outboundMessage.findMany({ where: { clinicId: c.clinicId } })).map((m) => m.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('невідомий результат доставки: окремий статус, без повтору й без переходу в Telegram', async () => {
    const c = await igClinic();
    const x = await igPatient(c.clinicId, 2);
    await planner.plan(c.clinicId, { dryRun: false });
    await approveAll(c);
    ig.mode = 'ambiguous';
    await outbox.process(noon(), { clinicId: c.clinicId });
    const m = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(m).toMatchObject({ status: 'UNKNOWN' });
    expect(m.error).toContain('Результат доставки невідомий');
    // the patient connects Telegram later, the scheduler and the sender run again: nothing more is sent anywhere
    ig.mode = 'ok';
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: x.p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
    await planner.plan(c.clinicId, { dryRun: false });
    await outbox.process(noon(), { clinicId: c.clinicId });
    expect(ig.calls).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
    expect(await prisma.outboundMessage.count({ where: { clinicId: c.clinicId } })).toBe(1);
    // a clear refusal is a failure (not a stop): the patient's link stays as it was
    const d = await igClinic();
    const z = await igPatient(d.clinicId, 2);
    await planner.plan(d.clinicId, { dryRun: false });
    await approveAll(d);
    ig.mode = 'refused';
    await outbox.process(noon(), { clinicId: d.clinicId });
    expect((await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: d.clinicId } })).status).toBe('FAILED');
    expect((await prisma.patientChannel.findFirstOrThrow({ where: { patientId: z.p.id, channel: 'INSTAGRAM' } })).optedOutAt).toBeNull();
  });
});
