import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AgentApprovalService } from '../src/automations/agent-approval.service';
import { SendError } from '../src/automations/channels';
import { AgentAutoService } from '../src/automations/agent-auto.service';
import { AgentAutoGate } from '../src/automations/agent-auto-gate';
import { IntakeService } from '../src/automations/intake.service';
import { SyncService } from '../src/integrations/sync.service';
import { RequestsService } from '../src/automations/requests.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, clinicHm, localToUtc } from '../src/common/clinic-time';
import { encrypt } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Stage 4: the agent's limited AUTONOMOUS mode: the same path as the staff-approved one, without the buttons, only for listed dialogs.
// (Stage 3, kept for context: from the approved offer of times to a visit: the patient's choice, the data, the patient's consent, the staff member's explicit creation of the visit.
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


const countOut = (c: C, extra: object = {}) => prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null, ...extra } });
const allow = (c: C, chat = c.chat) => {
  process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${chat}`].filter(Boolean).join(',');
};
let modelCalls = 0;
const stateOf = (c: C) => prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } });
// an autonomous clinic: the agent, the autonomy switch, the one test service (the consultation), writing on
async function autoClinic(o: { events?: boolean; auto?: boolean; listed?: boolean } = {}) {
  const c = await agentClinic({ events: o.events });
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: o.auto !== false, agentAutoServiceId: c.consult.id } });
  if (o.listed !== false) allow(c);
  const s = await refOf(c, 'Тестова консультація');
  fake.script = () => {
    modelCalls++;
    return decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
  };
  return { c, s };
}
const ask = (c: C, text = 'Скільки коштує тестова консультація?', mid?: string) => intake().handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: mid ?? `a${++midCounter}${rnd()}`, text });
let midCounter = 0;
const lastOut = async (c: C) => (await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null }, orderBy: { createdAt: 'desc' } }));

beforeEach(() => {
  modelCalls = 0;
  delete process.env.AGENT_AUTO_DIALOGS;
});
afterAll(() => {
  delete process.env.AGENT_AUTO_DIALOGS;
});

// a model that answers with a fixed text for every call (and counts the calls)
const scriptedModel = (fn: () => string) => {
  fake.script = () => {
    modelCalls++;
    return fn();
  };
  fake.complete = (async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 })) as never;
};

describe('автономний режим агента: той самий шлях без кнопок', () => {
  it('повний діалог без кнопок: відповідь і час → вибір → дані → згода → візит → підтвердження; кожна дія системи через той самий механізм', async () => {
    const { c } = await autoClinic({ events: true });
    // 1. the first question: the agent answers with the price and the times by itself
    await ask(c);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('100 грн');
    const times = transport.sent[0].options;
    expect(times.length).toBeGreaterThan(0);
    expect(modelCalls).toBe(1);
    // 2. the patient taps a time: the missing data is asked by itself, not through the model
    await tap(c, times[0]);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].text).toContain('прізвище');
    // 3. the data: the consent question with the buttons
    const num = phone();
    await say(c, NAME + num);
    expect(transport.sent).toHaveLength(3);
    expect(transport.sent[2].options.map((o) => o.label).sort()).toEqual(['Ні, інший час', 'Так, підтверджую']);
    expect(mock.writes).toHaveLength(0);
    // 4. the patient's yes: the visit is created and told, once
    const rq = (await bookingReq(c))!;
    expect(rq).toMatchObject({ stage: 'CONFIRM', service: 'Тестова консультація' });
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent).toHaveLength(4);
    expect(transport.sent[3].text).toContain('Ваш запис підтверджено');
    const done = (await bookingReq(c))!;
    expect(done).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', confirmSource: 'AUTO', noticeStatus: 'SENT', handledById: null });
    expect(done.externalVisitId).toBeTruthy();
    // no model call after the first answer, no staff action, every message is the system's
    expect(modelCalls).toBe(1);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT', authorUserId: { not: null } } })).toBe(0);
    // the same drafts and requests as the manual path
    expect((await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'asc' } })).map((d) => `${d.choice}:${d.status}`)).toEqual(['SEND_TIMES:SENT', 'ASK_DATA:SENT', 'ASK_CONSENT:SENT', 'CREATE_VISIT:SENT']);
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId, kind: 'CREATE', status: 'DONE' } })).toBe(1);
    expect((await prisma.funnelEvent.findMany({ where: { clinicId: c.clinicId } })).map((e) => e.kind).sort()).toEqual(['BOOKED', 'CLIENT_CONFIRMED', 'INQUIRY', 'TIME_OFFERED']);
    expect(await stateOf(c)).toMatchObject({ salesStage: 'CLOSED', owner: 'BOT', leaseToken: null });
    // the lease is let go, the next message of the patient is answered as usual
    expect((await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } })).autoSeenId).toBeTruthy();
  });

  it('вимкнено за замовчуванням: aiAgentMode сам не вмикає автономність; порожній список, чужий діалог, не кабінети, немає тестової послуги — відмова', async () => {
    const results: string[] = [];
    // 1. the agent without the autonomy switch: drafts only, nothing goes out by itself
    const a = await autoClinic({ auto: false });
    await ask(a.c);
    results.push(`off:${transport.sent.length}`);
    expect(await rows(a.c, 'agentDraft')).toBe(0);
    // 2. the switch is on but the list is empty or missing: a denial, not a permission for all
    delete process.env.AGENT_AUTO_DIALOGS;
    const b = await autoClinic({ listed: false });
    await ask(b.c);
    expect(transport.sent).toHaveLength(0);
    process.env.AGENT_AUTO_DIALOGS = '';
    await ask(b.c);
    expect(transport.sent).toHaveLength(0);
    // 3. another dialog of the same clinic is not on the list
    const c = await autoClinic();
    await ask(c.c, 'Скільки коштує тестова консультація?');
    const before = transport.sent.length;
    const other = { ...c.c, chat: `ig${rnd()}` };
    await ask(other);
    expect(transport.sent).toHaveLength(before);
    expect(await prisma.agentDraft.count({ where: { clinicId: c.c.clinicId, chatId: other.chat } })).toBe(0);
    // 4. no test service: denied in both scheduling modes (the doctors mode is allowed since 2026-11-11, see agent-administrator.md section 41; an unknown mode is not)
    const d = await autoClinic();
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { scheduleMode: 'DOCTORS', agentAutoServiceId: null } });
    const n1 = transport.sent.length;
    await ask(d.c);
    expect(transport.sent).toHaveLength(n1);
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { scheduleMode: 'CABINETS' } });
    await ask(d.c);
    expect(transport.sent).toHaveLength(n1);
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { scheduleMode: 'OTHER', agentAutoServiceId: d.c.consult.id } });
    expect(await app.get(AgentAutoGate).denied(d.c.clinicId, 'INSTAGRAM', d.c.chat)).toBe('not_cabinets');
    // the manual path of the clinic with the agent only is unchanged: a staff member makes the draft and approves it
    const draft = await make(a.c);
    expect((await approve(a.c, draft, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'SENT' });
    expect(results).toEqual(['off:0']);
  });

  it('повторний вебхук і повторне «так»: нічого не дублюється, один візит', async () => {
    const { c } = await autoClinic({ events: true });
    const m1 = `dup${rnd()}`;
    await ask(c, 'Скільки коштує тестова консультація?', m1);
    await ask(c, 'Скільки коштує тестова консультація?', m1); // the same delivery again
    expect(transport.sent).toHaveLength(1);
    expect(modelCalls).toBe(1);
    const times = transport.sent[0].options;
    await tap(c, times[0]);
    await say(c, NAME + phone());
    const rq = (await bookingReq(c))!;
    const mid = `yes${rnd()}`;
    for (let i = 0; i < 3; i++) await intake().handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid, text: 'Так, підтверджую', payload: `bookyes|${rq.id}` });
    await say(c, 'так');
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
  });

  it('два швидких повідомлення: обробляються по черзі, нове не губиться, відповідь не дублюється', async () => {
    const { c } = await autoClinic();
    await Promise.all([ask(c, 'Скільки коштує тестова консультація?'), ask(c, 'І ще: чи є знижки для студентів?')]);
    const lastIn = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'IN' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const st = await stateOf(c);
    expect(st.autoSeenId).toBe(lastIn.id); // the newest message was looked at
    expect(st.leaseToken).toBeNull();
    const last = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(last.direction).toBe('OUT'); // the dialogue ends with an answer, not with an unanswered message
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    expect(transport.sent.length).toBeLessThanOrEqual(2);
    expect(new Set(transport.sent.map((m) => m.text)).size).toBe(transport.sent.length);
    expect(mock.writes).toHaveLength(0);
  });

  it('співробітник втрутився під час підготовки відповіді: нічого не відправляється, діалог у співробітника до явного повернення; повернення обробляє повідомлення', async () => {
    const { c, s } = await autoClinic();
    let once = true;
    fake.script = () => {
      modelCalls++;
      return decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
    };
    const original = fake.complete;
    fake.complete = (async () => {
      if (once) {
        once = false;
        // the staff member answers while the model is working
        await http().post(`/conversations/INSTAGRAM/${c.chat}/reply`).set(auth(c.token)).send({ text: 'Вітаю! Зараз підкажу особисто.' }).expect(200);
      }
      return { text: fake.script(), inputTokens: 1, outputTokens: 1 };
    }) as never;
    try {
      await ask(c);
    } finally {
      fake.complete = original;
    }
    expect(transport.sent.map((m) => m.text)).toEqual(['Вітаю! Зараз підкажу особисто.']); // only the person's message
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    // a new message of the patient does not wake the agent
    await ask(c, 'А коли ви працюєте?');
    expect(transport.sent).toHaveLength(1);
    // the dialogue is given back explicitly: the unhandled message is answered
    await http().post(`/conversations/INSTAGRAM/${c.chat}/resume-bot`).set(auth(c.token)).send({}).expect(200);
    expect(await stateOf(c)).toMatchObject({ owner: 'BOT' });
    expect(transport.sent.length).toBe(2);
    expect(await countOut(c, { authorUserId: null })).toBe(1);
  });

  it('режим вимкнено перед дією: чернетка підготовлена, але нічого не відправлено й візит не створено', async () => {
    const { c, s } = await autoClinic();
    const original = fake.complete;
    fake.complete = (async () => {
      // the switch is turned off while the model works
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiAgentAuto: false } });
      return { text: decision({ reply: 'Дякуємо.', prices: [s] }, { action: 'OFFER_TIME', service: s }), inputTokens: 1, outputTokens: 1 };
    }) as never;
    try {
      await ask(c);
    } finally {
      fake.complete = original;
    }
    expect(transport.sent).toHaveLength(0);
    expect(await prisma.agentDraft.count({ where: { clinicId: c.clinicId, status: 'SENT' } })).toBe(0);
    // and the same before the visit: the consent was given, the permission is withdrawn, the visit is not made
    const d = await autoClinic();
    await ask(d.c);
    await tap(d.c, transport.sent[0].options[0]);
    await say(d.c, NAME + phone());
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { aiAgentAuto: false } });
    const rq = (await bookingReq(d.c))!;
    await say(d.c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(0);
    expect((await bookingReq(d.c))!.confirmedAt).toBeNull();
    expect(await bookingReq(d.c)).toMatchObject({ consentAt: expect.any(Date) }); // the consent is recorded; a person (or the mode, when it is back on) goes on
  });

  it('зупинка й відновлення обробника: прострочена оренда підхоплюється, повідомлення не губиться; непрострочена не перехоплюється; перерваний запис не відправляється вдруге', async () => {
    const { c } = await autoClinic();
    // a worker took the dialogue and stopped: the lease is held, a message arrived
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, leaseToken: 'dead-worker', leaseUntil: new Date(Date.now() + 60_000) } });
    await incoming(c, 'Скільки коштує тестова консультація?');
    await app.get(AgentAutoService).onInbound(c.clinicId, 'INSTAGRAM', c.chat);
    expect(transport.sent).toHaveLength(0); // the holder is still alive: nobody takes the dialogue over
    expect(await app.get(AgentAutoService).sweep()).toBe(0);
    // the lease expired: the sweep of the scheduler takes the dialogue over and answers once
    await prisma.conversationState.update({ where: { clinicId_channel_chatId: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat } }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect(await app.get(AgentAutoService).sweep()).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await app.get(AgentAutoService).sweep()).toBe(0); // nothing is handled twice
    expect(transport.sent).toHaveLength(1);
    expect((await stateOf(c)).leaseToken).toBeNull();

    // a worker stopped between the send and the saved result, without the channel's confirmation: unknown, a person's task, nothing is sent again
    const d = await autoClinic();
    await ask(d.c);
    const times = transport.sent[transport.sent.length - 1].options;
    await tap(d.c, times[0]);
    const sentBefore = transport.sent.length;
    const stuck = await prisma.agentDraft.findFirstOrThrow({ where: { clinicId: d.c.clinicId, status: 'SENT', choice: 'ASK_DATA' } });
    await prisma.agentDraft.update({ where: { id: stuck.id }, data: { status: 'APPROVING', transportConfirmedAt: null, messageId: null } });
    await prisma.$executeRawUnsafe(`update "AgentDraft" set "updatedAt" = now() - interval '5 minutes' where id = $1`, stuck.id);
    await say(d.c, NAME + phone());
    expect(transport.sent).toHaveLength(sentBefore);
    expect((await prisma.agentDraft.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('UNKNOWN');
    expect(await stateOf(d.c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: d.c.clinicId, kind: 'HANDOFF' } })).toBe(1);
  });

  it('зайнятий слот: до згоди вибір не приймається; після згоди візит не створюється, це справа співробітника', async () => {
    const { c } = await autoClinic();
    await ask(c);
    const times = transport.sent[0].options;
    await tap(c, times[0]);
    await say(c, NAME + phone());
    const rq = (await bookingReq(c))!;
    for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${times[0].date} ${times[0].time}:00`, visit_end: `${times[0].date} ${String(Number(times[0].time.slice(0, 2)) + 1).padStart(2, '0')}:${times[0].time.slice(3)}:00`, note: 'test', price_items: null, date_created: `${times[0].date} 08:00:00`, date_edited: `${times[0].date} 08:00:00` });
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
    expect(visitWrites()).toHaveLength(0);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0);
    expect((await bookingReq(c))!.confirmedAt).toBeNull();
  });

  it('невідомий результат запису: автономний режим зупиняється, нічого не повторює, співробітник перевіряє; пацієнту «записано» не кажуть', async () => {
    const { c } = await autoClinic({ events: true });
    // the chat is tied to a card (identity confirmed): only the visit is written
    await ask(c);
    const times = transport.sent[0].options;
    const card = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null }, externalId: { not: { startsWith: 'demo-' } } }, orderBy: { externalId: 'desc' } });
    await http().post(`/conversations/INSTAGRAM/${c.chat}/link`).set(auth(c.token)).send({ patientId: card.id }).expect(200);
    await tap(c, times[0]);
    const rq = (await bookingReq(c))!;
    reads.failAfterVisitWrite = true;
    mock.control.dropReplyAfterWrite = true;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    mock.control.dropReplyAfterWrite = false;
    reads.failAfterVisitWrite = false;
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(0);
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } })).toBe(1);
    // more messages of the patient change nothing
    await ask(c, 'То що, мене записали?');
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(0);
    // the staff member checks (the existing recheck): found, recorded once, the patient is told once
    const u = (await latest(c))!;
    expect(u).toMatchObject({ status: 'UNKNOWN', kind: 'create_visit' });
    expect((await http().post(`/agent-drafts/${u.id}/recheck`).set(auth(c.token)).expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(visitWrites()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
  });

  it('існуючий пацієнт без підтвердженої особи й інша послуга: це справа співробітника, візиту немає; модель не може обрати BOOK', async () => {
    const { c } = await autoClinic();
    const card = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null }, fullName: { not: '' } } });
    await ask(c);
    await tap(c, transport.sent[0].options[0]);
    await say(c, `Прізвище Тестенко, ім’я Олена, телефон ${card.phone}`);
    expect(mock.writes).toHaveLength(0);
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } })).toBe(1);
    expect(JSON.stringify(transport.sent)).not.toContain(card.fullName);
    // the model proposes BOOK: never executed, the safe hand-over answers
    const e = await autoClinic();
    const s = await refOf(e.c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Записую вас.' }, { action: 'BOOK', service: s });
    await ask(e.c);
    expect(mock.writes).toHaveLength(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId: e.c.clinicId, kind: 'BOOKING' } })).toBe(0);
    // the times of a service that is not the clinic's test service are not offered by itself: the staff are told
    const f = await autoClinic();
    const hygiene = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: f.c.clinicId, title: 'Тестова гігієна' } });
    await prisma.clinic.update({ where: { id: f.c.clinicId }, data: { agentAutoServiceId: hygiene.id } });
    const n = transport.sent.length;
    await ask(f.c);
    expect(transport.sent).toHaveLength(n);
    expect(await prisma.bookingRequest.count({ where: { clinicId: f.c.clinicId, kind: 'HANDOFF' } })).toBe(1);
    expect(await stateOf(f.c)).toMatchObject({ owner: 'HUMAN' });
  });

  it('ізоляція: автономні дії однієї клініки не торкаються іншої; ручний режим клініки без автономності не змінився', async () => {
    const a = await autoClinic();
    const b = await autoClinic({ auto: false });
    await ask(a.c);
    expect(await prisma.agentDraft.count({ where: { clinicId: b.c.clinicId } })).toBe(0);
    expect(await prisma.conversationState.count({ where: { clinicId: b.c.clinicId } })).toBe(0);
    // the platform owner sets the switch only for an approved service of that clinic
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: b.c.clinicId } })).toMatchObject({ aiAgentAuto: false });
  });

  it('два повідомлення в одну мілісекунду: чернетка не вважається застарілою через рівний час (порядок за часом і ідентифікатором)', async () => {
    const { c } = await autoClinic({ auto: false });
    const t = new Date();
    const mk = (text: string) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text, createdAt: t } });
    await mk('Скільки коштує тестова консультація?');
    await mk('І ще питання');
    const v = await make(c);
    expect((await latest(c))!.stale).toEqual({ stale: false, reasons: [] });
    expect((await approve(c, v, v.allowed[0]).expect(200)).body).toMatchObject({ outcome: 'SENT' });
  });

// a model that answers with a fixed text for every call (and counts the calls)
const scriptedModel = (fn: () => string) => {
  fake.script = () => {
    modelCalls++;
    return fn();
  };
  fake.complete = (async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 })) as never;
};

describe('виправлення після живого прогону автономного шляху', () => {
  const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);
  const decideBy = (map: (last: string) => string) => {
    // the fake model answers by the last words of the patient (the real model decides in the live run)
    fake.complete = (async (_system: string, messages: { role: string; content: string }[]) => ({ text: map(messages[messages.length - 1].content), inputTokens: 1, outputTokens: 1 })) as never;
  };
  // back to the scripted model (a fixed answer for every call)
  const scripted = (fn: () => string) => {
    fake.complete = (async () => ({ text: fn(), inputTokens: 1, outputTokens: 1 })) as never;
    fake.script = fn;
  };
  afterEach(() => scripted(() => ''));

  it('передача людині: HUMAN, одна заявка, одне підтвердження; наступні повідомлення зберігаються і не запускають агента; без заявки — не «передали»', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(c, 'Покличте, будь ласка, адміністратора, хочу поговорити з людиною');
    expect(sendsTo(c)).toHaveLength(1);
    expect(sendsTo(c)[0].text).toContain('Передали ваше запитання адміністратору');
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
    // further messages are saved for the staff and answered by nobody
    const modelCallsBefore = modelCalls;
    await ask(c, 'Ви тут? Мені потрібна людина');
    await ask(c, 'Скільки коштує консультація?');
    expect(sendsTo(c)).toHaveLength(1);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'IN' } })).toBe(3);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
    expect(modelCalls).toBe(modelCallsBefore);
    // a request for a person in the middle of a booking ends it: the chosen time stays for the staff, nothing is asked or sold again
    const b = await autoClinic();
    scripted(() => decision({ reply: 'Дякуємо.', prices: [b.s] }, { action: 'OFFER_TIME', service: b.s }));
    await ask(b.c, 'Хочу записатися');
    await tap(b.c, sendsTo(b.c)[0].options[0]);
    const n = sendsTo(b.c).length;
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(b.c, 'Ой, краще покличте людину, будь ласка');
    expect(sendsTo(b.c)).toHaveLength(n + 1);
    expect(sendsTo(b.c)[n].text).toContain('Передали ваше запитання адміністратору'); // the hand-over, not the data question again
    expect(await stateOf(b.c)).toMatchObject({ owner: 'HUMAN' });
    await say(b.c, `Мене звати Ірина Коваль, мій номер ${phone()}`);
    expect(sendsTo(b.c)).toHaveLength(n + 1);
    expect(mock.writes).toHaveLength(0);
    expect(s).toBeTruthy();

    // the request cannot be made: "handed over" is NOT said, the agent does not go on by itself
    const f = await autoClinic();
    const failing = jest.spyOn(app.get(RequestsService), 'upsert').mockRejectedValue(new Error('database unavailable'));
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(f.c, 'Покличте людину, будь ласка');
    expect(sendsTo(f.c).map((m) => m.text).join(' ')).not.toMatch(/передали/i);
    expect(await stateOf(f.c)).toMatchObject({ owner: 'HUMAN' });
    expect((await prisma.agentDraft.findFirstOrThrow({ where: { clinicId: f.c.clinicId } })).status).toBe('FAILED');
    await ask(f.c, 'Скільки коштує консультація?');
    expect(sendsTo(f.c)).toHaveLength(0);
    failing.mockRestore();
  });

  it('відхилена послуга: текст узгоджений з перевіркою — не «так, можна записатися», не «не надаємо», слотів тестової послуги замість неї немає, запит передано', async () => {
    const { c } = await autoClinic();
    const hygiene = await refOf(c, 'Тестова гігієна');
    decideBy(() => decision({ reply: 'Так, на гігієну можна записатися завтра. Вона триває 30 хвилин.' }, { action: 'OFFER_TIME', service: hygiene }));
    await ask(c, 'А на гігієну можна записатися на завтра?');
    const out = sendsTo(c);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('Онлайн-запис на «Тестова гігієна» наразі недоступний');
    expect(out[0].text).toContain('Ми передали ваш запит адміністратору');
    expect(out[0].text).not.toMatch(/можна записатися|не надаємо|не надає|Тестова консультація/);
    expect(out[0].options).toEqual([]);
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
    expect(mock.writes).toHaveLength(0);
  });

  it('питання посеред запису: відповідь і один зрозумілий наступний крок; час і послуга збережені; відмова, «людину» чи інший час не повертають до старого кроку', async () => {
    const { c, s } = await autoClinic();
    scripted(() => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Хочу записатися на консультацію');
    const times = sendsTo(c)[0].options;
    await tap(c, times[0]);
    const slot = (await bookingReq(c))!.slotAt!.getTime();
    // a question right after choosing the time: answered, then only the missing data is asked
    decideBy(() => decision({ reply: 'Консультація триває близько 30 хвилин.', prices: [s] }));
    const before = sendsTo(c).length;
    await ask(c, 'А скільки це коштує?');
    const added = sendsTo(c).slice(before);
    expect(added).toHaveLength(2);
    expect(added[0].text).toContain('100 грн');
    expect(added[1].text).toMatch(/прізвище/i);
    expect((await bookingReq(c))!).toMatchObject({ stage: 'COLLECT' });
    expect((await bookingReq(c))!.slotAt!.getTime()).toBe(slot);
    // the data, then a question at the consent: answered, and the consent question is asked again (the same service and time)
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    expect((await bookingReq(c))!).toMatchObject({ stage: 'CONFIRM' });
    const consentKey = (await bookingReq(c))!.consentKey;
    const n2 = sendsTo(c).length;
    await ask(c, 'А це надовго?');
    const added2 = sendsTo(c).slice(n2);
    expect(added2).toHaveLength(2);
    expect(added2[1].options.map((o) => o.label).sort()).toEqual(['Ні, інший час', 'Так, підтверджую']);
    expect((await bookingReq(c))!.consentKey).toBe(consentKey);
    expect((await bookingReq(c))!.consentAt).toBeNull(); // asking again is not consent
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);

    // a decline, a request for a person and a change of the wish are not sent back to the old step
    for (const [name, answer, expectOwner] of [
      ['decline', decision({ reply: 'Добре, дякуємо.' }, { action: 'CLOSE' }), 'BOT'],
      ['person', decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }), 'HUMAN'],
    ] as const) {
      const d = await autoClinic();
      scripted(() => decision({ reply: 'Дякуємо.', prices: [d.s] }, { action: 'OFFER_TIME', service: d.s }));
      await ask(d.c, 'Хочу записатися');
      await tap(d.c, sendsTo(d.c)[0].options[0]);
      const k = sendsTo(d.c).length;
      decideBy(() => answer);
      await ask(d.c, name === 'decline' ? 'Ні, я передумав, не потрібно?' : 'А можна поговорити з адміністратором?');
      expect(sendsTo(d.c).length).toBe(k + 1); // one answer, no step
      expect(sendsTo(d.c)[k].text).not.toMatch(/прізвище/i);
      expect((await stateOf(d.c)).owner).toBe(expectOwner);
    }
    // a changed time withdraws the old consent (unchanged rule)
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, confirmedAt: { not: null } } })).toBe(1);
  });

  it('після відповіді про ціну — одне м’яке питання «Підібрати зручний час?»: лише для послуги з онлайн-записом, не повторюється, не після відмови, не під час запису; «так» — це підбір часу, не згода на візит', async () => {
    const { c, s } = await autoClinic();
    const hygiene = await refOf(c, 'Тестова гігієна');
    decideBy(() => decision({ reply: 'Консультація триває близько 30 хвилин.', prices: [s] }));
    await ask(c, 'Скільки коштує консультація?');
    expect(sendsTo(c)).toHaveLength(1);
    expect(sendsTo(c)[0].text.trim().endsWith('Підібрати зручний час?')).toBe(true);
    expect(sendsTo(c)[0].options).toEqual([]); // no times shown without need
    // asked once: a second price question does not repeat it
    await ask(c, 'А скільки коштує консультація точно?');
    expect(sendsTo(c)[1].text).not.toContain('Підібрати зручний час?');
    // "yes" is a request for the times, not the consent to create a visit
    decideBy(() => decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Так, підберіть');
    expect(sendsTo(c)[2].options.length).toBeGreaterThan(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'BOOKING' } })).toBe(0);
    expect(mock.writes).toHaveLength(0);
    // a service without online booking, a decline, a booking that is under way, a person's dialogue: no offer
    const h = await autoClinic();
    decideBy(() => decision({ reply: 'Про гігієну.', prices: [hygiene] }));
    await ask(h.c, 'Скільки коштує гігієна?');
    expect(sendsTo(h.c)[0].text).not.toContain('Підібрати зручний час?');
    const d = await autoClinic();
    decideBy(() => decision({ reply: 'Добре.' }, { action: 'CLOSE' }));
    await ask(d.c, 'Ні, дякую, не потрібно');
    decideBy(() => decision({ reply: 'Ціна.', prices: [d.s] }));
    await ask(d.c, 'А скільки коштує консультація?');
    expect(sendsTo(d.c)[sendsTo(d.c).length - 1].text).not.toContain('Підібрати зручний час?'); // after a decline
    const b = await autoClinic();
    scripted(() => decision({ reply: 'Дякуємо.', prices: [b.s] }, { action: 'OFFER_TIME', service: b.s }));
    await ask(b.c, 'Хочу записатися');
    await tap(b.c, sendsTo(b.c)[0].options[0]);
    decideBy(() => decision({ reply: 'Ціна.', prices: [b.s] }));
    await ask(b.c, 'А скільки коштує консультація?');
    expect(sendsTo(b.c).filter((m) => m.text.includes('Підібрати зручний час?'))).toHaveLength(0); // during a booking
  });

  it('вікон немає: без «ось варіанти», передача лише пропонується питанням; згода пацієнта — реальна передача, HUMAN', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Ось які варіанти є.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Хочу записатися на консультацію після 19:00');
    const t = sendsTo(c)[0].text;
    expect(t).toContain('вільних вікон після 19:00 не знайшлося');
    expect(t).toContain('Передати ваш запит адміністратору, щоб він підібрав інший час?');
    expect(t).not.toMatch(/ось які варіанти|можемо уточнити|передали/i);
    expect(sendsTo(c)[0].options).toEqual([]);
    expect(await stateOf(c)).toMatchObject({ owner: 'BOT' }); // an offer, not a hand-over
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(0);
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'time_preference_unavailable' }));
    await ask(c, 'Так, передайте, будь ласка');
    expect(sendsTo(c)).toHaveLength(2);
    expect(sendsTo(c)[1].text).toContain('Передали ваше запитання адміністратору');
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
  });

  it('після успішного запису: повторне «так», «дякую» — без нового візиту, нового збору даних і повторної воронки', async () => {
    const { c, s } = await autoClinic({ events: true });
    scripted(() => decision({ reply: 'Дякуємо.', prices: [s] }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Хочу записатися');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    const done = sendsTo(c).length;
    decideBy(() => decision({ reply: 'Будь ласка! Гарного дня.', prices: [s] }));
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    await ask(c, 'так');
    await ask(c, 'Дякую!');
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'BOOKING' } })).toBe(1);
    const after = sendsTo(c).slice(done).map((m) => m.text).join(' | ');
    expect(after).not.toMatch(/прізвище|ім’я \(одним|Підібрати зручний час|Підтверджуєте запис/i);
    expect(sendsTo(c).slice(done).every((m) => m.options.length === 0)).toBe(true);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    expect(await prisma.agentDraft.count({ where: { clinicId: c.clinicId, choice: { in: ['ASK_DATA', 'ASK_CONSENT', 'CREATE_VISIT', 'SEND_TIMES'] } } })).toBe(4);
  });
});
});

describe('виправлення даних після вопроса про підтвердження', () => {
  // the model of this group is the default scripted one (the previous group replaced it)
  beforeEach(() => {
    fake.complete = (async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 })) as never;
  });
  const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);
  // the payload of the "yes" button of the LAST consent question that really went out
  const yesPayload = async (c: C) => {
    const msgs = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10 });
    const b = msgs.flatMap((m) => (Array.isArray(m.buttons) ? (m.buttons as { payload: string }[]) : [])).find((x) => x.payload.startsWith('bookyes|'));
    return b!.payload;
  };
  // up to the summary and the consent question (the old phone is `old`)
  async function toSummary(old: string, o: { events?: boolean } = {}) {
    const { c } = await autoClinic(o);
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${old}`);
    expect(sendsTo(c).at(-1)!.text).toContain('Дані для запису: Шевчук Оксана, ');
    return { c, oldYes: await yesPayload(c) };
  }

  it('виправлення телефону: згода й стара кнопка недійсні, візиту за старими даними немає; нове зведення спитано після збереження; нова кнопка працює', async () => {
    const oldPhone = phone();
    const newPhone = phone();
    const { c, oldYes } = await toSummary(oldPhone, { events: true });
    const before = (await bookingReq(c))!;
    await say(c, `Ні, номер інший: ${newPhone}`);
    const rq = (await bookingReq(c))!;
    expect(rq.phone).toContain(newPhone.slice(1)); // saved
    expect(rq).toMatchObject({ consentAt: null });
    expect(rq.consentKey).not.toBe(before.consentKey);
    // the new summary asked only after the save, with the NEW phone and not the old one
    const q = sendsTo(c).at(-1)!.text;
    expect(q).toContain('Дані для запису: Шевчук Оксана, ');
    expect(q).toContain(newPhone.slice(1));
    expect(q).not.toContain(oldPhone.slice(1));
    // the old button (of the first question) does nothing, even now that a new question is open
    expect(await yesPayload(c)).not.toBe(oldYes);
    await say(c, 'Так, підтверджую', oldYes);
    expect(visitWrites()).toHaveLength(0);
    expect((await bookingReq(c))!.consentAt).toBeNull();
    // the new button creates the visit for the corrected data
    await say(c, 'Так, підтверджую', await yesPayload(c));
    expect(visitWrites()).toHaveLength(1);
    expect(JSON.stringify(mock.writes.find((w) => w.path === '/patients')!.body)).toContain(newPhone.slice(1));
    expect(JSON.stringify(mock.writes.filter((w) => w.path === '/patients'))).not.toContain(oldPhone.slice(1));
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
  });

  it('виправлення імені: збережено, нове зведення з новим іменем; «так» разом із виправленням не підтверджує старе', async () => {
    const { c, oldYes } = await toSummary(phone());
    await say(c, 'Ні, прізвище Мельничук');
    expect((await bookingReq(c))!).toMatchObject({ lastName: 'Мельничук', firstName: 'Оксана', consentAt: null });
    expect(sendsTo(c).at(-1)!.text).toContain('Дані для запису: Мельничук Оксана, ');
    await say(c, 'Так, підтверджую', oldYes);
    expect(visitWrites()).toHaveLength(0);
    // "yes, but the first name is Олександра": the correction is saved, it is NOT a yes to the old summary
    const k = await yesPayload(c);
    await say(c, 'Так, але ім’я Олександра');
    expect((await bookingReq(c))!).toMatchObject({ firstName: 'Олександра', consentAt: null });
    expect(sendsTo(c).at(-1)!.text).toContain('Дані для запису: Мельничук Олександра, ');
    await say(c, 'Так, підтверджую', k);
    expect(visitWrites()).toHaveLength(0);
    // two bare words: saved as a pair, the order is asked (not guessed), nothing is booked meanwhile
    await say(c, 'Ні, Ірина Бойко');
    expect((await bookingReq(c))!).toMatchObject({ lastName: null, firstName: null, consentAt: null });
    expect(sendsTo(c).at(-1)!.text).toContain('що з цього прізвище — «Ірина» чи «Бойко»');
    expect(visitWrites()).toHaveLength(0);
  });

  it('виправлення, яке код не вміє прийняти надійно («це не мій номер», «не Оксана, а Олександра»): згода скасована, одна заявка, ОДИН нейтральний текст, HUMAN, автономний сценарій зупинено, «виправлено» не сказано', async () => {
    for (const wrong of ['Це не мій номер', 'Не Оксана, а Олександра', 'Дані невірні']) {
      const { c, oldYes } = await toSummary(phone());
      const before = sendsTo(c).length;
      await say(c, wrong);
      const rq = (await bookingReq(c))!;
      expect(rq).toMatchObject({ consentAt: null, consentKey: null, autoNote: 'data_disputed' });
      expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
      expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
      // exactly one text, the neutral one: nothing about a correction, no new question
      expect(sendsTo(c).slice(before).map((m) => m.text)).toEqual(['Передали ваше уточнення адміністратору. Він допоможе перевірити дані.']);
      await say(c, 'Так, підтверджую', oldYes); // the old button after the dispute
      await say(c, 'Так');
      expect(visitWrites()).toHaveLength(0);
      expect(sendsTo(c).length).toBe(before + 1); // the agent stays silent until a person gives the dialogue back; the notice is not repeated
      expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } })).toBe(1);
    }
    // the request for the staff cannot be made: the notice is NOT sent ("handed over" is not announced), the dialogue is still a person's
    const { c } = await toSummary(phone());
    const before = sendsTo(c).length;
    const failing = jest.spyOn(app.get(RequestsService), 'upsert').mockRejectedValue(new Error('database unavailable'));
    await say(c, 'Це не мій номер');
    failing.mockRestore();
    expect(sendsTo(c).length).toBe(before);
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    await say(c, 'Так');
    expect(sendsTo(c).length).toBe(before);
    expect(visitWrites()).toHaveLength(0);
  });

  it('те саме «так» без виправлення лишається згодою, а питання чи повтор тих самих даних її не скасовують', async () => {
    const oldPhone = phone();
    const { c, oldYes } = await toSummary(oldPhone);
    await say(c, `Так, мій номер ${oldPhone}`); // the same data repeated with a yes
    expect(visitWrites()).toHaveLength(1);
    expect(oldYes).toBeTruthy();
  });
});

describe('після завершеного запису: коротко кодом, без моделі', () => {
  beforeEach(() => {
    fake.complete = (async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 })) as never;
  });
  const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);

  it('повторне «так» (набране, стара кнопка), «дякую» і стара кнопка «ні, інший час»: короткий текст про існуючий запис або відповідь на подяку; модель не викликається; нового збору даних, часів і візиту немає', async () => {
    const { c, s } = await autoClinic({ events: true });
    scriptedModel(() => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    const oldYes = (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT' }, orderBy: { createdAt: 'desc' }, take: 5 })).flatMap((m) => (Array.isArray(m.buttons) ? (m.buttons as { payload: string }[]) : [])).find((b) => b.payload.startsWith('bookyes|'))!.payload;
    await say(c, 'Так, підтверджую', oldYes);
    expect(visitWrites()).toHaveLength(1);
    const done = (await bookingReq(c))!;
    const when = `${clinicDate(done.confirmedStartsAt!).split('-').reverse().join('.')} о ${clinicHm(done.confirmedStartsAt!)}`;
    const calls = modelCalls;
    const n = sendsTo(c).length;
    await say(c, 'Так, підтверджую', oldYes); // the old button
    await ask(c, 'так'); // typed
    await ask(c, 'Так, підтверджую'); // typed, the button's words
    await ask(c, 'Дякую!');
    await say(c, 'Ні, інший час', `bookno|${rq.id}`); // the old "no" button
    expect(modelCalls).toBe(calls); // no model call at all
    const added = sendsTo(c).slice(n).map((m) => m.text);
    expect(added).toHaveLength(5);
    for (const i of [0, 1, 2]) expect(added[i]).toBe(`Ваш запис уже підтверджено: Тестова консультація, ${when}. Додаткових дій не потрібно.`);
    expect(added[3]).toBe('Будь ласка! До зустрічі.');
    expect(added[4]).toContain(`Ваш запис підтверджено: Тестова консультація, ${when}. Щоб змінити час або скасувати запис`);
    expect(added.join(' ')).not.toMatch(/прізвище|Підібрати|Підтверджуєте|Оберіть/);
    expect(sendsTo(c).slice(n).every((m) => m.options.length === 0)).toBe(true);
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'BOOKING' } })).toBe(1);
    // Russian
    const r = await autoClinic();
    scriptedModel(() => decision({ reply: 'Спасибо.' }, { action: 'OFFER_TIME', service: r.s }));
    await ask(r.c, 'Здравствуйте, хочу записаться на консультацию');
    await tap(r.c, sendsTo(r.c)[0].options[0]);
    await say(r.c, `Фамилия Шевчук, имя Оксана, телефон ${phone()}`);
    const rq2 = (await bookingReq(r.c))!;
    await say(r.c, 'Да, подтверждаю', `bookyes|${rq2.id}`);
    const k = sendsTo(r.c).length;
    await ask(r.c, 'Спасибо!');
    expect(sendsTo(r.c)[k].text).toBe('Пожалуйста! До встречи.');
  });

  it('новий змістовний питання після запису не губиться: іде до моделі; передача людині для переносу лишається передачею', async () => {
    const { c, s } = await autoClinic();
    scriptedModel(() => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
    await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
    const calls = modelCalls;
    const n = sendsTo(c).length;
    scriptedModel(() => decision({ reply: 'Консультація триває близько 30 хвилин. Ваш запис уже підтверджено, чекаємо вас.' }));
    await ask(c, 'А скільки триває консультація?');
    expect(modelCalls).toBe(calls + 1);
    expect(sendsTo(c).slice(n).map((m) => m.text).join(' ')).toContain('Ваш запис уже підтверджено, чекаємо вас.'); // not refused as a "done" claim: the system's record says it is true
    // a request to move the visit THIS dialogue booked is the code's move (since 2026-11-11, agent-administrator.md section 46): the question about the day and the
    // time, no model call; the visit itself is not touched until the patient confirms a new time (see test/agent-move.spec.ts)
    const k = modelCalls;
    await ask(c, 'Мені треба перенести запис на інший день');
    expect(modelCalls).toBe(k);
    expect(sendsTo(c)[sendsTo(c).length - 1].text).toContain('На який день і час вам зручно його перенести?');
    expect(await stateOf(c)).toMatchObject({ owner: 'BOT' });
    expect(visitWrites()).toHaveLength(1);
  });
});

// The clinic's own activation (2026-11-12): Pro gives the right, the owner finishes the setup and switches the agent on for the whole clinic; the server
// list of dialogs is then not needed. An older test activation (scope DIALOGS) is never widened without that step.
describe('агент: самостійне ввімкнення власником клініки на тарифі «Про»', () => {
  const agent = (c: C) => http().get('/ai/agent').set(auth(c.token));
  const connectInstagram = (c: C) => prisma.integration.create({ data: { clinicId: c.clinicId, provider: 'INSTAGRAM', apiKeyEnc: encrypt(`ig-${rnd()}`) } });
  // a clinic with everything set up but the agent's autonomy off and no dialog on the server list
  async function readyClinic() {
    const { c } = await autoClinic({ auto: false, listed: false });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { agentAutoServiceId: null } });
    await connectInstagram(c);
    return c;
  }

  it('тариф сам нічого не вмикає; без послуг і каналу ввімкнути не можна; після ввімкнення агент відповідає в новому діалозі без серверного списку', async () => {
    const c = await readyClinic();
    let st = (await agent(c).expect(200)).body;
    expect(st).toMatchObject({ inPlan: true, active: false, ready: false, testMode: false });
    expect(st.prerequisites.find((p: { key: string }) => p.key === 'services').met).toBe(false);
    await http().post('/ai/agent/activate').set(auth(c.token)).expect(400);
    await ask(c);
    expect(transport.sent).toHaveLength(0);

    // the owner picks the services: only approved, active services of this clinic, at most five, no repeats
    const other = await agentClinic();
    await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [other.consult.id] }).expect(400);
    await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [c.consult.id, c.consult.id] }).expect(400);
    st = (await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [c.consult.id] }).expect(200)).body;
    expect(st).toMatchObject({ ready: true, active: false });
    expect(st.services.map((s: { id: string }) => s.id)).toEqual([c.consult.id]);

    st = (await http().post('/ai/agent/activate').set(auth(c.token)).expect(200)).body;
    expect(st).toMatchObject({ active: true, paused: false });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiAgentMode: true, aiAgentAuto: true, agentAutoScope: 'CLINIC' });
    // no server list at all, and a dialogue nobody ever listed
    expect(process.env.AGENT_AUTO_DIALOGS).toBeUndefined();
    await ask(c);
    expect(transport.sent.length).toBeGreaterThan(0);
    const fresh = { ...c, chat: `ig${rnd()}` };
    const before = transport.sent.length;
    await ask(fresh);
    expect(transport.sent.length).toBeGreaterThan(before);
    // Telegram is covered by the same owner switch (owner's decision of 2026-11-16): a new Telegram dialogue is answered too
    expect(await app.get(AgentAutoGate).denied(c.clinicId, 'TELEGRAM', 'tg1')).toBeNull();
    const tgBefore = transport.sent.length;
    await intake().handle(c.clinicId, { channel: 'TELEGRAM', chatId: `tg${rnd()}`, mid: `tg-${rnd()}`, text: 'Скільки коштує тестова консультація?' });
    expect(transport.sent.length).toBeGreaterThan(tgBefore);
    // channels the agent does not serve stay denied
    expect(await app.get(AgentAutoGate).denied(c.clinicId, 'VIBER', 'v1')).toBe('channel_not_supported');
    // the website chat (2026-11-17) is NOT reached by that switch: the owner includes it explicitly; until then the agent leaves it to the staff
    const web = `w-${rnd()}`;
    expect(await app.get(AgentAutoGate).denied(c.clinicId, 'WEB', web)).toBe('web_not_included');
    await intake().handle(c.clinicId, { channel: 'WEB', chatId: web, mid: null, text: 'Скільки коштує тестова консультація?' });
    const webOut = () => prisma.chatMessage.count({ where: { clinicId: c.clinicId, channel: 'WEB', chatId: web, direction: 'OUT' } });
    expect(await webOut()).toBe(0);
    const manager = await invite(c, 'MANAGER');
    await http().patch('/automations/webchat').set(auth(manager)).send({ aiAnswers: true }).expect(403);
    await http().patch('/automations/webchat').set(auth(c.token)).send({ aiAnswers: true }).expect(200);
    expect(await app.get(AgentAutoGate).denied(c.clinicId, 'WEB', web)).toBeNull();
    await intake().handle(c.clinicId, { channel: 'WEB', chatId: web, mid: null, text: 'А скільки вона триває?' });
    expect(await webOut()).toBeGreaterThan(0);
    // the visitor asks for a person: the agent stops in that dialogue
    await prisma.conversationState.updateMany({ where: { clinicId: c.clinicId, channel: 'WEB', chatId: web }, data: { owner: 'HUMAN' } });
    const n = await webOut();
    await intake().handle(c.clinicId, { channel: 'WEB', chatId: web, mid: null, text: 'Ще питання' });
    expect(await webOut()).toBe(n);
  });

  it('права: вмикає й змінює лише власник; керуючий бачить стан; інша клініка не зачеплена', async () => {
    const c = await readyClinic();
    await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [c.consult.id] }).expect(200);
    const manager = await invite(c, 'MANAGER');
    const admin = await invite(c, 'ADMIN');
    await http().get('/ai/agent').set(auth(manager)).expect(200);
    await http().get('/ai/agent').set(auth(admin)).expect(403);
    await http().post('/ai/agent/activate').set(auth(manager)).expect(403);
    await http().put('/ai/agent/services').set(auth(manager)).send({ ids: [] }).expect(403);
    await http().post('/ai/agent/deactivate').set(auth(admin)).expect(403);
    await http().get('/ai/agent').expect(401);

    const b = await readyClinic();
    await http().post('/ai/agent/activate').set(auth(c.token)).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: b.clinicId } })).toMatchObject({ aiAgentAuto: false, agentAutoScope: 'DIALOGS' });
    expect((await agent(b).expect(200)).body.active).toBe(false);
  });

  it('старе тестове ввімкнення не розширюється: без серверного списку агент мовчить, доки власник сам не ввімкне', async () => {
    // the service owner's older activation: the switch is on, the scope is the restricted one
    const { c } = await autoClinic({ listed: false });
    await connectInstagram(c);
    expect((await agent(c).expect(200)).body).toMatchObject({ active: false, testMode: true });
    await ask(c);
    expect(transport.sent).toHaveLength(0);
    // a dialog on the list still works as before
    allow(c);
    await ask(c);
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  it('перехід на «Старт» агента не зупиняє (розподіл 2026-11-23); вимкнення власником зупиняє; старий автовідповідач при цьому не вмикається', async () => {
    const c = await readyClinic();
    await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [c.consult.id] }).expect(200);
    await http().post('/ai/agent/activate').set(auth(c.token)).expect(200);
    await ask(c);
    const sent = transport.sent.length;
    expect(sent).toBeGreaterThan(0);

    // Start includes the agent since 2026-11-23: moving there keeps it answering in every channel
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'START', aiAutoReply: true } });
    expect(await app.get(AgentAutoGate).denied(c.clinicId, 'INSTAGRAM', `ig${rnd()}`)).toBeNull();
    expect((await agent(c).expect(200)).body).toMatchObject({ inPlan: true, active: true });

    // back on Pro, then the owner switches the agent off: silent again, the agent mode (drafts) stays, the older auto-reply stays held
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'PRO' } });
    expect((await http().post('/ai/agent/deactivate').set(auth(c.token)).expect(200)).body).toMatchObject({ active: false });
    const third = { ...c, chat: `ig${rnd()}` };
    await ask(third);
    expect(transport.sent).toHaveLength(sent);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiAgentMode: true, aiAgentAuto: false });
    expect((await http().get('/ai').set(auth(c.token)).expect(200)).body).toMatchObject({ agentMode: true, autoReplyHeldByAgent: true, agentAuto: false });
  });

  it('оплата: заблокована клініка не отримує автономних відповідей', async () => {
    const c = await readyClinic();
    await http().put('/ai/agent/services').set(auth(c.token)).send({ ids: [c.consult.id] }).expect(200);
    await http().post('/ai/agent/activate').set(auth(c.token)).expect(200);
    process.env.BILLING_ENFORCED = 'true';
    try {
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { billingStatus: 'LAPSED' } });
      expect(await app.get(AgentAutoGate).denied(c.clinicId, 'INSTAGRAM', c.chat)).toBe('billing_blocked');
    } finally {
      delete process.env.BILLING_ENFORCED;
    }
  });
});
