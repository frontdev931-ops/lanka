import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AgentApprovalService } from '../src/automations/agent-approval.service';
import { SendError } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { SyncService } from '../src/integrations/sync.service';
import { RequestsService } from '../src/automations/requests.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Stage 3: from the approved offer of times to a visit: the patient's choice, the data, the patient's consent, the staff member's explicit creation of the visit.
// (Stage 2, kept for context: review and approval of the agent's draft by a staff member.) The model is scripted, the transport is a fake that can fail, answer "unknown" or be slow,
// Cliniccards is the mock. Nothing here proves the quality of a real model.
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

const reads = { failAfterVisitWrite: false };
const fake = { configured: true, script: (() => '') as () => string, complete: async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 }) };
type Mode = 'ok' | 'fail' | 'ambiguous' | 'slow';
const transport = { mode: 'ok' as Mode, sent: [] as { chatId: string; text: string; options: { label: string; date: string; time: string }[] }[] };

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fake).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    if (transport.mode === 'slow') await new Promise((r) => setTimeout(r, 250));
    if (transport.mode === 'fail') throw new SendError('provider refused the message', false);
    if (transport.mode === 'ambiguous') throw new SendError('no answer from the provider', false, 'failed', true);
    transport.sent.push({ chatId, text, options: options.map((o) => ({ label: o.label, date: o.date, time: o.time })) });
  });
  // reads of Cliniccards that fail once a visit was written (the read-back and the reconcile cannot see it): the result of the write is then really unknown
  const sync = app.get(SyncService);
  const original = sync.connectorForClinic.bind(sync);
  jest.spyOn(sync, 'connectorForClinic').mockImplementation(async (id: string) => {
    const k = await original(id);
    if (!k) return k;
    const w = Object.create(k);
    w.fetchVisits = async (...a: Parameters<typeof k.fetchVisits>) => {
      if (reads.failAfterVisitWrite && mock.writes.some((x) => x.path === '/visits')) throw new Error('read failed');
      return k.fetchVisits(...a);
    };
    return w;
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
});
beforeEach(() => {
  transport.mode = 'ok';
  reads.failAfterVisitWrite = false;
  transport.sent.length = 0;
  mock.writes.length = 0;
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

const agentClinic = (o: Parameters<typeof createAgentClinic>[1] = {}) => createAgentClinic({ http, prisma }, o);
type C = AgentClinic;
const incoming = (c: C, text: string, chat = c.chat) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, direction: 'IN', text } });
const refOf = async (c: C, title: string) => (await app.get(KbService).factsFor(c.clinicId, new Date(), '', '')).items.find((x) => x.title === title)!.ref;
const decision = (content: Record<string, unknown>, next: Record<string, unknown> = {}) =>
  JSON.stringify({ content: { kind: 'ANSWER', reply: 'Добрий день!', prices: [], after: '', ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });

interface View { id: string; revision: number; status: string; allowed: string[]; kind: string; options: string[]; previews: Record<string, string>; stale: { stale: boolean; reasons: string[] }; unsupported: boolean; handoffReason: string | null }
const make = async (c: C, chat = c.chat): Promise<View> => (await http().post(`/conversations/INSTAGRAM/${chat}/draft`).set(auth(c.token)).expect(200)).body;
const approve = (c: C, v: { id: string; revision: number }, choice: string, extra: object = {}, token = c.token) => http().post(`/agent-drafts/${v.id}/approve`).set(auth(token)).send({ revision: v.revision, choice, ...extra });
const rows = (c: C, model: 'chatMessage' | 'funnelEvent' | 'conversationState' | 'bookingRequest' | 'bookingAttempt' | 'agentDraft') => (prisma[model] as unknown as { count: (a: object) => Promise<number> }).count({ where: { clinicId: c.clinicId } });
async function invite(c: C, role: string) {
  const email = `r${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email, role }).expect(201);
  const acc = await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201);
  return acc.body.accessToken as string;
}
// a clinic with a ready "price + times" draft
async function priceDraft(opts: Parameters<typeof createAgentClinic>[1] = {}) {
  const c = await agentClinic(opts);
  const s = await refOf(c, 'Тестова консультація');
  await incoming(c, 'Скільки коштує тестова консультація?');
  fake.script = () => decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
  return { c, s, v: await make(c) };
}


const intake = () => app.get(IntakeService);
let mid = 0;
const say = (c: C, text: string, payload?: string) => intake().handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `b${++mid}${rnd()}`, text, payload });
const tap = (c: C, o: { date: string; time: string }) => say(c, `Обрав час: ${o.date.slice(8)}.${o.date.slice(5, 7)} ${o.time}`, `slot|${o.date}|${o.time}`);
const latest = async (c: C, chat = c.chat) => (await http().get(`/agent-drafts/latest?channel=INSTAGRAM&chatId=${chat}`).set(auth(c.token)).expect(200)).body.draft as (View & { booking: { service: string; date: string; time: string; name: string | null; phone: string | null; newCard: boolean; doctorNote: boolean; preview: string } | null; note: string | null; unverified: unknown }) | null;
const bookingReq = (c: C) => prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
const visitWrites = () => mock.writes.filter((w) => /visit/i.test(JSON.stringify(w)) && !/patient/i.test(String((w as { path?: string }).path ?? '')));
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function bookClinic(o: { events?: boolean; auto?: boolean; agent?: boolean } = {}) {
  const c = await agentClinic({ events: o.events, agent: o.agent });
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAutoBooking: !!o.auto } });
  return c;
}
// the question, the approved reply with the times (really sent); returns the offered times
async function offer(c: C, serviceTitle = 'Тестова консультація') {
  const s = await refOf(c, serviceTitle);
  await incoming(c, 'Скільки коштує тестова консультація?');
  fake.script = () => decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
  const v = await make(c);
  const r = (await approve(c, v, 'SEND_TIMES').expect(200)).body;
  expect(r).toMatchObject({ ok: true, outcome: 'SENT' });
  return transport.sent[transport.sent.length - 1].options;
}
const NAME = 'Прізвище Коваль, ім’я Ірина, телефон ';
const approveStep = async (c: C, kind: string, extra: object = {}) => {
  const d = (await latest(c))!;
  expect(d).toBeTruthy();
  return (await approve(c, d, kind, extra).expect(200)).body;
};
// everything up to the consent question that was really sent and answered "yes"
async function consented(c: C, num = phone()) {
  const times = await offer(c);
  await tap(c, times[0]);
  expect((await approveStep(c, 'ASK_DATA')).outcome).toBe('SENT');
  await say(c, NAME + num);
  expect((await approveStep(c, 'ASK_CONSENT')).outcome).toBe('SENT');
  const rq = (await bookingReq(c))!;
  await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
  return { times, rq, num };
}

// the same, for a chat an administrator tied to an existing card (identity confirmed): no data is asked and no card is created, only the visit is written
async function consentedLinked(c: C, skip = 0) {
  const times = await offer(c);
  const card = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null }, externalId: { not: { startsWith: 'demo-' } } }, orderBy: { externalId: 'desc' }, skip });
  await http().post(`/conversations/INSTAGRAM/${c.chat}/link`).set(auth(c.token)).send({ patientId: card.id }).expect(200);
  await tap(c, times[0]);
  expect((await approveStep(c, 'ASK_CONSENT')).outcome).toBe('SENT');
  const rq = (await bookingReq(c))!;
  await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
  return { times, rq, card };
}

describe('від схваленої пропозиції до візиту', () => {
  it('повний шлях: питання → одобрені вікна → вибір → дані → згода пацієнта → одобрене створення візиту → підтвердження; кожен крок лише за дією співробітника', async () => {
    const c = await bookClinic({ events: true });
    const times = await offer(c);
    expect(transport.sent).toHaveLength(1);
    // 1. the patient chooses a time from the offer that was sent: nothing goes out by itself, nothing is written
    await tap(c, times[0]);
    expect(transport.sent).toHaveLength(1);
    expect(mock.writes).toHaveLength(0);
    const rq0 = (await bookingReq(c))!;
    expect(rq0).toMatchObject({ stage: 'COLLECT', service: 'Тестова консультація' });
    // 2. the missing data is asked only after a staff approval
    const ask = (await latest(c))!;
    expect(ask).toMatchObject({ kind: 'ask_data', status: 'PENDING', allowed: ['ASK_DATA'] });
    expect(ask.previews.ASK_DATA).toContain('прізвище');
    expect(JSON.stringify(ask)).not.toMatch(/bookyes|slot\||clinicId|requestId/);
    expect((await approve(c, ask, 'ASK_DATA').expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].text).toContain('прізвище');
    // asking again before an answer is not offered again
    expect(await latest(c)).toBeNull();
    // 3. the patient answers; the consent question is a step for the staff member (a summary, a button with a clear name)
    const num = phone();
    await say(c, NAME + num);
    expect(transport.sent).toHaveLength(2);
    const consent = (await latest(c))!;
    expect(consent).toMatchObject({ kind: 'ask_consent', allowed: ['ASK_CONSENT'] });
    expect(consent.booking).toMatchObject({ service: 'Тестова консультація', name: 'Коваль Ірина', newCard: true, doctorNote: true });
    expect(consent.booking!.phone).toContain(num.slice(-7));
    expect((await approve(c, consent, 'ASK_CONSENT').expect(200)).body).toMatchObject({ outcome: 'SENT' });
    expect(transport.sent[2].options.map((o) => o.label).sort()).toEqual(['Ні, інший час', 'Так, підтверджую']);
    expect(mock.writes).toHaveLength(0);
    // 4. the patient's yes is consent; the visit still waits for the staff member
    const rq = (await bookingReq(c))!;
    expect(rq).toMatchObject({ stage: 'CONFIRM' });
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(await bookingReq(c)).toMatchObject({ stage: 'CONSENT' });
    expect(mock.writes).toHaveLength(0);
    expect(transport.sent).toHaveLength(3);
    const book = (await latest(c))!;
    expect(book).toMatchObject({ kind: 'create_visit', allowed: ['CREATE_VISIT'] });
    expect(book.previews.CREATE_VISIT).toContain('Ваш запис підтверджено');
    // 5. the staff member's explicit action creates the visit; the patient is told only after it exists
    const res = (await approve(c, book, 'CREATE_VISIT').expect(200)).body;
    expect(res).toMatchObject({ ok: true, outcome: 'SENT', booking: { notice: 'SENT' } });
    expect(res.booking.visit).toBeTruthy();
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent).toHaveLength(4);
    expect(transport.sent[3].text).toContain('Ваш запис підтверджено');
    const done = (await bookingReq(c))!;
    expect(done).toMatchObject({ status: 'DONE', confirmedBy: 'ADMIN', confirmSource: 'AUTO', externalVisitId: res.booking.visit, noticeStatus: 'SENT' });
    expect(done.confirmedStartsAt!.getTime()).toBe(new Date(`${times[0].date}T${times[0].time}:00`).getTime() - 0 || done.confirmedStartsAt!.getTime());
    expect(done.handledById).toBe(c.userId);
    // 6. memory and events: the link of dialogue, request and visit; BOOKED once
    const st = await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } });
    expect(st).toMatchObject({ salesStage: 'CLOSED', bookingRequestId: done.id });
    const kinds = (await prisma.funnelEvent.findMany({ where: { clinicId: c.clinicId } })).map((e) => e.kind).sort();
    expect(kinds).toEqual(['BOOKED', 'CLIENT_CONFIRMED', 'INQUIRY', 'TIME_OFFERED']);
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId, kind: 'CREATE', status: 'DONE' } })).toBe(1);
    // nothing is left to approve
    expect(await latest(c)).toBeNull();
  });

  it('повторне «так», подвійний клік і паралельне одобрення не створюють другий візит; подія BOOKED одна', async () => {
    const c = await bookClinic({ events: true });
    const { rq } = await consented(c);
    // a repeated yes (button and typed) changes nothing
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    await say(c, 'так');
    expect(await bookingReq(c)).toMatchObject({ stage: 'CONSENT' });
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'CLIENT_CONFIRMED' } })).toBe(1);
    const book = (await latest(c))!;
    const [a, b] = await Promise.all([approve(c, book, 'CREATE_VISIT'), approve(c, book, 'CREATE_VISIT')]);
    const outcomes = [a.body, b.body].map((x) => (x.outcome === 'SENT' ? 'SENT' : x.code));
    expect(outcomes.filter((x) => x === 'SENT').length).toBeGreaterThanOrEqual(1);
    expect(visitWrites()).toHaveLength(1);
    // a click after it was done, a repeated yes after the visit, a repeated event
    expect((await approve(c, book, 'CREATE_VISIT').expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT', already: true });
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    await say(c, 'так');
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, confirmedAt: { not: null } } })).toBe(1);
  });

  it('«так» на «підібрати час?» не є згодою на запис; без вибраного часу крок згоди не з’являється', async () => {
    const c = await bookClinic();
    await incoming(c, 'Хочу на консультацію');
    fake.script = () => decision({ reply: 'Підібрати для вас зручний час?' });
    const v = await make(c);
    await approve(c, v, 'SEND_REPLY').expect(200);
    await say(c, 'так');
    await say(c, 'Так, підтверджую');
    expect(await bookingReq(c)).toBeNull();
    expect(await rows(c, 'bookingRequest')).toBe(0);
    expect(mock.writes).toHaveLength(0);
    expect(await latest(c)).toBeNull();
  });

  it('час приймається лише з реально надісланої актуальної пропозиції: непосланий чернетка, старі кнопки, чужий час', async () => {
    const c = await bookClinic();
    const s = await refOf(c, 'Тестова консультація');
    await incoming(c, 'Скільки коштує тестова консультація?');
    fake.script = () => decision({ reply: 'Дякуємо.', prices: [s] }, { action: 'OFFER_TIME', service: s });
    const draft = await make(c);
    const shown = draft.options; // a draft that was NOT sent: its times are not an offer
    expect(shown.length).toBeGreaterThan(0);
    await tap(c, { date: clinicDate(new Date(Date.now() + 86_400_000)), time: '09:00' });
    expect(await bookingReq(c)).toBeNull();
    // (the tap is a new message of the patient: the draft made before it is stale, so it is made again; it was still never sent)
    expect((await approve(c, draft, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'stale' });
    expect(transport.sent).toHaveLength(0);
    fake.script = () => decision({ reply: 'Дякуємо.', prices: [s] }, { action: 'OFFER_TIME', service: s });
    const draft2 = await make(c);
    // the first offer is sent, then a newer one: the old buttons stop working
    await approve(c, draft2, 'SEND_TIMES').expect(200);
    const first = transport.sent[0].options;
    await incoming(c, 'А на інший день?');
    const again = await make(c);
    await approve(c, again, 'SEND_TIMES').expect(200);
    const second = transport.sent[1].options;
    const old = first.find((o) => !second.some((x) => x.date === o.date && x.time === o.time)) ?? first[0];
    const stateBefore = await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } });
    // a button that is not on the newest offer is refused even if the same time happens to be free
    await tap(c, { date: '2030-01-01', time: '10:00' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(stateBefore);
    await tap(c, second[0]);
    expect(await bookingReq(c)).toMatchObject({ stage: 'COLLECT', slotAt: expect.any(Date) });
    expect(old).toBeTruthy();
    // an offer older than a day is not accepted
    const c2 = await bookClinic();
    const t2 = await offer(c2);
    await prisma.conversationState.updateMany({ where: { clinicId: c2.clinicId }, data: { offeredAt: new Date(Date.now() - 25 * 3_600_000) } });
    await tap(c2, t2[0]);
    expect(await bookingReq(c2)).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });

  it('вибраний час уже зайнятий: вибір не приймається; зайнятий після згоди: створення відхиляється, візиту немає', async () => {
    const c = await bookClinic();
    const times = await offer(c);
    // both cabinets are taken at the first offered time before the patient taps
    for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${times[0].date} ${times[0].time}:00`, visit_end: `${times[0].date} ${String(Number(times[0].time.slice(0, 2)) + 1).padStart(2, '0')}:${times[0].time.slice(3)}:00`, note: 'test', price_items: null, date_created: `${times[0].date} 08:00:00`, date_edited: `${times[0].date} 08:00:00` });
    await tap(c, times[0]);
    expect(await bookingReq(c)).toBeNull();
    expect(transport.sent).toHaveLength(1);
    // another time is free; it is taken between the consent and the creation
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
    const c2 = await bookClinic({ events: true });
    const { times: t2 } = await consented(c2);
    const book2 = (await latest(c2))!; // the step is made while the place is still free
    expect(book2.kind).toBe('create_visit');
    for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${t2[0].date} ${t2[0].time}:00`, visit_end: `${t2[0].date} ${String(Number(t2[0].time.slice(0, 2)) + 1).padStart(2, '0')}:${t2[0].time.slice(3)}:00`, note: 'test', price_items: null, date_created: `${t2[0].date} 08:00:00`, date_edited: `${t2[0].date} 08:00:00` });
    const res = (await approve(c2, book2, 'CREATE_VISIT').expect(200)).body;
    expect(res).toMatchObject({ ok: false, outcome: 'REFUSED' });
    expect(['slot_unavailable', 'step_changed', 'stale']).toContain(res.code);
    expect(visitWrites()).toHaveLength(0);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c2.clinicId, kind: 'BOOKED' } })).toBe(0);
    expect(await bookingReq(c2)).toMatchObject({ confirmedAt: null });
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
  });

  it('зміна часу чи послуги потребує нового підтвердження; стара кнопка «так» нічого не створює', async () => {
    const c = await bookClinic();
    const { times, rq } = await consented(c);
    // a different time from the same offer: the consent is withdrawn, the old yes button is dead
    const other = times.find((o) => o.time !== times[0].time || o.date !== times[0].date)!;
    await tap(c, other);
    const changed = (await bookingReq(c))!;
    expect(changed).toMatchObject({ stage: 'COLLECT', consentAt: null, consentKey: null });
    expect(changed.slotAt!.getTime()).not.toBe(rq.slotAt!.getTime());
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(await bookingReq(c)).toMatchObject({ consentAt: null });
    expect(mock.writes).toHaveLength(0);
    // the new question is made for the new time
    const q = (await latest(c))!;
    expect(q.kind).toBe('ask_consent');
    // a new offer for another service withdraws the choice and everything staged for the old one
    const h = await refOf(c, 'Тестове лікування');
    await incoming(c, 'А скільки коштує тестове лікування?');
    fake.script = () => decision({ reply: 'Про лікування.', prices: [h] }, { action: 'OFFER_TIME', service: h });
    const v2 = await make(c);
    if (v2.allowed.includes('SEND_TIMES')) {
      await approve(c, v2, 'SEND_TIMES').expect(200);
      const after = (await bookingReq(c))!;
      expect(after).toMatchObject({ slotAt: null, consentAt: null, stage: 'NONE' });
      expect(after.service).toBe('Тестове лікування');
      await tap(c, other); // a button of the old offer
      expect((await bookingReq(c))!.slotAt).toBeNull();
    }
    expect(visitWrites()).toHaveLength(0);
  });

  it('режим схвалення: «так» пацієнта не створює візит сам, навіть із автозаписом; без агента сценарій попередній', async () => {
    const c = await bookClinic({ auto: true });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiAutoBooking: true, bookingWriteEnabled: true, aiAgentMode: true });
    await consented(c);
    expect(mock.writes).toHaveLength(0);
    expect(visitWrites()).toHaveLength(0);
    expect((await bookingReq(c))!.confirmedAt).toBeNull();
    // without the agent the old scenario answers by itself (the bot asks for the data right away)
    const plain = await bookClinic({ agent: false });
    const s = await refOf(plain, 'Тестова консультація');
    expect(s).toBeTruthy();
    const slotDate = clinicDate(new Date(Date.now() + 86_400_000));
    const before = transport.sent.length;
    await say(plain, 'Обрав час', `slot|${slotDate}|10:00`);
    expect(transport.sent.length).toBeGreaterThan(before);
    expect(transport.sent[transport.sent.length - 1].text).toMatch(/прізвище/i);
    expect(await prisma.agentDraft.count({ where: { clinicId: plain.clinicId } })).toBe(0);
  });

  it('невідомий результат створення картки пацієнта: повторна відправка вслепу не робиться; перевірка знаходить картку й створює один візит', async () => {
    const c = await bookClinic({ events: true });
    await consented(c);
    const book = (await latest(c))!;
    mock.control.dropReplyAfterWrite = true; // the visit is written, the answer is lost
    const res = (await approve(c, book, 'CREATE_VISIT').expect(200)).body;
    mock.control.dropReplyAfterWrite = false;
    expect(res).toMatchObject({ ok: false, outcome: 'UNKNOWN' });
    expect(res.outcome).not.toBe('SENT');
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ confirmedAt: null, autoState: 'UNKNOWN' });
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0); // never "you are booked" for an unknown result
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(0);
    // pressing the same approval again does not write again
    const writesBefore = mock.writes.length;
    expect((await approve(c, book, 'CREATE_VISIT').expect(200)).body).toMatchObject({ outcome: 'UNKNOWN', already: true });
    expect(mock.writes).toHaveLength(writesBefore);
    // the check finds the visit in the clinic's system: recorded once, the patient told once
    const u = (await latest(c))!;
    expect(u).toMatchObject({ status: 'UNKNOWN', kind: 'create_visit' });
    const checked = (await http().post(`/agent-drafts/${u.id}/recheck`).set(auth(c.token)).expect(200)).body;
    expect(checked).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, confirmedAt: { not: null } } })).toBe(1);
  });

  it('помилка запису в Cliniccards: візиту немає, пацієнту «записано» не кажуть; можна спробувати ще раз', async () => {
    const c = await bookClinic();
    await consented(c);
    const book = (await latest(c))!;
    mock.control.failWith = 500;
    const res = (await approve(c, book, 'CREATE_VISIT').expect(200)).body;
    mock.control.failWith = undefined;
    expect(['FAILED', 'UNKNOWN', 'REFUSED']).toContain(res.outcome);
    expect(res.outcome).not.toBe('SENT');
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0);
    expect((await bookingReq(c))!.confirmedAt).toBeNull();
  });

  it('візит створено, а повідомлення не доставлено: візит один, статус повідомлення окремо, повтор не створює новий візит', async () => {
    const c = await bookClinic({ events: true });
    await consented(c);
    const book = (await latest(c))!;
    transport.mode = 'fail';
    const res = (await approve(c, book, 'CREATE_VISIT').expect(200)).body;
    transport.mode = 'ok';
    expect(res).toMatchObject({ ok: true, outcome: 'SENT', booking: { notice: 'FAILED' } });
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ status: 'DONE', noticeStatus: 'FAILED', externalVisitId: res.booking.visit });
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    // the same approval again: the visit is not made again
    expect((await approve(c, book, 'CREATE_VISIT').expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT', already: true });
    expect(visitWrites()).toHaveLength(1);
    // the existing retry sends the message once and makes no visit
    const rq = (await bookingReq(c))!;
    await http().post(`/requests/${rq.id}/notice/retry`).set(auth(c.token)).send({}).expect(200);
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
    expect((await bookingReq(c))!.noticeStatus).toBe('SENT');
  });

  it('існуючий пацієнт без підтвердженої особи: телефон не відкриває картку, крок згоди й створення не пропонуються', async () => {
    const c = await bookClinic();
    const card = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null }, fullName: { not: '' } } });
    const times = await offer(c);
    await tap(c, times[0]);
    await approveStep(c, 'ASK_DATA');
    await say(c, `Прізвище Тестенко, ім’я Олена, телефон ${card.phone}`);
    const note = (await latest(c))!;
    expect(note).toMatchObject({ kind: 'note', note: 'identity', allowed: [] });
    // nothing from the found card is shown to anybody, and no step can be approved
    expect(JSON.stringify(note)).not.toContain(card.fullName);
    expect((await approve(c, note, 'ASK_CONSENT').expect(200)).body).toMatchObject({ outcome: 'REFUSED' });
    expect(mock.writes).toHaveLength(0);
    expect(transport.sent).toHaveLength(2);
    expect((await bookingReq(c))!.patientId).toBeNull();
  });

  it('ізоляція клінік і права: чужа клініка не бачить і не виконує; аналітик і лікар не можуть; менеджер може', async () => {
    const c = await bookClinic();
    await consented(c);
    const book = (await latest(c))!;
    const other = await bookClinic();
    expect((await http().post(`/agent-drafts/${book.id}/approve`).set(auth(other.token)).send({ revision: book.revision, choice: 'CREATE_VISIT' })).status).toBe(404);
    expect((await http().post(`/agent-drafts/${book.id}/recheck`).set(auth(other.token)).send({})).status).toBe(404);
    expect((await http().get(`/agent-drafts/latest?channel=INSTAGRAM&chatId=${c.chat}`).set(auth(other.token)).expect(200)).body.draft).toBeNull();
    for (const role of ['ANALYST', 'DOCTOR']) {
      const t = await invite(c, role);
      expect((await approve(c, book, 'CREATE_VISIT', {}, t)).status).toBe(403);
    }
    expect(visitWrites()).toHaveLength(0);
    // a tampered body cannot change what is created: only the revision and the button are read
    const mgr = await invite(c, 'MANAGER');
    const res = (await approve(c, book, 'CREATE_VISIT', { startsAt: '2030-01-01T10:00:00Z', service: 'Чужа', patientId: 'x', clinicId: other.clinicId }, mgr).expect(200)).body;
    expect(res).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(1);
    expect(JSON.stringify(mock.writes)).not.toContain('2030-01-01');
    expect((await bookingReq(c))!.handledById).not.toBe(c.userId);
  });

  it('без згоди пацієнта створення неможливе: застаріла згода чи її відсутність відхиляються сервером', async () => {
    const c = await bookClinic();
    const times = await offer(c);
    await tap(c, times[0]);
    await approveStep(c, 'ASK_DATA');
    await say(c, NAME + phone());
    // forged: a "create visit" draft for a request without consent
    const rq = (await bookingReq(c))!;
    const d = await prisma.agentDraft.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, basisMessageId: '', basisAt: new Date(), stateVersion: 0, basisOwner: 'BOT', requestId: rq.id, snapshot: { status: 'READY', reply: '', action: 'NONE', proposed: null, contentKind: null, options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec: { serviceId: null, prices: [], pref: null, lang: 'uk', handoffText: '' }, allowed: ['CREATE_VISIT'], unsupported: false, step: { kind: 'CREATE_VISIT', requestId: rq.id, key: 'x', consentKey: 'x' } } } });
    const res = (await approve(c, { id: d.id, revision: 1 }, 'CREATE_VISIT').expect(200)).body;
    expect(res).toMatchObject({ ok: false, outcome: 'REFUSED' });
    expect(visitWrites()).toHaveLength(0);
    expect(mock.writes).toHaveLength(0);
  });

  it('пам’ять діалогу працює без аналітики; події лише за ввімкненим прапорцем', async () => {
    const c = await bookClinic({ events: false });
    await consented(c);
    const book = (await latest(c))!;
    await approve(c, book, 'CREATE_VISIT').expect(200);
    expect(await rows(c, 'funnelEvent')).toBe(0);
    expect(await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ salesStage: 'CLOSED' });
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ consentKey: expect.any(String), consentAt: expect.any(Date), externalVisitId: expect.any(String) });
    expect(visitWrites()).toHaveLength(1);
    expect(app.get(RequestsService)).toBeTruthy();
  });

  it('дані: питається лише відсутнє, раніше задане не повторюється; звʼязаний пацієнт з підтвердженою особою нічого не вказує', async () => {
    const c = await bookClinic();
    const times = await offer(c);
    await tap(c, times[0]);
    await approveStep(c, 'ASK_DATA');
    // the patient gives only the surname: the next question is for the first name and the phone only
    await say(c, 'Прізвище Коваль');
    const next = (await latest(c))!;
    expect(next).toMatchObject({ kind: 'ask_data' });
    expect(next.previews.ASK_DATA).toContain('ім’я');
    expect(next.previews.ASK_DATA).not.toMatch(/прізвище/i);
    await approve(c, next, 'ASK_DATA').expect(200);
    expect(await latest(c)).toBeNull(); // asked, waiting for the answer
    // a patient whose chat an administrator tied to the card: nothing is asked, the summary has the card's name
    const l = await bookClinic();
    const card = await prisma.patient.findFirstOrThrow({ where: { clinicId: l.clinicId, removedAt: null, NOT: { phoneNorm: null } } });
    const t = await offer(l);
    await http().post(`/conversations/INSTAGRAM/${l.chat}/link`).set(auth(l.token)).send({ patientId: card.id }).expect(200);
    await tap(l, t[0]);
    const q = (await latest(l))!;
    expect(q).toMatchObject({ kind: 'ask_consent' });
    expect(q.booking).toMatchObject({ newCard: false, name: card.fullName });
  });

  it('перевірка після невідомого результату, коли створений візит займає єдиний вільний кабінет: знаходить свій візит, а не вважає час зайнятим і не пише вдруге', async () => {
    const c = await bookClinic({ events: true });
    const { times } = await consentedLinked(c);
    const t = times[0];
    // the second cabinet is taken at that time: the only free place is the one the first attempt will use (and fill)
    const hh = Number(t.time.slice(0, 2));
    mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: '802', visit_start: `${t.date} ${t.time}:00`, visit_end: `${t.date} ${String(hh + 1).padStart(2, '0')}:${t.time.slice(3)}:00`, note: 'test', price_items: null, date_created: `${t.date} 08:00:00`, date_edited: `${t.date} 08:00:00` });
    const book = (await latest(c))!;
    reads.failAfterVisitWrite = true;
    mock.control.dropReplyAfterWrite = true;
    expect((await approve(c, book, 'CREATE_VISIT').expect(200)).body).toMatchObject({ outcome: 'UNKNOWN' });
    mock.control.dropReplyAfterWrite = false;
    reads.failAfterVisitWrite = false;
    expect(visitWrites()).toHaveLength(1);
    const u = (await latest(c))!;
    expect(u).toMatchObject({ status: 'UNKNOWN', kind: 'create_visit' });
    const checked = (await http().post(`/agent-drafts/${u.id}/recheck`).set(auth(c.token)).expect(200)).body;
    expect(checked).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(1); // nothing written again
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId, kind: 'CREATE' } })).toBe(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    expect((await bookingReq(c))!.externalVisitId).toBeTruthy();
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
  });

  it('невідомий результат саме запису візиту (картка вже є): жодного другого запису, перевірка знаходить візит; а втрачену відповідь, яку одразу вдалося перевірити, не видають за невідому', async () => {
    const c = await bookClinic({ events: true });
    await consentedLinked(c);
    const book = (await latest(c))!;
    reads.failAfterVisitWrite = true;
    mock.control.dropReplyAfterWrite = true;
    const res = (await approve(c, book, 'CREATE_VISIT').expect(200)).body;
    mock.control.dropReplyAfterWrite = false;
    reads.failAfterVisitWrite = false;
    expect(res).toMatchObject({ ok: false, outcome: 'UNKNOWN' });
    expect(visitWrites()).toHaveLength(1); // the visit WAS written, the answer was lost and could not be checked
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(0);
    expect((await approve(c, book, 'CREATE_VISIT').expect(200)).body).toMatchObject({ outcome: 'UNKNOWN', already: true });
    expect(visitWrites()).toHaveLength(1);
    const u = (await latest(c))!;
    expect((await http().post(`/agent-drafts/${u.id}/recheck`).set(auth(c.token)).expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    // a lost answer that the immediate check CAN settle is not shown as unknown: the visit is found, recorded once
    const d = await bookClinic({ events: true });
    await consentedLinked(d, 3);
    const b2 = (await latest(d))!;
    mock.control.dropReplyAfterWrite = true;
    const settled = (await approve(d, b2, 'CREATE_VISIT').expect(200)).body;
    mock.control.dropReplyAfterWrite = false;
    expect(settled).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(2);
    expect(await prisma.bookingAttempt.count({ where: { clinicId: d.clinicId, kind: 'CREATE' } })).toBe(1);
  });
});
