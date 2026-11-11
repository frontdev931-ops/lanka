import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bookingStatusOf } from '../src/ai/booking-status';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AgentApprovalService } from '../src/automations/agent-approval.service';
import { SendError } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { clinicDate } from '../src/common/clinic-time';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// The agent cancels ONE future visit that THIS dialogue created (BookingRequest → externalVisitId), only after the patient's "yes" to the question about that
// visit, with a fresh reading of Cliniccards before the PUT. Everything else (several visits, changed visits, unknown results, disabled writing) becomes one
// cancellation request for the staff. Scripted model, fake transport, Cliniccards mock: nothing here proves the behaviour of the real Cliniccards API.
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let modelCalls = 0;
const fake = { configured: true, script: (() => '') as () => string, complete: async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 }) };
type Mode = 'ok' | 'fail';
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
    if (transport.mode === 'fail') throw new SendError('provider refused the message', false);
    transport.sent.push({ chatId, text, options: options.map((o) => ({ label: o.label, date: o.date, time: o.time })) });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
  delete process.env.AGENT_AUTO_DIALOGS;
  delete process.env.AUTOBOOKING_TEST_ONLY;
  delete process.env.AUTOBOOKING_TEST_DIALOGS;
});
beforeEach(() => {
  transport.mode = 'ok';
  transport.sent.length = 0;
  mock.writes.length = 0;
  mock.control.dropReplyAfterWrite = false;
  mock.control.failWith = undefined;
  modelCalls = 0;
  delete process.env.AGENT_AUTO_DIALOGS;
  delete process.env.AUTOBOOKING_TEST_ONLY;
  delete process.env.AUTOBOOKING_TEST_DIALOGS;
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
});

type C = AgentClinic;
const decision = (content: Record<string, unknown>, next: Record<string, unknown> = {}) =>
  JSON.stringify({ content: { kind: 'ANSWER', reply: 'Добрий день!', prices: [], after: '', ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });
const scriptedModel = (fn: () => string) => {
  fake.script = () => {
    modelCalls++;
    return fn();
  };
};
const refOf = async (c: C, title: string) => (await app.get(KbService).factsFor(c.clinicId, new Date(), '', '')).items.find((x) => x.title === title)!.ref;
let mid = 0;
const say = (c: C, text: string, payload?: string) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `x${++mid}${rnd()}`, text, payload });
const tap = (c: C, o: { date: string; time: string }) => say(c, `Обрав час: ${o.date.slice(8)}.${o.date.slice(5, 7)} ${o.time}`, `slot|${o.date}|${o.time}`);
const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const bookingReq = (c: C) => prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
const puts = () => mock.writes.filter((w) => w.method === 'PUT' && w.path === '/visits');
const posts = () => mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits');
const stateOf = (c: C) => prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } });
const cancelRequests = (c: C) => prisma.bookingRequest.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'CANCEL' } });
const lastButtons = async (c: C) => {
  const m = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return (Array.isArray(m.buttons) ? m.buttons : []) as { label: string; payload: string }[];
};
const yesOf = async (c: C) => (await lastButtons(c)).find((b) => b.payload.startsWith('cancelyes|'))!.payload;
const noOf = async (c: C) => (await lastButtons(c)).find((b) => b.payload.startsWith('cancelno|'))!.payload;
const allow = (c: C) => {
  process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${c.chat}`].filter(Boolean).join(',');
};

// an autonomous clinic where THIS dialogue booked one visit (the whole booking path of the agent: offer, time, data, consent, visit)
async function booked() {
  const c = await createAgentClinic({ http, prisma });
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: true, agentAutoServiceId: c.consult.id } });
  allow(c);
  const s = await refOf(c, 'Тестова консультація');
  scriptedModel(() => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s }));
  await say(c, 'Добрий день, хочу записатися на консультацію');
  await tap(c, sendsTo(c)[0].options[0]);
  await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
  await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
  const done = (await bookingReq(c))!;
  expect(done).toMatchObject({ status: 'DONE' });
  const visit = await prisma.visit.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: done.externalVisitId! } });
  const raw = () => mock.data.visits.find((v) => String(v.visit_id) === done.externalVisitId)!;
  mock.writes.length = 0;
  modelCalls = 0;
  return { c, s, done, visit, raw };
}
const when = (at: Date) => `${clinicDate(at).split('-').reverse().join('.')}`;

describe('агент скасовує запис, створений у цьому діалозі', () => {
  it('питання про конкретний запис → «так» цього питання → один PUT зі статусом CANCELLED → «скасовано» лише після успіху; статус агента — скасовано; повтор і старі кнопки нічого не пишуть; новий запис потім працює', async () => {
    const { c, s, done, visit, raw } = await booked();
    const n = sendsTo(c).length;
    await say(c, 'Скасуйте, будь ласка, мій запис');
    // the question names the visit and has its own buttons; nothing is written yet, no model call
    const q = sendsTo(c)[n];
    expect(q.text).toContain('Тестова консультація');
    expect(q.text).toContain(when(visit.startsAt));
    expect(q.text).toContain('Скасувати цей запис?');
    expect(q.options.map((o) => o.label)).toEqual(['Так, скасувати', 'Ні, залишити']);
    expect(puts()).toHaveLength(0);
    expect(modelCalls).toBe(0);
    // the old consent button of the BOOKING is not an answer to this question: the question is asked again, nothing is cancelled
    await say(c, 'Так, підтверджую', `bookyes|${done.id}`);
    expect(puts()).toHaveLength(0);
    expect(sendsTo(c)[n + 1].text).toContain('Скасувати цей запис?');
    const firstYes = (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT' }, orderBy: { createdAt: 'asc' } })).flatMap((m) => (Array.isArray(m.buttons) ? (m.buttons as { payload: string }[]) : [])).find((b) => b.payload.startsWith('cancelyes|'))!.payload;
    // a button of the earlier question (superseded by the repeated one): not valid, said so, nothing written
    await say(c, 'Так, скасувати', firstYes);
    expect(puts()).toHaveLength(0);
    expect(sendsTo(c)[n + 2].text).toContain('кнопка вже неактуальна');
    await say(c, 'Скасуйте запис');
    // the yes of the open question: the visit is cancelled, then told
    await say(c, 'Так, скасувати', await yesOf(c));
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toMatchObject({ status: 'CANCELLED', visit_id: Number(done.externalVisitId) });
    expect(raw().status).toBe('CANCELLED');
    // the fresh visit's other fields are kept (the note, the cabinet, the doctor, the time)
    expect(puts()[0].body).toMatchObject({ note: raw().note, cabinet_id: Number(raw().cabinet_id), doctor_id: Number(raw().doctor_id) });
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('CANCELLED');
    const told = sendsTo(c)[sendsTo(c).length - 1];
    expect(told.text).toMatch(/^Запис скасовано: Тестова консультація/);
    expect(modelCalls).toBe(0);
    // recorded with the existing mechanisms: the attempt, the audit, the request and its visit id untouched
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId, kind: 'CANCEL', status: 'DONE' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking.cancelled' } })).toBe(1);
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: done.id } })).externalVisitId).toBe(done.externalVisitId);
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toMatchObject({ kind: 'CANCELLED', service: 'Тестова консультація' });
    // a repeated yes (the same button again), a typed yes and an old booking button: nothing is written again; never "confirmed"
    const k = sendsTo(c).length;
    await say(c, 'Так, скасувати', firstYes);
    await say(c, 'так');
    await say(c, 'Так, підтверджую', `bookyes|${done.id}`);
    expect(puts()).toHaveLength(1);
    expect(posts()).toHaveLength(0);
    const after = sendsTo(c).slice(k).map((m) => m.text);
    expect(after.join(' ')).not.toMatch(/підтверджено/);
    expect(after[0]).toContain('Цей запис уже скасовано');
    expect(await cancelRequests(c)).toHaveLength(0);
    expect(await stateOf(c)).toMatchObject({ owner: 'BOT' });
    // the model, when it answers later, is told the booking is cancelled
    let system = '';
    fake.complete = (async (sys: string) => {
      system = sys;
      return { text: fake.script(), inputTokens: 1, outputTokens: 1 };
    }) as never;
    scriptedModel(() => decision({ reply: 'Консультація триває близько 30 хвилин.' }));
    await say(c, 'А скільки триває консультація?');
    expect(system).toContain('СКАСОВАНО');
    expect(system).not.toContain('запис УЖЕ створено системою й підтверджено: Тестова'); // (the rules mention the line; the state does not have it)
    fake.complete = async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 });
    // a new explicit booking works as usual: a new request, a new visit
    scriptedModel(() => decision({ reply: 'Дякуємо.' }, { action: 'OFFER_TIME', service: s }));
    await say(c, 'Хочу записатися знову на консультацію');
    const offer = sendsTo(c)[sendsTo(c).length - 1];
    expect(offer.options.length).toBeGreaterThan(0);
    await tap(c, offer.options[offer.options.length - 1]);
    const next = (await bookingReq(c))!;
    expect(next.id).not.toBe(done.id);
    if (next.stage === 'COLLECT') await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
    await say(c, 'Так, підтверджую', `bookyes|${next.id}`);
    expect(posts()).toHaveLength(1);
    expect((await bookingReq(c))!).toMatchObject({ status: 'DONE' });
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toMatchObject({ kind: 'CONFIRMED' });
  });

  it('пацієнт відмовляється: «ні, залишити» — запис без змін, без PUT; потім набране «так» нічого не скасовує', async () => {
    const { c, visit, raw } = await booked();
    await say(c, 'Хочу скасувати запис');
    await say(c, 'Ні, залишити', await noOf(c));
    expect(sendsTo(c)[sendsTo(c).length - 1].text).toMatch(/^Добре, запис залишається без змін: Тестова консультація/);
    await say(c, 'так');
    expect(puts()).toHaveLength(0);
    expect(raw().status).not.toBe('CANCELLED');
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('PLANNED');
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toMatchObject({ kind: 'CONFIRMED' });
  });

  it('лише текст (Instagram на комп’ютері): набране «Так, скасувати» скасовує; «Да, отменить» під українським питанням — теж; набране «так» — ні', async () => {
    const { c } = await booked();
    await say(c, 'Скасуйте мій запис');
    await say(c, 'так');
    expect(puts()).toHaveLength(0);
    await say(c, 'Так, скасувати'); // typed: no payload
    expect(puts()).toHaveLength(1);
    expect(sendsTo(c)[sendsTo(c).length - 1].text).toMatch(/^Запис скасовано/);
    const b = await booked();
    await say(b.c, 'Скасуйте мій запис');
    await say(b.c, 'Да, отменить'); // the button's words in the other language
    expect(puts()).toHaveLength(1); // (each booked() starts a fresh count of writes)
    expect(b.raw().status).toBe('CANCELLED');
    // the same words with no open question cancel nothing by themselves (they ask the question)
    const d = await booked();
    await say(d.c, 'Да, отменить');
    expect(puts()).toHaveLength(0);
    expect(sendsTo(d.c)[sendsTo(d.c).length - 1].text).toContain('Скасувати цей запис?'); // (the dialogue's language is Ukrainian)
  });

  it('одночасні «так»: один PUT, одна спроба', async () => {
    const { c } = await booked();
    await say(c, 'Скасуйте мій запис');
    const yes = await yesOf(c);
    await Promise.all([say(c, 'Так, скасувати', yes), say(c, 'Так, скасувати', yes), say(c, 'Так, скасувати', yes)]);
    expect(puts()).toHaveLength(1);
    expect(await prisma.bookingAttempt.count({ where: { clinicId: c.clinicId, kind: 'CANCEL' } })).toBe(1);
    expect(sendsTo(c).filter((m) => m.text.startsWith('Запис скасовано')).length).toBe(1);
  });

  it('кілька майбутніх записів цього діалогу: агент не обирає — одна заявка CANCEL з обома посиланнями, без питання й без PUT', async () => {
    const { c, done, visit } = await booked();
    const at = new Date(visit.startsAt.getTime() + 86_400_000);
    const other = await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: visit.patientId, externalId: `9${Date.now() % 1_000_000}`, doctorId: visit.doctorId, cabinetId: visit.cabinetId, startsAt: at, endsAt: new Date(at.getTime() + 1_800_000), status: 'PLANNED' } });
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'друга', status: 'DONE', confirmedAt: new Date(), confirmedStartsAt: at, confirmedService: 'Тестова консультація', externalVisitId: other.externalId } });
    const n = sendsTo(c).length;
    await say(c, 'Скасуйте запис');
    expect(puts()).toHaveLength(0);
    const reqs = await cancelRequests(c);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].summary).toContain(done.externalVisitId!);
    expect(reqs[0].summary).toContain(other.externalId);
    expect(reqs[0].summary).toContain('кілька');
    expect(sendsTo(c).slice(n).map((m) => m.text)).toEqual(['Передали ваш запит на скасування адміністратору. Поки він його не опрацює, запис не змінено.']);
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
  });

  it('візит змінили в Cliniccards (інший час) або він уже відбувся: PUT не надсилається, заявка CANCEL із причиною, пацієнту — що запис не змінено', async () => {
    for (const change of ['moved', 'visited'] as const) {
      const { c, raw } = await booked();
      await say(c, 'Скасуйте запис');
      const yes = await yesOf(c);
      if (change === 'moved') {
        raw().visit_start = String(raw().visit_start).replace(/ (\d{2}):/, (_m, h: string) => ` ${String((Number(h) + 1) % 24).padStart(2, '0')}:`);
      } else raw().status = 'VISITED';
      await say(c, 'Так, скасувати', yes);
      expect(puts()).toHaveLength(0);
      const reqs = await cancelRequests(c);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].summary).toContain('візит змінено або не знайдено в Cliniccards');
      expect(sendsTo(c)[sendsTo(c).length - 1].text).toContain('запис не змінено');
      expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
      mock.writes.length = 0;
    }
  });

  it('уже скасований у Cliniccards (наша копія ще ні): розпізнано без PUT, записано в нашій копії', async () => {
    const { c, visit, raw } = await booked();
    await say(c, 'Скасуйте запис');
    raw().status = 'CANCELLED';
    await say(c, 'Так, скасувати', await yesOf(c));
    expect(puts()).toHaveLength(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('CANCELLED');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking.cancel_seen' } })).toBe(1);
    expect(sendsTo(c)[sendsTo(c).length - 1].text).toMatch(/^Запис скасовано/);
  });

  it('відповідь Cliniccards втрачено: результат НЕВІДОМИЙ — ні «скасовано», ні «чинний»; одна заявка CANCEL; повтору немає; звірка персоналом без другого PUT', async () => {
    const { c, visit } = await booked();
    await say(c, 'Скасуйте запис');
    const n = sendsTo(c).length;
    const yes = await yesOf(c);
    mock.control.dropReplyAfterWrite = true;
    await say(c, 'Так, скасувати', yes);
    mock.control.dropReplyAfterWrite = false;
    expect(puts()).toHaveLength(1);
    expect(sendsTo(c).length).toBe(n); // nothing is said either way
    expect(await prisma.agentDraft.count({ where: { clinicId: c.clinicId, choice: 'CANCEL_VISIT', status: 'UNKNOWN' } })).toBe(1);
    const reqs = await cancelRequests(c);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].summary).toContain('результат скасування невідомий');
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toEqual({ kind: 'UNKNOWN', cancel: true });
    // a repeated tap does nothing (the dialogue is a person's, the action is unfinished)
    await say(c, 'Так, скасувати', yes);
    expect(puts()).toHaveLength(1);
    expect(await cancelRequests(c)).toHaveLength(1);
    // the staff member's cancel reconciles first: the visit IS cancelled in Cliniccards, so nothing is written again
    await http().post(`/bookings/visits/${visit.id}/cancel`).set(auth(c.token)).expect(200);
    expect(puts()).toHaveLength(1);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('CANCELLED');
  });

  it('скасовано, але повідомлення не надіслано: Cliniccards не змінюється вдруге; персонал отримує заявку «скасовано, повідомте пацієнта»', async () => {
    const { c, raw } = await booked();
    await say(c, 'Скасуйте запис');
    const yes = await yesOf(c);
    transport.mode = 'fail';
    await say(c, 'Так, скасувати', yes);
    transport.mode = 'ok';
    expect(puts()).toHaveLength(1);
    expect(raw().status).toBe('CANCELLED');
    const reqs = await cancelRequests(c);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].summary).toContain('СКАСОВАНО в Cliniccards, але повідомлення пацієнту не надіслано');
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
    await say(c, 'Так, скасувати', yes);
    expect(puts()).toHaveLength(1);
  });

  it('запис у Cliniccards вимкнено (прапорець клініки, обмеження живого тесту, вимкнено між питанням і «так»): нічого не пишеться, заявка CANCEL', async () => {
    // the clinic's flag off: no question at all
    const a = await booked();
    await prisma.clinic.update({ where: { id: a.c.clinicId }, data: { bookingWriteEnabled: false } });
    await say(a.c, 'Скасуйте запис');
    expect(sendsTo(a.c)[sendsTo(a.c).length - 1].options).toEqual([]);
    expect((await cancelRequests(a.c))[0].summary).toContain('запис у Cliniccards вимкнено');
    // the live-test restriction with this dialog not on the list
    const b = await booked();
    process.env.AUTOBOOKING_TEST_ONLY = 'true';
    process.env.AUTOBOOKING_TEST_DIALOGS = '';
    await say(b.c, 'Скасуйте запис');
    expect(await cancelRequests(b.c)).toHaveLength(1);
    delete process.env.AUTOBOOKING_TEST_ONLY;
    // switched off after the question: the yes writes nothing
    const d = await booked();
    await say(d.c, 'Скасуйте запис');
    const yes = await yesOf(d.c);
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { bookingWriteEnabled: false } });
    await say(d.c, 'Так, скасувати', yes);
    expect(await cancelRequests(d.c)).toHaveLength(1);
    expect(puts()).toHaveLength(0);
    expect(d.raw().status).not.toBe('CANCELLED');
  });

  it('ізоляція клінік і жодних побічних дій від чернетки: кнопка чужої клініки не діє; чернетка персоналу нічого не змінює, а передача — заявка CANCEL з посиланням', async () => {
    const a = await booked();
    await say(a.c, 'Скасуйте запис');
    const yesA = await yesOf(a.c);
    const b = await booked();
    await say(b.c, 'Так, скасувати', yesA);
    expect(puts()).toHaveLength(0);
    expect(sendsTo(b.c)[sendsTo(b.c).length - 1].text).toContain('кнопка вже неактуальна');
    expect(a.raw().status).not.toBe('CANCELLED');
    // the approval mode (no autonomy): making a draft writes nothing and makes no request
    const m = await booked();
    await prisma.clinic.update({ where: { id: m.c.clinicId }, data: { aiAgentAuto: false } });
    scriptedModel(() => decision({ reply: 'Передамо адміністратору.' }, { action: 'HAND_OFF', reason: 'needs_clarification' }));
    await say(m.c, 'Скасуйте, будь ласка, мій запис');
    const before = await prisma.bookingRequest.count({ where: { clinicId: m.c.clinicId } });
    const draft = (await http().post(`/conversations/INSTAGRAM/${m.c.chat}/draft`).set(auth(m.c.token)).expect(200)).body as { id: string; revision: number };
    expect(await prisma.bookingRequest.count({ where: { clinicId: m.c.clinicId } })).toBe(before);
    expect(puts()).toHaveLength(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: m.visit.id } })).status).toBe('PLANNED');
    // the staff member approves the hand-over: a CANCEL request with the visit's reference (the visit itself is not touched)
    await http().post(`/agent-drafts/${draft.id}/approve`).set(auth(m.c.token)).send({ revision: draft.revision, choice: 'HAND_OFF' }).expect(200);
    const reqs = await cancelRequests(m.c);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].summary).toContain(m.done.externalVisitId!);
    expect(puts()).toHaveLength(0);
    // a cancellation step is never approved by a staff member through the draft screen
    const other = await prisma.agentDraft.findFirst({ where: { clinicId: a.c.clinicId, choice: 'ASK_CANCEL' } });
    await http().post(`/agent-drafts/${other!.id}/approve`).set(auth(m.c.token)).send({ revision: other!.revision, choice: 'CANCEL_VISIT' }).expect(404);
    const approval = app.get(AgentApprovalService);
    const [target] = await approval.cancelTargets(m.c.clinicId, 'INSTAGRAM', m.c.chat);
    const q = await approval.stageCancelQuestion(m.c.clinicId, 'INSTAGRAM', m.c.chat, target, 'uk');
    expect((await http().post(`/agent-drafts/${q.id}/approve`).set(auth(m.c.token)).send({ revision: q.revision, choice: 'ASK_CANCEL' }).expect(200)).body).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(puts()).toHaveLength(0);
  });
});
