import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AgentApprovalService } from '../src/automations/agent-approval.service';
import { SendError } from '../src/automations/channels';
import { AgentAutoService } from '../src/automations/agent-auto.service';
import { IntakeService } from '../src/automations/intake.service';
import { SyncService } from '../src/integrations/sync.service';
import { RequestsService } from '../src/automations/requests.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, clinicHm, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Privacy of the booking contacts toward the model provider, the price asked in the middle of a booking, the name parsing. (Stage 4 header kept: the agent's limited AUTONOMOUS mode: the same path as the staff-approved one, without the buttons, only for listed dialogs.
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
// the fake provider: every body that reaches api.anthropic.com is kept; `invalidNext` answers with a broken text (the repeated request follows)
const provider = { bodies: [] as { system: string; messages: { role: string; content: string }[] }[], invalidNext: 0, last: '' };
const fake = { configured: true, script: (() => '') as () => string, complete: async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 }) };
type Mode = 'ok' | 'fail' | 'ambiguous' | 'slow';
const transport = { mode: 'ok' as Mode, sent: [] as { chatId: string; text: string; options: { label: string; date: string; time: string }[] }[] };

beforeAll(async () => {
  process.env.AI_API_KEY = 'test-key-not-real';
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  const realFetch = global.fetch;
  jest.spyOn(global, 'fetch').mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'object' && input && 'url' in input ? (input as { url: string }).url : input);
    if (!url.includes('api.anthropic.com')) return realFetch(input as never, init);
    const sentBody = JSON.parse(String(init?.body));
    provider.bodies.push(sentBody);
    provider.last = sentBody.messages[sentBody.messages.length - 1].content;
    const text = provider.invalidNext > 0 ? (provider.invalidNext--, 'не JSON') : fake.script();
    return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
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


import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { maskText, scrubMessages, DATA_ANSWER_NOTE } from '../src/ai/contact-mask';
import { isPriceOnlyQuestion, isPriceQuestion } from '../src/ai/guardrails';
import { namePair } from '../src/automations/booking-flow.service';

const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);
// the synthetic patient of the scenarios
const P = { last: 'Шевчук', first: 'Оксана' };
// every test uses its own synthetic number (the mock Cliniccards is shared by the tests of the file: a card made by one test must not become a "known patient" of another)
const uniquePhone = () => `0970${String(Math.floor(100_000 + Math.random() * 899_999))}`;
const leakOf = (phone: string) => new RegExp(`Шевчук|Оксан|${phone}|${phone.slice(1)}|Ковалев|Ірин`, 'i');

describe('контакти для запису не йдуть моделі', () => {
  it('очистка копії: телефони (будь-який запис), відомі ім’я й прізвище у будь-якому відмінку, службові питання й відповіді з контактами — нейтральна відмітка; решта змісту лишається', () => {
    const known = { names: ['Оксана', 'Шевчук'], phones: ['0970000777'] };
    expect(maskText('Мене звати Оксана Шевчук, мій номер +38 (097) 000-07-77, а скільки це коштує?', known)).toBe('Мене звати [ім’я] [ім’я], мій номер [телефон], а скільки це коштує?');
    expect(maskText('Дякуємо, Оксано! Зателефонуємо Шевчуку.', known)).toBe('Дякуємо, [ім’я]! Зателефонуємо [ім’я].');
    expect(maskText('мій номер 097 000 07 77 і 380970000777', { names: [], phones: [] })).toBe('мій номер [телефон] і [телефон]');
    expect(maskText('Консультація коштує 100 грн, прийом 06.11.2026 о 09:00', known)).toBe('Консультація коштує 100 грн, прийом 06.11.2026 о 09:00'); // a price, a date, a time are not phones
    // the clinic's own phone in the system text is not touched (only the patient's known contacts are masked there)
    expect(maskText('телефон адміністратора: 044 123 45 67', known, false)).toBe('телефон адміністратора: 044 123 45 67');
    const msgs = scrubMessages(
      [
        { role: 'user', content: 'Хочу записатися' },
        { role: 'assistant', content: 'Щоб оформити запис, напишіть, будь ласка, прізвище, ім’я та номер телефону. Можна одним повідомленням, наприклад: «Прізвище Коваль, ім’я Ірина, телефон 0971234567».' },
        { role: 'user', content: 'Прізвище Шевчук, ім’я Оксана, телефон 0970000777' },
        { role: 'assistant', content: 'Дані для запису: Шевчук Оксана, 0970000777.\nПідтверджуєте запис?' },
        { role: 'user', content: 'Шевчук' },
        { role: 'user', content: 'А чи є парковка? Мій номер 0970000777' },
      ],
      known,
    );
    expect(msgs.map((m) => m.content)).toEqual(['Хочу записатися', '[запит даних для запису]', DATA_ANSWER_NOTE, '[запит даних для запису]', DATA_ANSWER_NOTE, 'А чи є парковка? Мій номер [телефон]']);
    // a surname alone, with no question of the system before it, is masked by name (not replaced)
    expect(scrubMessages([{ role: 'user', content: 'Це Шевчук, питаю про ціну' }], known)[0].content).toBe('Це [ім’я], питаю про ціну');
  });

  it('фактичне тіло запиту до провайдера, включно з повтором: ім’я, прізвище й телефон із сценарію запису туди не потрапляють; чат і заявка зберігають оригінал', async () => {
    const { c, s } = await autoClinic({ events: true });
    const phone = uniquePhone();
    const LEAK = leakOf(phone);
    provider.bodies.length = 0;
    // 1. the offer (a model call, no contacts yet), the time, the data in a natural phrase (two bare words: the order is asked), the surname, the consent
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Мене звати ${P.first} ${P.last}, мій номер ${phone}`);
    await say(c, P.last);
    const rq = (await bookingReq(c))!;
    expect(rq).toMatchObject({ lastName: P.last, firstName: P.first, phone: expect.stringContaining(phone.slice(1)) }); // the data stay in the request, as given
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    // 2. after the visit the patient asks something else (a model call that sees the dialogue), the first answer is broken, so the request is REPEATED with a reminder
    fake.script = () => decision({ reply: `Консультація триває близько 30 хвилин. ${P.first}, до зустрічі.` });
    provider.invalidNext = 1;
    const calls = provider.bodies.length;
    await ask(c, `Дякую! Мене звати ${P.first}, а скільки триває консультація? Мій номер ${phone}`);
    const fresh = provider.bodies.slice(calls);
    expect(fresh.length).toBe(2); // the request and its repeat
    for (const b of provider.bodies) expect(JSON.stringify(b)).not.toMatch(LEAK);
    expect(fresh[1].system).not.toBe(fresh[0].system); // the repeat carries a reminder, and it is clean as well
    // what the model saw of the dialogue: the questions about the contacts and the answers are notes, the rest is the same
    const seen = fresh[0].messages.map((m) => m.content).join(' | ');
    expect(seen).toContain('[запит даних для запису]');
    expect(seen).toContain('[дані для запису надіслано]');
    expect(seen).toContain('скільки триває консультація');
    expect(seen).toContain('[телефон]');
    // the original chat is not changed
    expect((await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, text: { contains: phone } } })).text).toContain(phone);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: c.chat, text: { contains: 'Дані для запису: Шевчук Оксана' } } })).toBe(1); // the summary with the contacts that went to the PATIENT is stored as sent
    expect(s).toBeTruthy();
  });

  it('старий бот: та сама очистка, його історія й повтор не містять контактів', async () => {
    const c = await agentClinic({ agent: false });
    const phone = uniquePhone();
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'x', lastName: P.last, firstName: P.first, phone, stage: 'READY' } });
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: `Прізвище ${P.last}, ім’я ${P.first}, телефон ${phone}` } });
    await incoming(c, `Скажіть, ${P.first} Шевчук питає: чи є у вас дитячий лікар? Дзвонити на ${phone}`);
    provider.bodies.length = 0;
    fake.script = () => JSON.stringify({ intent: 'info', reply: 'Звісно, розкажу.', summary: null, service: '', options: [] });
    const d = await app.get(ChatAssistantService).draft(c.clinicId, 'INSTAGRAM', c.chat);
    expect(d.reply).toBeTruthy();
    expect(provider.bodies.length).toBeGreaterThan(0);
    for (const b of provider.bodies) expect(JSON.stringify(b)).not.toMatch(leakOf(phone));
  });
});

describe('статус запису для моделі', () => {
  it('після запису модель отримує підтверджений статус із системи (послуга, дата, час) без контактів; правило промпту; невідомий результат не називається успішним', async () => {
    const { c, s } = await autoClinic({ events: true });
    const phone = uniquePhone();
    const LEAK = leakOf(phone);
    fake.script = () => decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: s });
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище ${P.last}, ім’я ${P.first}, телефон ${phone}`);
    await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
    expect(visitWrites()).toHaveLength(1);
    const done = (await bookingReq(c))!;
    const when = `${clinicDate(done.confirmedStartsAt!).split('-').reverse().join('.')} о ${clinicHm(done.confirmedStartsAt!)}`;
    fake.script = () => decision({ reply: 'Консультація триває близько 30 хвилин. Ваш запис підтверджено, до зустрічі.' });
    provider.bodies.length = 0;
    const n = sendsTo(c).length;
    await ask(c, `А скільки триває консультація? Мене звати ${P.first}, мій номер ${phone}`);
    expect(provider.bodies).toHaveLength(1); // a substantive question reaches the model
    const system = provider.bodies[0].system;
    expect(system).toContain(`запис УЖЕ створено системою й підтверджено: Тестова консультація, ${when}`);
    expect(system).toContain('не спростовуй його');
    expect(system).toContain('Прохання перенести чи скасувати запис — next.action HAND_OFF');
    for (const b of provider.bodies) expect(JSON.stringify(b)).not.toMatch(LEAK); // no contacts, in the status line either
    expect(sendsTo(c).slice(n).map((m) => m.text).join(' ')).toContain('Ваш запис підтверджено, до зустрічі.'); // a true statement about the booking is not refused
    // an unknown result: the model is told NOT to call the booking successful, and is not told that it exists
    const u = await autoClinic();
    await prisma.bookingRequest.create({ data: { clinicId: u.c.clinicId, channel: 'INSTAGRAM', chatId: u.c.chat, kind: 'BOOKING', summary: 'x', service: 'Тестова консультація', stage: 'CONSENT', autoState: 'UNKNOWN' } });
    await prisma.chatMessage.create({ data: { clinicId: u.c.clinicId, channel: 'INSTAGRAM', chatId: u.c.chat, direction: 'IN', text: 'Мене записали?' } });
    provider.bodies.length = 0;
    fake.script = () => decision({ reply: 'Дякуємо.' });
    await app.get(AgentDraftService).generate(u.c.clinicId, 'INSTAGRAM', u.c.chat);
    expect(provider.bodies[0].system).toContain('результат створення запису ще невідомий: не називай запис створеним');
    expect(provider.bodies[0].system).not.toContain('запис УЖЕ створено системою й підтверджено:'); // the state line (the rule text of the prompt names the line, with no colon)
  });
});

describe('ціна посеред запису і розбір імені', () => {
  it('однозначне питання лише про ціну розпізнається (uk, ru), змішане — ні', () => {
    for (const t of ['А скільки це коштує?', 'скільки це коштує', 'а яка ціна', 'Яка ціна?', 'Сколько это стоит?', 'а какая цена', 'Скільки коштує, будь ласка?', 'вартість?', 'Підкажіть, скільки це буде коштувати']) expect(isPriceOnlyQuestion(t)).toBe(true);
    for (const t of ['Сколько стоит и можно ли при беременности?', 'Скільки коштує і де ви знаходитесь?', 'А скільки це коштує, чи є знижки?', 'Хочу записатися', 'Ціна не підходить, я подумаю']) expect(isPriceOnlyQuestion(t)).toBe(false);
    for (const t of ['скільки це коштує', 'сколько это стоит', 'а яка ціна']) expect(isPriceQuestion(t)).toBe(true);
  });

  it('namePair: дві слова з великої літери — пара без порядку; питання, цифри, три слова, малі літери — ні', () => {
    expect(namePair('Мене звати Оксана Шевчук, мій номер 0970000777')).toEqual(['Оксана', 'Шевчук']);
    expect(namePair('Меня зовут Ирина Ковалёва, телефон 0970000778')).toEqual(['Ирина', 'Ковалёва']);
    expect(namePair('Оксана Шевчук')).toEqual(['Оксана', 'Шевчук']);
    for (const t of ['Мене звати Оксана', 'оксана шевчук', 'Оксана Іванівна Шевчук', 'Оксана Шевчук, а скільки це коштує?', 'Завтра зранку', 'Хочу записатися', 'Дякую вам']) expect(namePair(t)).toBeNull();
  });

  it('питання «а скільки це коштує?» після вибору часу: відповідь кодом з актуальною ціною обраної послуги без моделі, час збережено, одне повернення до запису; далі запис завершується', async () => {
    const { c, s } = await autoClinic({ events: true });
    const phone = uniquePhone();
    fake.script = () => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s });
    await ask(c, 'Добрий день, хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    const slot = (await bookingReq(c))!.slotAt!.getTime();
    const before = provider.bodies.length;
    const n = sendsTo(c).length;
    await ask(c, 'А скільки це коштує?');
    expect(provider.bodies.length).toBe(before); // no model call: the code answered
    const added = sendsTo(c).slice(n);
    expect(added).toHaveLength(2);
    expect(added[0].text).toContain('Тестова консультація: 100 грн');
    expect(added[0].text).not.toMatch(/передали/i);
    expect(added[1].text).toContain('прізвище, ім’я та номер телефону'); // the ONE pending step: nothing was given yet, so all of it is asked, once
    expect((await bookingReq(c))!.slotAt!.getTime()).toBe(slot);
    expect((await bookingReq(c))!).toMatchObject({ service: 'Тестова консультація', stage: 'COLLECT', consentAt: null });
    // the price changes in the price list: the answer follows the price NOW
    await prisma.kbItem.update({ where: { id: c.consult.id }, data: { priceUah: 120 } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { priceListSyncedAt: new Date() } });
    await ask(c, 'сколько это стоит');
    expect(sendsTo(c).slice(n + 2)[0].text).toContain('Тестова консультація: 120 грн');
    await prisma.kbItem.update({ where: { id: c.consult.id }, data: { priceUah: 100 } });
    // the dialogue goes on: the data, the summary, the consent, the visit
    await say(c, `Прізвище ${P.last}, ім’я ${P.first}, телефон ${phone}`);
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    console.log('PRICE_DIALOG\n' + (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m) => `${m.direction === 'IN' ? 'ПАЦІЄНТ' : 'СИСТЕМА'}: ${m.text.replace(/\n+/g, ' / ')}`).join('\n'));
    expect(visitWrites()).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
  });

  it('змішане повідомлення («скільки коштує і можна при вагітності») не перехоплюється кодом: медичну частину веде передача людині, запис не триває за її рахунок', async () => {
    const { c, s } = await autoClinic();
    fake.script = () => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s });
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    const n = sendsTo(c).length;
    await ask(c, 'Скільки це коштує і чи можна це при вагітності?');
    const added = sendsTo(c).slice(n);
    expect(added.map((m) => m.text).join(' ')).not.toContain('Тестова консультація: 100 грн'); // not the code's price-only answer
    expect(added.map((m) => m.text).join(' ')).not.toMatch(/прізвище/i); // and no forced return to the data question
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(visitWrites()).toHaveLength(0);
  });

  it('дані одним повідомленням, по частинах, російською: телефон і явні імена не просяться вдруге; невизначений порядок — одне коротке уточнення; перед візитом — зведення для підтвердження', async () => {
    const phone = uniquePhone();
    const phoneB = uniquePhone();
    const phoneR = uniquePhone();
    const phoneD = uniquePhone();
    // A. one natural message: the phone is kept, ONE clarification about the order, then the summary
    const a = await autoClinic();
    await ask(a.c, 'Добрий день, хочу записатися на консультацію');
    await tap(a.c, sendsTo(a.c)[0].options[0]);
    await say(a.c, `Мене звати ${P.first} ${P.last}, мій номер ${phone}`);
    const asked = sendsTo(a.c).slice(2).map((m) => m.text);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(`Уточніть, будь ласка: що з цього прізвище — «${P.first}» чи «${P.last}»? Напишіть лише прізвище.`);
    expect(asked[0]).not.toMatch(/телефон|ім’я \(одним/);
    expect(await bookingReq(a.c)).toMatchObject({ lastName: null, firstName: null, phone: expect.stringContaining(phone.slice(1)) });
    await say(a.c, P.last);
    const q = sendsTo(a.c).at(-1)!;
    expect(q.text).toContain(`Дані для запису: ${P.last} ${P.first}, `);
    expect(q.text).toContain('Підтверджуєте запис на Тестова консультація');
    expect(q.options.map((o) => o.label).sort()).toEqual(['Ні, інший час', 'Так, підтверджую']);
    expect(sendsTo(a.c).filter((m) => /прізвище \(одним словом\)|ім’я \(одним словом\)/.test(m.text))).toHaveLength(0); // nothing already given is asked again
    expect(visitWrites()).toHaveLength(0);
    // B. by parts: the phone first, then both names in one labelled message
    const b = await autoClinic();
    await ask(b.c, 'Добрий день, хочу записатися на консультацію');
    await tap(b.c, sendsTo(b.c)[0].options[0]);
    await say(b.c, phoneB);
    expect(sendsTo(b.c).at(-1)!.text).toContain('прізвище та ім’я');
    expect(sendsTo(b.c).at(-1)!.text).not.toMatch(/телефон/i);
    await say(b.c, `Прізвище ${P.last}, ім’я ${P.first}`);
    expect(sendsTo(b.c).at(-1)!.text).toContain(`Дані для запису: ${P.last} ${P.first}, `);
    // C. Russian, one message, one clarification
    const r = await autoClinic();
    await ask(r.c, 'Здравствуйте, хочу записаться на консультацию');
    await tap(r.c, sendsTo(r.c)[0].options[0]);
    await say(r.c, `Меня зовут Ирина Ковалёва, мой телефон ${phoneR}`);
    expect(sendsTo(r.c).at(-1)!.text).toBe('Уточните, пожалуйста: что из этого фамилия — «Ирина» или «Ковалёва»? Напишите только фамилию.');
    await say(r.c, 'Ковалёва');
    expect(sendsTo(r.c).at(-1)!.text).toContain('Данные для записи: Ковалёва Ирина, ');
    // D. a single word to "your surname?"/"your first name?" still works
    const d = await autoClinic();
    await ask(d.c, 'Добрий день, хочу записатися на консультацію');
    await tap(d.c, sendsTo(d.c)[0].options[0]);
    await say(d.c, 'Прізвище Мельник');
    expect(sendsTo(d.c).at(-1)!.text).toContain('ваше ім’я');
    await say(d.c, 'Дарина');
    expect(sendsTo(d.c).at(-1)!.text).toContain('номер телефону');
    await say(d.c, phoneD);
    expect(sendsTo(d.c).at(-1)!.text).toContain('Дані для запису: Мельник Дарина, ');
    expect(visitWrites()).toHaveLength(0);
  });

  it('повний діалог без повторного запиту отриманих даних (запис для звіту)', async () => {
    const { c, s } = await autoClinic({ events: true });
    const phone = uniquePhone();
    fake.script = () => (/підберіть/i.test(provider.last) ? decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Консультація триває близько 30 хвилин.', prices: [s] }));
    await ask(c, 'Скільки коштує консультація?');
    await ask(c, 'Так, підберіть');
    await tap(c, sendsTo(c).at(-1)!.options[0]);
    await say(c, `Мене звати ${P.first} ${P.last}, мій номер ${phone}`);
    await say(c, P.last);
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    console.log('PRIVACY_DIALOG\n' + (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m) => `${m.direction === 'IN' ? 'ПАЦІЄНТ' : 'СИСТЕМА'}: ${m.text.replace(/\n+/g, ' / ')}`).join('\n'));
    expect(visitWrites()).toHaveLength(1);
    const out = sendsTo(c).map((m) => m.text);
    expect(out.filter((t) => /прізвище \(одним словом\)|ім’я \(одним словом\)|номер телефону для зв’язку/.test(t))).toHaveLength(0);
    expect(out.some((t) => t.includes('Підібрати зручний час?'))).toBe(true); // the soft offer after the price
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'BOOKED' } })).toBe(1);
  });
});
