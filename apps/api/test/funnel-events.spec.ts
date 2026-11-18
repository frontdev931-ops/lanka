import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AutoReplyService } from '../src/automations/auto-reply.service';
import { BookingService } from '../src/booking/booking.service';
import { BookingFlowService } from '../src/automations/booking-flow.service';
import { slotPayload } from '../src/automations/channels';
import { FunnelEventsService } from '../src/funnel-events/funnel-events.service';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';
import { pinPlatformFixture } from './platform-fixture';

jest.setTimeout(120_000);

// Funnel events and the dialogue state (foundation of the agent): only real actions are written, once, per clinic, and only when the clinic's own
// collection flag is on. Synthetic data, the mock Cliniccards and fake channels only.
let app: INestApplication;
let prisma: PrismaService;
let restorePlatform: (() => Promise<void>) | undefined;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const ADMIN_EMAIL = `platform-${rnd()}@example.com`;
let platformToken: string | undefined;
async function getPlatformToken() {
  if (!platformToken) {
    const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Платформа ${rnd()}`, name: 'Адмін', email: ADMIN_EMAIL, password: PASSWORD }).expect(201);
    restorePlatform = await pinPlatformFixture(prisma, ADMIN_EMAIL);
    platformToken = res.body.accessToken as string;
  }
  return platformToken;
}

const ai = { configured: true, service: 'Консультація', complete: async () => ({ text: JSON.stringify({ intent: 'booking', reply: 'Оберіть, будь ласка, час.', summary: 'хоче записатися', service: ai.service, options: [] }), inputTokens: 1, outputTokens: 1 }) };
const sent: { chatId: string; text: string; buttons: { label: string; payload: string }[] }[] = [];

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(ai).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    sent.push({ chatId, text, buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) });
  });
});
afterAll(async () => {
  await restorePlatform?.();
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
  delete process.env.PLATFORM_ADMIN_EMAILS;
});
beforeEach(() => {
  sent.length = 0;
  mock.writes.length = 0;
  mock.control.failWith = undefined;
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

const WEEK = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '09:00', to: '18:00' }]));
const put = (token: string, path: string, body: unknown) => http().put(path).set(auth(token)).send(body as object);

// A clinic with booking by cabinets (one shared account, two online cabinets). auto: the bot books by itself after the client's yes.
async function clinic(opts: { auto?: boolean; events?: boolean; agent?: boolean } = {}) {
  const email = `c${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  await prisma.clinic.update({
    where: { id: clinicId },
    data: { plan: 'PRO', aiEnabled: true, aiAutoReply: true, sendingEnabled: true, funnelEventsEnabled: !!opts.events, aiAgentMode: !!opts.agent, ...(opts.auto ? { bookingWriteEnabled: true, aiAutoBooking: true } : {}) },
  });
  const consult = await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 30, active: true, approvedAt: new Date() } });
  await http().get('/booking-settings').set(auth(token)).expect(200);
  await put(token, '/booking-settings/shared-account', { doctorId: '503' }).expect(200);
  await put(token, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: true, acceptsUrgent: false }, { externalId: '802', onlineBooking: true, acceptsUrgent: false }] }).expect(200);
  await put(token, '/booking-settings/services', { services: [{ id: consult.id, onlineBooking: true, cabinetIds: [] }] }).expect(200);
  await put(token, '/clinic/work-hours', WEEK).expect(200);
  await put(token, '/booking-settings/mode', { mode: 'CABINETS' }).expect(200);
  return { token, clinicId, chat: `ig${rnd()}`, email };
}
type C = Awaited<ReturnType<typeof clinic>>;

let mid = 0;
const write = (c: C, text: string, payload?: string, chat = c.chat) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const last = () => sent[sent.length - 1];
const slots = (m: { buttons: { payload: string }[] }) => m.buttons.map((b) => b.payload).filter((p) => p.startsWith('slot|'));
const link = async (c: C, skip = 0, chat = c.chat) => {
  const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' }, skip });
  await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: chat } });
  return p;
};
const counts = (c: C) => app.get(FunnelEventsService).counts(c.clinicId);
const rows = (c: C) => prisma.funnelEvent.findMany({ where: { clinicId: c.clinicId }, orderBy: { occurredAt: 'asc' } });
const flowCtx = (c: C, chat = c.chat) => ({ clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, patientId: null, contactName: null });
// one full automatic booking: ask, choose the first time, say yes
async function autoBooking(c: C, skip = 0, chat = c.chat) {
  await link(c, skip, chat);
  await write(c, 'Хочу записатися на консультацію', undefined, chat);
  const offered = slots(last());
  await write(c, '', offered[0], chat);
  await write(c, 'так', undefined, chat);
  return offered;
}

describe('події воронки: лише з окремим прапором клініки', () => {
  it('прапор вимкнено: жодного рядка стану чи події, навіть коли aiAgentMode увімкнено; без агента відповіді й запис як раніше', async () => {
    // without the agent and with the collection flag off: the scenario is as before and nothing is written to the new tables
    const plain = await clinic({ auto: true });
    await autoBooking(plain);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(1);
    expect(sent.some((m) => m.text.includes('Ваш запис підтверджено'))).toBe(true);
    expect(await prisma.conversationState.count({ where: { clinicId: plain.clinicId } })).toBe(0);
    expect(await prisma.funnelEvent.count({ where: { clinicId: plain.clinicId } })).toBe(0);
    // with aiAgentMode on (and the collection flag off): it does not start the collection; the old AI does not answer by itself next to the agent
    // (drafts-only rule), so the dialogue does not start by itself; still no row of the new tables
    const agent = await clinic({ auto: true, agent: true });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: agent.clinicId }, select: { funnelEventsEnabled: true, aiAgentMode: true } })).toEqual({ funnelEventsEnabled: false, aiAgentMode: true });
    await write(agent, 'Хочу записатися на консультацію');
    expect(await prisma.conversationState.count({ where: { clinicId: agent.clinicId } })).toBe(0);
    expect(await prisma.funnelEvent.count({ where: { clinicId: agent.clinicId } })).toBe(0);
    // and the defaults of a new clinic are off
    const fresh = await clinic();
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: fresh.clinicId }, select: { funnelEventsEnabled: true, aiAgentMode: true } })).toEqual({ funnelEventsEnabled: false, aiAgentMode: false });
  });

  it('автозапис: одне звернення, одна пропозиція часу, одна згода на конкретний час, один візит; повтори нічого не дублюють', async () => {
    const c = await clinic({ auto: true, events: true });
    await autoBooking(c);
    expect(await counts(c)).toEqual({ INQUIRY: 1, TIME_OFFERED: 1, CLIENT_CONFIRMED: 1, BOOKED: 1 });
    const request = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    const booked = (await rows(c)).find((r) => r.kind === 'BOOKED')!;
    expect(booked).toMatchObject({ refKey: request.id, source: 'AUTO', reason: 'visit_created', leadStatus: 'EXISTING_LINKED' });
    expect((await rows(c)).find((r) => r.kind === 'CLIENT_CONFIRMED')!.refKey).toBe(`${request.id}:${request.slotAt!.toISOString()}`);
    // a repeated "yes", the repeated buttons, a repeated slot button: still the same single events
    await write(c, 'так');
    await write(c, 'так');
    await write(c, '', `bookyes|${request.id}`);
    await write(c, '', `bookno|${request.id}`);
    expect(await counts(c)).toEqual({ INQUIRY: 1, TIME_OFFERED: 1, CLIENT_CONFIRMED: 1, BOOKED: 1 });
    expect(await prisma.conversationState.count({ where: { clinicId: c.clinicId } })).toBe(1);
    // a handler run again after a crash between the send and the save of the message: the client got a second message, the offer is still ONE event
    const chat2 = `ig${rnd()}`;
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat2, direction: 'IN', text: 'Хочу записатися на консультацію' } });
    await app.get(AutoReplyService).onInbound(c.clinicId, 'INSTAGRAM', chat2);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'TIME_OFFERED' } })).toBe(2); // the first chat once, this chat once
    await prisma.chatMessage.deleteMany({ where: { clinicId: c.clinicId, chatId: chat2, direction: 'OUT' } }); // the save was lost: the incoming message is the last one again
    await app.get(AutoReplyService).onInbound(c.clinicId, 'INSTAGRAM', chat2);
    expect(sent.filter((m) => m.chatId === chat2)).toHaveLength(2);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'TIME_OFFERED' } })).toBe(2);
  });

  it('канал-чат — одне звернення, а не епізод: другий запис того самого чату — нові згода й візит, але INQUIRY лишається одним', async () => {
    const c = await clinic({ auto: true, events: true });
    const first = (await autoBooking(c))[0];
    await write(c, 'Хочу записатися ще на консультацію');
    const second = slots(last()).filter((p) => p !== first); // another time: the same time again is the repeat of the first booking
    expect(second.length).toBeGreaterThan(0);
    await write(c, '', second[0]);
    await write(c, 'так');
    expect(await counts(c)).toMatchObject({ INQUIRY: 1, CLIENT_CONFIRMED: 2, BOOKED: 2 });
    expect((await counts(c)).TIME_OFFERED).toBeGreaterThanOrEqual(2);
    expect(new Set((await rows(c)).filter((r) => r.kind === 'BOOKED').map((r) => r.refKey)).size).toBe(2); // different actions are not merged
  });

  it('заявка адміністратору: передача людині — подія; слова адміністратора, навіть із візитом пацієнта на той самий час, не є записом за цією заявкою; запис — лише створений для заявки візит', async () => {
    const c = await clinic({ events: true }); // request mode
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true } }); // staff may write (the bot does not: aiAutoBooking is off)
    await link(c);
    await write(c, 'Хочу записатися на консультацію');
    await write(c, '', slots(last())[0]);
    expect(await counts(c)).toMatchObject({ INQUIRY: 1, TIME_OFFERED: 1, HANDED_OFF: 1 });
    expect((await rows(c)).find((r) => r.kind === 'HANDED_OFF')).toMatchObject({ reason: 'booking_request' });
    expect(await counts(c)).not.toHaveProperty('CLIENT_CONFIRMED'); // no automatic question in this mode: the client chose a time, nobody confirmed a booking
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    const owner = (await prisma.membership.findFirstOrThrow({ where: { clinicId: c.clinicId } })).userId;
    const flow = app.get(BookingFlowService);
    const hmOf = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    // (a) no visit exists: the confirmation is only the administrator's word
    await flow.confirmByAdmin(c.clinicId, owner, req.id, { date: clinicDate(req.slotAt!), time: hmOf(req.slotAt!) });
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).confirmSource).toBe('MANUAL');
    expect(await counts(c)).not.toHaveProperty('BOOKED');
    // (b) a visit of the same patient at the same time that nobody made for this request (made by hand in Cliniccards): found, but not proof
    const chat2 = `ig${rnd()}`;
    await link(c, 1, chat2);
    await write(c, 'Хочу записатися на консультацію', undefined, chat2);
    await write(c, '', slots(last())[0], chat2);
    const req2 = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: chat2 } });
    const card2 = await prisma.patientChannel.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: chat2 }, include: { patient: true } });
    const day2 = clinicDate(req2.slotAt!);
    const hm2 = hmOf(req2.slotAt!);
    mock.data.visits.push({ visit_id: `7${rnd()}`, patient_id: card2.patient.externalId, status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: '801', visit_start: `${day2} ${hm2}:00`, visit_end: `${day2} ${hm2}:00`, note: 'made by hand', price_items: null, date_created: `${day2} 08:00:00`, date_edited: `${day2} 08:00:00` });
    await flow.confirmByAdmin(c.clinicId, owner, req2.id, { date: day2, time: hm2 });
    await flow.confirmByAdmin(c.clinicId, owner, req2.id, { date: day2, time: hm2 });
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req2.id } })).confirmSource).toBe('CLINICCARDS'); // found and linked on the request, as before
    expect(await counts(c)).not.toHaveProperty('BOOKED'); // but the funnel does not call it a result of this conversation
    // (c) staff create the visit FOR the request (the attempt carries the request id): that is a booking, written once
    const chat3 = `ig${rnd()}`;
    const card3 = await link(c, 2, chat3);
    await write(c, 'Хочу записатися на консультацію', undefined, chat3);
    await write(c, '', slots(last())[0], chat3);
    const req3 = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: chat3 } });
    const input = { patientId: card3.id, startsAt: req3.slotAt!, durationMin: 30, cabinetId: '802', doctorId: '503', sharedAccount: true, requestId: req3.id };
    await app.get(BookingService).book(c.clinicId, owner, input);
    await app.get(BookingService).book(c.clinicId, owner, input); // the repeat of the same booking
    await flow.confirmByAdmin(c.clinicId, owner, req3.id, { date: clinicDate(req3.slotAt!), time: hmOf(req3.slotAt!) });
    expect(await counts(c)).toMatchObject({ BOOKED: 1 });
    expect((await rows(c)).find((r) => r.kind === 'BOOKED')).toMatchObject({ refKey: req3.id, source: 'ADMIN', reason: 'visit_created' });
  });

  it('відправлення, результат якого невідомий або невдалий, не записується як показ часу', async () => {
    const c = await clinic({ auto: true, events: true });
    await link(c);
    const send = app.get(MessengerService).send as jest.Mock;
    send.mockImplementationOnce(async () => {
      throw new Error('timeout: unknown whether delivered');
    });
    await write(c, 'Хочу записатися на консультацію');
    const got = await counts(c);
    expect(got.INQUIRY).toBe(1); // the incoming message is real
    expect(got).not.toHaveProperty('TIME_OFFERED'); // the offer may not have reached the client: not recorded as a success
    // an answer that does go out later is recorded once
    await write(c, 'Так, хочу на консультацію, підберіть час');
    expect((await counts(c)).TIME_OFFERED).toBe(1);
  });

  it('збій запису в Cliniccards і запит на скасування: передача людині є, хибного успіху (запису) немає', async () => {
    const c = await clinic({ auto: true, events: true });
    await link(c);
    await write(c, 'Хочу записатися на консультацію');
    await write(c, '', slots(last())[0]);
    // the clinic's system fails exactly when the client says yes
    mock.control.failWith = 500;
    await write(c, 'так');
    mock.control.failWith = undefined;
    const got = await counts(c);
    expect(got).toMatchObject({ INQUIRY: 1, TIME_OFFERED: 1, CLIENT_CONFIRMED: 1, HANDED_OFF: 1 });
    expect(got).not.toHaveProperty('BOOKED'); // nothing was created, so no success is written
    const failed = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(failed).toMatchObject({ autoState: 'FAILED', externalVisitId: null, confirmedAt: null });
    // a different kind of hand-over: a cancellation request from the client (the model's intent), another request id
    ai.complete = async () => ({ text: JSON.stringify({ intent: 'cancel', reply: 'Передам адміністратору.', summary: 'скасування', service: null, options: [] }), inputTokens: 1, outputTokens: 1 });
    try {
      await write(c, 'Скасуйте мій запис, будь ласка');
    } finally {
      ai.complete = async () => ({ text: JSON.stringify({ intent: 'booking', reply: 'Оберіть, будь ласка, час.', summary: 'хоче записатися', service: ai.service, options: [] }), inputTokens: 1, outputTokens: 1 });
    }
    expect((await rows(c)).filter((r) => r.kind === 'HANDED_OFF').map((r) => r.reason)).toContain('cancel');
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'HANDED_OFF' } })).toBe(2);
  });

  it('чернетка нічого не фіксує: ні пропозиції часу, ні передачі людині, ні заявки, ні стану', async () => {
    const c = await clinic({ auto: true, events: true });
    await link(c);
    // an incoming message exists (its enquiry is real), the draft is asked for by staff
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: 'Хочу записатися на консультацію' } });
    const draft = (await http().post(`/conversations/INSTAGRAM/${c.chat}/draft`).set(auth(c.token)).expect(200)).body;
    expect(draft.options?.length ?? 0).toBeGreaterThan(0); // the draft does propose times...
    expect(sent).toHaveLength(0); // ...but nothing is sent
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId } })).toBe(0); // and none of it counts as offered, handed over or booked
    expect(await prisma.conversationState.count({ where: { clinicId: c.clinicId } })).toBe(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(0);
  });

  it('клініки ізольовані: події, стан і підрахунок однієї не видно й не змінюються з іншої, навіть при однаковому chatId', async () => {
    const a = await clinic({ auto: true, events: true });
    const b = await clinic({ auto: true, events: true });
    const off = await clinic({ auto: true }); // collection off
    const sharedChat = `ig${rnd()}`;
    await autoBooking(a, 0, sharedChat);
    await write(b, 'Хочу записатися на консультацію', undefined, sharedChat);
    await write(off, 'Хочу записатися на консультацію', undefined, sharedChat);
    expect(await counts(a)).toMatchObject({ INQUIRY: 1, BOOKED: 1 });
    expect(await counts(b)).toEqual({ INQUIRY: 1, TIME_OFFERED: 1 });
    expect(await counts(off)).toEqual({});
    expect(await prisma.conversationState.count({ where: { clinicId: a.clinicId } })).toBe(1);
    expect(await prisma.conversationState.count({ where: { clinicId: b.clinicId } })).toBe(1);
    expect(await prisma.conversationState.count({ where: { clinicId: off.clinicId } })).toBe(0);
    // a direct record for clinic B never lands on clinic A, and a record for the clinic with the flag off writes nothing
    const svc = app.get(FunnelEventsService);
    expect(await svc.record(off.clinicId, { channel: 'INSTAGRAM', chatId: 'x', kind: 'INQUIRY', refKey: 'first' })).toBe('off');
    expect(await svc.record(b.clinicId, { channel: 'INSTAGRAM', chatId: sharedChat, kind: 'INQUIRY', refKey: 'first' })).toBe('duplicate');
    expect(await counts(a)).toMatchObject({ INQUIRY: 1 });
    // an event holds no text: only codes and keys
    const sample = (await rows(a))[0];
    expect(Object.keys(sample).sort()).toEqual(['clinicId', 'conversationId', 'id', 'kind', 'leadStatus', 'occurredAt', 'reason', 'refKey', 'source']);
  });

  it('прапори ставить лише власник сервісу: звичайний власник клініки отримує 403, власник сервісу змінює обидва, зміна в аудиті', async () => {
    const owner = await clinic();
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(owner.token)).send({ funnelEventsEnabled: true }).expect(403);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).funnelEventsEnabled).toBe(false);
    const admin = await getPlatformToken();
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send({ funnelEventsEnabled: true, aiAgentMode: true }).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId }, select: { funnelEventsEnabled: true, aiAgentMode: true } })).toEqual({ funnelEventsEnabled: true, aiAgentMode: true });
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: 'platform.clinic_changed' } })).toBe(1);
  });

  it('автономний режим агента вмикає лише власник сервісу: за замовчуванням вимкнено, aiAgentMode його не вмикає, тестова послуга лише схвалена послуга цієї клініки', async () => {
    const owner = await clinic();
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId }, select: { aiAgentAuto: true, agentAutoServiceId: true } })).toEqual({ aiAgentAuto: false, agentAutoServiceId: null });
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(owner.token)).send({ aiAgentAuto: true }).expect(403);
    const admin = await getPlatformToken();
    expect(admin).toBeTruthy();
    // the agent alone does not turn the autonomy on
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send({ aiAgentMode: true }).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).aiAgentAuto).toBe(false);
    // a service of another clinic, or one that is not approved, is refused
    const other = await clinic();
    const foreign = await prisma.kbItem.create({ data: { clinicId: other.clinicId, kind: 'SERVICE', title: 'Чужа', active: true, approvedAt: new Date() } });
    const draftOnly = await prisma.kbItem.create({ data: { clinicId: owner.clinicId, kind: 'SERVICE', title: 'Чернетка', active: true } });
    const mine = await prisma.kbItem.create({ data: { clinicId: owner.clinicId, kind: 'SERVICE', title: 'Своя', active: true, approvedAt: new Date() } });
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send({ aiAgentAuto: true, agentAutoServiceId: foreign.id }).expect(400);
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send({ agentAutoServiceId: draftOnly.id }).expect(400);
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send({ aiAgentAuto: true, agentAutoServiceId: mine.id }).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId }, select: { aiAgentAuto: true, agentAutoServiceId: true } })).toEqual({ aiAgentAuto: true, agentAutoServiceId: mine.id });
  });

  it('набір послуг автономного режиму: лише схвалені активні послуги цієї клініки, без повторів, не більше п’яти; хибне оновлення відхиляється цілком; зміна в аудиті; очищення вимикає й не повертає стару послугу', async () => {
    const owner = await clinic();
    const admin = await getPlatformToken();
    const svc = (title: string, o: { approved?: boolean; active?: boolean; clinicId?: string } = {}) =>
      prisma.kbItem.create({ data: { clinicId: o.clinicId ?? owner.clinicId, kind: 'SERVICE', title, active: o.active !== false, ...(o.approved === false ? {} : { approvedAt: new Date() }) } });
    const [a, b, c2, d, e, f] = await Promise.all(['А', 'Б', 'В', 'Г', 'Ґ', 'Д'].map((t) => svc(t)));
    const other = await clinic();
    const foreign = await svc('Чужа', { clinicId: other.clinicId });
    const inactive = await svc('Неактивна', { active: false });
    const draft = await svc('Не схвалена', { approved: false });
    const patch = (body: object) => http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(admin)).send(body);
    const state = () => prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId }, select: { agentAutoServiceIds: true, agentAutoServicesSet: true, agentAutoServiceId: true } });
    // the legacy single value of a never-configured clinic
    await prisma.clinic.update({ where: { id: owner.clinicId }, data: { agentAutoServiceId: a.id } });
    const before = await state();
    for (const bad of [[a.id, foreign.id], [a.id, inactive.id], [a.id, draft.id], [a.id, a.id], [a.id, b.id, c2.id, d.id, e.id, f.id], [a.id, 'nope']]) await patch({ agentAutoServiceIds: bad }).expect(400);
    await patch({ agentAutoServiceIds: [a.id], agentAutoServiceId: a.id }).expect(400);
    expect(await state()).toEqual(before); // nothing changed by any rejected update
    await patch({ agentAutoServiceIds: [b.id, a.id] }).expect(200);
    expect(await state()).toEqual({ agentAutoServiceIds: [b.id, a.id], agentAutoServicesSet: true, agentAutoServiceId: b.id });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: owner.clinicId, action: 'platform.clinic_changed' }, orderBy: { createdAt: 'desc' } });
    expect(audit.details).toMatchObject({ agentAutoServices: { before: [a.id], after: [b.id, a.id] } });
    // cleared: autonomy has no service, and the old single value does not come back (even if an old writer puts it back)
    await patch({ agentAutoServiceIds: [] }).expect(200);
    expect(await state()).toEqual({ agentAutoServiceIds: [], agentAutoServicesSet: true, agentAutoServiceId: null });
    await prisma.clinic.update({ where: { id: owner.clinicId }, data: { agentAutoServiceId: a.id } });
    const { autoServices } = await import('../src/automations/agent-auto-gate');
    expect(await autoServices(prisma, owner.clinicId)).toEqual([]);
  });

  it('міграція: стара одна послуга переходить у набір, і дійсний дозвіл не змінюється', async () => {
    const owner = await clinic();
    const s = await prisma.kbItem.create({ data: { clinicId: owner.clinicId, kind: 'SERVICE', title: 'Стара', active: true, approvedAt: new Date() } });
    await prisma.clinic.update({ where: { id: owner.clinicId }, data: { agentAutoServiceId: s.id, agentAutoServiceIds: [], agentAutoServicesSet: false } });
    const { autoServices } = await import('../src/automations/agent-auto-gate');
    const effective = await autoServices(prisma, owner.clinicId);
    // the data step of the migration (20261111120000_agent_auto_services), applied to this clinic only
    await prisma.$executeRawUnsafe('UPDATE "Clinic" SET "agentAutoServiceIds" = ARRAY["agentAutoServiceId"] WHERE "agentAutoServiceId" IS NOT NULL AND id = $1', owner.clinicId);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).agentAutoServiceIds).toEqual([s.id]);
    expect(await autoServices(prisma, owner.clinicId)).toEqual(effective);
    expect(effective).toEqual([{ id: s.id, title: 'Стара' }]);
  });
});
