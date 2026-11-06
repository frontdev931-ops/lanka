import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AGENT_FALLBACK_TEXT, AGENT_HANDOFF_TEXT, AgentDraftService, internalReferenceIn, parseDecisionText } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { slotPayload } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinicOpts, TITLES, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Stage 1A: the agent's DRAFT through the decision contract. Synthetic clinic "LANKA Agent Test", the service "Тестовая консультация" with an explicitly
// test price (100 UAH) and the mock Cliniccards. The answers of the model are SCRIPTED by these tests: they prove the rules of the code around the
// model (contract, checks, no side effects, staleness), NOT the quality of a real model.
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type Call = { system: string; turns: { role: string; content: string }[]; maxTokens?: number; schema?: Record<string, unknown> };
const fake = {
  configured: true,
  calls: [] as Call[],
  // what the "model" answers: set by each test; may do things while "thinking"
  script: (async () => '') as (c: Call, n: number) => Promise<string> | string,
  complete: async (system: string, turns: { role: string; content: string }[], maxTokens?: number, opts?: { schema?: Record<string, unknown> }) => {
    const call = { system, turns, maxTokens, schema: opts?.schema };
    fake.calls.push(call);
    return { text: await fake.script(call, fake.calls.length), inputTokens: 1, outputTokens: 1 };
  },
};
const sent: { chatId: string; text: string }[] = [];

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
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string) => {
    sent.push({ chatId, text });
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
  sent.length = 0;
  fake.calls.length = 0;
  mock.writes.length = 0;
  fake.script = async () => '';
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

const agentClinic = (opts: AgentClinicOpts = {}) => createAgentClinic({ http, prisma }, opts);
type C = Awaited<ReturnType<typeof agentClinic>>;

const incoming = (c: C, text: string, chat = c.chat) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, direction: 'IN', text } });
const outgoing = (c: C, text: string) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text, byAi: true } });
const refOf = async (c: C, title: string) => (await app.get(KbService).factsFor(c.clinicId, new Date(), '', '')).items.find((x) => x.title === title)!.ref;
// the draft endpoint (the old bot's draft, or the agent's draft STORED for review) ...
const draftHttp = (c: C, chat = c.chat, token = c.token) => http().post(`/conversations/INSTAGRAM/${chat}/draft`).set(auth(token));
// ... and the generation itself (what the rules of the agent produce; nothing is stored): the checks of the contract, the validators and the assembly are tested through it
const draft = (c: C, chat = c.chat, token = c.token) => {
  if (token !== c.token) return draftHttp(c, chat, token);
  return { expect: async (status: number) => ({ status, body: await app.get(AgentDraftService).generate(c.clinicId, 'INSTAGRAM', chat) }) } as unknown as ReturnType<typeof draftHttp>;
};
const decision = (content: Record<string, unknown>, next: Record<string, unknown> = {}) =>
  JSON.stringify({ content: { kind: 'ANSWER', reply: 'Добрий день!', prices: [], after: '', advantages: [], objection: null, ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });

// Everything that belongs to the clinic, as one fingerprint per table (updates count, not only inserts); the model-usage counters are the one allowed change
async function snapshot(clinicId: string) {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'clinicId' and table_name <> 'AiUsage'`;
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = await prisma.$queryRawUnsafe<{ h: string; n: number }[]>(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h, count(*)::int as n from "${t.table_name}" x where "clinicId" = $1`, clinicId);
    out[t.table_name] = `${r[0].n}:${r[0].h}`;
  }
  const own = await prisma.$queryRawUnsafe<{ h: string }[]>(`select md5(x::text) as h from "Clinic" x where id = $1`, clinicId);
  out.Clinic = own[0].h;
  return out;
}
const untouched = async (c: C, before: Record<string, string>) => {
  expect(await snapshot(c.clinicId)).toEqual(before);
  expect(sent).toHaveLength(0);
  expect(mock.writes).toHaveLength(0);
};

describe('черновик агента: контракт рішення, без виконання дій', () => {
  it('перевірка побічних ефектів сама чутлива: будь-яка зміна даних клініки (вставка чи правка рядка) змінює відбиток', async () => {
    const c = await agentClinic();
    const before = await snapshot(c.clinicId);
    expect(await snapshot(c.clinicId)).toEqual(before);
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'HANDOFF', summary: 'x' } });
    expect(await snapshot(c.clinicId)).not.toEqual(before);
    const mid = await snapshot(c.clinicId);
    await prisma.bookingRequest.updateMany({ where: { clinicId: c.clinicId }, data: { summary: 'y' } });
    expect(await snapshot(c.clinicId)).not.toEqual(mid); // an update counts, not only an insert
  });

  it('питання про ціну: відповідь із цінами від коду й доречний наступний крок «підібрати час»; чернетка нічого не змінює', async () => {
    const c = await agentClinic();
    await incoming(c, 'Скільки коштує тестова консультація?');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Дякуємо за запитання.', prices: [s], after: 'Підібрати для вас зручний час?' }, { action: 'OFFER_TIME', service: s });
    const before = await snapshot(c.clinicId);
    const d = (await draft(c).expect(200)).body;
    expect(d).toMatchObject({ agent: true, status: 'READY', handoff: false, service: 'Тестова консультація' });
    expect(d.reply).toContain('- Тестова консультація: 100 грн'); // the sum is written by the code from the database
    expect(d.reply).toContain('Вартість попередня'); // the sum is KNOWN: the notice goes with it
    // ONE next step: the code's "choose a time" line; the model's own "shall I find a time?" is left out, the answer to the question stays
    expect(d.reply).toContain('Дякуємо за запитання.');
    expect(d.reply).not.toContain('Підібрати');
    expect(d.reply.match(/час/g)?.filter(Boolean).length ?? 0).toBeLessThanOrEqual(2);
    expect(d.reply.split('\n\n').filter((p: string) => /обер/i.test(p))).toHaveLength(1);
    expect(d.next).toMatchObject({ proposed: 'OFFER_TIME', action: 'OFFER_TIME', check: { ok: true, rejected: null } });
    expect(d.options.length).toBeGreaterThan(0); // real free times, read
    expect(d.options.every((o: { date: string; time: string }) => !!o.date && !!o.time)).toBe(true);
    expect(d.stale).toEqual({ stale: false, reasons: [] });
    await untouched(c, before);
  });

  it('готовність записатися одразу: без анкетування, час підбирає код; пропозиція запису не обов’язкова в інших відповідях', async () => {
    const c = await agentClinic();
    await incoming(c, 'Хочу записатися на тестову консультацію');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'З радістю допоможемо. Зараз підберемо час.' }, { action: 'OFFER_TIME', service: s });
    const d = (await draft(c).expect(200)).body;
    expect(d.next.action).toBe('OFFER_TIME');
    expect(d.options.length).toBeGreaterThan(0);
    expect(d.reply).not.toMatch(/\d{1,2}:\d{2}/); // the times are in the buttons, not in the model's words
    expect(d.reply).toContain('З радістю допоможемо.'); // the model's welcome stays
    expect(d.reply).not.toMatch(/підбер/i); // its promise to look for a time is left out: the code shows the times
    // a plain answer with no next step
    await incoming(c, 'А ви працюєте у вихідні?');
    fake.script = () => decision({ reply: 'Ми відповімо щодо графіка.' }, { action: 'NONE' });
    const d2 = (await draft(c).expect(200)).body;
    expect(d2.next).toMatchObject({ proposed: 'NONE', action: 'NONE' });
    expect(d2.options).toEqual([]);
  });

  it('уточнення без одночасного нав’язування часу: питання лишається, дія знімається з причиною', async () => {
    const c = await agentClinic();
    await incoming(c, 'Хочу до лікаря');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ kind: 'CLARIFY', reply: 'Підкажіть, будь ласка, яка послуга вам потрібна?' }, { action: 'OFFER_TIME', service: s });
    const d = (await draft(c).expect(200)).body;
    expect(d.next).toMatchObject({ proposed: 'OFFER_TIME', action: 'NONE', check: { ok: false, rejected: 'clarify_with_next_dropped' } });
    expect(d.options).toEqual([]);
    expect(d.content.kind).toBe('CLARIFY');
  });

  it('відмова — ввічлива відповідь без продажу; прохання покликати людину — лише ПРОПОЗИЦІЯ передачі: заявки немає, текст фіксований', async () => {
    const c = await agentClinic();
    await incoming(c, 'Ні, дякую, я подумаю');
    fake.script = () => decision({ reply: 'Добре, дякуємо. Будемо раді допомогти, коли будете готові.' }, { action: 'CLOSE' });
    const closed = (await draft(c).expect(200)).body;
    expect(closed.next).toMatchObject({ proposed: 'CLOSE', action: 'CLOSE', check: { ok: true } });
    expect(closed.options).toEqual([]);
    await incoming(c, 'Покличте, будь ласка, адміністратора');
    fake.script = () => decision({ reply: 'Передаю адміністратору, він зателефонує вам завтра о 10:00 і даремно обіцяє знижку' }, { action: 'HAND_OFF', reason: 'asked_for_person' });
    const before = await snapshot(c.clinicId);
    const handed = (await draft(c).expect(200)).body;
    expect(handed).toMatchObject({ status: 'READY', handoff: true, reply: AGENT_HANDOFF_TEXT.uk, handoffSuggestion: { reason: 'asked_for_person' } });
    expect(handed.options).toEqual([]);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(0); // a suggestion only
    await untouched(c, before);
  });

  it('зміна послуги: посилання нової послуги, ціна з бази; невідома ціна — «уточнити», не нуль; невідома послуга — пропозиція передати', async () => {
    const c = await agentClinic();
    const consult = await refOf(c, 'Тестова консультація');
    const hygiene = await refOf(c, 'Тестова гігієна');
    await incoming(c, 'Скільки коштує гігієна?');
    await outgoing(c, 'Вартість гігієни уточнить адміністратор.');
    await incoming(c, 'А краще тестова консультація, скільки вона коштує?');
    fake.script = () => decision({ reply: 'Звісно.', prices: [consult] }, { action: 'OFFER_TIME', service: consult });
    const changed = (await draft(c).expect(200)).body;
    expect(changed.service).toBe('Тестова консультація');
    expect(changed.reply).toContain('100 грн');
    expect(changed.reply).not.toContain('гігієна');
    // a service whose price is not known: never a number, never a zero
    await incoming(c, 'Скільки коштує тестова гігієна?');
    fake.script = () => decision({ reply: 'Про гігієну:', prices: [hygiene] });
    const unknownPrice = (await draft(c).expect(200)).body;
    expect(unknownPrice.reply).toContain('Тестова гігієна: вартість потрібно уточнити в адміністратора');
    expect(unknownPrice.reply).not.toMatch(/\b0\s*грн|безкоштовно/);
    // a service the clinic has not: the first try (no price lines for a price question) is refused, the corrected one hands over
    await incoming(c, 'Скільки коштує імплант?');
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: 'Імплант коштує близько 20 тисяч.' }) : decision({ reply: 'Цю послугу уточнить адміністратор.' }, { action: 'HAND_OFF', reason: 'service_unknown' }));
    const unknownService = (await draft(c).expect(200)).body;
    expect(unknownService).toMatchObject({ status: 'READY', handoff: true, handoffSuggestion: { reason: 'service_unknown' }, modelCalls: 2 });
  });

  it('невалідна відповідь моделі й заборонені дії: після одного повтору — безпечний результат для адміністратора, заявки немає', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    const cases: [string, () => string, string][] = [
      ['не JSON', () => 'Добрий день, чим допомогти?', 'model'],
      ['BOOK недоступний моделі', () => decision({ reply: 'Записую вас.' }, { action: 'BOOK', service: s }), 'reply_check'],
      ['сума словами й цифрами у вільному тексті', () => decision({ reply: 'Це коштує 100 гривень' }), 'reply_check'],
      ['знижка й відсотки', () => decision({ reply: 'Для вас знижка 20%' }), 'reply_check'],
      ['гарантія результату', () => decision({ reply: 'Ми гарантуємо результат' }), 'reply_check'],
      ['вигаданий час', () => decision({ reply: 'Чекаємо вас завтра о 15:30' }), 'reply_check'],
      ['посилання на послугу, якої немає', () => decision({ reply: 'Ось ціна', prices: ['S999'] }), 'reply_check'],
      ['чужий id замість позначки', () => decision({ reply: 'Ось ціна', prices: [c.consult.id] }), 'reply_check'],
    ];
    for (const [i, [name, answer, reason]] of cases.entries()) {
      await incoming(c, `Розкажіть про послуги, варіант ${i + 1}`); // the label of the case stays out of the patient's words (a word like "знижка" would stop at the classifier)
      expect(name).toBeTruthy();
      fake.calls.length = 0;
      fake.script = answer;
      const before = await snapshot(c.clinicId);
      const d = (await draft(c).expect(200)).body;
      expect(d).toMatchObject({ status: 'SAFE_FALLBACK', reply: AGENT_FALLBACK_TEXT.uk, handoff: true, reason, handoffSuggestion: { reason }, modelCalls: 2 });
      expect(d.next.check).toMatchObject({ ok: false, rejected: reason });
      expect(fake.calls).toHaveLength(2); // one try and one repeat
      expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(0); // no hand-over request was created
      await untouched(c, before);
    }
  });

  it('нове повідомлення, відповідь співробітника чи передача людині ПІД ЧАС підготовки роблять чернетку застарілою', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    await incoming(c, 'Скільки коштує тестова консультація?');
    const ok = () => decision({ reply: 'Ось ціна.', prices: [s] });
    // a new incoming message arrives while the model is thinking
    fake.script = async () => {
      await incoming(c, 'Ще одне питання');
      return ok();
    };
    expect((await draft(c).expect(200)).body.stale).toEqual({ stale: true, reasons: ['new_incoming_message'] });
    // a staff member answers meanwhile
    await incoming(c, 'Ще питання 2');
    fake.script = async () => {
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: 'Відповідаю вручну', authorUserId: c.userId } });
      return ok();
    };
    expect((await draft(c).expect(200)).body.stale.reasons).toEqual(['staff_replied']);
    // the dialogue is taken over (a state with a human owner) and handed to a person meanwhile
    await incoming(c, 'Ще питання 3');
    fake.script = async () => {
      await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, owner: 'HUMAN' } });
      await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'HANDOFF', summary: 'x' } });
      return ok();
    };
    const taken = (await draft(c).expect(200)).body.stale;
    expect(taken.stale).toBe(true);
    expect(taken.reasons).toEqual(expect.arrayContaining(['staff_took_over', 'handed_to_person']));
    // and later: the staleness of a finished draft can be asked again with its basis
    await prisma.conversationState.deleteMany({ where: { clinicId: c.clinicId } });
    await prisma.bookingRequest.deleteMany({ where: { clinicId: c.clinicId } });
    await incoming(c, 'Останнє питання');
    fake.script = () => ok();
    const fresh = (await draft(c).expect(200)).body;
    expect(fresh.stale.stale).toBe(false);
    await incoming(c, 'Нове повідомлення після чернетки');
    expect(await app.get(AgentDraftService).staleness(c.clinicId, 'INSTAGRAM', c.chat, fresh.basis)).toEqual({ stale: true, reasons: ['new_incoming_message'] });
  });

  it('ізоляція: чужа клініка не бачить діалог, послуги іншої клініки не потрапляють у запит до моделі, чужі посилання відхиляються', async () => {
    const a = await agentClinic();
    const b = await agentClinic({ name: 'LANKA Agent Test B' });
    await prisma.kbItem.create({ data: { clinicId: b.clinicId, kind: 'SERVICE', title: 'Секретна послуга клініки B', priceUah: 777, active: true, approvedAt: new Date(), reviewedAt: new Date() } });
    await incoming(a, 'Скільки коштує тестова консультація?');
    fake.script = () => decision({ reply: 'Ось ціна.' }, { action: 'HAND_OFF', reason: 'other' });
    await draft(a, a.chat, b.token).expect(400); // clinic B asks for the dialogue of clinic A: no conversation for it
    expect(fake.calls).toHaveLength(0);
    await draft(a).expect(200);
    expect(fake.calls[0].system).not.toContain('Секретна послуга клініки B');
    expect(fake.calls[0].system).not.toContain('777');
    // the reference of clinic B's service is just not a reference of clinic A
    const bRef = (await app.get(KbService).factsFor(b.clinicId, new Date(), 'секретна', 'секретна')).items.find((x) => x.title.startsWith('Секретна'))!.ref;
    const aRefs = (await app.get(KbService).factsFor(a.clinicId, new Date(), '', '')).items.map((x) => x.ref);
    const foreign = ['S9', 'S99', bRef].find((r) => !aRefs.includes(r)) ?? 'S999';
    fake.script = () => decision({ reply: 'Ось ціна.', prices: [foreign] });
    expect((await draft(a).expect(200)).body).toMatchObject({ status: 'SAFE_FALLBACK', reason: 'reply_check' });
  });

  it('чернетка з увімкненим збором подій нічого не надсилає, не створює й не змінює; єдиний слід — витрата моделі', async () => {
    const c = await agentClinic({ events: true });
    await incoming(c, 'Скільки коштує тестова консультація?');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Ось ціна.', prices: [s], after: 'Підібрати час?' }, { action: 'OFFER_TIME', service: s });
    const before = await snapshot(c.clinicId);
    const usageBefore = await prisma.aiUsage.count({ where: { clinicId: c.clinicId } });
    const d = (await draft(c).expect(200)).body;
    expect(d.options.length).toBeGreaterThan(0);
    await untouched(c, before);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId } })).toBe(0);
    expect(await prisma.conversationState.count({ where: { clinicId: c.clinicId } })).toBe(0);
    expect(await prisma.aiUsage.count({ where: { clinicId: c.clinicId } })).toBe(usageBefore + 1); // the one allowed trace: the cost of the model call
  });

  it('режим «лише чернетки»: aiAgentMode + aiAutoReply — старий ШІ сам не відповідає, нової відправки немає, ручна відповідь і прежня поведінка клінік без агента збережені', async () => {
    const c = await agentClinic({ autoReply: true });
    const generate = jest.spyOn(app.get(AgentDraftService), 'generate');
    const old = JSON.stringify({ intent: 'info', reply: 'Добрий день! Допоможемо із записом.', summary: null, service: '', options: [] });
    fake.script = () => old;
    const chat = `held${rnd()}`;
    await app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: chat, mid: `m${rnd()}`, text: 'Добрий день', name: 'Гість' });
    expect(fake.calls).toHaveLength(0); // the model was not asked
    expect(generate).not.toHaveBeenCalled();
    expect(sent.some((m) => m.text.includes('Допоможемо із записом'))).toBe(false); // no AI reply
    const status = (await http().get('/ai').set(auth(c.token)).expect(200)).body;
    expect(status).toMatchObject({ agentMode: true, autoReply: true, autoReplyHeldByAgent: true });
    // a person can still answer by hand
    await http().post(`/conversations/INSTAGRAM/${chat}/reply`).set(auth(c.token)).send({ text: 'Вітаємо! Це співробітник.' }).expect((r) => expect([200, 201]).toContain(r.status));
    expect(sent.some((m) => m.text === 'Вітаємо! Це співробітник.')).toBe(true);
    // the draft is still made on request
    await incoming(c, 'Скільки коштує тестова консультація?', chat);
    fake.script = () => decision({ reply: 'Ось ціна.', prices: [] }, { action: 'HAND_OFF', reason: 'other' });
    expect((await http().post(`/conversations/INSTAGRAM/${chat}/draft`).set(auth(c.token)).expect(200)).body.agent).toBe(true);
    generate.mockRestore();
    // a clinic without the agent: the automatic reply works as before
    const plain = await agentClinic({ agent: false, autoReply: true });
    sent.length = 0;
    fake.calls.length = 0;
    fake.script = () => old;
    await app.get(IntakeService).handle(plain.clinicId, { channel: 'INSTAGRAM', chatId: `plain${rnd()}`, mid: `m${rnd()}`, text: 'Добрий день', name: 'Гість' });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(sent.map((m) => m.text).join(' ')).toContain('Допоможемо із записом');
    expect((await http().get('/ai').set(auth(plain.token)).expect(200)).body).toMatchObject({ agentMode: false, autoReplyHeldByAgent: false });
  });

  it('збірка відповіді: застереження про попередню вартість лише для суми з прайсу; безкоштовна — без нього; «уточнити» — без нього; назви мовою діалогу (uk і ru)', async () => {
    for (const lang of ['uk', 'ru'] as const) {
      const c = await agentClinic({ lang });
      const t = TITLES[lang];
      const known = await refOf(c, t.consult);
      const free = await refOf(c, t.free);
      const unknown = await refOf(c, t.hygiene);
      const asks = lang === 'uk'
        ? { known: 'Скільки коштує консультація?', free: 'Скільки коштує безкоштовна перевірка?', unknown: 'Скільки коштує гігієна?', both: 'Скільки коштують консультація і безкоштовна перевірка?' }
        : { known: 'Сколько стоит консультация?', free: 'Сколько стоит бесплатная проверка?', unknown: 'Сколько стоит гигиена?', both: 'Сколько стоят консультация и бесплатная проверка?' };
      await incoming(c, asks.known);
      const notice = lang === 'uk' ? 'Вартість попередня' : 'Стоимость предварительная';
      fake.script = () => decision({ reply: lang === 'uk' ? 'Дякуємо.' : 'Спасибо.', prices: [known] });
      const k = (await draft(c).expect(200)).body;
      expect(k.reply).toContain(`- ${t.consult}: 100 грн`);
      expect(k.reply).toContain(notice);
      await incoming(c, asks.free);
      fake.script = () => decision({ reply: lang === 'uk' ? 'Дякуємо.' : 'Спасибо.', prices: [free] });
      const f = (await draft(c).expect(200)).body;
      expect(f.reply).toContain(`- ${t.free}: ${lang === 'uk' ? 'безкоштовно' : 'бесплатно'}`);
      expect(f.reply).not.toContain(notice);
      await incoming(c, asks.unknown);
      fake.script = () => decision({ reply: lang === 'uk' ? 'Дякуємо.' : 'Спасибо.', prices: [unknown] });
      const u = (await draft(c).expect(200)).body;
      expect(u.reply).toContain(`- ${t.hygiene}: ${lang === 'uk' ? 'вартість потрібно уточнити в адміністратора' : 'стоимость нужно уточнить у администратора'}`);
      expect(u.reply).not.toContain(notice);
      // a known and a free service together: the notice comes once, with the sum
      await incoming(c, asks.both);
      fake.script = () => decision({ reply: lang === 'uk' ? 'Дякуємо.' : 'Спасибо.', prices: [known, free] });
      const both = (await draft(c).expect(200)).body;
      expect(both.reply.split(notice)).toHaveLength(2);
    }
  });

  it('OFFER_TIME без вільних вікон: дія відхилена з причиною, у тексті немає обіцянки підібрати час', async () => {
    const c = await agentClinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: {} } }); // no working hours: nothing can be offered
    await incoming(c, 'Скільки коштує тестова консультація?');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Дякуємо.', prices: [s], after: 'Підібрати для вас зручний час?' }, { action: 'OFFER_TIME', service: s });
    const d = (await draft(c).expect(200)).body;
    expect(d.next).toMatchObject({ proposed: 'OFFER_TIME', action: 'NONE', check: { ok: false, rejected: 'no_free_time' } });
    expect(d.options).toEqual([]);
    expect(d.reply).toContain('100 грн'); // the answer to the question stays
    expect(d.reply).not.toMatch(/оберіть|підібрати для вас|ось які|варіанти/i); // and no "here are the times" when there are none
    expect(d.reply).toContain('Передати ваш запит адміністратору'); // a hand-over is only offered, as a question
    expect(d.reply).not.toMatch(/передали|передано/i);
  });

  it('aiAgentMode вимкнено: прежній шлях і прежня форма відповіді; новий шлях не викликається', async () => {
    const c = await agentClinic({ agent: false });
    await incoming(c, 'Добрий день, хочу записатися');
    fake.script = () => JSON.stringify({ intent: 'info', reply: 'Добрий день! Допоможемо із записом.', summary: null, service: '', options: [] });
    const generate = jest.spyOn(app.get(AgentDraftService), 'generate');
    const d = (await draftHttp(c).expect(200)).body;
    expect(generate).not.toHaveBeenCalled();
    expect(d).toMatchObject({ intent: 'info', reply: 'Добрий день! Допоможемо із записом.' });
    expect(d).not.toHaveProperty('agent');
    expect(d).not.toHaveProperty('next');
    expect(fake.calls[0].system).not.toContain('ЧЕРНЕТКУ'); // the prompt of the working bot
    generate.mockRestore();
    // and the service itself refuses to run for a clinic with the switch off
    await expect(app.get(AgentDraftService).generate(c.clinicId, 'INSTAGRAM', c.chat)).rejects.toThrow('agent_mode_off');
  });

  it('класифікатори працюють до моделі: біль, знижка, скарга — пропозиція передати без виклику моделі; адреса й години — відповідь коду', async () => {
    const c = await agentClinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { publicAddress: 'м. Тестове, вул. Вигадана, 1 (тестова адреса)' } });
    for (const [text, reason] of [['У мене сильно болить зуб', 'urgent'], ['Є знижка на консультацію?', 'price'], ['Подам скаргу на вашу клініку', 'complaint']] as const) {
      await incoming(c, text);
      const d = (await draft(c).expect(200)).body;
      expect(d).toMatchObject({ status: 'READY', handoff: true, modelCalls: 0 });
      expect(d.reason).toBeTruthy();
      expect(reason).toBeTruthy();
    }
    expect(fake.calls).toHaveLength(0);
    await incoming(c, 'Яка ваша адреса?');
    const addr = (await draft(c).expect(200)).body;
    expect(addr.reply).toContain('Вигадана, 1');
    expect(addr.modelCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
    // an address AND a price in one message: not answered by the code alone (the price question would be lost); the model gets it with the contacts in its prompt
    await incoming(c, 'Скільки коштує тестова консультація і де ви знаходитесь?');
    const ref = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Ми за адресою: м. Тестове, вул. Вигадана, 1 (тестова адреса).', prices: [ref] });
    const both = (await draft(c).expect(200)).body;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).toContain('Вигадана, 1');
    expect(both.reply).toContain('100 грн');
    expect(both.reply).toContain('Вигадана, 1');
  });
});

// Examples for the report (printed by the test run; the answers of the model are scripted)
describe('Stage 1: службові позначки, формат, ліміт, сумніви, побажання щодо часу, фіксовані причини', () => {
  const lastSystem = () => fake.calls[fake.calls.length - 1].system;

  it('фікстура: ім’я тестової клініки не перезаписується синхронізацією; лише вигадані активні послуги', async () => {
    const c = await agentClinic();
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).name).toBe('LANKA Agent Test');
    const active = (await prisma.kbItem.findMany({ where: { clinicId: c.clinicId, kind: 'SERVICE', active: true }, select: { title: true } })).map((x) => x.title).sort();
    expect(active).toEqual([TITLES.uk.consult, TITLES.uk.filling, TITLES.uk.free, TITLES.uk.hygiene].sort());
  });

  it('службова позначка (S3) у тексті: відхилення з точною причиною, повтор бачить саму позначку, чистий другий варіант проходить; назва зі схожим сполученням не чіпається', () => {
    // pure: only a token that equals a reference of THIS request counts, and a real title is masked first
    expect(internalReferenceIn('Консультація (S3) триває 30 хвилин', ['Тестова консультація'], ['S1', 'S3'])).toBe('S3');
    expect(internalReferenceIn('Для вас підійде консультація S3.', [], ['S3'])).toBe('S3');
    expect(internalReferenceIn('(позначка s3)', [], ['S3'])).toBe('s3');
    expect(internalReferenceIn('Імплант S3 Pro коштує', ['Імплант S3 Pro'], ['S3'])).toBeNull(); // a real name with such letters
    expect(internalReferenceIn('Є моделі S12 і S3x', [], ['S3'])).toBeNull(); // not a reference of this request, not part of one
    expect(internalReferenceIn('Тестова консультація: 100 грн\n\nОберіть час.', ['Тестова консультація'], ['S1'])).toBeNull();
  });

  it('службова позначка в тексті моделі: перша спроба відхилена (internal_reference_in_text), повтор отримує саму позначку; видимий текст чистий', async () => {
    const c = await agentClinic();
    await incoming(c, 'Скільки коштує тестова консультація?');
    const s = await refOf(c, 'Тестова консультація');
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: `Консультація (${s}) триває 30 хвилин.`, prices: [s] }) : decision({ reply: 'Консультація триває 30 хвилин.', prices: [s] }));
    const d = (await draft(c).expect(200)).body;
    expect(d).toMatchObject({ status: 'READY', modelCalls: 2, retryReasons: ['internal_reference_in_text'] });
    expect(fake.calls[1].system).toContain(`«${s}»`); // the retry is told the exact token
    expect(d.reply).not.toMatch(/\bS\d+\b/);
    expect(d.reply).toContain('100 грн');
    // and if it stays: a safe draft, not an empty one, and never a claim that a hand-over happened
    fake.script = () => decision({ reply: `Консультація (${s})`, prices: [s] });
    await incoming(c, 'А скільки коштує консультація?');
    const bad = (await draft(c).expect(200)).body;
    expect(bad).toMatchObject({ status: 'SAFE_FALLBACK', reason: 'reply_check', reply: AGENT_FALLBACK_TEXT.uk });
    expect(bad.reply).not.toMatch(/передали|передано|передав/i);
    expect(bad.reply.trim()).not.toBe('');
  });

  it('формат: рівно один JSON-об’єкт; зовнішній markdown-блок допустимий; два об’єкти, текст навколо, масив, обрізання — відмова без «виправлення»', () => {
    const obj = '{"content":{"kind":"ANSWER","reply":"x","after":"","prices":[]},"next":{"action":"NONE","service":null,"reason":null}}';
    expect(parseDecisionText(obj, 'end_turn')).toEqual({ raw: JSON.parse(obj) });
    expect(parseDecisionText('```json\n' + obj + '\n```', 'end_turn')).toEqual({ raw: JSON.parse(obj) });
    expect(parseDecisionText(`${obj}\n${obj}`, 'end_turn')).toMatchObject({ code: 'json_parse_error' }); // not "the first of two"
    expect(parseDecisionText(`Ось відповідь: ${obj}`, 'end_turn')).toMatchObject({ code: 'not_json' });
    expect(parseDecisionText(`${obj} Дякую!`, 'end_turn')).toMatchObject({ code: 'not_json' });
    expect(parseDecisionText('[1,2]', 'end_turn')).toMatchObject({ code: 'not_json' });
    expect(parseDecisionText('{"content": {"kind": "ANSWER", "reply": "Абзац\nдругий"}}', 'end_turn')).toMatchObject({ code: 'json_parse_error' }); // a raw line break inside a string is not repaired
    expect(parseDecisionText(obj.slice(0, 40), 'max_tokens')).toEqual({ code: 'truncated' }); // a truncated answer is never read, even when it looks like JSON
    expect(parseDecisionText(obj, 'max_tokens')).toEqual({ code: 'truncated' });
    expect(parseDecisionText('', 'refusal')).toEqual({ code: 'refusal' });
  });

  it('запит агента: суворa схема з переліками (дії, види, коди причин, позначки ЦЬОГО запиту), ліміт 1500; старий бот без схеми', async () => {
    const c = await agentClinic();
    await incoming(c, 'Скільки коштує тестова консультація?');
    const s = await refOf(c, 'Тестова консультація');
    fake.script = () => decision({ reply: 'Ось ціна.', prices: [s] });
    await draft(c).expect(200);
    const call = fake.calls[0];
    expect(call.maxTokens).toBe(1500);
    const schema = JSON.stringify(call.schema);
    expect(schema).toContain('"additionalProperties":false');
    for (const code of ['asked_for_person', 'service_unknown', 'identity_needed', 'time_preference_unavailable']) expect(schema).toContain(code);
    for (const action of ['OFFER_TIME', 'ASK_CONSENT', 'HAND_OFF', 'CLOSE']) expect(schema).toContain(action);
    expect(schema).not.toContain('"BOOK"');
    expect(schema).toContain(s); // the references of this request
    // the working bot is not changed: no schema, its own limit
    const plain = await agentClinic({ agent: false });
    await incoming(plain, 'Добрий день');
    fake.calls.length = 0;
    fake.script = () => JSON.stringify({ intent: 'info', reply: 'Добрий день!', summary: null, service: '', options: [] });
    await draftHttp(plain).expect(200);
    expect(fake.calls[0].schema).toBeUndefined();
  });

  it('причини передачі — лише фіксовані коди: вільний текст відхиляється й не потрапляє в поле reason', async () => {
    const c = await agentClinic();
    await incoming(c, 'Мені потрібна консультація щодо мого минулого лікування');
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'Пацієнтка питає про історію лікування торік' }) : decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'identity_needed' }));
    const d = (await draft(c).expect(200)).body;
    expect(d).toMatchObject({ status: 'READY', handoff: true, reason: 'identity_needed', handoffSuggestion: { reason: 'identity_needed' }, retryReasons: ['bad_reason'] });
    expect(JSON.stringify(d)).not.toContain('Пацієнтка');
    // a hand-over without a reason gets the neutral code
    await incoming(c, 'Покличте людину');
    fake.script = () => decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: null });
    expect((await draft(c).expect(200)).body.reason).toBe('other');
  });

  it('слова-ризики: заперечення обіцянки («не гарантуємо») проходить, обіцянка — ні; повтор називає слово', async () => {
    const c = await agentClinic();
    await incoming(c, 'Розкажіть про консультацію');
    fake.script = () => decision({ reply: 'Ми не гарантуємо результат: його визначає лікар після огляду.' });
    expect((await draft(c).expect(200)).body).toMatchObject({ status: 'READY', modelCalls: 1 });
    await incoming(c, 'А що буде на консультації?');
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: 'Для вас діє знижка на консультацію.' }) : decision({ reply: 'На консультації лікар проводить огляд.' }));
    const d = (await draft(c).expect(200)).body;
    expect(d).toMatchObject({ status: 'READY', modelCalls: 2, retryReasons: ['risky_claim'] });
    expect(fake.calls[fake.calls.length - 1].system).toContain('«знижк»'); // the exact word is told to the retry
  });

  it('«дорого» і страх: чернетка визнає сумнів і спирається на затверджені склад і FAQ (текст у довідці, моделі видано), без знижок і гарантій; підказки в запиті', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    await incoming(c, 'А чому так дорого?');
    fake.script = () => decision({ reply: 'Розумію ваш сумнів. До консультації входять огляд, консультація лікаря та план лікування, триває вона близько 30 хвилин. За деталями ціни можна уточнити в адміністратора.' }, { action: 'NONE' });
    const dear = (await draft(c).expect(200)).body;
    expect(dear).toMatchObject({ status: 'READY', modelCalls: 1, next: { action: 'NONE' } });
    expect(lastSystem()).toContain('Сумнів «дорого»');
    expect(lastSystem()).toContain('Лікар пояснює кожен крок'); // the approved FAQ is in the prompt
    await incoming(c, 'Мені страшно йти до лікаря, нервую заздалегідь');
    fake.script = () => decision({ reply: 'Розуміємо вас. Можна сказати лікарю, що ви хвилюєтеся: він пояснює кожен крок і зупиняється за вашим сигналом.' });
    const fear = (await draft(c).expect(200)).body;
    expect(fear).toMatchObject({ status: 'READY', modelCalls: 1 });
    // the same answers with a promise are refused
    await incoming(c, 'Мені страшно, що буде неприємно');
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: 'Не бійтеся, у нас усе безболісно.' }) : decision({ reply: 'Розуміємо. Лікар пояснює кожен крок і зупиняється за вашим сигналом.' }));
    const promised = (await draft(c).expect(200)).body;
    expect(promised).toMatchObject({ status: 'READY', retryReasons: ['risky_claim'] });
    expect(promised.reply).not.toMatch(/безболісно/);
    expect(s).toBeTruthy();
  });

  it('«після 19:00»: побажання враховується; вікон немає — чесне повідомлення й пропозиція уточнення, не ті самі часи; «вранці» — лише ранкові', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    await incoming(c, 'Хочу записатися на консультацію');
    fake.script = () => decision({ reply: 'Із задоволенням.' }, { action: 'OFFER_TIME', service: s });
    const first = (await draft(c).expect(200)).body;
    expect(first.options.length).toBeGreaterThan(0);
    // the staff send it (simulated: the harness also keeps the chosen service in the dialogue state), the client wants later than the clinic works (09:00-18:00)
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, serviceId: c.consult.id } });
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: first.reply, authorUserId: c.userId, buttons: first.options.map((o: { label: string; date: string; time: string }) => ({ label: o.label, payload: `slot|${o.date}|${o.time}` })) } });
    await incoming(c, 'Ці часи мені не підходять, зручніше було б після 19:00.');
    fake.script = () => decision({ reply: 'Зрозуміли ваше побажання.' }, { action: 'OFFER_TIME', service: null });
    const late = (await draft(c).expect(200)).body;
    expect(late.options).toEqual([]); // the same unsuitable windows are not shown again
    expect(late.next).toMatchObject({ proposed: 'OFFER_TIME', action: 'NONE', check: { ok: false, rejected: 'no_window_for_preference' } });
    expect(late.reply).toContain('На найближчі 7 днів вільних вікон після 19:00 не знайшлося.'); // the searched range and the wish, written by the code
    expect(late.reply).not.toContain('найближчим часом немає');
    expect(late.reply).toContain('Передати ваш запит адміністратору, щоб він підібрав інший час?'); // offered as a question, not promised
    expect(late.reply).not.toMatch(/ось які варіанти|Зрозуміли ваше побажання|Дякуємо, що уточнили/i); // the model's "here are the options" is dropped when there are none
    expect(late.reply).not.toMatch(/передали|передано/i);
    expect(late.handoffSuggestion).toEqual({ reason: 'time_preference_unavailable' });
    // a morning wish: only times before 12:00, none of the times offered before
    await incoming(c, 'Тоді можна вранці?');
    fake.script = () => decision({ reply: 'Так, подивимось ранок.' }, { action: 'OFFER_TIME', service: s });
    const morning = (await draft(c).expect(200)).body;
    expect(morning.options.length).toBeGreaterThan(0);
    const before = new Set(first.options.map((o: { date: string; time: string }) => `${o.date}|${o.time}`));
    expect(morning.reply).toContain('Враховуємо ваше побажання (зранку).');
    for (const o of morning.options as { date: string; time: string }[]) {
      expect(Number(o.time.slice(0, 2))).toBeLessThan(12);
      expect(before.has(`${o.date}|${o.time}`)).toBe(false);
    }
    // nothing but the one pattern: a wish read by code from the last message
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(0);
  });
});

describe('Stage 1 (доробка): назви, час, ціна, мова й дія', () => {
  it('назва «Тестова безкоштовна перевірка» у тексті моделі проходить без повтору; обіцянка безкоштовного лікування поруч — ні', async () => {
    const c = await agentClinic();
    await incoming(c, 'Розкажіть, які у вас є послуги');
    fake.script = () => decision({ reply: 'Є Тестова безкоштовна перевірка, тестова гігієна й тестове лікування.' });
    expect((await draft(c).expect(200)).body).toMatchObject({ status: 'READY', modelCalls: 1, retryReasons: [] });
    await incoming(c, 'А що ще?');
    fake.calls.length = 0;
    let n = 0;
    fake.script = () => (++n === 1 ? decision({ reply: 'Є Тестова безкоштовна перевірка, а лікування у нас безкоштовне.' }) : decision({ reply: 'Є Тестова безкоштовна перевірка.' }));
    const d = (await draft(c).expect(200)).body;
    expect(d).toMatchObject({ modelCalls: 2, retryReasons: ['risky_claim'] });
    expect(fake.calls[1].system).toContain('«безкоштовн»');
  });

  it('час: відлуння побажання й години роботи в тексті моделі відхиляються; слова про побажання й діапазон пише код; слот з’являється лише за наявного вікна', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    // the clinic works until 21:00 on every day: a window after 19:00 exists
    await http().put('/clinic/work-hours').set(auth(c.token)).send(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '10:00', to: '21:00' }]))).expect(200);
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, serviceId: c.consult.id } });
    await incoming(c, 'Хочу на консультацію, зручніше після 19:00.');
    const tries: string[] = [
      'Добре, вам зручніше після 19:00.', // an echo of the wish
      'Так, можемо записати вас на 19:00.', // a slot claimed with no window behind it
      'Клініка працює до 21:00.', // the clinic's hours
    ];
    for (const bad of tries) {
      fake.calls.length = 0;
      let n = 0;
      fake.script = () => (++n === 1 ? decision({ reply: bad }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Зрозуміли ваше побажання.' }, { action: 'OFFER_TIME', service: s }));
      const d = (await draft(c).expect(200)).body;
      expect(d).toMatchObject({ modelCalls: 2, retryReasons: ['time_outside_windows'] });
      expect(fake.calls[1].system).toContain('Не називай жодного часу');
      expect(d.options.length).toBeGreaterThan(0);
      for (const o of d.options as { time: string }[]) expect(o.time >= '19:00').toBe(true); // real windows, after the wish
      expect(d.reply).toContain('Враховуємо ваше побажання (після 19:00).'); // the wish confirmed by the code, as a wish
      expect(d.reply).not.toMatch(/можемо записати|працює до/);
    }
  });

  it('діапазон пошуку: фраза про відсутність вікон називає фактичні 7 днів, а не «часу немає взагалі»; ті самі вікна вдруге не показуються', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, serviceId: c.consult.id } });
    await incoming(c, 'Є вільні вікна після 21:00?');
    fake.script = () => decision({ reply: 'Подивимось.' }, { action: 'OFFER_TIME', service: s });
    const d = (await draft(c).expect(200)).body;
    expect(d.options).toEqual([]);
    expect(d.reply).toContain('На найближчі 7 днів вільних вікон після 21:00 не знайшлося.');
    expect(d.reply).not.toMatch(/часу (взагалі )?немає|завжди|ніколи/);
    expect(d.next.check.rejected).toBe('no_window_for_preference');
  });

  it('ціна: невідома ціна лишається прямою відповіддю й у передачі; після «дорого» та сама ціна не повторюється, а при повторному питанні чи зміні послуги — так', async () => {
    const c = await agentClinic();
    const consult = await refOf(c, 'Тестова консультація');
    const hygiene = await refOf(c, 'Тестова гігієна');
    // unknown price + hand-over: the direct line first, then the offer to hand over (the model gave no reference: the one service of the question is found by the code)
    await incoming(c, 'Скільки коштує тестова гігієна?');
    fake.script = () => decision({ reply: 'Це краще уточнити.' }, { action: 'HAND_OFF', reason: 'needs_clarification' });
    const unknown = (await draft(c).expect(200)).body;
    expect(unknown.reply).toContain('- Тестова гігієна: вартість потрібно уточнити в адміністратора');
    expect(unknown.reply.endsWith(AGENT_HANDOFF_TEXT.uk)).toBe(true);
    expect(unknown.reply).not.toContain('Вартість попередня');
    expect(unknown.handoffSuggestion).toEqual({ reason: 'needs_clarification' });
    // the model's own reference does the same
    await incoming(c, 'Скільки коштує гігієна?');
    fake.script = () => decision({ reply: 'Передамо.', prices: [hygiene] }, { action: 'HAND_OFF', reason: 'needs_clarification' });
    expect((await draft(c).expect(200)).body.reply).toContain('- Тестова гігієна: вартість потрібно уточнити в адміністратора');
    // the price of the consultation is given once (a staff member sent it) ...
    const c2 = await agentClinic();
    const ref2 = await refOf(c2, 'Тестова консультація');
    await incoming(c2, 'Скільки коштує консультація?');
    fake.script = () => decision({ reply: 'Ось ціна.', prices: [ref2] });
    const first = (await draft(c2).expect(200)).body;
    expect(first.reply).toContain('100 грн');
    await prisma.chatMessage.create({ data: { clinicId: c2.clinicId, channel: 'INSTAGRAM', chatId: c2.chat, direction: 'OUT', text: first.reply, authorUserId: c2.userId } });
    // ... and "expensive" does not repeat it, nor the notice
    await incoming(c2, 'Ого, дорогувато.');
    fake.script = () => decision({ reply: 'Розумію. До консультації входять огляд і план лікування.', prices: [ref2] });
    const doubt = (await draft(c2).expect(200)).body;
    expect(doubt.reply).toContain('Розумію.');
    expect(doubt.reply).not.toContain('100 грн');
    expect(doubt.reply).not.toContain('Вартість попередня');
    // asked again: the price comes back
    await prisma.chatMessage.create({ data: { clinicId: c2.clinicId, channel: 'INSTAGRAM', chatId: c2.chat, direction: 'OUT', text: doubt.reply, authorUserId: c2.userId } });
    await incoming(c2, 'А скільки коштує консультація, нагадайте?');
    fake.script = () => decision({ reply: 'Нагадуємо.', prices: [ref2] });
    expect((await draft(c2).expect(200)).body.reply).toContain('- Тестова консультація: 100 грн');
    // another service: its line is written even though no one asked about price in words
    await prisma.chatMessage.create({ data: { clinicId: c2.clinicId, channel: 'INSTAGRAM', chatId: c2.chat, direction: 'OUT', text: 'Нагадуємо.\n\n- Тестова консультація: 100 грн', authorUserId: c2.userId } });
    await incoming(c2, 'А лікування?');
    const filling = await refOf(c2, 'Тестове лікування');
    fake.script = () => decision({ reply: 'Про лікування.', prices: [filling] });
    expect((await draft(c2).expect(200)).body.reply).toContain('- Тестове лікування: 300 грн');
  });

  it('мова й дія: «система покаже», «окремим рядком нижче», обіцянка при NONE, «вже підібрали» — відхиляються з точною причиною; назва зі зміненим закінченням не блокує; запрошення проходить', async () => {
    const c = await agentClinic();
    const cases: [string, string, string, string][] = [
      ['mechanism_in_text', 'Суму вам покаже система.', 'Не пиши про систему', 'NONE'],
      ['mechanism_in_text', 'Ціна консультації буде в окремому рядку нижче.', 'Не пиши про систему', 'NONE'],
      ['action_promise', 'Зараз підберемо вам час.', 'підберемо', 'NONE'],
      ['action_promise', 'Ми вже підібрали для вас час.', 'підібрали', 'NONE'],
    ];
    for (const [code, bad, detail, action] of cases) {
      await incoming(c, `Розкажіть про консультацію (${code})`);
      fake.calls.length = 0;
      let n = 0;
      fake.script = () => (++n === 1 ? decision({ reply: bad }, { action }) : decision({ reply: 'Консультація триває близько 30 хвилин.' }, { action }));
      const d = (await draft(c).expect(200)).body;
      expect(d).toMatchObject({ modelCalls: 2, retryReasons: [code] });
      expect(fake.calls[1].system).toContain(detail.replace(/[«»]/g, ''));
    }
    // a changed form of a service title is a question of language quality, not a safety refusal: no repeat of the model
    await incoming(c, 'Що входить у консультацію?');
    fake.calls.length = 0;
    fake.script = () => decision({ reply: 'До Тестової консультації входять огляд і план лікування. У Тестову консультацію теж можна записатися.' });
    expect((await draft(c).expect(200)).body).toMatchObject({ status: 'READY', modelCalls: 1, retryReasons: [] });
    // an invitation is not a promise; the code line of OFFER_TIME may speak about the times
    await incoming(c, 'А як записатися?');
    fake.script = () => decision({ reply: 'Якщо захочете, можу підказати, як записатися на зручний час.' });
    expect((await draft(c).expect(200)).body).toMatchObject({ status: 'READY', modelCalls: 1, next: { action: 'NONE' } });
  });
});

describe('«більше» не є скаргою на біль: старий бот і агент', () => {
  it('старий бот: «більше цікавить» іде до моделі, «болить зуб» — ні (термінова відповідь кодом); агент: те саме', async () => {
    const old = JSON.stringify({ intent: 'info', reply: 'Добрий день! Розкажемо про лікування.', summary: null, service: '', options: [] });
    // the working bot
    const plain = await agentClinic({ agent: false });
    await incoming(plain, 'Ні, мене більше цікавить лікування');
    fake.script = () => old;
    const a = (await draftHttp(plain).expect(200)).body;
    expect(fake.calls).toHaveLength(1); // the model was asked
    expect(a.handoff).toBe(false);
    fake.calls.length = 0;
    await incoming(plain, 'У мене болить зуб');
    const b = (await draftHttp(plain).expect(200)).body;
    expect(fake.calls).toHaveLength(0); // the classifier answered before the model
    expect(b.reply).toBeTruthy();
    // the agent
    const c = await agentClinic();
    const s = await refOf(c, 'Тестове лікування');
    fake.calls.length = 0;
    await incoming(c, 'Ні, мене більше цікавить лікування');
    fake.script = () => decision({ reply: 'Розкажемо про лікування.', prices: [s] });
    const d = (await draft(c).expect(200)).body;
    expect(fake.calls).toHaveLength(1);
    expect(d).toMatchObject({ status: 'READY', handoff: false });
    expect(d.reply).toContain('300 грн');
    fake.calls.length = 0;
    await incoming(c, 'Больше интересует лечение');
    fake.script = () => decision({ reply: 'Расскажем о лечении.', prices: [s] });
    expect((await draft(c).expect(200)).body.handoff).toBe(false);
    expect(fake.calls).toHaveLength(1);
    fake.calls.length = 0;
    await incoming(c, 'Сильний біль у зубі');
    const e = (await draft(c).expect(200)).body;
    expect(e).toMatchObject({ handoff: true, reason: 'urgent', modelCalls: 0 });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('приклади «повідомлення → чернетка → дія» (відповіді моделі задані тестом)', () => {
  it('друкує приклади', async () => {
    const c = await agentClinic();
    const consult = await refOf(c, 'Тестова консультація');
    const hygiene = await refOf(c, 'Тестова гігієна');
    const rows: string[] = [];
    const run = async (text: string, answer: string) => {
      await incoming(c, text);
      fake.script = () => answer;
      const d = (await draft(c).expect(200)).body;
      rows.push(`IN:  ${text}\nREPLY: ${String(d.reply).replace(/\n+/g, ' / ') || '(порожньо)'}\nNEXT: proposed=${d.next.proposed} action=${d.next.action} ok=${d.next.check.ok}${d.next.check.rejected ? ` rejected=${d.next.check.rejected}` : ''} status=${d.status}${d.options.length ? ` options=${d.options.map((o: { label: string }) => o.label).join(' | ')}` : ''}${d.handoffSuggestion ? ` handoffSuggestion=${d.handoffSuggestion.reason}` : ''}`);
    };
    await run('Скільки коштує тестова консультація?', decision({ reply: 'Дякуємо за запитання.', prices: [consult], after: 'Підібрати для вас зручний час?' }, { action: 'OFFER_TIME', service: consult }));
    await run('Хочу записатися', decision({ reply: 'Із задоволенням допоможемо. Зараз підберемо час.' }, { action: 'OFFER_TIME', service: consult }));
    await run('Скільки коштує безкоштовна перевірка?', decision({ reply: 'Ось відповідь.', prices: [await refOf(c, 'Тестова безкоштовна перевірка')] }));
    await run('Підкажіть, у вас є гігієна, і скільки вона?', decision({ reply: 'Є така послуга.', prices: [hygiene] }));
    await run('Дякую, я подумаю', decision({ reply: 'Добре, будемо раді вас бачити.' }, { action: 'CLOSE' }));
    await run('Покличте, будь ласка, людину', decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await run('Розкажіть про послуги', decision({ reply: 'Ми гарантуємо ідеальний результат' }));
    // the same on a clinic whose dialogue and service titles are Russian
    const r = await agentClinic({ lang: 'ru', name: 'LANKA Agent Test RU' });
    const rc = await refOf(r, 'Тестовая консультация');
    await incoming(r, 'Здравствуйте! Сколько стоит консультация?');
    fake.script = () => decision({ reply: 'Спасибо за вопрос.', prices: [rc], after: 'Подобрать для вас удобное время?' }, { action: 'OFFER_TIME', service: rc });
    const dru = (await draft(r).expect(200)).body;
    rows.push(`IN:  Здравствуйте! Сколько стоит консультация? (ru)\nREPLY: ${String(dru.reply).replace(/\n+/g, ' / ')}\nNEXT: proposed=${dru.next.proposed} action=${dru.next.action} ok=${dru.next.check.ok} options=${dru.options.map((o: { label: string }) => o.label).join(' | ')}`);
    console.log(`\n=== ПРИКЛАДИ ===\n${rows.join('\n---\n')}\n=== КІНЕЦЬ ===`);
    expect(rows).toHaveLength(8);
  });

  it('послугу без онлайн-запису не обіцяють: текст узгоджений із відхиленою дією, передача — єдиний наступний крок; послугу не підміняють', async () => {
    const c = await agentClinic();
    const hygiene = await refOf(c, 'Тестова гігієна');
    await incoming(c, 'А на гігієну можна записатися на завтра?');
    fake.script = () => decision({ reply: 'Так, на гігієну можна записатися завтра!' }, { action: 'OFFER_TIME', service: hygiene });
    const d = (await draft(c).expect(200)).body;
    expect(d.next).toMatchObject({ proposed: 'OFFER_TIME', action: 'HAND_OFF', check: { ok: false, rejected: 'service_not_allowed' } });
    expect(d.options).toEqual([]);
    expect(d.reason).toBe('online_booking_unavailable');
    expect(d.reply).toContain('Онлайн-запис на «Тестова гігієна» наразі недоступний.');
    expect(d.reply).toContain('Якщо хочете, передамо ваш запит адміністратору'); // an offer in the draft
    expect(d.reply).not.toMatch(/можна записатися|не надаємо|Тестова консультація|передали/);
    expect(d.exec.handoffText).toContain('Ми передали ваш запит адміністратору'); // a done thing only in the text that goes out together with the request
    expect(d.exec.handoffText).not.toMatch(/можна записатися|не надаємо/);
  });

  it('м’яке питання після відповіді про ціну: одне, лише для послуги з онлайн-записом, не під час запису і не після відмови', async () => {
    const c = await agentClinic();
    const s = await refOf(c, 'Тестова консультація');
    await incoming(c, 'Скільки коштує тестова консультація?');
    fake.script = () => decision({ reply: 'Дякуємо.', prices: [s] });
    const d = (await draft(c).expect(200)).body;
    expect(d.reply.trim().endsWith('Підібрати зручний час?')).toBe(true);
    expect(d.options).toEqual([]);
    // the question was already asked in this dialogue: not repeated
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'OUT', text: d.reply, authorUserId: c.userId } });
    await incoming(c, 'А ще раз: скільки коштує тестова консультація?');
    const again = (await draft(c).expect(200)).body;
    expect(again.reply).not.toContain('Підібрати зручний час?');
    // a doubt is not a price question
    const e = await agentClinic();
    const es = await refOf(e, 'Тестова консультація');
    await incoming(e, 'Ого, дорого якось...');
    fake.script = () => decision({ reply: 'Розумію.', prices: [es] });
    expect(((await draft(e).expect(200)).body).reply).not.toContain('Підібрати зручний час?');
  });
});
