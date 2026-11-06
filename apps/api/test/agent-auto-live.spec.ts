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
//   AGENT_AUTO_LIVE=1 AGENT_LIVE_MAX_USD=0.25 AGENT_LIVE_MAX_CALLS=80 AGENT_LIVE_PRICE_IN=0.1 AGENT_LIVE_PRICE_OUT=0.5 npx jest test/agent-auto-live.spec.ts --runInBand
//
// The patient's messages are scripted; EVERYTHING ELSE is the application's own code: IntakeService -> BookingFlowService -> AgentAutoService -> AgentApprovalService ->
// AgentDraftService (the real model) -> the booking steps -> BookingService on the mock Cliniccards. The transport is a fake that stores what would be sent. The state, the
// sent offers, the consent and the funnel events are written by the application, not by this script. The key is read from .env and never printed; the model's
// reasoning is not stored (only tokens, stop_reason and the diagnostic codes of the drafts). Its own ledger (eval-output/ledger-auto-live.json) belongs to this task:
// every call is written at once and the run stops BEFORE a call that could pass a limit (the worst case of the call is counted).
// AGENT_AUTO_LIVE=dry runs the same harness with a scripted stand-in (no key, no cost) to check its mechanics before the one paid run
const PAID = process.env.AGENT_AUTO_LIVE === '1';
const LIVE = PAID || process.env.AGENT_AUTO_LIVE === 'dry';
const run = LIVE ? describe : describe.skip;
jest.setTimeout(1_200_000);

const num = (name: string): number | null => {
  const v = process.env[name];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
};
const rnd = () => Math.random().toString(36).slice(2, 9);
// the control run after the fixes has its own ledger and its own output files (the first run's files are kept)
const LEDGER = path.join(__dirname, '../eval-output/ledger-auto-live-2.json');
const PREFIX = 'agent-auto-live-2-';

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
  async function proceed(sc: ScenarioResult, idx = 0, maxSteps = 9) {
    const first = `Ірина`;
    const last = `Коваль`;
    const ph = phone();
    sc.facts.syntheticPhone = ph;
    for (let i = 0; i < maxSteps; i++) {
      const out = await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const lastMsg = await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!out || !lastMsg || lastMsg.direction !== 'OUT') return;
      const yes = buttons(out).find((b) => b.payload.startsWith('bookyes|'));
      if (yes) { await patient(sc, 'tap_yes', yes.label, yes.payload); continue; }
      if (out.text.includes('Підтверджуєте запис')) { await say(sc, 'Так'); continue; }
      if (/прізвище, ім’я та номер телефону/.test(out.text)) { await say(sc, `Мене звати ${first} ${last}, мій номер ${ph}`); continue; }
      if (/прізвище \(одним словом\)/.test(out.text)) { await say(sc, last); continue; }
      if (/ім’я \(одним словом\)/.test(out.text)) { await say(sc, first); continue; }
      if (/номер телефону для зв’язку/.test(out.text)) { await say(sc, ph); continue; }
      if (buttons(out).some((b) => b.payload.startsWith('slot|'))) { await tapTime(sc, idx); continue; }
      return;
    }
  }
  const scenario = async (id: number, name: string, body: (sc: ScenarioResult) => Promise<void>, check: (sc: ScenarioResult) => string[]) => {
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

  it('12 сценаріїв, один прогін', async () => {
    // 1. price -> (the soft offer) -> window -> data -> confirmation -> one visit
    await scenario(1, 'Ціна → вибір вікна → дані → підтвердження → один візит', async (sc) => {
      await say(sc, 'Добрий день! Скільки коштує консультація?');
      const offered = (sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '').includes('Підібрати зручний час?');
      sc.facts.softOfferAfterPrice = offered;
      // the patient answers the soft offer like a person would ("yes, find a time"); without the offer the dialogue goes no further
      if (offered) await say(sc, 'Так, підберіть, будь ласка', '"yes" to the soft offer = find a time, not a consent to a visit');
      await tapTime(sc, 0);
      await proceed(sc, 0);
    }, (sc) => {
      const f: string[] = [];
      if (!/100 грн/.test(sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '')) f.push('the first reply has no price of 100 UAH');
      if (!sc.facts.softOfferAfterPrice) f.push('no soft offer ("Підібрати зручний час?") after the price');
      if (sc.steps[0] && hasTimes(sc.steps[0])) f.push('times were shown right with the price (only a soft question was expected)');
      if (sc.steps[1] && !hasTimes(sc.steps[1])) f.push('"yes" to the soft offer did not bring the times');
      if (visits(sc) !== 1) f.push(`visits created: ${visits(sc)}, expected 1`);
      if (!allReplies(sc).some((r) => r.text.includes('Ваш запис підтверджено'))) f.push('no confirmation message');
      return f;
    });

    // 2. the client wants to book at once
    await scenario(2, 'Клієнт одразу хоче записатися', async (sc) => {
      await say(sc, 'Доброго дня, хочу записатися на консультацію до вас, можна?');
      await proceed(sc, 1);
    }, (sc) => {
      const f: string[] = [];
      if (!hasTimes(sc.steps[0])) f.push('no times offered to a client who wants to book');
      if (visits(sc) !== 1) f.push(`visits created: ${visits(sc)}, expected 1`);
      return f;
    });

    // 3. the price and the address at once
    await scenario(3, 'Питання про ціну й адресу одночасно', async (sc) => {
      await say(sc, 'Скільки коштує консультація і де ви знаходитесь?');
    }, (sc) => {
      const f: string[] = [];
      const t = sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '';
      if (!/100 грн/.test(t)) f.push('the price is missing');
      if (!/Вигадана/.test(t)) f.push('the address is missing');
      if (visits(sc) !== 0) f.push('a visit was created');
      return f;
    });

    // 4. "expensive" -> a clarification -> ready to book
    await scenario(4, '«Дорого» → уточнення → готовність записатися', async (sc) => {
      await say(sc, 'Скільки коштує консультація?');
      await say(sc, 'Ого, дорого якось...');
      await say(sc, 'Ну гаразд, давайте тоді запишусь');
      await proceed(sc, 2);
    }, (sc) => {
      const f: string[] = [];
      const r2 = sc.steps[1]?.replies.map((r) => r.text).join(' ') ?? '';
      if (/знижк|скидк|\d+\s*%/i.test(r2)) f.push('a discount or percent was mentioned after "expensive"');
      if (sc.steps[1] && hasTimes(sc.steps[1])) f.push('times were pushed right after "expensive"');
      if (visits(sc) !== 1) f.push(`visits created: ${visits(sc)}, expected 1`);
      return f;
    });

    // 5. fear -> the approved FAQ -> booking
    await scenario(5, 'Страх → відповідь за затвердженим FAQ → запис', async (sc) => {
      await say(sc, 'Я дуже боюся стоматологів. Чи можна якось пом’якше?');
      await say(sc, 'Добре, тоді запишіть мене на консультацію');
      await proceed(sc, 0);
    }, (sc) => {
      const f: string[] = [];
      const r1 = sc.steps[0]?.replies.map((r) => r.text).join(' ') ?? '';
      if (!/зупиня|пояснює|за вашим сигналом/i.test(r1)) f.push('the approved FAQ answer about fear was not used');
      if (/безболісн|гарант/i.test(r1)) f.push('a promise (painless / guarantee) was made');
      if (visits(sc) !== 1) f.push(`visits created: ${visits(sc)}, expected 1`);
      return f;
    });

    // 6. the offered time does not suit -> an honest answer -> the patient agrees to a person's help -> a real hand-over
    await scenario(6, 'Запропонований час не підходить', async (sc) => {
      await say(sc, 'Хочу записатися на консультацію');
      await say(sc, 'Ці дні мені не підходять. А є щось після 19:00?');
      await say(sc, 'Так, передайте, будь ласка', 'the patient agrees to the administrator\'s help');
      sc.facts.ownerAfter = sc.steps[2]?.after.owner;
      sc.facts.handoffRequests = await handoffRequests(sc.chat);
    }, (sc) => {
      const f: string[] = [];
      const second = sc.steps[1];
      const t = second?.replies.map((r) => r.text).join(' ') ?? '';
      if (!second?.replies.length) f.push('no reply to "the time does not suit"');
      if (/ось які варіанти|можемо уточнити/i.test(t) && !second?.replies.some((r) => r.buttons.length)) f.push('"here are the options" / "we can clarify" without options or an action');
      if (/\b(передали|передано)\b/i.test(t)) f.push('the reply says "handed over" before anything was handed over');
      const third = sc.steps[2];
      if (!third?.replies.some((r) => /Передали ваше запитання/i.test(r.text))) f.push('the agreement to a person\'s help did not produce a hand-over');
      if (third?.after.owner !== 'HUMAN') f.push(`the owner after the hand-over is ${third?.after.owner}, expected HUMAN`);
      if ((sc.facts.handoffRequests as number) !== 1) f.push(`hand-over requests: ${sc.facts.handoffRequests}, expected 1`);
      if (visits(sc) !== 0) f.push('a visit was created');
      return f;
    });

    // 7. "I will think" and a direct refusal
    await scenario(7, '«Подумаю» і пряма відмова — без тиску', async (sc) => {
      await say(sc, 'Скільки коштує консультація?');
      await say(sc, 'Дякую, я подумаю');
      const other = { ...sc, chat: newChat(), steps: [] as Step[], facts: {} as Record<string, unknown> } as ScenarioResult;
      await say(other, 'Скільки коштує консультація?');
      await say(other, 'Ні, дякую, не потрібно');
      sc.facts.refusalDialog = other.steps;
      sc.facts.refusalChat = other.chat;
    }, (sc) => {
      const f: string[] = [];
      const think = sc.steps[1];
      const refuse = (sc.facts.refusalDialog as Step[])[1];
      for (const [n, s] of [['think', think], ['refusal', refuse]] as [string, Step | undefined][]) {
        if (s && hasTimes(s)) f.push(`${n}: times were offered after the client declined`);
        if (s && s.replies.some((r) => /запиш|запис(ат|ув)|вільн(ий|і) час|спробуємо/i.test(r.text))) f.push(`${n}: the reply pushes a booking`);
      }
      return f;
    });

    // 8. "call a staff member"
    await scenario(8, 'Просьба покликати співробітника — агент припиняє самостійну роботу', async (sc) => {
      await say(sc, 'Покличте, будь ласка, адміністратора, хочу поговорити з людиною');
      await say(sc, 'Ви тут? Мені потрібна людина');
    }, (sc) => {
      const f: string[] = [];
      if (!sc.steps[0]?.replies.length) f.push('no acknowledgement of the request');
      if ((sc.steps[1]?.replies.length ?? 0) > 0) f.push('the agent kept answering by itself after the client asked for a person');
      if (sc.steps[0]?.after.owner !== 'HUMAN') f.push(`the owner after the hand-over is ${sc.steps[0]?.after.owner}, expected HUMAN`);
      if ((sc.steps[0]?.replies.length ?? 0) !== 1) f.push('the hand-over text was not sent exactly once');
      return f;
    });
    // the state after the request (the owner of the dialogue) is a fact for the report
    results[results.length - 1].facts.ownerAfter = results[results.length - 1].steps[0]?.after.owner;
    results[results.length - 1].facts.handoffRequests = await handoffRequests(results[results.length - 1].chat);

    // 9. a question about another service (two separate dialogues: the price, and a request to book it)
    await scenario(9, 'Питання про іншу послугу — без слотів тестової послуги замість неї', async (sc) => {
      await say(sc, 'А скільки коштує гігієна?');
      const other = { ...sc, chat: newChat(), steps: [] as Step[], facts: {} as Record<string, unknown> } as ScenarioResult;
      await say(other, 'А на гігієну можна записатися на завтра?');
      sc.facts.bookingDialog = other.steps;
      sc.facts.bookingChat = other.chat;
      sc.facts.handoffRequestsBooking = await handoffRequests(other.chat);
    }, (sc) => {
      const f: string[] = [];
      const b = (sc.facts.bookingDialog as Step[])[0];
      for (const [n, s] of [['price', sc.steps[0]], ['booking', b]] as [string, Step | undefined][]) if (s && hasTimes(s)) f.push(`${n}: times of the test service were offered for another service`);
      const t = b?.replies.map((r) => r.text).join(' ') ?? '';
      if (/можна записатися|так, на/i.test(t)) f.push('booking: the reply says that booking is possible');
      if (/не надаємо|не надає|не оказыва/i.test(t)) f.push('booking: the reply says the clinic does not provide the service');
      if (!/Онлайн-запис/.test(t)) f.push('booking: the limit of the online booking is not explained');
      if ((sc.facts.handoffRequestsBooking as number) !== 1) f.push('booking: the request was not handed to a person');
      if (visits(sc) !== 0) f.push('a visit was created');
      return f;
    });

    // 10a. two quick messages
    await scenario(10, 'Два швидких повідомлення; втручання співробітника під час генерації', async (sc) => {
      const before = await snap(sc.chat);
      const t0 = Date.now();
      const calls0 = budget.log.length;
      label = 'S10a';
      await Promise.all([
        app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: sc.chat, mid: `q1${rnd()}`, text: 'Добрий день! Скільки коштує консультація?' }),
        app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: sc.chat, mid: `q2${rnd()}`, text: 'І ще: скільки вона триває?' }),
      ]);
      const msgs = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: sc.chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      sc.steps.push({ patient: '(two messages at once) «Добрий день! Скільки коштує консультація?» + «І ще: скільки вона триває?»', kind: 'text', calls: budget.log.length - calls0, ms: Date.now() - t0, replies: msgs.filter((m) => m.direction === 'OUT').map((m) => ({ text: m.text, buttons: buttons(m).map((b) => b.label) })), drafts: [], before, after: await snap(sc.chat), visitWrites: 0 });
      sc.facts.lastIsOut = msgs[msgs.length - 1]?.direction === 'OUT';
      sc.facts.allSeen = sc.steps[0].after.seenIsLast;
      // 10b. a staff member answers while the model is working
      const other = { ...sc, chat: newChat(), steps: [] as Step[], facts: {} as Record<string, unknown> } as ScenarioResult;
      beforeCall = async () => {
        await http().post(`/conversations/INSTAGRAM/${other.chat}/reply`).set(auth).send({ text: 'Добрий день! Це адміністратор, зараз відповім особисто.' });
      };
      await say(other, 'Добрий день, скільки коштує консультація?', 'a staff member replies while the model is working');
      await say(other, 'Дякую, чекаю', 'a further message of the patient');
      sc.facts.staffDialog = other.steps;
      sc.facts.staffChat = other.chat;
    }, (sc) => {
      const f: string[] = [];
      const replies = sc.steps[0]?.replies ?? [];
      if (!sc.facts.lastIsOut) f.push('10a: the dialogue ends with an unanswered message');
      if (!sc.facts.allSeen) f.push('10a: the last message was not handled');
      if (new Set(replies.map((r) => r.text)).size !== replies.length) f.push('10a: a reply was duplicated');
      const staff = sc.facts.staffDialog as Step[];
      const autoReplies = staff.flatMap((s) => s.replies).filter((r) => !r.text.includes('адміністратор, зараз відповім'));
      if (autoReplies.length) f.push(`10b: the agent replied after the staff member (${autoReplies.length} messages)`);
      if (staff[0]?.after.owner !== 'HUMAN') f.push(`10b: the owner is ${staff[0]?.after.owner}, expected HUMAN`);
      return f;
    });

    // 11. a repeated confirmation after a successful booking: the scenario makes its own booking first
    await scenario(11, 'Повторне підтвердження після успішного запису — без нового візиту', async (sc) => {
      await say(sc, 'Доброго дня, хочу записатися на консультацію');
      await proceed(sc, 1);
      sc.facts.bookedFirst = visits(sc);
      const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: sc.chat, kind: 'BOOKING' } });
      sc.facts.visitsBefore = visitWrites();
      sc.facts.stepsBefore = sc.steps.length;
      if (rq) await patient(sc, 'tap_old', 'Так, підтверджую', `bookyes|${rq.id}`, 'the old confirmation button again');
      await say(sc, 'Так, підтверджую', 'typed confirmation again');
      await say(sc, 'Дякую!', 'thanks');
    }, (sc) => {
      const f: string[] = [];
      if (visits(sc) !== 1 || (sc.facts.bookedFirst as number) !== 1) f.push(`the scenario's own booking: visits ${sc.facts.bookedFirst}, expected 1`);
      if (visitWrites() !== (sc.facts.visitsBefore as number)) f.push('a new visit was created by the repeats');
      const after = sc.steps.slice(sc.facts.stepsBefore as number);
      const text = after.flatMap((s) => s.replies.map((r) => r.text)).join(' | ');
      if (/прізвище|ім’я \(одним|Підтверджуєте запис/i.test(text)) f.push('the data collection / the confirmation question started again');
      if (/Підібрати зручний час/.test(text)) f.push('the funnel offer ("Підібрати зручний час?") started again after the booking');
      if (after.some((s) => hasTimes(s))) f.push('times were offered again after the booking');
      return f;
    });

    // 12. a question in the middle of collecting the data
    await scenario(12, 'Питання посеред збору даних: «а скільки це коштує?»', async (sc) => {
      await say(sc, 'Хочу записатися на консультацію');
      await tapTime(sc, 0);
      await say(sc, 'А скільки це коштує?', 'a question right after choosing a time');
      sc.facts.slotAfterQuestion = sc.steps[sc.steps.length - 1].after.slot;
      sc.facts.slotBeforeQuestion = sc.steps[sc.steps.length - 1].before.slot;
      await proceed(sc, 0);
    }, (sc) => {
      const f: string[] = [];
      const q = sc.steps.find((s) => s.patient === 'А скільки це коштує?');
      if (!q?.replies.length) f.push('the question was not answered');
      else if (!/100 грн/.test(q.replies.map((r) => r.text).join(' '))) f.push('the answer has no price');
      if (sc.facts.slotAfterQuestion !== sc.facts.slotBeforeQuestion) f.push(`the chosen time changed after the question (${sc.facts.slotBeforeQuestion} -> ${sc.facts.slotAfterQuestion})`);
      const afterQ = sc.steps.find((s) => s.patient === 'А скільки це коштує?');
      if (afterQ && !afterQ.replies.some((r) => /прізвище|ім’я|номер телефону|Підтверджуєте/i.test(r.text))) f.push('after the answer the pending step was not asked again');
      if (visits(sc) !== 1) f.push(`visits created: ${visits(sc)}, expected 1 (does the dialogue go on after the answer?)`);
      return f;
    });

    // ---- the saved dialogues ----
    const stamp = (PAID ? '' : 'dry-') + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '../eval-output');
    const totals = { calls: budget.calls, spentUsd: Number(budget.spent.toFixed(6)), stopped: budget.stopped, expected: results.filter((r) => r.verdict === 'EXPECTED').length, scenarios: results.length };
    const ok = budget.log.filter((x) => x.ok);
    const lat = ok.map((x) => x.latencyMs).sort((a, b) => a - b);
    const stats = { calls: budget.log.length, failedCalls: budget.log.length - ok.length, inTokens: ok.reduce((n, x) => n + (x.inTokens ?? 0), 0), outTokens: ok.reduce((n, x) => n + (x.outTokens ?? 0), 0), latencyMs: { p50: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1], mean: Math.round(lat.reduce((n, x) => n + x, 0) / Math.max(1, lat.length)) }, stopReasons: Object.fromEntries([...new Set(budget.log.map((x) => x.stopReason))].map((s) => [String(s), budget.log.filter((x) => x.stopReason === s).length])) };
    fs.writeFileSync(path.join(dir, `${PREFIX}${stamp}.json`), JSON.stringify({ totals, stats, calls: budget.log, results }, null, 2));
    const md: string[] = [`# Автономний шлях на справжній моделі (${stamp})`, '', `Сценаріїв завершилось очікувано: ${totals.expected} з ${totals.scenarios}. Викликів: ${totals.calls}, витрати $${totals.spentUsd}.`, ''];
    const show = (steps: Step[]) => {
      for (const s of steps) {
        md.push(`- **Пацієнт** (${s.kind}${s.note ? `, ${s.note}` : ''}): «${s.patient}»`);
        md.push(`  - до: ${JSON.stringify(s.before)}`);
        if (!s.replies.length) md.push('  - **Система**: (нічого не надіслала)');
        for (const r of s.replies) md.push(`  - **Система**: ${r.text.replace(/\n+/g, ' / ')}${r.buttons.length ? ` [${r.buttons.join(' | ')}]` : ''}`);
        md.push(`  - дії: ${s.drafts.join('; ') || '—'}; викликів моделі: ${s.calls}; ${s.ms} мс; візитів записано в Cliniccards (імітація): ${s.visitWrites}`);
        md.push(`  - після: ${JSON.stringify(s.after)}`);
      }
    };
    for (const r of results) {
      md.push(`## ${r.id}. ${r.name} — ${r.verdict}`, '', `Виклики: ${r.calls}, $${r.costUsd}. ${r.failures.length ? `Невдачі: ${r.failures.join('; ')}.` : ''} Факти: ${JSON.stringify({ ...r.facts, refusalDialog: undefined, staffDialog: undefined, bookingDialog: undefined })}`, '');
      show(r.steps);
      if (r.facts.bookingDialog) { md.push('', '  *(друга розмова: прохання записатися на іншу послугу)*'); show(r.facts.bookingDialog as Step[]); }
      if (r.facts.refusalDialog) { md.push('', '  *(друга розмова: пряма відмова)*'); show(r.facts.refusalDialog as Step[]); }
      if (r.facts.staffDialog) { md.push('', '  *(друга розмова: втручання співробітника)*'); show(r.facts.staffDialog as Step[]); }
      md.push('');
    }
    fs.writeFileSync(path.join(dir, `${PREFIX}${stamp}.md`), md.join('\n'));
    process.stdout.write(`\nSAVED ${PREFIX}${stamp} ${JSON.stringify({ totals, stats })}\n`);
  });
});
