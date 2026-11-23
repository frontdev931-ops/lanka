import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { AgentAutoGate } from '../src/automations/agent-auto-gate';
import { FollowUpService, guessLang, latestDaytime } from '../src/automations/follow-up.service';
import { MessengerService } from '../src/automations/messenger.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

let app: INestApplication;
let prisma: PrismaService;
let svc: FollowUpService;
let send: jest.SpyInstance;
const sent: { channel: string; chatId: string; text: string }[] = [];
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3_600_000;
// a fixed evening (23:00 Kyiv): the next day's daytime falls inside Instagram's 24-hour window of a message 5 hours earlier
const NOW = new Date('2026-11-24T21:00:00Z');

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  svc = app.get(FollowUpService);
  // the channels are faked: a sent follow-up is only recorded here
  send = jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, channel: string, chatId: string, text: string) => {
    sent.push({ channel, chatId, text });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
});

async function clinic(on = true) {
  const email = `f${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { followUpEnabled: on, sendingEnabled: true, billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * 24 * HOUR) } });
  return { token: res.body.accessToken as string, clinicId };
}

// An agent dialogue: the patient wrote `inAgo` hours ago, the agent answered `outAgo` hours ago, at the given stage; prices: the agent stated a price
async function dialogue(clinicId: string, o: { channel?: string; stage?: string; inAgo: number; outAgo: number; prices?: boolean; text?: string; now?: Date }) {
  const now = o.now ?? NOW;
  const channel = o.channel ?? 'INSTAGRAM';
  const chatId = `c${rnd()}`;
  await prisma.chatMessage.create({ data: { clinicId, channel, chatId, direction: 'IN', text: o.text ?? 'Скільки коштує гігієна?', contactName: 'Олена', createdAt: new Date(now.getTime() - o.inAgo * HOUR) } });
  await prisma.chatMessage.create({ data: { clinicId, channel, chatId, direction: 'OUT', text: 'Гігієна — 1 400 грн. Підібрати час?', byAi: true, createdAt: new Date(now.getTime() - o.outAgo * HOUR) } });
  await prisma.conversationState.create({ data: { clinicId, channel, chatId, salesStage: o.stage ?? 'DISCOVERY' } });
  if (o.prices) await prisma.agentDraft.create({ data: { clinicId, channel, chatId, basisMessageId: 'b', basisAt: now, stateVersion: 1, status: 'SENT', snapshot: { exec: { prices: [{ id: 's', price: 1400 }] } } } });
  return { channel, chatId };
}
const rows = (clinicId: string, chatId: string) => prisma.followUp.findMany({ where: { clinicId, chatId }, orderBy: { step: 'asc' } });

describe('догнати пацієнтів, які не дійшли до запису', () => {
  it('причина: ціна, час не вибрано, мовчить; Instagram — одне повідомлення вдень у межах 24-годинного вікна', async () => {
    const c = await clinic();
    const price = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4, prices: true });
    const time = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4, stage: 'OFFERED' });
    const silent = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await svc.plan(c.clinicId, NOW);
    const [p] = await rows(c.clinicId, price.chatId);
    expect(p).toMatchObject({ reason: 'PRICE', step: 1, status: 'PLANNED', lang: 'uk' });
    expect(p.text).toMatch(/вартістю/);
    expect((await rows(c.clinicId, time.chatId))[0]).toMatchObject({ reason: 'TIME' });
    expect((await rows(c.clinicId, silent.chatId))[0]).toMatchObject({ reason: 'SILENT' });
    // only one for Instagram, inside the window and in the clinic's daytime
    expect(await rows(c.clinicId, price.chatId)).toHaveLength(1);
    const lastIn = NOW.getTime() - 5 * HOUR;
    expect(p.dueAt.getTime()).toBeLessThan(lastIn + 24 * HOUR);
    expect(p.dueAt.getTime()).toBeGreaterThanOrEqual(lastIn + 16 * HOUR - 60_000);
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(p.dueAt));
    expect(h).toBeGreaterThanOrEqual(10);
    expect(h).toBeLessThan(19);
    // planning again makes no second copy
    await svc.plan(c.clinicId, NOW);
    expect(await rows(c.clinicId, price.chatId)).toHaveLength(1);
  });

  it('не чіпає: пацієнт написав останнім, тиша менше 3 годин, є заявка, передано людині, запис, вимкнено, давня розмова', async () => {
    const c = await clinic();
    const fresh = await dialogue(c.clinicId, { inAgo: 2, outAgo: 1 });
    const patientLast = await dialogue(c.clinicId, { inAgo: 5, outAgo: 6 });
    const request = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: request.chatId, kind: 'HANDOFF', summary: 'x' } });
    const handed = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4, stage: 'HANDED' });
    const human = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await prisma.conversationState.update({ where: { clinicId_channel_chatId: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: human.chatId } }, data: { owner: 'HUMAN' } });
    const old = await dialogue(c.clinicId, { inAgo: 100, outAgo: 99 });
    await svc.plan(c.clinicId, NOW);
    for (const d of [fresh, patientLast, request, handed, human, old]) expect(await rows(c.clinicId, d.chatId)).toHaveLength(0);
    const off = await clinic(false);
    const d = await dialogue(off.clinicId, { inAgo: 5, outAgo: 4 });
    await svc.tick();
    expect(await rows(off.clinicId, d.chatId)).toHaveLength(0);
  });

  it('Telegram: наступного дня й ще раз через задану кількість днів; відповідь пацієнта скасовує обидва', async () => {
    const c = await clinic();
    await http().patch('/follow-ups/settings').set(auth(c.token)).send({ days: 4 }).expect(200);
    const d = await dialogue(c.clinicId, { channel: 'TELEGRAM', inAgo: 6, outAgo: 5, stage: 'OFFERED' });
    await svc.plan(c.clinicId, NOW);
    const [a, b] = await rows(c.clinicId, d.chatId);
    expect(a).toMatchObject({ step: 1, reason: 'TIME' });
    expect(b).toMatchObject({ step: 2, reason: 'TIME' });
    expect(b.text).toMatch(/Будемо раді/);
    expect(Math.round((b.dueAt.getTime() - a.dueAt.getTime()) / (24 * HOUR))).toBe(4);
    // the patient answers: at its time nothing is sent, both are cancelled
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: d.chatId, direction: 'IN', text: 'Дякую, подумаю', createdAt: new Date(NOW.getTime() + HOUR) } });
    const before = sent.length;
    await svc.process(c.clinicId, new Date(b.dueAt.getTime() + 60_000));
    expect(sent.length).toBe(before);
    expect((await rows(c.clinicId, d.chatId)).map((r) => r.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('без самостійного режиму агента чекає на співробітника; співробітник надсилає — повідомлення в розмові; з самостійним режимом іде саме', async () => {
    const c = await clinic();
    const d = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4, prices: true });
    await svc.plan(c.clinicId, NOW);
    const [f] = await rows(c.clinicId, d.chatId);
    const at = new Date(f.dueAt.getTime() + 60_000);
    let before = sent.length;
    await svc.process(c.clinicId, at);
    expect(sent.length).toBe(before);
    expect((await rows(c.clinicId, d.chatId))[0].status).toBe('PENDING_APPROVAL');
    const list = (await http().get('/follow-ups').set(auth(c.token)).expect(200)).body;
    expect(list.items[0]).toMatchObject({ id: f.id, reason: 'PRICE', status: 'PENDING_APPROVAL', name: 'Олена' });
    await http().post(`/follow-ups/${f.id}/send`).set(auth(c.token)).expect(200);
    expect(sent.at(-1)).toMatchObject({ channel: 'INSTAGRAM', chatId: d.chatId, text: f.text });
    expect((await rows(c.clinicId, d.chatId))[0]).toMatchObject({ status: 'SENT' });
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: d.chatId, direction: 'OUT', text: f.text } })).toBe(1);
    await http().post(`/follow-ups/${f.id}/send`).set(auth(c.token)).expect(400); // never twice

    // the agent answers on its own in this dialogue: the follow-up goes out by itself
    const gate = jest.spyOn(app.get(AgentAutoGate), 'denied').mockResolvedValue(null);
    try {
      const e = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      await svc.plan(c.clinicId, NOW);
      const [g] = await rows(c.clinicId, e.chatId);
      before = sent.length;
      await svc.process(c.clinicId, new Date(g.dueAt.getTime() + 60_000));
      expect(sent.length).toBe(before + 1);
      expect((await rows(c.clinicId, e.chatId))[0].status).toBe('SENT');
      // the master switch off: nothing goes out
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
      const h = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      await svc.plan(c.clinicId, NOW);
      const [k] = await rows(c.clinicId, h.chatId);
      before = sent.length;
      await svc.process(c.clinicId, new Date(k.dueAt.getTime() + 60_000));
      expect(sent.length).toBe(before);
    } finally {
      gate.mockRestore();
    }
  });

  it('життєвий цикл: відповідь після першого скасовує решту одразу; та сама розмова не відроджується; новий сценарій лише з нової тиші', async () => {
    const c = await clinic();
    const gate = jest.spyOn(app.get(AgentAutoGate), 'denied').mockResolvedValue(null);
    try {
      const d = await dialogue(c.clinicId, { channel: 'TELEGRAM', inAgo: 6, outAgo: 5 });
      await svc.plan(c.clinicId, NOW);
      const [a, b] = await rows(c.clinicId, d.chatId);
      const afterFirst = new Date(a.dueAt.getTime() + 60_000);
      await svc.process(c.clinicId, afterFirst);
      expect((await rows(c.clinicId, d.chatId)).map((r) => r.status)).toEqual(['SENT', 'PLANNED']);
      // planning again after our own reminder makes nothing new: the basis is the same patient message
      await svc.plan(c.clinicId, new Date(afterFirst.getTime() + 4 * HOUR));
      expect(await rows(c.clinicId, d.chatId)).toHaveLength(2);
      // the patient answers the reminder: the second step is cancelled right away, long before its time
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: d.chatId, direction: 'IN', text: 'Дякую, подумаю', createdAt: new Date(afterFirst.getTime() + HOUR) } });
      await svc.process(c.clinicId, new Date(afterFirst.getTime() + 2 * HOUR));
      expect((await rows(c.clinicId, d.chatId)).find((r) => r.id === b.id)).toMatchObject({ status: 'CANCELLED', error: 'patient_wrote' });
      // the last message is the patient's: no new scenario until the agent answers and the dialogue goes quiet again
      await svc.plan(c.clinicId, new Date(afterFirst.getTime() + 6 * HOUR));
      expect(await rows(c.clinicId, d.chatId)).toHaveLength(2);
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: d.chatId, direction: 'OUT', text: 'Будемо на звʼязку', byAi: true, createdAt: new Date(afterFirst.getTime() + 2 * HOUR) } });
      await svc.plan(c.clinicId, new Date(afterFirst.getTime() + 6 * HOUR));
      expect((await rows(c.clinicId, d.chatId)).filter((r) => r.status === 'PLANNED')).toHaveLength(2);
    } finally {
      gate.mockRestore();
    }
  });

  it('перед відправкою: запис після планування, відмова, передача людині, вимкнена відправка; ніч поза вікном; два паралельні запуски — одне повідомлення', async () => {
    const c = await clinic();
    const gate = jest.spyOn(app.get(AgentAutoGate), 'denied').mockResolvedValue(null);
    try {
      const patient = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Пацієнт' } });
      const visit = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: patient.id, channel: 'INSTAGRAM', externalId: visit.chatId } });
      const optOut = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      const handed = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      const night = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      const twice = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      await svc.plan(c.clinicId, NOW);
      // after planning: a visit is booked at the desk, a patient opts out, a dialogue is handed to a person
      await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: patient.id, externalId: `v${rnd()}`, startsAt: new Date(NOW.getTime() + 72 * HOUR), status: 'PLANNED' } });
      const p2 = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Пацієнт 2' } });
      await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p2.id, channel: 'INSTAGRAM', externalId: optOut.chatId, optedOutAt: NOW } });
      await prisma.conversationState.update({ where: { clinicId_channel_chatId: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: handed.chatId } }, data: { owner: 'HUMAN' } });
      const [n] = await rows(c.clinicId, night.chatId);
      // Instagram: valid only until the end of that daytime, never at night even with the 24-hour window still open
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(n.expiresAt!));
      expect(h).toBeLessThanOrEqual(19);
      // the sending switch off at the due time: nothing goes out, the rows wait
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: false } });
      const before = sent.length;
      const [t] = await rows(c.clinicId, twice.chatId);
      const due = new Date(t.dueAt.getTime() + 60_000);
      await svc.process(c.clinicId, due);
      expect(sent.length).toBe(before);
      expect((await rows(c.clinicId, twice.chatId))[0].status).toBe('PLANNED');
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true } });
      // two runs at once: one message
      await Promise.all([svc.process(c.clinicId, due), svc.process(c.clinicId, due)]);
      expect(sent.filter((s) => s.chatId === twice.chatId)).toHaveLength(1);
      expect((await rows(c.clinicId, visit.chatId))[0]).toMatchObject({ status: 'CANCELLED', error: 'booked' });
      expect((await rows(c.clinicId, optOut.chatId))[0]).toMatchObject({ status: 'CANCELLED', error: 'opted_out' });
      expect((await rows(c.clinicId, handed.chatId))[0]).toMatchObject({ status: 'CANCELLED', error: 'dialogue_changed' });
      for (const x of [visit, optOut, handed]) expect(sent.some((s) => s.chatId === x.chatId)).toBe(false);
      // the night chat was sent with the rest at its daytime; a later night run finds nothing to send
      const late = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
      await svc.plan(c.clinicId, NOW);
      const [l] = await rows(c.clinicId, late.chatId);
      await svc.process(c.clinicId, new Date(l.expiresAt!.getTime() + 2 * HOUR));
      expect((await rows(c.clinicId, late.chatId))[0]).toMatchObject({ status: 'EXPIRED', error: 'expired' });
      expect(sent.some((s) => s.chatId === late.chatId)).toBe(false);
    } finally {
      gate.mockRestore();
    }
  });

  it('вікно Instagram закрилося — не надсилається, позначається як прострочене; скасування співробітником', async () => {
    const c = await clinic();
    const d = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await svc.plan(c.clinicId, NOW);
    const [f] = await rows(c.clinicId, d.chatId);
    const before = sent.length;
    await svc.process(c.clinicId, new Date(NOW.getTime() + 25 * HOUR));
    expect(sent.length).toBe(before);
    expect((await rows(c.clinicId, d.chatId))[0].status).toBe('EXPIRED');
    const e = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await svc.plan(c.clinicId, NOW);
    const [g] = await rows(c.clinicId, e.chatId);
    await http().post(`/follow-ups/${g.id}/cancel`).set(auth(c.token)).expect(200);
    expect((await rows(c.clinicId, e.chatId))[0].status).toBe('CANCELLED');
    expect(f.id).not.toBe(g.id);
  });

  it('налаштування: лише власник і керуючий; тексти й дні перевіряються; вимкнення скасовує заплановане; клініки ізольовані', async () => {
    const c = await clinic();
    const d = await dialogue(c.clinicId, { inAgo: 5, outAgo: 4 });
    await svc.plan(c.clinicId, NOW);
    const s = (await http().patch('/follow-ups/settings').set(auth(c.token)).send({ texts: { PRICE: { uk: 'Наш текст' } } }).expect(200)).body;
    expect(s.texts.PRICE).toMatchObject({ uk: 'Наш текст' });
    expect(s.texts.TIME.uk).toMatch(/вільні вікна/);
    await http().patch('/follow-ups/settings').set(auth(c.token)).send({ days: 0 }).expect(400);
    await http().patch('/follow-ups/settings').set(auth(c.token)).send({ texts: { PRICE: { uk: ' ' } } }).expect(400);
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `a${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: 'correct-horse-battery' }).expect(201)).body.accessToken as string;
    await http().patch('/follow-ups/settings').set(auth(admin)).send({ enabled: false }).expect(403);
    await http().get('/follow-ups').set(auth(admin)).expect(200);
    // another clinic sees and touches nothing of this one
    const other = await clinic();
    const [f] = await rows(c.clinicId, d.chatId);
    expect((await http().get('/follow-ups').set(auth(other.token)).expect(200)).body.items).toHaveLength(0);
    await http().post(`/follow-ups/${f.id}/cancel`).set(auth(other.token)).expect(404);
    await http().post(`/follow-ups/${f.id}/send`).set(auth(other.token)).expect(404);
    await http().patch('/follow-ups/settings').set(auth(c.token)).send({ enabled: false }).expect(200);
    expect((await rows(c.clinicId, d.chatId))[0]).toMatchObject({ status: 'CANCELLED', error: 'switched_off' });
  });

  it('мова й денний час', () => {
    expect(guessLang(['Скільки коштує?'])).toBe('uk');
    expect(guessLang(['Сколько стоит? Объясните'])).toBe('ru');
    // 01:00–03:00 Kyiv is night: nothing; 08:00–12:00 gives the latest daytime moment
    const kyiv = (h: number) => new Date(`2026-11-24T${String(h - 2).padStart(2, '0')}:00:00Z`);
    expect(latestDaytime(kyiv(1), kyiv(3))).toBeNull();
    expect(latestDaytime(kyiv(8), kyiv(12))?.toISOString()).toBe(kyiv(12).toISOString());
    expect(send).toBeDefined();
  });
});
