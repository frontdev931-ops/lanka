import * as fs from 'fs';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient, LlmError } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, clinicHm } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { createAgentClinic } from './agent-fixtures';

// ONE LIVE RUN OF THE AUTONOMOUS PATH on the REAL model (paid). Off by default.
//
//   AGENT_AUTO_LIVE3=1 AGENT_LIVE_MAX_USD=0.25 AGENT_LIVE_MAX_CALLS=80 AGENT_LIVE_PRICE_IN=0.1 AGENT_LIVE_PRICE_OUT=0.5 npx jest test/agent-auto-live-3.spec.ts --runInBand
//
// The patient's messages are scripted; EVERYTHING ELSE is the application's own code: IntakeService -> BookingFlowService -> AgentAutoService -> AgentApprovalService ->
// AgentDraftService (the real model) -> the booking steps -> BookingService on the mock Cliniccards. The transport is a fake that stores what would be sent. The state, the
// sent offers, the consent and the funnel events are written by the application, not by this script. The key is read from .env and never printed; the model's
// reasoning is not stored (only tokens, stop_reason and the diagnostic codes of the drafts). Its own ledger (eval-output/ledger-auto-live.json) belongs to this task:
// every call is written at once and the run stops BEFORE a call that could pass a limit (the worst case of the call is counted).
// AGENT_AUTO_LIVE=dry runs the same harness with a scripted stand-in (no key, no cost) to check its mechanics before the one paid run
const PAID = process.env.AGENT_AUTO_LIVE3 === '1';
const LIVE = PAID || process.env.AGENT_AUTO_LIVE3 === 'dry';
const run = LIVE ? describe : describe.skip;
jest.setTimeout(1_200_000);

const num = (name: string): number | null => {
  const v = process.env[name];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
};
const rnd = () => Math.random().toString(36).slice(2, 9);
// the control run after the fixes has its own ledger and its own output files (the first run's files are kept)
// AGENT_LIVE3_TAG=4 AGENT_LIVE3_ONLY=4,6: the short repeat of two scenarios after the fixes of the end of a booking and the hand-over notice (own ledger, own files)
const TAG = process.env.AGENT_LIVE3_TAG ?? '3';
const ONLY = (process.env.AGENT_LIVE3_ONLY ?? '').split(',').map((x) => Number(x)).filter(Boolean);
const LEDGER = path.join(__dirname, `../eval-output/ledger-auto-live-${TAG}.json`);
const PREFIX = `agent-auto-live-${TAG}-`;

interface CallLog { at: string; scenario: string; ok: boolean; inTokens: number | null; outTokens: number | null; thinkingTokens: number | null; stopReason: string | null; latencyMs: number; maxTokens: number; errorDetail: string | null; costUsd: number; estimated: boolean }
class Budget {
  calls = 0;
  spent = 0;
  stopped: string | null = null;
  readonly log: CallLog[] = [];
  constructor(readonly maxUsd: number, readonly maxCalls: number, readonly priceIn: number, readonly priceOut: number) {}
  worstCase(chars: number, maxTokens: number) { return (chars / 2 / 1e6) * this.priceIn + (maxTokens / 1e6) * this.priceOut; }
  guard(chars: number, maxTokens: number) {
    if (this.calls >= this.maxCalls) this.stopped = 'max_calls';
    else if (this.spent + this.worstCase(chars, maxTokens) > this.maxUsd) this.stopped = 'max_usd';
    if (this.stopped) throw new Error('eval_budget_exceeded');
  }
  cost(i: number, o: number) { return (i / 1e6) * this.priceIn + (o / 1e6) * this.priceOut; }
  record(e: Omit<CallLog, 'at'>) {
    this.calls++;
    this.spent += e.costUsd;
    const entry = { at: new Date().toISOString(), ...e };
    this.log.push(entry);
    if (!PAID) return;
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ calls: this.calls, spentUsd: Number(this.spent.toFixed(6)), entries: this.log }, null, 2));
  }
}

interface Step { patient: string; kind: 'text' | 'tap_time' | 'tap_yes' | 'tap_old'; calls: number; ms: number; replies: { text: string; buttons: string[] }[]; drafts: string[]; before: Snap; after: Snap; visitWrites: number; note?: string }
interface Snap { owner: string | null; stage: string | null; salesStage: string | null; request: string | null; slot: string | null; consent: boolean; visit: string | null; seenIsLast: boolean }
interface ScenarioResult { id: number; name: string; chat: string; steps: Step[]; facts: Record<string, unknown>; verdict: 'EXPECTED' | 'NOT_EXPECTED' | 'NOT_RUN'; failures: string[]; calls: number; costUsd: number }

run('ПРОГОН автономного шляху на справжній моделі', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockHandle;
  let budget: Budget;
  let c: Awaited<ReturnType<typeof createAgentClinic>>;
  let label = '';
  let beforeCall: null | (() => Promise<void>) = null;
  const sent: { chatId: string; text: string; options: { label: string; date: string; time: string }[] }[] = [];
  const results: ScenarioResult[] = [];
  // every request as it reaches the provider's client (after the cleaning of AiService): checked for the synthetic contacts of the scenarios
  const bodies: { scenario: string; system: string; messages: { role: string; content: string }[] }[] = [];
  const http = () => request(app.getHttpServer());
  const auth = { Authorization: '' };
  let mid = 0;
  const phone = () => `0970000${String(Math.floor(100 + Math.random() * 899))}`; // synthetic numbers 0970000xxx

  beforeAll(async () => {
    const limits = PAID ? [num('AGENT_LIVE_MAX_USD'), num('AGENT_LIVE_MAX_CALLS'), num('AGENT_LIVE_PRICE_IN'), num('AGENT_LIVE_PRICE_OUT')] : [1, 1000, 0.1, 0.5];
    if (limits.some((x) => x === null || x <= 0)) throw new Error('AGENT_AUTO_LIVE needs AGENT_LIVE_MAX_USD, AGENT_LIVE_MAX_CALLS, AGENT_LIVE_PRICE_IN and AGENT_LIVE_PRICE_OUT');
    if (PAID) {
      const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
      process.env.AI_API_KEY = envFile.match(/^AI_API_KEY=(.+)$/m)?.[1]?.trim();
      process.env.AI_MODEL = envFile.match(/^AI_MODEL=(.+)$/m)?.[1]?.trim() || 'claude-haiku-5-5';
      if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY is not in .env');
      if (fs.existsSync(LEDGER)) throw new Error('the ledger of this task exists: one run only');
    }
    budget = new Budget(limits[0]!, limits[1]!, limits[2]!, limits[3]!);
    const real = PAID ? new LlmClient() : null;
    const dry = (system: string, last: string) => {
      const ref = (title: string) => new RegExp(`\\[(S\\d+)\\]\\s*${title}`).exec(system)?.[1] ?? null;
      const consult = ref('Тестова консультація');
      const d = (content: Record<string, unknown>, next: Record<string, unknown> = {}) => JSON.stringify({ content: { kind: 'ANSWER', reply: 'Дякуємо за повідомлення.', prices: [], after: '', advantages: [], objection: null, ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });
      if (/покличте|адміністратор/i.test(last)) return d({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' });
      if (/подумаю|не потрібно/i.test(last)) return d({ reply: 'Добре, дякуємо.' }, { action: 'CLOSE' });
      if (/запис|записатися|запишусь|запишіть/i.test(last) && consult) return d({ reply: 'Із задоволенням допоможемо.' }, { action: 'OFFER_TIME', service: consult });
      if (/коштує/i.test(last) && consult) return d({ reply: 'Дякуємо за запитання.', prices: [consult] });
      return d({});
    };
    const model = {
      configured: true,
      complete: async (system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens = 700, opts: { schema?: Record<string, unknown> } = {}) => {
        const hook = beforeCall;
        beforeCall = null;
        if (hook) await hook();
        const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
        bodies.push({ scenario: label, system, messages });
        budget.guard(chars, maxTokens);
        const t0 = Date.now();
        try {
          const r = real ? await real.complete(system, messages, maxTokens, opts) : { text: dry(system, messages[messages.length - 1].content), inputTokens: Math.round(chars / 2.5), outputTokens: 100, stopReason: 'end_turn', thinkingTokens: 0 };
          budget.record({ scenario: label, ok: true, inTokens: r.inputTokens, outTokens: r.outputTokens, thinkingTokens: r.thinkingTokens ?? null, stopReason: r.stopReason ?? null, latencyMs: Date.now() - t0, maxTokens, errorDetail: null, costUsd: budget.cost(r.inputTokens, r.outputTokens), estimated: false });
          return r;
        } catch (e) {
          budget.record({ scenario: label, ok: false, inTokens: null, outTokens: null, thinkingTokens: null, stopReason: null, latencyMs: Date.now() - t0, maxTokens, errorDetail: e instanceof LlmError ? (e.detail ?? null) : String((e as Error).message).slice(0, 200), costUsd: budget.worstCase(chars, maxTokens), estimated: true });
          throw e;
        }
      },
    };
    mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
    process.env.CLINICCARDS_BASE_URL = mock.url;
    process.env.CLINICCARDS_WRITE_ENABLED = 'true';
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(model).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new I18nExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    // nothing real is ever sent
    jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
      sent.push({ chatId, text, options: options.map((o) => ({ label: o.label, date: o.date, time: o.time })) });
    });
    c = await createAgentClinic({ http, prisma }, { events: true });
    auth.Authorization = `Bearer ${c.token}`;
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: true, agentAutoServiceId: c.consult.id, aiRepliesPerChatDay: 40 } });
    const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
    mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
    mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
  });
  afterAll(async () => {
    process.stdout.write(`\nCALLS ${budget?.calls} SPENT ${budget?.spent.toFixed(5)} STOPPED ${budget?.stopped}\n`);
    jest.restoreAllMocks();
    await app?.close();
    await mock?.close();
    delete process.env.CLINICCARDS_BASE_URL;
    delete process.env.CLINICCARDS_WRITE_ENABLED;
    delete process.env.AGENT_AUTO_DIALOGS;
  });

  // ---- the patient's side (scripted) and what the application did ----
  const newChat = () => {
    const chat = `ig${rnd()}`;
    process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${chat}`].filter(Boolean).join(',');
    return chat;
  };
  const visitWrites = () => mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits').length;
  const lastOutWithButtons = async (chat: string) => (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 6 })).find((m) => Array.isArray(m.buttons) && m.buttons.length);
  const buttons = (m: { buttons: unknown } | undefined) => (Array.isArray(m?.buttons) ? (m!.buttons as { label: string; payload: string }[]) : []);

  async function snap(chat: string): Promise<Snap> {
    const st = await prisma.conversationState.findFirst({ where: { clinicId: c.clinicId, chatId: chat } });
    const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
    const last = await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: chat, direction: 'IN' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return { owner: st?.owner ?? null, stage: rq?.stage ?? null, salesStage: st?.salesStage ?? null, request: rq ? rq.status : null, slot: rq?.slotAt ? `${clinicDate(rq.slotAt)} ${clinicHm(rq.slotAt)}` : null, consent: !!rq?.consentAt, visit: rq?.externalVisitId ?? null, seenIsLast: !!last && st?.autoSeenId === last.id };
  }

  // one thing the patient does, with everything the system did in response
  async function patient(sc: ScenarioResult, kind: Step['kind'], text: string, payload?: string, note?: string, after?: () => Promise<void>): Promise<Step> {
    const before = await snap(sc.chat);
    const msgsBefore = await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: sc.chat } });
    const draftsBefore = new Set((await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId, chatId: sc.chat }, select: { id: true } })).map((d) => d.id));
    const callsBefore = budget.log.length;
    const writesBefore = visitWrites();
    const t0 = Date.now();
    label = `S${sc.id}`;
    try {
      if (after) await after();
      else await app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: sc.chat, mid: `p${++mid}${rnd()}`, text, payload });
    } catch (e) {
      if (String((e as Error).message).includes('eval_budget_exceeded')) throw e;
      sc.failures.push(`exception: ${(e as Error).message.slice(0, 120)}`);
    }
    const ms = Date.now() - t0;
    const msgs = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: sc.chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const fresh = msgs.slice(msgsBefore).filter((m) => m.direction === 'OUT' && !m.error);
    const drafts = (await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId, chatId: sc.chat }, orderBy: { createdAt: 'asc' } })).filter((d) => !draftsBefore.has(d.id) || true);
    const newDrafts = drafts.filter((d) => !draftsBefore.has(d.id)).map((d) => {
      const s = d.snapshot as { action?: string; contentKind?: string | null; checkRejected?: string | null; handoffReason?: string | null; step?: { kind: string; note?: string } };
      return `${s.step ? `step:${s.step.kind}${s.step.note ? `:${s.step.note}` : ''}` : `model:${s.action}/${s.contentKind ?? '-'}`} -> ${d.choice ?? 'no action'} ${d.status}${d.error ? ` (${d.error})` : ''}${s.checkRejected ? ` [rejected:${s.checkRejected}]` : ''}${s.handoffReason ? ` [handoff:${s.handoffReason}]` : ''}`;
    });
    const step: Step = { patient: text, kind, calls: budget.log.length - callsBefore, ms, replies: fresh.map((m) => ({ text: m.text, buttons: buttons(m).map((b) => b.label) })), drafts: newDrafts, before, after: await snap(sc.chat), visitWrites: visitWrites() - writesBefore, ...(note ? { note } : {}) };
    sc.steps.push(step);
    return step;
  }
  const say = (sc: ScenarioResult, text: string, note?: string) => patient(sc, 'text', text, undefined, note);
  async function tapTime(sc: ScenarioResult, idx = 0) {
    const m = await lastOutWithButtons(sc.chat);
    const b = buttons(m).filter((x) => x.payload.startsWith('slot|'))[idx];
    if (!b) return null;
    return patient(sc, 'tap_time', `Обрав час: ${b.label}`, b.payload);
  }
  // the patient's answers to what the system asks, in natural words (NOT in the labelled format the parser likes), until the dialogue ends or the cap is reached
  interface Who { first: string; last: string; phone: string }
  async function proceed(sc: ScenarioResult, who: Who, o: { idx?: number; stopAtConsent?: boolean; maxSteps?: number } = {}) {
    for (let i = 0; i < (o.maxSteps ?? 10); i++) {
      const out = await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const lastMsg = await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!out || !lastMsg || lastMsg.direction !== 'OUT') return;
      const yes = buttons(out).find((b) => b.payload.startsWith('bookyes|'));
      if (yes) {
        if (o.stopAtConsent) return;
        await patient(sc, 'tap_yes', yes.label, yes.payload);
        continue;
      }
      const order = /що з цього прізвище — «([^»]+)» чи «([^»]+)»/.exec(out.text);
      if (order) { await say(sc, who.last, 'the answer to the one clarification about the order'); continue; }
      if (/прізвище, ім’я та номер телефону/.test(out.text)) { await say(sc, `Мене звати ${who.first} ${who.last}, мій номер ${who.phone}`); continue; }
      if (/прізвище та ім’я/.test(out.text)) { await say(sc, `${who.first} ${who.last}`); continue; }
      if (/прізвище \(одним словом\)/.test(out.text)) { await say(sc, who.last); continue; }
      if (/ім’я \(одним словом\)/.test(out.text)) { await say(sc, who.first); continue; }
      if (/номер телефону для зв’язку/.test(out.text)) { await say(sc, who.phone); continue; }
      if (buttons(out).some((b) => b.payload.startsWith('slot|'))) { await tapTime(sc, o.idx ?? 0); continue; }
      return;
    }
  }
  const scenario = async (id: number, name: string, body: (sc: ScenarioResult) => Promise<void>, check: (sc: ScenarioResult) => string[]) => {
    if (ONLY.length && !ONLY.includes(id)) return;
    const sc: ScenarioResult = { id, name, chat: newChat(), steps: [], facts: {}, verdict: 'EXPECTED', failures: [], calls: 0, costUsd: 0 };
    results.push(sc);
    const calls0 = budget.log.length;
    try {
      await body(sc);
      sc.failures.push(...check(sc));
    } catch (e) {
      if (String((e as Error).message).includes('eval_budget_exceeded')) { sc.verdict = 'NOT_RUN'; sc.failures.push(`stopped by the budget (${budget.stopped})`); } else sc.failures.push(`exception: ${(e as Error).message.slice(0, 160)}`);
    }
    // the patient had to repeat something already given (the agent asked for the surname/first name after a full name with a phone): not "fully clean"
    sc.facts.patientRepeatedData = sc.steps.some((st, i) => /Мене звати/.test(sc.steps[i - 1]?.patient ?? '') && st.replies.some((r) => /прізвище \(одним словом\)|ім’я \(одним словом\)/.test(r.text)));
    const mine = budget.log.slice(calls0);
    sc.calls = mine.length;
    sc.costUsd = Number(mine.reduce((n, x) => n + x.costUsd, 0).toFixed(6));
    if (sc.verdict !== 'NOT_RUN') sc.verdict = sc.failures.length ? 'NOT_EXPECTED' : 'EXPECTED';
  };
  const allReplies = (sc: ScenarioResult) => sc.steps.flatMap((s) => s.replies);
  const hasTimes = (s: Step) => s.replies.some((r) => r.buttons.some((b) => /\d\d\.\d\d, \d\d:\d\d/.test(b)));
  const visits = (sc: ScenarioResult) => sc.steps.reduce((n, s) => n + s.visitWrites, 0);
  const handoffRequests = (chat: string) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: chat, kind: 'HANDOFF' } });


  it('6 незалежних діалогів, один прогін', async () => {
    const who = (first: string, last: string): Who => ({ first, last, phone: phone() });
    const track = (sc: ScenarioResult, w: Who, extra: string[] = []) => { sc.facts.contacts = { names: [w.first, w.last], phones: [w.phone, ...extra] }; };
    const yesButton = async (sc: ScenarioResult) => buttons(await lastOutWithButtons(sc.chat)).find((b) => b.payload.startsWith('bookyes|'));
    const asks = (sc: ScenarioResult) => sc.steps.flatMap((s) => s.replies.map((r) => r.text)).filter((t) => /прізвище \(одним словом\)|ім’я \(одним словом\)|номер телефону для зв’язку|прізвище, ім’я та номер телефону/.test(t)).length;
    const orderQuestions = (sc: ScenarioResult) => sc.steps.flatMap((s) => s.replies.map((r) => r.text)).filter((t) => /що з цього прізвище/.test(t)).length;

    // 1. price -> times -> choice -> contacts -> consent -> one visit
    await scenario(1, 'Ціна → пропозиція часу → вибір → контакти → згода → один візит', async (sc) => {
      const w = who('Оксана', 'Шевчук');
      track(sc, w);
      await say(sc, 'Добрий день! Скільки коштує консультація?');
      if ((sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '').includes('Підібрати зручний час?')) await say(sc, 'Так, підберіть, будь ласка');
      await tapTime(sc, 0);
      await proceed(sc, w);
    }, (sc) => {
      const f: string[] = [];
      if (!/100 грн/.test(sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '')) f.push('the first reply has no price');
      if (!sc.steps[0]?.replies.some((r) => r.text.includes('Підібрати зручний час?'))) f.push('no soft offer after the price');
      if (!sc.steps[1] || !hasTimes(sc.steps[1])) f.push('"yes" to the soft offer did not bring times');
      if (visits(sc) !== 1) f.push(`visits: ${visits(sc)}, expected 1`);
      if (orderQuestions(sc) > 1) f.push('the order of the name was asked more than once');
      if (asks(sc) > 1) f.push('a contact question was asked again');
      return f;
    });

    // 2. a price question after choosing a time -> the price -> back to the data -> the booking
    await scenario(2, 'Питання про ціну після вибору часу → ціна → повернення до збору даних → запис', async (sc) => {
      const w = who('Дарина', 'Мельник');
      track(sc, w);
      await say(sc, 'Хочу записатися на консультацію');
      await tapTime(sc, 1);
      sc.facts.callsBeforeQuestion = budget.log.length;
      await say(sc, 'А скільки це коштує?', 'a price question in the middle of the booking');
      sc.facts.modelCallsForQuestion = budget.log.length - (sc.facts.callsBeforeQuestion as number);
      await proceed(sc, w);
    }, (sc) => {
      const f: string[] = [];
      const q = sc.steps.find((s) => s.patient === 'А скільки це коштує?');
      const t = q?.replies.map((r) => r.text).join(' ') ?? '';
      if (!/100 грн/.test(t)) f.push('the price was not answered');
      if (!/прізвище, ім’я та номер телефону/.test(t)) f.push('the data question did not come back');
      if (sc.facts.modelCallsForQuestion !== 0) f.push(`the question used ${sc.facts.modelCallsForQuestion} model calls (the code should answer it)`);
      if (visits(sc) !== 1) f.push(`visits: ${visits(sc)}, expected 1`);
      return f;
    });

    // 3. the phone corrected after the summary
    await scenario(3, 'Виправлення телефону після зведення → стара кнопка не діє → нове підтвердження → візит з новим телефоном', async (sc) => {
      const w = who('Ірина', 'Бойко');
      const corrected = phone();
      track(sc, w, [corrected]);
      sc.facts.correctedPhone = corrected;
      await say(sc, 'Хочу записатися на консультацію');
      await tapTime(sc, 0);
      await proceed(sc, w, { stopAtConsent: true });
      const old = await yesButton(sc);
      sc.facts.oldPayload = old?.payload ?? null;
      const writesBefore = visitWrites();
      await say(sc, `Ні, номер інший: ${corrected}`, 'the patient corrects the phone');
      sc.facts.newSummary = sc.steps[sc.steps.length - 1].replies.map((r) => r.text).join(' ');
      if (old) await patient(sc, 'tap_old', 'Так, підтверджую', old.payload, 'the OLD button after the correction');
      sc.facts.visitsAfterOldButton = visitWrites() - writesBefore;
      const fresh = await yesButton(sc);
      if (fresh) await patient(sc, 'tap_yes', fresh.label, fresh.payload, 'the NEW button');
    }, (sc) => {
      const f: string[] = [];
      const summary = String(sc.facts.newSummary ?? '');
      const corrected = String((sc.facts.correctedPhone as string).slice(1));
      if (!summary.includes(corrected)) f.push('the new summary does not show the corrected phone');
      if (summary.includes(String((sc.facts.contacts as { phones: string[] }).phones[0].slice(1)))) f.push('the new summary still shows the old phone');
      if ((sc.facts.visitsAfterOldButton as number) !== 0) f.push('the old button created a visit');
      if (!sc.facts.oldPayload) f.push('no consent question before the correction');
      if (visits(sc) !== 1) f.push(`visits: ${visits(sc)}, expected 1`);
      const patientWrite = mock.writes.filter((w) => w.path === '/patients').map((w) => JSON.stringify(w.body)).filter((b) => b.includes(corrected));
      if (!patientWrite.length) f.push('the card in Cliniccards (mock) was not made with the corrected phone');
      return f;
    });

    // 4. an unclear correction -> one hand-over, HUMAN, a later "yes" makes no visit
    await scenario(4, 'Незрозуміле виправлення «це не мій номер» → одна передача, HUMAN, «так» візиту не створює', async (sc) => {
      const w = who('Наталія', 'Ткаченко');
      track(sc, w);
      await say(sc, 'Хочу записатися на консультацію');
      await tapTime(sc, 2);
      await proceed(sc, w, { stopAtConsent: true });
      const old = await yesButton(sc);
      sc.facts.writesBefore = visitWrites();
      await say(sc, 'Це не мій номер', 'an unclear correction');
      sc.facts.ownerAfter = sc.steps[sc.steps.length - 1].after.owner;
      sc.facts.handoffs = await handoffRequests(sc.chat);
      await say(sc, 'Так', 'a later "yes"');
      if (old) await patient(sc, 'tap_old', 'Так, підтверджую', old.payload, 'the old button');
    }, (sc) => {
      const f: string[] = [];
      if (sc.facts.ownerAfter !== 'HUMAN') f.push(`the owner after the unclear correction is ${sc.facts.ownerAfter}, expected HUMAN`);
      if ((sc.facts.handoffs as number) !== 1) f.push(`hand-over requests: ${sc.facts.handoffs}, expected 1`);
      if (visitWrites() !== (sc.facts.writesBefore as number)) f.push('a visit was created');
      const afterDispute = sc.steps.slice(-3).flatMap((s) => s.replies.map((r) => r.text));
      if (/виправлен|змінен|оновлен|Дані для запису/i.test(afterDispute.join(' | '))) f.push('the system said something was corrected or asked a new summary');
      const dispute = sc.steps.find((s) => s.patient === 'Це не мій номер');
      if (JSON.stringify(dispute?.replies.map((r) => r.text)) !== JSON.stringify(['Передали ваше уточнення адміністратору. Він допоможе перевірити дані.'])) f.push('the dispute did not get exactly the one neutral text');
      if (sc.steps.slice(sc.steps.indexOf(dispute!) + 1).some((s) => s.replies.length || s.calls)) f.push('something was sent or the model was called after the notice');
      return f;
    });

    // 5. a request for a person
    await scenario(5, 'Просьба покликати людину → одна передача, наступні повідомлення не запускають агента', async (sc) => {
      const w = who('Олена', 'Мороз');
      track(sc, w);
      await say(sc, 'Покличте, будь ласка, адміністратора, хочу поговорити з людиною');
      sc.facts.ownerAfter = sc.steps[0].after.owner;
      await say(sc, 'Ви тут? Мені потрібна людина');
      await say(sc, 'Скільки коштує консультація?');
      sc.facts.handoffs = await handoffRequests(sc.chat);
    }, (sc) => {
      const f: string[] = [];
      if ((sc.steps[0]?.replies.length ?? 0) !== 1) f.push('the hand-over text was not sent exactly once');
      if (sc.facts.ownerAfter !== 'HUMAN') f.push(`owner: ${sc.facts.ownerAfter}, expected HUMAN`);
      if ((sc.facts.handoffs as number) !== 1) f.push(`hand-over requests: ${sc.facts.handoffs}, expected 1`);
      if (sc.steps.slice(1).some((s) => s.replies.length || s.calls)) f.push('a later message started the agent');
      return f;
    });

    // 6. a successful booking, then the repeats
    await scenario(6, 'Успішний запис → повторне «так», стара кнопка й «дякую» → без другого візиту й повторної воронки', async (sc) => {
      const w = who('Вікторія', 'Савчук');
      track(sc, w);
      await say(sc, 'Доброго дня, хочу записатися на консультацію');
      await proceed(sc, w, { idx: 1 });
      sc.facts.bookedFirst = visits(sc);
      sc.facts.visitsBefore = visitWrites();
      sc.facts.stepsBefore = sc.steps.length;
      const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, kind: 'BOOKING' } });
      if (rq) await patient(sc, 'tap_old', 'Так, підтверджую', `bookyes|${rq.id}`, 'the old confirmation button');
      await say(sc, 'Так, підтверджую', 'typed confirmation again');
      await say(sc, 'Дякую!', 'thanks');
      sc.facts.callsBeforeQuestion = budget.log.length;
      await say(sc, 'А скільки триває консультація?', 'a substantive question after the booking (the model gets the booking status)');
    }, (sc) => {
      const f: string[] = [];
      const rep = sc.steps.slice(sc.facts.stepsBefore as number, -1);
      if (rep.some((s) => s.calls)) f.push('the repeats (old button, typed yes, thanks) used the model');
      if (!rep.slice(0, 2).every((s) => /Ваш запис уже підтверджено: Тестова консультація, \d\d\.\d\d\.\d{4} о \d\d:\d\d\./.test(s.replies.map((r) => r.text).join(' ')))) f.push('the repeated yes did not get the short confirmation of the existing booking');
      if (!/Будь ласка! До зустрічі\./.test(rep[2]?.replies.map((r) => r.text).join(' ') ?? '')) f.push('thanks did not get the short answer');
      const q = sc.steps[sc.steps.length - 1];
      const qt = q.replies.map((r) => r.text).join(' ');
      if (!q.replies.length) f.push('the new question was lost after the booking');
      if (/не створено|не записан|не підтверджен|ще не|помилков/i.test(qt)) f.push('the answer denies or doubts the existing booking');
      if (!/30 хвилин/.test(qt)) f.push('the question was not answered (the length of the consultation)');
      if ((sc.facts.bookedFirst as number) !== 1) f.push(`the scenario's own booking: visits ${sc.facts.bookedFirst}, expected 1`);
      if (visitWrites() !== (sc.facts.visitsBefore as number)) f.push('a new visit was created by the repeats');
      const text = sc.steps.slice(sc.facts.stepsBefore as number).flatMap((s) => s.replies.map((r) => r.text)).join(' | ');
      if (/прізвище|ім’я \(одним|Підтверджуєте запис|Дані для запису/i.test(text)) f.push('the data collection / the summary started again');
      if (/Підібрати зручний час/.test(text)) f.push('the funnel offer started again');
      if (sc.steps.slice(sc.facts.stepsBefore as number).some((s) => hasTimes(s))) f.push('times were offered again');
      return f;
    });

    // ---- the provider requests: the synthetic contacts must not be in any of them (repeats included) ----
    const leaks: { scenario: string; what: string }[] = [];
    for (const sc of results) {
      const known = sc.facts.contacts as { names: string[]; phones: string[] } | undefined;
      if (!known) continue;
      const mine = bodies.filter((b) => b.scenario === `S${sc.id}`);
      sc.facts.providerRequests = mine.length;
      for (const b of mine) {
        const text = JSON.stringify(b);
        for (const n of known.names) if (new RegExp(n.slice(0, Math.max(4, n.length - 2)), 'i').test(text)) leaks.push({ scenario: `S${sc.id}`, what: `name ${n}` });
        for (const p of known.phones) if (text.includes(p.slice(1)) || text.includes(p)) leaks.push({ scenario: `S${sc.id}`, what: `phone ...${p.slice(-4)}` });
      }
    }
    const privacy = { requestsChecked: bodies.length, leaks };
    results.forEach((r) => { r.facts.leakedContacts = leaks.filter((l) => l.scenario === `S${r.id}`).length; });
    if (leaks.length) for (const r of results) if (leaks.some((l) => l.scenario === `S${r.id}`)) { r.failures.push('a synthetic contact reached the provider request'); r.verdict = 'NOT_EXPECTED'; }

    // ---- the saved dialogues ----
    const stamp = (PAID ? '' : 'dry-') + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '../eval-output');
    const totals = { calls: budget.calls, spentUsd: Number(budget.spent.toFixed(6)), stopped: budget.stopped, expected: results.filter((r) => r.verdict === 'EXPECTED').length, scenarios: results.length };
    const ok = budget.log.filter((x) => x.ok);
    const lat = ok.map((x) => x.latencyMs).sort((a, b) => a - b);
    const stats = { calls: budget.log.length, failedCalls: budget.log.length - ok.length, inTokens: ok.reduce((n, x) => n + (x.inTokens ?? 0), 0), outTokens: ok.reduce((n, x) => n + (x.outTokens ?? 0), 0), latencyMs: { p50: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1], mean: Math.round(lat.reduce((n, x) => n + x, 0) / Math.max(1, lat.length)) }, stopReasons: Object.fromEntries([...new Set(budget.log.map((x) => x.stopReason))].map((s) => [String(s), budget.log.filter((x) => x.stopReason === s).length])) };
    fs.writeFileSync(path.join(dir, `${PREFIX}${stamp}.json`), JSON.stringify({ totals, stats, privacy, calls: budget.log, results }, null, 2));
    const md: string[] = [`# Контрольний прогін автономного шляху (${stamp})`, '', `Сценаріїв очікувано: ${totals.expected} з ${totals.scenarios}. Викликів: ${totals.calls}, витрати $${totals.spentUsd}. Запитів до провайдера перевірено: ${privacy.requestsChecked}, витоків синтетичних контактів: ${leaks.length}.`, ''];
    for (const r of results) {
      md.push(`## ${r.id}. ${r.name} — ${r.verdict}`, '', `Виклики: ${r.calls}, $${r.costUsd}. ${r.failures.length ? `Невдачі: ${r.failures.join('; ')}.` : ''} Факти: ${JSON.stringify({ ...r.facts, contacts: undefined })}`, '');
      for (const s of r.steps) {
        md.push(`- **Пацієнт** (${s.kind}${s.note ? `, ${s.note}` : ''}): «${s.patient}»`);
        if (!s.replies.length) md.push('  - **Система**: (нічого не надіслала)');
        for (const x of s.replies) md.push(`  - **Система**: ${x.text.replace(/\n+/g, ' / ')}${x.buttons.length ? ` [${x.buttons.join(' | ')}]` : ''}`);
        md.push(`  - дії: ${s.drafts.join('; ') || '—'}; викликів моделі: ${s.calls}; ${s.ms} мс; візитів (імітація): ${s.visitWrites}`);
        md.push(`  - стан після: ${JSON.stringify(s.after)}`);
      }
      md.push('');
    }
    fs.writeFileSync(path.join(dir, `${PREFIX}${stamp}.md`), md.join('\n'));
    process.stdout.write(`\nSAVED ${PREFIX}${stamp} ${JSON.stringify({ totals, stats, leaks: leaks.length })}\n`);
  });
});
