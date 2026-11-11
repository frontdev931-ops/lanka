import * as fs from 'fs';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentDraftService, DraftDiagnostics, SOFT_OFFER } from '../src/ai/agent-draft.service';
import { LlmClient, LlmError } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { conversationLanguage } from '../src/ai/conversation-language';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { createAgentClinic } from './agent-fixtures';

const MOCK_WRITES = process.env.AGENT_FUNNEL_MOCK_WRITES === '1';

// THE FUNNEL RULES ON THE REAL MODEL (18 scenarios: 15 of the rules + 3 paraphrases of an objection) (paid). Off by default; this is NOT part of the normal suite and nothing in it counts as verified until it has really been run.
//
//   paid:  AGENT_FUNNEL_LIVE=1 AGENT_FUNNEL_MAX_USD=0.15 AGENT_FUNNEL_MAX_CALLS=60 AGENT_FUNNEL_PRICE_IN=0.1 AGENT_FUNNEL_PRICE_OUT=0.5 npx jest test/agent-funnel-live.spec.ts --runInBand
//   free:  AGENT_FUNNEL_LIVE=dry npx jest test/agent-funnel-live.spec.ts --runInBand      (a scripted stand-in instead of the model: checks the harness itself, no key, no cost)
//
// Isolation: its own synthetic clinics in the TEST database (never a real clinic), the Cliniccards MOCK, a fake transport that only stores what would be sent (no real
// message), booking writes switched OFF for the clinics (no visit can be made; the run fails if the mock saw any write). The key is read from .env and never printed. Each call
// is written to its own ledger (eval-output/ledger-funnel-live-<tag>.json) at once, the run stops BEFORE a call that could pass a limit (the worst case of the call is counted),
// and a second paid run with the same ledger is refused. Prices per million tokens (AGENT_FUNNEL_PRICE_IN / _OUT) are YOUR numbers: the harness does not know the rates.
// A scenario is judged by deterministic checks on what the application sent and stored (meaning, state, actions); a person still reads the saved .md.
const PAID = process.env.AGENT_FUNNEL_LIVE === '1';
const LIVE = PAID || process.env.AGENT_FUNNEL_LIVE === 'dry';
const run = LIVE ? describe : describe.skip;
jest.setTimeout(1_200_000);

const num = (name: string): number | null => {
  const v = process.env[name];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
};
const rnd = () => Math.random().toString(36).slice(2, 9);
const TAG = process.env.AGENT_FUNNEL_TAG ?? '1';
const LEDGER = path.join(__dirname, `../eval-output/ledger-funnel-live-${TAG}.json`);

interface CallLog { at: string; scenario: string; ok: boolean; inTokens: number | null; outTokens: number | null; stopReason: string | null; latencyMs: number; costUsd: number }
class Budget {
  calls = 0;
  spent = 0;
  stopped: string | null = null;
  readonly log: CallLog[] = [];
  constructor(readonly maxUsd: number, readonly maxCalls: number, readonly priceIn: number, readonly priceOut: number) {}
  guard(chars: number, maxTokens: number) {
    const worst = (chars / 2 / 1e6) * this.priceIn + (maxTokens / 1e6) * this.priceOut;
    if (this.calls >= this.maxCalls) this.stopped = 'max_calls';
    else if (this.spent + worst > this.maxUsd) this.stopped = 'max_usd';
    if (this.stopped) throw new Error('eval_budget_exceeded');
  }
  cost(i: number, o: number) { return (i / 1e6) * this.priceIn + (o / 1e6) * this.priceOut; }
  record(e: Omit<CallLog, 'at'>) {
    this.calls++;
    this.spent += e.costUsd;
    this.log.push({ at: new Date().toISOString(), ...e });
    if (!PAID) return;
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ calls: this.calls, spentUsd: Number(this.spent.toFixed(6)), entries: this.log }, null, 2));
  }
}

interface Reply { text: string; buttons: string[] }
// chat: the dialogue's own id (to tie the chat to a patient card before the first message); confirmWith: a confirmation button carrying an older consent key
interface Ctl { tap: (i?: number) => Promise<Step>; confirm: () => Promise<Step>; confirmWith: (requestId: string, key: string) => Promise<Step>; takeSlot: () => void; freeSlot: () => void; calls: () => number; chat: string }
// raw: what the model returned in each call of the step (also the tries the checks refused); gens: status, call count and retry reasons of each generated draft
// lang: the language the application resolved for the conversation at this turn; asked: the language each model call of the turn was told to write (from its prompt) and whether a retry reminder named the language
interface Step { patient: string; replies: Reply[]; calls: number; drafts: string[]; raw: string[]; gens: string[]; lang: string; asked: string[] }
interface Scenario { id: number; name: string; chat: string; steps: Step[]; failures: string[]; verdict: 'EXPECTED' | 'NOT_EXPECTED' | 'NOT_RUN'; calls: number; costUsd: number }

run('ПРАВИЛА ВОРОНКИ на справжній моделі (ізольований стенд)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockHandle;
  let budget: Budget;
  let label = '';
  let mainClinic: Awaited<ReturnType<typeof createAgentClinic>>;
  let noAddressClinic: Awaited<ReturnType<typeof createAgentClinic>>;
  let routedClinic: Awaited<ReturnType<typeof createAgentClinic>>;
  let writeClinic: Awaited<ReturnType<typeof createAgentClinic>>;
  const results: Scenario[] = [];
  const http = () => request(app.getHttpServer());
  let mid = 0;
  const sent: { clinicId: string; chatId: string; text: string }[] = [];
  const raws: string[] = []; // one entry per model call, in the order of budget.log
  const gens: string[] = [];
  const asked: string[] = []; // one entry per model call, in the order of budget.log

  beforeAll(async () => {
    const limits = PAID ? [num('AGENT_FUNNEL_MAX_USD'), num('AGENT_FUNNEL_MAX_CALLS'), num('AGENT_FUNNEL_PRICE_IN'), num('AGENT_FUNNEL_PRICE_OUT')] : [1, 1000, 0.1, 0.5];
    if (limits.some((x) => x === null || x <= 0)) throw new Error('a paid run needs AGENT_FUNNEL_MAX_USD, AGENT_FUNNEL_MAX_CALLS, AGENT_FUNNEL_PRICE_IN and AGENT_FUNNEL_PRICE_OUT');
    if (PAID) {
      const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
      process.env.AI_API_KEY = envFile.match(/^AI_API_KEY=(.+)$/m)?.[1]?.trim();
      process.env.AI_MODEL = envFile.match(/^AI_MODEL=(.+)$/m)?.[1]?.trim() || 'claude-haiku-5-5';
      if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY is not in .env');
      if (fs.existsSync(LEDGER)) throw new Error('the ledger of this tag exists: one paid run per tag (set AGENT_FUNNEL_TAG for another)');
    }
    budget = new Budget(limits[0]!, limits[1]!, limits[2]!, limits[3]!);
    const real = PAID ? new LlmClient() : null;
    // the stand-in of the free mode: it answers the way a good model is expected to, only to exercise the harness
    const dry = (system: string, last: string) => {
      const consult = new RegExp('\\[(S\\d+)\\]\\s*Тестова консультація').exec(system)?.[1] ?? null;
      const address = /адреса: ([^;\n]+)/.exec(system)?.[1] ?? null;
      const d = (content: Record<string, unknown>, next: Record<string, unknown> = {}) => JSON.stringify({ content: { kind: 'ANSWER', reply: 'Дякуємо за повідомлення.', prices: [], after: '', advantages: [], objection: null, ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });
      const ru = /записаться|записываться|подберите|пожалуйста|консультацию|Фамилия|сколько|сейчас|Сравниваю|для меня важны|клиник|стоимость|окончательн|находитесь|приём|только/i.test(last);
      if (/розкажіть про консультацію|расскажите о консультации/i.test(last)) return d({ reply: ru ? 'Консультация длится около 30 минут.' : 'Консультація триває близько 30 хвилин.' }, { action: 'NONE', service: consult });
      if (/обрати вашу клініку|порівнюю кілька|порівнюю клініки|сравниваю клиники|чем вы лучше/i.test(last)) return d({ reply: ru ? 'Консультация включает осмотр и план лечения.' : 'Консультація включає огляд, консультацію лікаря та план лікування.' });
      // (scenarios 44 and 46 are Russian conversations the stand-in did not know: a long comparison message without a criterion, "what is in the first visit", a price-only
      // request worded "только стоимость ..., записываться не хочу", the duration, the address and the reminder of the price)
      if (/по-русски/i.test(last)) return d({ reply: 'Хорошо, отвечаем по-русски.' });
      if (/смотрю несколько клиник|не понимаю, какую/i.test(last)) return d({ reply: 'Что для вас важнее всего при выборе клиники?' });
      if (/что входит|що входить/i.test(last)) return d({ reply: ru ? 'Консультация включает осмотр, консультацию врача и план лечения.' : 'Консультація включає огляд, консультацію лікаря та план лікування.' });
      if (/окончательная сумма|остаточна сума/i.test(last)) return d({ reply: ru ? 'Это предварительная стоимость по прайсу.' : 'Це попередня вартість за прайсом.' });
      if (/сколько длится/i.test(last)) return d({ reply: 'Консультация длится около 30 минут.' });
      if (/где вы находитесь/i.test(last)) return d({ reply: address ? `Адрес клиники: ${address.replace(/\.$/, '')}.` : 'Адреса у меня нет.' });
      if (/только стоимость|напомните[^.?!]*стоимость|нагадайте[^.?!]*вартість/i.test(last) && consult) return d({ reply: ru ? 'Конечно.' : 'Звісно.', prices: [consult] });
      if (/лише ціна|тільки вартість|только цену|вартість консультації|скажіть ціну/i.test(last) && consult) return d({ reply: ru ? 'Хорошо.' : 'Гаразд.', prices: [consult] }, /запишіть/i.test(last) ? { action: 'OFFER_TIME', service: consult } : {});
      if (/не знаю[, ]/i.test(last)) return d({ kind: 'CLARIFY', reply: 'Що саме вас турбує?' });
      if (/де ви знаходитесь|где вы/i.test(last) && !/коштує/i.test(last)) return d({ reply: address ? `Наша адреса: ${address.replace(/\.$/, '')}.` : 'Адреси в мене немає.' });
      if (/покличте|адміністратор/i.test(last)) return d({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' });
      if (/подумаю|не хочу запис|не хочу записыв/i.test(last)) return d({ reply: 'Добре, дякуємо за відповідь.' }, { action: 'CLOSE' });
      if (/дорого|страшно|боюся|потягну|досвід|порадитися/i.test(last) && !/запиш/i.test(last)) return d({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо вас. Склад консультації й точну суму уточнить адміністратор.', prices: /скільки/i.test(last) && consult ? [consult] : [] });
      const hygiene = new RegExp('\\[(S\\d+)\\]\\s*Тестова гігієна').exec(system)?.[1] ?? null;
      if (/підберіть|подберите|запиш|запис|не підходить|після \d|вечор|завтра/i.test(last)) return d({ reply: ru ? 'Хорошо.' : 'Добре.' }, { action: 'OFFER_TIME', service: /Хочу записатися$/i.test(last) ? null : /гігієн|гигиен/i.test(last) ? hygiene : consult });
      if (/коштує/i.test(last) && consult) return d({ reply: `${address ? `Наша адреса: ${address.replace(/\.$/, '')}. ` : 'Адреси клініки в мене немає, це уточнить адміністратор. '}Консультація триває близько 30 хвилин.`, prices: [consult] });
      return d({ reply: 'Консультація триває близько 30 хвилин.' });
    };
    const model = {
      configured: true,
      complete: async (system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens = 700, opts: { schema?: Record<string, unknown> } = {}) => {
        asked.push(`${/мовою пацієнта: російською/.test(system) ? 'ru' : 'uk'}${/ПОПЕРЕДНЮ ВІДПОВІДЬ ВІДХИЛЕНО/.test(system) ? ` retry${/Мова пацієнта — (РОСІЙСЬКА|УКРАЇНСЬКА)/.test(system) ? ` names ${/Мова пацієнта — РОСІЙСЬКА/.test(system) ? 'ru' : 'uk'}` : ''}` : ''}`);
        const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
        budget.guard(chars, maxTokens);
        const t0 = Date.now();
        try {
          const r = real ? await real.complete(system, messages, maxTokens, opts) : { text: dry(system, messages[messages.length - 1].content), inputTokens: Math.round(chars / 2.5), outputTokens: 100, stopReason: 'end_turn', thinkingTokens: 0 };
          raws.push(r.text);
          budget.record({ scenario: label, ok: true, inTokens: r.inputTokens, outTokens: r.outputTokens, stopReason: r.stopReason ?? null, latencyMs: Date.now() - t0, costUsd: budget.cost(r.inputTokens ?? 0, r.outputTokens ?? 0) });
          return r;
        } catch (e) {
          raws.push('(call failed)');
          budget.record({ scenario: label, ok: false, inTokens: null, outTokens: null, stopReason: e instanceof LlmError ? (e.detail ?? null) : String((e as Error).message).slice(0, 80), latencyMs: Date.now() - t0, costUsd: 0 });
          throw e;
        }
      },
    };
    mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
    process.env.CLINICCARDS_BASE_URL = mock.url; // the MOCK; CLINICCARDS_WRITE_ENABLED stays unset, so even the mock cannot be written to
    delete process.env.CLINICCARDS_WRITE_ENABLED;
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(model).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new I18nExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    // nothing real is ever sent: the transport only stores what it was asked to send
    jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (clinicId: string, _ch: string, chatId: string, text: string) => {
      sent.push({ clinicId, chatId, text });
    });
    // the retry reasons are not stored with a draft: they are taken from the result of the generation itself
    const draftSvc = app.get(AgentDraftService);
    const generate = draftSvc.generate.bind(draftSvc);
    jest.spyOn(draftSvc, 'generate').mockImplementation(async (...a: Parameters<AgentDraftService['generate']>) => {
      // the exact reason of every refused try (the code of the check and the word or phrase it matched) comes from the diagnostics object of the local evaluation
      const diag: DraftDiagnostics = a[3] ?? { attempts: [] };
      const d = await generate(a[0], a[1], a[2], diag);
      const why = diag.attempts.filter((x) => x.problem).map((x) => `${x.problem}${x.detail ? ` «${x.detail}»` : ''}`);
      gens.push(`${d.status} calls=${d.modelCalls} retries=[${d.retryReasons.join(', ')}]${why.length ? ` refused: ${why.join('; ')}` : ''}`);
      return d;
    });
    const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
    mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
    mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
    const make = async (address: boolean) => {
      const c = await createAgentClinic({ http, prisma }, { events: true });
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: false, aiAgentAuto: true, agentAutoServiceId: c.consult.id, aiRepliesPerChatDay: 40, ...(address ? {} : { publicAddress: null, publicDirections: null }) } });
      return c;
    };
    mainClinic = await make(true);
    noAddressClinic = await make(false);
    // stage 3: a clinic whose approved description names its consultation the first step (routing information), and, ONLY with AGENT_FUNNEL_MOCK_WRITES=1, a clinic that may write visits to the MOCK
    routedClinic = await make(true);
    await prisma.kbItem.update({ where: { id: routedClinic.consult.id }, data: { text: 'Склад (тестові дані): огляд і план лікування. Підходить як перший крок, якщо не знаєте, з чого почати.' } });
    if (MOCK_WRITES) {
      process.env.CLINICCARDS_WRITE_ENABLED = 'true'; // the base URL is the mock above: a write can only reach the mock
      writeClinic = await make(true);
      await prisma.clinic.update({ where: { id: writeClinic.clinicId }, data: { bookingWriteEnabled: true } });
    }
  });
  afterAll(async () => {
    process.stdout.write(`\nFUNNEL LIVE ${PAID ? 'PAID' : 'DRY'}: CALLS ${budget?.calls} SPENT ${budget?.spent.toFixed(5)} STOPPED ${budget?.stopped}\n`);
    jest.restoreAllMocks();
    await app?.close();
    await mock?.close();
    delete process.env.CLINICCARDS_BASE_URL;
    delete process.env.CLINICCARDS_WRITE_ENABLED;
    delete process.env.AGENT_AUTO_DIALOGS;
  });

  const scenario = async (id: number, name: string, clinic: () => typeof mainClinic, body: (say: (t: string, payload?: string) => Promise<Step>, ctl: Ctl) => Promise<void>, check: (steps: Step[]) => string[]) => {
    // AGENT_FUNNEL_ONLY=6,10,12: only these scenarios run (a targeted re-run); the others cost nothing
    const only = (process.env.AGENT_FUNNEL_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (only.length && !only.includes(String(id))) return;
    const c = clinic();
    const chat = `ig${rnd()}`;
    process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${chat}`].filter(Boolean).join(',');
    const sc: Scenario = { id, name, chat, steps: [], failures: [], verdict: 'EXPECTED', calls: 0, costUsd: 0 };
    results.push(sc);
    const calls0 = budget.log.length;
    label = `S${id}`;
    const say = async (text: string, payload?: string): Promise<Step> => {
      const msgsBefore = await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: chat } });
      const draftsBefore = new Set((await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId, chatId: chat }, select: { id: true } })).map((d) => d.id));
      const callsBefore = budget.log.length;
      const gensBefore = gens.length;
      await app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: chat, mid: `p${++mid}${rnd()}`, text, payload });
      const msgs = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const fresh = msgs.slice(msgsBefore).filter((m) => m.direction === 'OUT' && !m.error);
      const drafts = (await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId, chatId: chat }, orderBy: { createdAt: 'asc' } })).filter((d) => !draftsBefore.has(d.id)).map((d) => {
        const s = d.snapshot as { action?: string; contentKind?: string | null; checkRejected?: string | null };
        return `${s.action}/${s.contentKind ?? '-'} -> ${d.choice ?? 'none'} ${d.status}${s.checkRejected ? ` [rejected:${s.checkRejected}]` : ''}`;
      });
      const step: Step = { patient: text, replies: fresh.map((m) => ({ text: m.text, buttons: Array.isArray(m.buttons) ? (m.buttons as { label: string }[]).map((b) => b.label) : [] })), calls: budget.log.length - callsBefore, drafts, raw: raws.slice(callsBefore), gens: gens.slice(gensBefore), lang: await conversationLanguage(prisma, c.clinicId, 'INSTAGRAM', chat), asked: asked.slice(callsBefore) };
      sc.steps.push(step);
      return step;
    };
    try {
      // helpers for the booking steps: the tap of an offered time (the payload the button carries), the consent, a time that gets taken in the mock
      const slotOf: { date?: string; time?: string } = {};
      const ctl: Ctl = {
        tap: async (i = 0) => {
          const outs = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: chat, direction: 'OUT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 6 });
          const btn = outs.flatMap((m) => (Array.isArray(m.buttons) ? (m.buttons as { label: string; payload: string }[]) : [])).filter((b) => b.payload?.startsWith('slot|'))[i];
          if (!btn) throw new Error('no time button to tap');
          const [, date, time] = btn.payload.split('|');
          slotOf.date = date;
          slotOf.time = time;
          return say(`Обрав час: ${date.slice(8)}.${date.slice(5, 7)} ${time}`, btn.payload);
        },
        confirm: async () => {
          const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
          if (!rq) throw new Error('no booking request to confirm');
          return say('Так, підтверджую', `bookyes|${rq.id}`);
        },
        takeSlot: () => {
          if (!slotOf.date) throw new Error('no slot chosen');
          for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${slotOf.date} 00:00:00`, visit_end: `${slotOf.date} 23:59:00`, note: 'harness', price_items: null, date_created: `${slotOf.date} 08:00:00`, date_edited: `${slotOf.date} 08:00:00` } as never);
        },
        freeSlot: () => {
          mock.data.visits = mock.data.visits.filter((v) => v.note !== 'harness');
        },
        calls: () => budget.log.length,
        chat,
        confirmWith: (requestId: string, key: string) => say('Так, підтверджую', `bookyes|${requestId}|${key.slice(0, 10)}`),
      };
      await body(say, ctl);
      sc.failures.push(...check(sc.steps));
    } catch (e) {
      if (String((e as Error).message).includes('eval_budget_exceeded')) {
        sc.verdict = 'NOT_RUN';
        sc.failures.push(`stopped by the budget (${budget.stopped})`);
      } else sc.failures.push(`exception: ${(e as Error).message.slice(0, 160)}`);
    }
    const mine = budget.log.slice(calls0);
    sc.calls = mine.length;
    sc.costUsd = Number(mine.reduce((n, x) => n + x.costUsd, 0).toFixed(6));
    if (sc.verdict !== 'NOT_RUN') sc.verdict = sc.failures.length ? 'NOT_EXPECTED' : 'EXPECTED';
  };

  // ---- the deterministic checks (meaning, not wording) ----
  const all = (steps: Step[]) => steps.flatMap((s) => s.replies);
  const text = (s: Step | undefined) => (s?.replies ?? []).map((r) => r.text).join(' ');
  const hasTimes = (s: Step | undefined) => (s?.replies ?? []).some((r) => r.buttons.some((b) => /\d\d\.\d\d, \d\d:\d\d/.test(b)));
  const q = (s: Step | undefined) => (text(s).match(/\?/g) ?? []).length;
  const offered = (s: Step | undefined) => text(s).includes(SOFT_OFFER.uk) || text(s).includes(SOFT_OFFER.ru);
  const PROMO = /знижк|скидк|акці|акци|розстрочк|рассрочк|гарант|безболісн|безболезн|не боляче|не больно|подарун|подарок/i;
  // wording of the price part: the preliminary price is never called exact/final, a lead-in colon is followed by the price line, no type word repeated before the title
  const priceWording = (s: Step | undefined, label: string): string[] => {
    const f: string[] = [];
    const t = text(s);
    if (/(точн|остаточн|окончательн|фіксован)\p{L}*\s+(вартіст|ціна|цін)/iu.test(t.replace(/(уточн)\p{L}*/giu, ''))) f.push(`${label}: the preliminary price is called exact or final`);
    if ((t.match(/Вартість попередня/g) ?? []).length > 1) f.push(`${label}: the price notice is duplicated`);
    for (const r of s?.replies ?? []) {
      const lines = r.text.split('\n').filter((x) => x.trim());
      lines.forEach((l, i) => { if (/:\s*$/.test(l) && !/^\s*-\s/.test(lines[i + 1] ?? '')) f.push(`${label}: a lead-in "${l.slice(-40)}" is not followed by the price line`); });
    }
    if (/Консультація «Тестова консультація»/.test(t)) f.push(`${label}: the service type is repeated before its title`);
    return f;
  };
  const noPush = (s: Step | undefined, label: string): string[] => {
    const f: string[] = [];
    if (hasTimes(s)) f.push(`${label}: times were offered`);
    if (offered(s)) f.push(`${label}: the booking offer was added`);
    if (/100 грн|100 ₴/.test(text(s))) f.push(`${label}: a price list nobody asked for`);
    if (q(s) > 0) f.push(`${label}: the agent asked a question`);
    if (PROMO.test(text(s))) f.push(`${label}: a promise or promotion`);
    if (!s || !s.replies.length) f.push(`${label}: no reply`);
    return f;
  };

  it('сценарії', async () => {
    const main = () => mainClinic;
    await scenario(1, 'Нейтральне питання про ціну: ціна й одна пропозиція', main, async (say) => { await say('Добрий день! Скільки коштує консультація?'); }, (st) => {
      const f: string[] = [];
      if (!/100 грн/.test(text(st[0]))) f.push('no price');
      if (!offered(st[0]) && !hasTimes(st[0])) f.push('no booking step after the price');
      return f;
    });
    await scenario(2, 'Ціна → «Так, підберіть» → часи', main, async (say) => { await say('Скільки коштує консультація?'); await say('Так, підберіть, будь ласка'); }, (st) => (hasTimes(st[1]) ? [] : ['"yes" to the offer did not bring times']));
    await scenario(3, 'Перше повідомлення «Це занадто дорого» (uk)', main, async (say) => { await say('Це занадто дорого'); }, (st) => noPush(st[0], 'S3'));
    await scenario(4, 'Ціна, потім «А чому так дорого?»', main, async (say) => { await say('Скільки коштує консультація?'); await say('А чому так дорого?'); }, (st) => noPush(st[1], 'S4'));
    await scenario(5, 'Страх (ru): «Мне страшно идти к врачу»', main, async (say) => { await say('Мне страшно идти к врачу'); }, (st) => noPush(st[0], 'S5'));
    await scenario(6, 'Заперечення і явне питання про ціну', main, async (say) => { await say('Це дорого, а скільки точно коштує консультація?'); }, (st) => {
      const f: string[] = [];
      if (!/100 грн/.test(text(st[0]))) f.push('the explicit price question was not answered');
      if (offered(st[0]) || hasTimes(st[0])) f.push('a booking nudge after the objection');
      if (PROMO.test(text(st[0]))) f.push('a promise or promotion');
      f.push(...priceWording(st[0], 'S6'));
      return f;
    });
    await scenario(7, '«Я подумаю»: ввічливе закриття', main, async (say) => { await say('Скільки коштує консультація?'); await say('Я подумаю'); }, (st) => noPush(st[1], 'S7'));
    await scenario(8, 'Відмова (ru), потім пряме прохання записатися', main, async (say) => { await say('Не хочу записываться'); await say('Хорошо, запишите меня на консультацию'); }, (st) => {
      const f = noPush(st[0], 'S8a');
      if (!hasTimes(st[1])) f.push('S8b: the explicit request after a refusal brought no times');
      return f;
    });
    await scenario(9, 'Готовий записатися: найкоротший шлях', main, async (say) => { await say('Хочу записатися на консультацію'); }, (st) => {
      const f: string[] = [];
      if (!hasTimes(st[0])) f.push('no times at once');
      if (q(st[0]) > 0) f.push('a question before the times');
      if (PROMO.test(text(st[0]))) f.push('promotion before booking');
      return f;
    });
    await scenario(10, 'Послугу не названо: одне уточнення зі списку придатних', main, async (say) => { await say('Хочу записатися'); }, (st) => {
      const f: string[] = [];
      if (hasTimes(st[0])) f.push('times without a service');
      if (q(st[0]) !== 1) f.push(`questions: ${q(st[0])}, expected 1`);
      if (/гігієн|лікування|безкоштовна/i.test(text(st[0]))) f.push('an ineligible service was listed');
      return f;
    });
    await scenario(11, 'Названа непридатна послуга (гігієна)', main, async (say) => { await say('Хочу записатися на гігієну'); }, (st) => {
      const f: string[] = [];
      if (hasTimes(st[0])) f.push('times for a service that cannot be booked online');
      if (!/адміністратор/i.test(text(st[0]))) f.push('the staff path was not named');
      return f;
    });
    await scenario(12, 'Ціна, адреса й тривалість в одному повідомленні', main, async (say) => { await say('Скільки коштує консультація, де ви знаходитесь і скільки вона триває?'); }, (st) => {
      const f: string[] = [];
      if (!/100 грн/.test(text(st[0]))) f.push('no price');
      if (!/Вигадана/.test(text(st[0]))) f.push('no address');
      if (!/30\s*хвилин|півгодини/i.test(text(st[0]))) f.push('no duration');
      if (q(st[0]) > 1) f.push(`more than one question from the agent: ${q(st[0])}`);
      f.push(...priceWording(st[0], 'S12'));
      return f;
    });
    await scenario(13, 'Те саме, але адреси клініка не вводила', () => noAddressClinic, async (say) => { await say('Скільки коштує консультація, де ви знаходитесь і скільки вона триває?'); }, (st) => {
      const f: string[] = [];
      if (/вул\.|вулиц|просп|бульвар|Шевченк/i.test(text(st[0]))) f.push('an address was invented');
      if (!/немає|не знаю|не маю|уточн/i.test(text(st[0]))) f.push('the missing address was not stated');
      if (!/100 грн/.test(text(st[0]))) f.push('the price part was dropped');
      f.push(...priceWording(st[0], 'S13'));
      return f;
    });
    await scenario(14, 'Після пропозиції — довідкове питання без повтору пропозиції', main, async (say) => { await say('Скільки коштує консультація?'); await say('А скільки вона триває?'); }, (st) => {
      const f: string[] = [];
      if (offered(st[1]) || hasTimes(st[1])) f.push('the booking offer was repeated');
      if (!/30|півгодини/i.test(text(st[1]))) f.push('the duration was not answered');
      return f;
    });
    await scenario(15, 'Прохання покликати людину: передача, далі мовчання', main, async (say) => { await say('Покличте, будь ласка, адміністратора'); await say('Скільки коштує консультація?'); }, (st) => {
      const f: string[] = [];
      if (!st[0]?.replies.length) f.push('no hand-over notice');
      if (st[1]?.replies.length) f.push('the agent went on after the hand-over');
      return f;
    });

    // paraphrases: the first is read by the code too ("не потягну"), the other two are NOT in the code's lists, so they show what the model does alone
    await scenario(16, 'Перефраз: «Зараз не потягну» (код теж читає)', main, async (say) => { await say('Зараз не потягну'); }, (st) => noPush(st[0], 'S16'));
    await scenario(17, 'Перефраз: «Мав неприємний досвід» (лише модель)', main, async (say) => { await say('Я вже мав неприємний досвід у стоматолога'); }, (st) => noPush(st[0], 'S17'));
    await scenario(18, 'Перефраз: «Мені треба порадитися» (лише модель)', main, async (say) => { await say('Мені треба порадитися з чоловіком'); }, (st) => noPush(st[0], 'S18'));

    // ---- stage 2 (objection handling and decision support): prepared for a LATER isolated real-model review, not run in the stage-2 task. Select them with AGENT_FUNNEL_ONLY=19,20,... ----
    const fewQ = (st: Step[], max: number, label: string): string[] => {
      const n = st.reduce((k, x) => k + q(x), 0);
      return n > max ? [`${label}: ${n} questions to the patient in the objection episode, at most ${max}`] : [];
    };
    const noTimes = (st: Step[], label: string): string[] => (st.some((x) => hasTimes(x) || offered(x)) ? [`${label}: times or the booking offer appeared`] : []);
    const claims = (st: Step[], label: string): string[] => (PROMO.test(all(st).map((r) => r.text).join(' ')) ? [`${label}: a promise, discount or guarantee`] : []);
    await scenario(19, 'Етап 2: невиразний страх → пояснення (не більше одного уточнення, без запису)', main, async (say) => { await say('Мені страшно'); await say('Боюся болю'); }, (st) => [...fewQ(st, 1, 'S19'), ...noTimes(st, 'S19'), ...claims(st, 'S19')]);
    await scenario(20, 'Етап 2: страх уже пояснений (ru): без зайвого уточнення', main, async (say) => { await say('Боюсь боли у стоматолога'); }, (st) => [...fewQ(st, 0, 'S20'), ...noTimes(st, 'S20'), ...claims(st, 'S20')]);
    await scenario(21, 'Етап 2: недовіра після поганого досвіду: без гарантій і критики, максимум одне уточнення', main, async (say) => { await say('Я вже мав неприємний досвід у стоматолога, тепер не довіряю'); }, (st) => [...fewQ(st, 1, 'S21'), ...noTimes(st, 'S21'), ...claims(st, 'S21'), ...(/інші клініки|другие клиники|погано працю/i.test(text(st[0])) ? ['S21: criticism of another clinic'] : [])]);
    await scenario(22, 'Етап 2: сумнів щодо ціни → питання про зміст → «добре, дякую»: відповіді без часів', main, async (say) => { await say('Це занадто дорого'); await say('А що входить у консультацію?'); await say('Добре, дякую'); }, (st) => [...fewQ(st, 0, 'S22'), ...noTimes(st, 'S22'), ...claims(st, 'S22'), ...(/бюджет/i.test(all(st).map((r) => r.text).join(' ')) ? ['S22: the budget was asked'] : [])]);
    await scenario(23, 'Етап 2: «мені треба порадитися» → згодом пряме прохання записати', main, async (say) => { await say('Мені треба порадитися з чоловіком'); await say('Запишіть мене на консультацію'); }, (st) => [...noPush(st[0], 'S23a'), ...(hasTimes(st[1]) ? [] : ['S23: the later explicit request did not bring times'])]);
    await scenario(24, 'Етап 2: сумнів і прохання записатися в одному повідомленні', main, async (say) => { await say('Мені страшно, але запишіть мене на консультацію'); }, (st) => (hasTimes(st[0]) ? [] : ['S24: the explicit booking request was not respected']));
    await scenario(25, 'Етап 2: незрозуміло, яка послуга потрібна: без діагнозу й без примусового маршруту', main, async (say) => { await say('Не знаю, яка послуга мені потрібна'); }, (st) => [...fewQ(st, 1, 'S25'), ...claims(st, 'S25'), ...(hasTimes(st[0]) ? ['S25: times were offered without a known service'] : []), ...(/діагноз|диагноз/i.test(text(st[0])) ? ['S25: a diagnosis'] : [])]);

    // ---- stage 3 (an interested patient: unclear need, booking, rejected times, lost slot): prepared for a LATER isolated real-model run; select with AGENT_FUNNEL_ONLY=26,...,33.
    // Scenarios 32 and 33 create a visit, only in the MOCK, and run only with AGENT_FUNNEL_MOCK_WRITES=1. ----
    const nonRu = (st: Step[]): string[] => (/[іїєґ]/i.test(all(st).map((r) => r.text).join(' ').replace(/Ірина|Коваль|Тестова консультація/g, '')) ? ['an Ukrainian letter in a Russian conversation'] : []);
    await scenario(26, 'Етап 3: російською до вибору слота й даних', main, async (say, ctl) => { await say('Хочу записаться на консультацию'); await ctl.tap(0); await say('Фамилия Коваль, имя Ирина, телефон 0971112233'); }, (st) => [...(hasTimes(st[0]) ? [] : ['S26: no times']), ...(/Подтверждаете запись/.test(all(st).map((r) => r.text).join(' ')) ? [] : ['S26: no consent question']), ...nonRu(st)]);
    await scenario(27, 'Етап 3: невідома послуга, є затверджений перший крок', () => routedClinic, async (say) => { await say('Не знаю, яка послуга мені потрібна'); await say('Так, підберіть, будь ласка'); }, (st) => [...(st[0].calls === 0 && /Почати можна з/.test(text(st[0])) ? [] : ['S27: the first step was not offered by the code from the description']), ...(hasTimes(st[0]) ? ['S27: times before the patient agreed'] : []), ...(hasTimes(st[1]) ? [] : ['S27: no times after the acceptance'])]);
    await scenario(28, 'Етап 3: невідома послуга, затвердженого маршруту немає', main, async (say) => { await say('Не знаю, яка послуга мені потрібна'); await say('Не знаю, мабуть щось із зубами'); }, (st) => [...noTimes(st, 'S28'), ...claims(st, 'S28'), ...fewQ(st, 2, 'S28'), ...(/Почати можна з|рекомендуємо|вам потрібна консультація/i.test(all(st).map((r) => r.text).join(' ')) ? ['S28: a service was recommended without approved routing'] : [])]);
    await scenario(29, 'Етап 3: відхилені часи → побажання → інші часи', main, async (say) => { await say('Хочу записатися на консультацію'); await say('Не підходить'); await say('Після 16:00'); }, (st) => {
      const labels = (s: Step) => s.replies.flatMap((r) => r.buttons);
      const f: string[] = [];
      if (!hasTimes(st[0])) f.push('S29: no first times');
      if (hasTimes(st[1]) || q(st[1]) !== 1) f.push('S29: after the rejection one focused question and no new search were expected');
      const again = labels(st[2]).filter((b) => labels(st[0]).includes(b));
      if (again.length) f.push(`S29: a rejected time was offered again: ${again.join(', ')}`);
      if (!hasTimes(st[2]) && !/вікон/.test(text(st[2]))) f.push('S29: neither times nor an honest no-window answer');
      return f;
    });
    await scenario(30, 'Етап 3: вільних вікон за побажанням немає', main, async (say) => { await say('Хочу записатися на консультацію після 21:00'); }, (st) => [...(hasTimes(st[0]) ? ['S30: times that cannot exist'] : []), ...(/7/.test(text(st[0])) ? [] : ['S30: the searched range is not stated']), ...(/черг|очіку|списк/i.test(text(st[0])) ? ['S30: a waiting list was mentioned'] : []), ...(/Передали|передано/i.test(text(st[0])) ? ['S30: a hand-over was claimed'] : [])]);
    await scenario(31, 'Етап 3: фактичне питання під час збору контактів', main, async (say, ctl) => { await say('Хочу записатися на консультацію'); await ctl.tap(0); await say('А де ви знаходитесь?'); await say('Прізвище Коваль, ім’я Ірина, телефон 0971112244'); }, (st) => [...(/Вигадана/.test(text(st[2])) ? [] : ['S31: the factual question was not answered']), ...(hasTimes(st[2]) ? ['S31: times were offered again during the data collection'] : []), ...(/Підтверджуєте запис/.test(text(st[3])) ? [] : ['S31: the booking did not go on to the consent question'])]);
    if (MOCK_WRITES) {
      await scenario(32, 'Етап 3 (мок): обраний час зайнявся — відновлення', () => writeClinic, async (say, ctl) => { await say('Хочу записатися на консультацію'); await ctl.tap(0); await say('Прізвище Коваль, ім’я Ірина, телефон 0971112255'); ctl.takeSlot(); await ctl.confirm(); ctl.freeSlot(); await ctl.tap(0); await ctl.confirm(); }, (st) => {
        const f: string[] = [];
        const told = st[3];
        if (!/зайнятий/.test(text(told)) || !hasTimes(told)) f.push('S32: the taken time was not explained with fresh times');
        if (/підтверджено/.test(text(told))) f.push('S32: a confirmation for a time that was taken');
        if (!/Ваш запис підтверджено/.test(text(st[st.length - 1]))) f.push('S32: no confirmation after the recovery');
        return f;
      });
      await scenario(33, 'Етап 3 (мок): запис підтверджено, далі інформаційне питання', () => writeClinic, async (say, ctl) => { await say('Хочу записатися на консультацію'); await ctl.tap(0); await say('Прізвище Коваль, ім’я Ірина, телефон 0971112266'); await ctl.confirm(); await say('А де ви знаходитесь?'); await say('Дякую'); }, (st) => [
        ...(/Ваш запис підтверджено/.test(text(st[3])) ? [] : ['S33: no confirmation']),
        ...(/Вигадана/.test(text(st[4])) ? [] : ['S33: the question was not answered']),
        ...(st.slice(4).some((x) => hasTimes(x) || /прізвище|телефон|Підтверджуєте/i.test(text(x))) ? ['S33: a new booking or a new request for contacts started after the confirmation'] : []),
      ]);
    }

    // ---- comparison of clinics and explicit "price only" requests (34-40): prepared for a LATER combined real-model run (select with AGENT_FUNNEL_ONLY=34,...,40) ----
    const SUPER = /кращ|найкращ|лучш|інших клінік|других клиник|конкурент|затверджен|довідц|вигадув|выдумыв/i;
    const invite = (st: Step[]) => /Запишіться|Запишитесь|зручний час|удобное время|Підібрати|Подобрать/.test(all(st).map((r) => r.text).join(' ')) || st.some((x) => hasTimes(x));
    await scenario(34, 'Порівняння: відома послуга, відповідні факти', main, async (say) => { await say('Розкажіть про консультацію'); await say('Чому мені обрати вашу клініку?'); }, (st) => {
      const t = text(st[1]);
      return [...(SUPER.test(t) ? ['S34: a superiority claim or internal machinery in the answer'] : []), ...(/огляд|30\s*хвилин|лікаря|план лікування/i.test(t) ? [] : ['S34: no relevant approved fact']), ...(hasTimes(st[1]) || offered(st[1]) || /Запишіться|зручний час/.test(t) ? ['S34: a booking invitation'] : []), ...(/Вигадана|09:00|18:00/.test(t) ? ['S34: unrelated address or hours listed'] : []), ...(q(st[1]) > 1 ? ['S34: more than one question'] : [])];
    });
    await scenario(35, 'Порівняння: критерій невідомий, фактів небагато', main, async (say) => { await say('Я порівнюю кілька клінік.'); }, (st) => [...(SUPER.test(text(st[0])) ? ['S35: a superiority claim or internal machinery'] : []), ...(invite(st) ? ['S35: a booking invitation or times'] : []), ...(/Передали|передано/i.test(text(st[0])) ? ['S35: a hand-over was claimed'] : []), ...(q(st[0]) > 0 && /адміністратор/i.test(text(st[0])) ? ['S35: the criterion question and an administrator offer in one answer'] : []), ...(q(st[0]) > 1 ? ['S35: more than one question'] : []), ...(st[0].replies.length ? [] : ['S35: no reply'])]);
    await scenario(36, 'Порівняння (ru): критерій названо — без питання про нього', main, async (say) => { await say('Сравниваю клиники, для меня важны цена, длительность и понятный план лечения'); }, (st) => [...(q(st[0]) > 0 && /важнее всего|самое важное|что для вас важно|что вам важно/i.test(text(st[0])) ? ['S36: the criterion was asked although it was stated'] : []), ...(q(st[0]) > 1 ? ['S36: more than one question'] : []), // (with the price among the criteria and no service known, the ONE question which service is the intended step: the live run of tag 6 was flagged by the older "no question at all" test)
       ...(SUPER.test(text(st[0])) ? ['S36: a superiority claim or internal machinery'] : []), ...(invite(st) ? ['S36: a booking invitation or times'] : []), ...nonRu(st)]);
    await scenario(41, 'Порівняння: короткий явний критерій («важлива ціна») — без питання про критерій', main, async (say) => { await say('Порівнюю клініки, важлива ціна'); }, (st) => [...(q(st[0]) > 0 && /найважливіше/i.test(text(st[0])) ? ['S41: asked what matters although the criterion was stated'] : []), ...(SUPER.test(text(st[0])) ? ['S41: a superiority claim or internal machinery'] : []), ...(invite(st) ? ['S41: a booking invitation or times'] : []), ...(st[0].replies.length ? [] : ['S41: no reply'])]);
    await scenario(42, 'Порівняння: довге речення без критерію — або питання про критерій, або факти, але не питання разом із пропозицією адміністратора', main, async (say) => { await say('Я порівнюю кілька клінік, бо вчора був довгий день на роботі, ще треба забрати дитину зі школи і купити хліб'); }, (st) => [...(q(st[0]) > 0 && /адміністратор/i.test(text(st[0])) ? ['S42: the question and an administrator offer in one answer'] : []), ...(q(st[0]) > 1 ? ['S42: more than one question'] : []), ...(SUPER.test(text(st[0])) ? ['S42: a superiority claim or internal machinery'] : []), ...(invite(st) ? ['S42: a booking invitation or times'] : []), ...(st[0].replies.length ? [] : ['S42: no reply'])]);
    await scenario(37, 'Лише ціна: послуга невідома → яка → ціна без запрошення', main, async (say) => { await say('Мене цікавить лише ціна.'); await say('Вартість консультації'); }, (st) => [...(st[0].calls === 0 && q(st[0]) === 1 && !hasTimes(st[0]) ? [] : ['S37: the first answer should be the one question about the service']), ...(/100 грн/.test(text(st[1])) ? [] : ['S37: no price']), ...(invite([st[1]]) ? ['S37: a booking invitation or times after a price-only request'] : [])]);
    await scenario(38, 'Лише ціна (ru), послуга відома', main, async (say) => { await say('Расскажите о консультации'); await say('Мне только цену, без записи.'); }, (st) => [...(/100 грн/.test(text(st[1])) ? [] : ['S38: no price (the service may not have been recorded by the model)']), ...(invite([st[1]]) ? ['S38: a booking invitation or times'] : []), ...(/Стоимость предварительная/.test(text(st[1])) ? [] : ['S38: the price is not marked preliminary'])]);
    await scenario(39, 'Лише ціна → пізніше пряме прохання записатися', main, async (say) => { await say('Тільки вартість консультації, записуватися поки не хочу'); await say('Запишіть мене на консультацію'); }, (st) => [...(invite([st[0]]) ? ['S39: a booking invitation after a price-only request'] : []), ...(hasTimes(st[1]) ? [] : ['S39: the later explicit request did not bring times'])]);
    await scenario(40, 'Ціна й запис в одному повідомленні', main, async (say) => { await say('Скажіть ціну консультації і запишіть мене'); }, (st) => [...(/100 грн/.test(text(st[0])) ? [] : ['S40: no price']), ...(hasTimes(st[0]) ? [] : ['S40: the booking request was suppressed'])]);

    // ---- 43-46: a short criterion then a price, a long message without a criterion (ru), fear in fresh wording then a booking, a price-only preference over six messages (ru) ----
    const CRIT_Q = /найважливіше|що для вас важлив|самое важное|что для вас важн|что вам важн|що вам важлив/i;
    const ADMIN = /адміністратор|администратор/i;
    await scenario(43, 'Порівняння: короткий критерій («Важлива ціна») → ціна тестової консультації', main, async (say) => { await say('Я порівнюю клініки. Важлива ціна.'); await say('Скільки коштує тестова консультація?'); }, (st) => [
      ...(CRIT_Q.test(text(st[0])) && q(st[0]) > 0 ? ['S43: asked what matters although the criterion was stated'] : []),
      ...(SUPER.test(text(st[0])) || /дешевш|нижч\p{L}* цін|найнижч/iu.test(text(st[0])) ? ['S43: a superiority or lower-price claim'] : []),
      ...(hasTimes(st[0]) ? ['S43: times after a comparison message'] : []),
      ...(st[0].replies.length ? [] : ['S43: no reply to the first message']),
      ...(/100 грн/.test(text(st[1])) ? [] : ['S43: no price of the consultation']),
      ...(/Вартість попередня/.test(text(st[1])) ? [] : ['S43: the price is not marked preliminary']),
      ...(PROMO.test(all(st).map((r) => r.text).join(' ')) ? ['S43: a discount, promise or guarantee'] : []),
      ...priceWording(st[1], 'S43'),
    ]);
    await scenario(44, 'Порівняння (ru): довге повідомлення без критерію → «что входит в первый приём»', main, async (say) => { await say('Я сейчас смотрю несколько клиник и пока совершенно не понимаю, какую из них выбрать.'); await say('Мне важно понимать, что входит в первый приём.'); }, (st) => [
      ...(q(st[0]) > 1 ? ['S44: more than one question after the first message'] : []),
      ...(q(st[0]) > 0 && ADMIN.test(text(st[0])) ? ['S44: a question and an administrator offer in one answer'] : []),
      ...(invite([st[0]]) ? ['S44: a booking invitation or times after the first message'] : []),
      ...(st[0].replies.length ? [] : ['S44: no reply to the first message']),
      ...(q(st[1]) > 0 && CRIT_Q.test(text(st[1])) ? ['S44: the criterion was asked again'] : []), // (a statement "понимаю, что для вас важно знать" is not a question: the live run of 2026-11-10 was flagged falsely without the question mark test)
      ...(/осмотр|план лечения|огляд|план лікування/i.test(text(st[1])) || ADMIN.test(text(st[1])) ? [] : ['S44: neither the approved contents nor an administrator offer']),
      ...(hasTimes(st[1]) ? ['S44: times without a booking request'] : []),
      ...(/Передали|передано/i.test(all(st).map((r) => r.text).join(' ')) ? ['S44: a hand-over was claimed'] : []),
      ...(SUPER.test(all(st).map((r) => r.text).join(' ')) ? ['S44: a superiority claim or internal machinery'] : []),
      ...(PROMO.test(all(st).map((r) => r.text).join(' ')) ? ['S44: a discount, promise or guarantee'] : []),
      ...nonRu(st),
    ]);
    await scenario(45, 'Страх іншими словами → що важливо → пряме прохання записатися', main, async (say) => { await say('Давно відкладаю візит: щойно уявляю стоматологічне крісло, хочеться все скасувати.'); await say('Мені важливо, щоб пояснювали, що роблять.'); await say('Добре, хочу записатися на тестову консультацію.'); }, (st) => [
      ...(st[0].replies.length && st[1].replies.length ? [] : ['S45: no reply to a fear message']),
      ...noTimes([st[0], st[1]], 'S45'),
      ...claims([st[0], st[1]], 'S45'),
      ...fewQ([st[0], st[1]], 1, 'S45'),
      ...(q(st[1]) > 0 ? ['S45: a question after the concern was explained'] : []),
      ...(/Передали|передано|седац|наркоз/i.test(text(st[0]) + ' ' + text(st[1])) ? ['S45: a hand-over or an invented sedation option'] : []),
      ...(hasTimes(st[2]) ? [] : ['S45: the explicit booking request did not bring times']),
    ]);
    await scenario(46, 'Лише ціна (ru) упродовж довшої розмови → пряме прохання записатися', main, async (say) => { await say('Мне пока только стоимость тестовой консультации, записываться не хочу.'); await say('Это окончательная сумма?'); await say('А сколько длится консультация?'); await say('И где вы находитесь?'); await say('Напомните, пожалуйста, стоимость.'); await say('Теперь хочу записаться на тестовую консультацию.'); }, (st) => [
      ...[0, 1, 2, 3, 4].flatMap((i) => (invite([st[i]]) || offered(st[i]) ? [`S46: a booking invitation or times in message ${i + 1}`] : [])),
      ...[0, 1, 2, 3, 4].flatMap((i) => (st[i]?.replies.length ? [] : [`S46: no reply to message ${i + 1}`])),
      ...(/100 грн/.test(text(st[0])) ? [] : ['S46: no price in message 1']),
      ...(/предварительн|попередн/i.test(text(st[1])) ? [] : ['S46: message 2 does not say that the price is preliminary']),
      ...(/30/.test(text(st[2])) ? [] : ['S46: no duration in message 3']),
      ...(/Вигадана|Выдуманная/.test(text(st[3])) ? [] : ['S46: no address in message 4']),
      ...(/100 грн/.test(text(st[4])) ? [] : ['S46: no price in message 5']),
      ...(hasTimes(st[5]) ? [] : ['S46: the explicit booking request did not bring times']),
      ...(PROMO.test(all(st).map((r) => r.text).join(' ')) ? ['S46: a discount, promise or guarantee'] : []),
      ...(/Передали|передано/i.test(all(st).map((r) => r.text).join(' ')) ? ['S46: a hand-over was claimed'] : []),
      ...(/(?:точн|окончательн)\p{L}*\s+сумм\p{L}*[^.\n]*администратор|не\s+предварительн/iu.test(all(st).map((r) => r.text).join(' ')) ? ['S46: an exact or final sum is promised, or the provisional status is denied'] : []),
    ]);

    // ---- 47: the honest limit of the language reading and an explicit request. "Хочу на прием завтра." has no sign of either language, so the first reply follows the default; after
    // "отвечайте по-русски" every conversational sentence must be Russian (stored titles and the address stay as the clinic wrote them). The third message answers what the agent asked. ----
    const ruProse = (st: Step) => text(st).replace(/Тестова консультація|Тестова гігієна|Тестове лікування|Тестова безкоштовна перевірка|м\. Тестове, вул\. Вигадана, 1 \(тестова адреса\)/g, '');
    await scenario(47, 'Мова: «Хочу на прием завтра.» → «отвечайте по-русски» → коротка відповідь на питання агента', main, async (say, ctl) => {
      await say('Хочу на прием завтра.');
      const second = await say('Пожалуйста, отвечайте по-русски.');
      const t = text(second);
      if (hasTimes(second)) await ctl.tap(0);
      else if (/услуг|послуг/i.test(t)) await say('На тестовую консультацию');
      else if (/когда|удобн|время|какой день/i.test(t)) await say('Завтра после обеда');
      else await say('Да');
    }, (st) => [
      ...(st[0].replies.length ? [] : ['S47: no reply to the first message']),
      ...(st[1].lang === 'ru' && st[2].lang === 'ru' ? [] : [`S47: the language after the explicit request is ${st[1].lang}/${st[2].lang}`]),
      ...[1, 2].flatMap((i) => (st[i]?.replies.length ? [] : [`S47: no reply to message ${i + 1}`])),
      ...[1, 2].flatMap((i) => (/[іїєґ]/i.test(ruProse(st[i])) ? [`S47: Ukrainian prose in the reply to message ${i + 1}`] : [])),
      ...(/Передали|передано/i.test(all(st).map((r) => r.text).join(' ')) ? ['S47: a hand-over was claimed'] : []),
    ]);

    // ---- 48-52: the doctors mode (DoctorChoiceService decides the doctor; the model only asks for times) and a named doctor in the cabinets mode. The visits of 48, 49
    // and 51 are written only in the MOCK and only with AGENT_FUNNEL_MOCK_WRITES=1 (without it those scenarios stop before the visit is checked). ----
    const doctorsClinic = async () => {
      const c = await createAgentClinic({ http, prisma }, { events: true });
      await prisma.clinic.update({ where: { id: c.clinicId }, data: { scheduleMode: 'DOCTORS', bookingWriteEnabled: MOCK_WRITES, aiAgentAuto: true, agentAutoServiceId: c.consult.id, aiRepliesPerChatDay: 40 } });
      for (const [id, last, first, cab] of [['901', 'Мельник', 'Олена', '801'], ['902', 'Бондар', 'Ігор', '802']]) {
        await prisma.doctor.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: id } }, create: { clinicId: c.clinicId, externalId: id, lastName: last, firstName: first, serviceIds: [c.consult.id] }, update: { serviceIds: [c.consult.id] } });
        await prisma.doctorAvailability.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinicId: c.clinicId, doctorId: id, weekday, fromHm: '10:00', toHm: '17:00', cabinetId: cab })) });
      }
      return c;
    };
    const visitsOf = (from: number) => mock.writes.slice(from).filter((w) => (w as { path?: string }).path === '/visits' && w.method === 'POST');
    const btnDoctors = async (cId: string, chatId: string) => {
      const out = await prisma.chatMessage.findFirst({ where: { clinicId: cId, chatId, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { buttons: true } });
      return [...new Set((Array.isArray(out?.buttons) ? (out!.buttons as { payload?: string }[]) : []).map((b) => b.payload ?? '').filter((x) => x.startsWith('slot|')).map((x) => x.split('|')[3]))];
    };
    const tomorrow = clinicDate(new Date(Date.now() + 86_400_000));
    const timesOf = (st: Step) => st.replies.flatMap((r) => r.buttons).map((b) => /(\d\d)\.(\d\d), (\d\d:\d\d)/.exec(b)).filter(Boolean).map((m) => ({ date: `${tomorrow.slice(0, 4)}-${m![2]}-${m![1]}`, time: m![3] }));
    const facts: Record<number, Record<string, unknown>> = {};

    const d48 = await doctorsClinic();
    await scenario(48, 'Лікарі: названий лікар, завтра після 16:00 → час, контакти, згода, один візит до нього', () => d48 as typeof mainClinic, async (say, ctl) => {
      const w0 = mock.writes.length;
      const s1 = await say('Добрий день! Хочу записатися на консультацію до лікаря Мельник, завтра після 16:00');
      facts[48] = { doctorsOffered: await btnDoctors(d48.clinicId, ctl.chat), times: timesOf(s1) };
      if (!hasTimes(s1)) return;
      await ctl.tap(0);
      await say('Прізвище Петренко, ім’я Олег, телефон 0971112233');
      const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: d48.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
      if (rq?.stage === 'CONFIRM') await say('Так, усе вірно');
      const v = visitsOf(w0);
      facts[48] = { ...facts[48], visits: v.map((x) => (x as { body?: unknown }).body), request: rq && { doctorId: rq.doctorId, slotAt: rq.slotAt?.toISOString(), stage: rq.stage } };
    }, (st) => {
      const f = facts[48] as { doctorsOffered: string[]; times: { date: string; time: string }[]; visits?: { doctor_id?: number; date?: string; time_start?: string }[] };
      const all = st.map((x) => text(x)).join(' ');
      return [
        ...(f.doctorsOffered.length === 1 && f.doctorsOffered[0] === '#901' ? [] : [`S48: offered doctors ${f.doctorsOffered.join(',')}`]),
        ...(f.times.length && f.times.every((t) => t.date === tomorrow && t.time >= '16:00') ? [] : ['S48: an offered time outside "tomorrow after 16:00"']),
        ...(/лікар Мельник Олена\?/.test(all) ? [] : ['S48: the consent question does not name the doctor']),
        ...(MOCK_WRITES ? ((f.visits ?? []).length === 1 && f.visits![0].doctor_id === 901 && f.visits![0].date === tomorrow && (f.visits![0].time_start ?? '') >= '16:00' ? [] : [`S48: visits ${JSON.stringify(f.visits)}`]) : []),
        ...(MOCK_WRITES && !/Лікар: Мельник Олена/.test(all) ? ['S48: the confirmation does not name the doctor'] : []),
      ];
    });

    const d49 = await doctorsClinic();
    await scenario(49, 'Лікарі (ru): пов’язаний пацієнт — попередній лікар, відмова, будь-який лікар → один візит', () => d49 as typeof mainClinic, async (say, ctl) => {
      const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: d49.clinicId, removedAt: null } });
      await prisma.patientChannel.create({ data: { clinicId: d49.clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: ctl.chat } });
      await prisma.visit.create({ data: { clinicId: d49.clinicId, patientId: p.id, externalId: `h${rnd()}`, doctorId: '902', serviceName: 'Тестова консультація', startsAt: new Date(Date.now() - 90 * 86_400_000), status: 'VISITED' } });
      const w0 = mock.writes.length;
      await say('Здравствуйте, хочу записаться на консультацию');
      await say('Нет, спасибо, к другому врачу');
      const s3 = await say('Без разницы, к любому');
      facts[49] = { offered: await btnDoctors(d49.clinicId, ctl.chat) };
      if (!hasTimes(s3)) return;
      const chosen = (await btnDoctors(d49.clinicId, ctl.chat))[0];
      await ctl.tap(0);
      const rq0 = await prisma.bookingRequest.findFirst({ where: { clinicId: d49.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
      if (rq0?.stage === 'CONFIRM') await say('Да, подтверждаю');
      facts[49] = { ...facts[49], chosen, visits: visitsOf(w0).map((x) => (x as { body?: unknown }).body) };
    }, (st) => {
      const f = facts[49] as { offered: string[]; chosen?: string; visits?: { doctor_id?: number }[] };
      const all = st.map((x) => text(x)).join(' ');
      const names: Record<string, string> = { '#901': 'Мельник Олена', '#902': 'Бондар Ігор' };
      return [
        ...(/Ранее эту услугу .* Бондар Ігор\. Продолжим у этого врача\?/.test(text(st[0])) ? [] : ['S49: no continuation question for the previous doctor']),
        ...(f.offered.length >= 1 && f.offered.every((d) => d === '#901' || d === '#902') ? [] : [`S49: offered ${f.offered.join(',')}`]),
        ...(MOCK_WRITES ? ((f.visits ?? []).length === 1 && `#${f.visits![0].doctor_id}` === f.chosen ? [] : [`S49: visits ${JSON.stringify(f.visits)} chosen ${f.chosen}`]) : []),
        ...(MOCK_WRITES && f.chosen && !all.includes(`Врач: ${names[f.chosen]}`) ? ['S49: the confirmation does not name the booked doctor'] : []),
        // (the stored names of the doctors and the service are the clinic's own Ukrainian data)
        ...(/[іїєґ]/i.test(st.slice(0, 3).map((x) => text(x)).join(' ').replace(/Бондар Ігор|Мельник Олена|Тестова консультація/g, '')) ? ['S49: Ukrainian prose in the Russian conversation'] : []),
      ];
    });

    const d50 = await doctorsClinic();
    await scenario(50, 'Лікарі: у названого лікаря немає часу за побажанням у межах 7 днів → чесно, лікар той самий, згода на адміністратора → одна передача', () => d50 as typeof mainClinic, async (say, ctl) => {
      const w0 = mock.writes.length;
      await say('Запишіть мене, будь ласка, на консультацію до лікаря Мельник після 19:00');
      await say('Так, передайте адміністратору');
      await say('Дякую');
      const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: d50.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
      const handoffs = await prisma.bookingRequest.findMany({ where: { clinicId: d50.clinicId, chatId: ctl.chat, kind: 'HANDOFF' } });
      const state = await prisma.conversationState.findFirst({ where: { clinicId: d50.clinicId, chatId: ctl.chat } });
      facts[50] = { doctorId: rq?.doctorId ?? null, handoffs: handoffs.length, owner: state?.owner, visits: visitsOf(w0).length };
    }, (st) => {
      const f = facts[50] as { doctorId: string | null; handoffs: number; owner?: string; visits: number };
      return [
        ...(/На найближчі 7 днів вільних вікон після 19:00 не знайшлося/.test(text(st[0])) && !hasTimes(st[0]) ? [] : ['S50: no honest no-match answer']),
        ...(/Бондар/.test(text(st[0])) ? ['S50: another doctor was put forward'] : []),
        ...(f.doctorId === '901' ? [] : [`S50: the settled doctor was not kept (${f.doctorId})`]),
        ...(f.handoffs === 1 ? [] : [`S50: ${f.handoffs} hand-overs`]),
        ...(f.owner === 'HUMAN' ? [] : [`S50: owner ${f.owner}`]),
        ...(f.visits === 0 ? [] : ['S50: a visit was written']),
        ...(st[2]?.replies.length ? ['S50: the agent answered after the hand-over'] : []),
      ];
    });

    const d51 = await doctorsClinic();
    await scenario(51, 'Лікарі (ru): інший лікар після питання про згоду → контакти збережено, стара згода не діє, часи нового лікаря, один візит до нього', () => d51 as typeof mainClinic, async (say, ctl) => {
      const w0 = mock.writes.length;
      const s1 = await say('Хочу записаться на консультацию к врачу Мельник');
      if (!hasTimes(s1)) return;
      await ctl.tap(0);
      await say('Фамилия Петренко, имя Олег, телефон 0971112244');
      const before = await prisma.bookingRequest.findFirst({ where: { clinicId: d51.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
      const s4 = await say('Ой, лучше к доктору Бондарю, если можно');
      const offeredNew = await btnDoctors(d51.clinicId, ctl.chat);
      const mid = await prisma.bookingRequest.findFirst({ where: { clinicId: d51.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
      if (before?.consentKey) await ctl.confirmWith(before.id, before.consentKey);
      const afterOld = visitsOf(w0).length;
      if (hasTimes(s4)) {
        await ctl.tap(0);
        const rq = await prisma.bookingRequest.findFirst({ where: { clinicId: d51.clinicId, chatId: ctl.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
        if (rq?.stage === 'CONFIRM') await say('Да, всё верно');
      }
      facts[51] = { beforeStage: before?.stage, kept: mid && before ? [mid.lastName, mid.firstName, mid.phone].join('|') === [before.lastName, before.firstName, before.phone].join('|') : false, midConsent: mid?.consentKey ?? null, offeredNew, afterOld, visits: visitsOf(w0).map((x) => (x as { body?: unknown }).body) };
    }, (st) => {
      const f = facts[51] as { beforeStage?: string; kept: boolean; midConsent: string | null; offeredNew: string[]; afterOld: number; visits?: { doctor_id?: number }[] };
      const all = st.map((x) => text(x)).join(' ');
      return [
        ...(f.beforeStage === 'CONFIRM' ? [] : [`S51: the consent question was not reached (${f.beforeStage})`]),
        ...(f.kept ? [] : ['S51: the contacts were not kept']),
        ...(f.midConsent === null ? [] : ['S51: the old consent key survived the doctor change']),
        ...(f.offeredNew.length === 1 && f.offeredNew[0] === '#902' ? [] : [`S51: new offer doctors ${f.offeredNew.join(',')}`]),
        ...(f.afterOld === 0 ? [] : ['S51: the old confirmation created a visit']),
        ...(MOCK_WRITES ? ((f.visits ?? []).length === 1 && f.visits![0].doctor_id === 902 ? [] : [`S51: visits ${JSON.stringify(f.visits)}`]) : []),
        ...(/врач Бондар Ігор\?/.test(all) ? [] : ['S51: the new consent question does not name the new doctor']),
      ];
    });

    await prisma.kbItem.create({ data: { clinicId: mainClinic.clinicId, kind: 'DOCTOR', title: 'Коваль Ірина', text: 'терапевт (тестові дані)', active: true, approvedAt: new Date() } });
    await scenario(52, 'Кабінети: названий лікар → без гарантії, побажання адміністратору → одна передача з побажанням, далі тиша', main, async (say, ctl) => {
      await say('Добрий день, можна записатися на консультацію саме до лікарки Коваль?');
      await say('Тоді передайте, будь ласка, моє побажання адміністратору');
      await say('А скільки це триватиме?');
      const h = await prisma.bookingRequest.findMany({ where: { clinicId: mainClinic.clinicId, chatId: ctl.chat, kind: 'HANDOFF' } });
      const state = await prisma.conversationState.findFirst({ where: { clinicId: mainClinic.clinicId, chatId: ctl.chat } });
      facts[52] = { handoffs: h.map((x) => x.summary), owner: state?.owner, visits: await prisma.bookingRequest.count({ where: { clinicId: mainClinic.clinicId, chatId: ctl.chat, confirmedAt: { not: null } } }) };
    }, (st) => {
      const f = facts[52] as { handoffs: string[]; owner?: string; visits: number };
      return [
        ...(/не можемо обіцяти запис саме до нього/.test(text(st[0])) && !hasTimes(st[0]) ? [] : ['S52: the doctor was not said to be unguaranteed (or times were offered)']),
        ...(f.handoffs.length === 1 && /бажаний лікар: Коваль Ірина/.test(f.handoffs[0]) ? [] : [`S52: hand-overs ${JSON.stringify(f.handoffs)}`]),
        ...(f.owner === 'HUMAN' ? [] : [`S52: owner ${f.owner}`]),
        ...(f.visits === 0 ? [] : ['S52: a visit was confirmed']),
        ...(st[2]?.replies.length ? ['S52: the agent answered after the hand-over'] : []),
      ];
    });

    // ---- the report ----
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '../eval-output');
    fs.mkdirSync(dir, { recursive: true });
    const mode = PAID ? 'live' : 'dry';
    const md = [
      `# Funnel rules on the ${PAID ? `REAL model (${process.env.AI_MODEL})` : 'scripted stand-in (DRY: not a verification of the model)'} - ${stamp}`,
      `Calls ${budget.calls}, spent ${budget.spent.toFixed(5)} USD (at the prices given), stopped: ${budget.stopped ?? 'no'}. Mock writes seen: ${mock.writes.length}. Messages that would be sent: ${sent.length}.`,
      '',
      ...results.flatMap((r) => [`## ${r.id}. ${r.name} - ${r.verdict}`, ...(r.failures.length ? r.failures.map((x) => `- FAILED: ${x}`) : []), ...r.steps.flatMap((s) => [`- patient: ${s.patient}`, ...s.replies.map((x) => `  - agent: ${x.text.replace(/\n+/g, ' / ')}${x.buttons.length ? ` [${x.buttons.join(' | ')}]` : ''}`), `  - resolved language ${s.lang}; model told: ${s.asked.join(' | ') || '-'}`, `  - model calls ${s.calls}; drafts: ${s.drafts.join('; ') || '-'}; generations: ${s.gens.join('; ') || '-'}`, ...s.raw.map((x, i) => `  - raw model output ${i + 1}: ${x.replace(/\s+/g, ' ')}`)]), '']),
    ].join('\n');
    fs.writeFileSync(path.join(dir, `agent-funnel-${mode}-${stamp}.md`), md);
    fs.writeFileSync(path.join(dir, `agent-funnel-${mode}-${stamp}.json`), JSON.stringify({ mode, calls: budget.calls, spentUsd: budget.spent, results }, null, 2));
    process.stdout.write(`\nFUNNEL ${mode}: ${results.map((r) => `${r.id}:${r.verdict}`).join(' ')}\nFiles: eval-output/agent-funnel-${mode}-${stamp}.{md,json}\n`);
    // a write to the mock, a message outside the fake transport or an unlisted dialogue would make the run unsafe: it fails loudly
    // without AGENT_FUNNEL_MOCK_WRITES=1 no write is allowed at all; with it only the MOCK may have been written to (the base URL is the mock), and only visits of the two booking scenarios
    expect(mock.writes.filter((w) => w.method !== 'GET' && !MOCK_WRITES)).toEqual([]);
    expect(mock.writes.filter((w) => w.method !== 'GET' && /visit/i.test(JSON.stringify(w)) && !/patient/i.test(String((w as { path?: string }).path ?? ''))).length).toBeLessThanOrEqual(MOCK_WRITES ? 5 : 0);
    if (!PAID) expect(results.every((r) => r.verdict !== 'NOT_RUN')).toBe(true);
    expect(all(results.flatMap((r) => r.steps))).toBeDefined();
  });
});
