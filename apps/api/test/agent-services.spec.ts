import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bookingStatusOf } from '../src/ai/booking-status';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
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

// The autonomous agent books only the services of the clinic's explicit set (AgentAutoGate.autoServices, agent-administrator.md section 49): each with its own
// length, cabinets and consent; a service outside the set, or removed from it in the middle, goes to a person. Scripted model, fake transport, Cliniccards mock.
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
const posts = () => mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits');
const lastButtons = async (c: C) => {
  const m = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return (Array.isArray(m.buttons) ? m.buttons : []) as { label: string; payload: string }[];
};
const allow = (c: C) => {
  process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${c.chat}`].filter(Boolean).join(',');
};

const handoffs = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } });
const minutes = (w: { body: Record<string, unknown> }) => {
  const m = (t: unknown) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  return m(w.body.time_end) - m(w.body.time_start);
};
const lastSent = (c: C) => sendsTo(c)[sendsTo(c).length - 1];

// an autonomous clinic (cabinets) with three bookable services: the consultation (30 min, any cabinet), the treatment (60 min, cabinet 802 only) and the hygiene
// (30 min); the autonomous set holds the first two only
async function servicesClinic() {
  const c = await createAgentClinic({ http, prisma });
  await prisma.kbItem.update({ where: { id: c.filling.id }, data: { durationMin: 60 } });
  await http().put('/booking-settings/services').set(auth(c.token)).send({ services: [{ id: c.consult.id, onlineBooking: true, cabinetIds: [] }, { id: c.filling.id, onlineBooking: true, cabinetIds: ['802'] }, { id: c.hygiene.id, onlineBooking: true, cabinetIds: [] }] }).expect(200);
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: true, agentAutoServiceIds: [c.consult.id, c.filling.id], agentAutoServicesSet: true } });
  allow(c);
  const ref = { consult: await refOf(c, 'Тестова консультація'), filling: await refOf(c, 'Тестове лікування'), hygiene: await refOf(c, 'Тестова гігієна') };
  return { c, ref };
}
const offerOf = (s: string) => scriptedModel(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }));
async function bookThrough(c: C, ask: string) {
  await say(c, ask);
  const offer = lastSent(c);
  expect(offer.options.length).toBeGreaterThan(0);
  await tap(c, offer.options[0]);
  await say(c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
  await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
}

describe('автономний агент: явний набір послуг', () => {
  it('дві послуги з набору — кожна своїм шляхом: своя тривалість, свій кабінет, один візит', async () => {
    const a = await servicesClinic();
    offerOf(a.ref.consult);
    await bookThrough(a.c, 'Хочу записатися на консультацію');
    expect(posts()).toHaveLength(1);
    expect(minutes(posts()[0])).toBe(30);
    expect((await bookingReq(a.c))!).toMatchObject({ status: 'DONE', service: 'Тестова консультація' });
    const b = await servicesClinic();
    mock.writes.length = 0;
    offerOf(b.ref.filling);
    await bookThrough(b.c, 'Хочу записатися на лікування');
    expect(posts()).toHaveLength(1);
    expect(minutes(posts()[0])).toBe(60);
    expect(posts()[0].body).toMatchObject({ cabinet_id: 802 });
    expect((await bookingReq(b.c))!).toMatchObject({ status: 'DONE', service: 'Тестове лікування' });
  });

  it('третя послуга поза набором не записується автономно: часів немає, передача людині', async () => {
    const a = await servicesClinic();
    offerOf(a.ref.hygiene);
    await say(a.c, 'Хочу записатися на гігієну');
    expect(sendsTo(a.c).some((m) => m.options.length > 0)).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(await handoffs(a.c)).toBe(1);
  });

  it('зміна послуги після питання згоди потребує нової згоди: стара кнопка нічого не записує', async () => {
    const a = await servicesClinic();
    offerOf(a.ref.consult);
    await say(a.c, 'Хочу записатися на консультацію');
    await tap(a.c, lastSent(a.c).options[0]);
    await say(a.c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
    const oldYes = (await lastButtons(a.c)).find((x) => x.payload.startsWith('bookyes|'))!.payload; // the consent button of the consultation
    expect(lastSent(a.c).text).toMatch(/Тестова консультація/);
    // the patient changes the service: the treatment's own times, then its own consent question
    offerOf(a.ref.filling);
    await say(a.c, 'Ні, краще запишіть мене на лікування');
    const offer = lastSent(a.c);
    expect(offer.options.length).toBeGreaterThan(0);
    await tap(a.c, offer.options[0]);
    expect(lastSent(a.c).text).toMatch(/Тестове лікування/);
    const newYes = (await lastButtons(a.c)).find((x) => x.payload.startsWith('bookyes|'))!.payload;
    expect(newYes).not.toBe(oldYes);
    await say(a.c, 'Так, підтверджую', oldYes);
    expect(posts()).toHaveLength(0);
    await say(a.c, 'Так, підтверджую', newYes);
    expect(posts()).toHaveLength(1);
    expect(minutes(posts()[0])).toBe(60);
  });

  it('послугу прибрали з набору під час відповіді або перед дією: дія не виконується, передача людині', async () => {
    // before the action: times of the consultation were offered, then it is removed; the tapped time does not move on
    const a = await servicesClinic();
    offerOf(a.ref.consult);
    await say(a.c, 'Хочу записатися на консультацію');
    await prisma.clinic.update({ where: { id: a.c.clinicId }, data: { agentAutoServiceIds: [a.c.filling.id] } });
    const n = sendsTo(a.c).length;
    await tap(a.c, lastSent(a.c).options[0]);
    await say(a.c, `Прізвище Шевчук, ім’я Оксана, телефон ${phone()}`);
    expect(posts()).toHaveLength(0);
    expect(sendsTo(a.c).slice(n).some((m) => /Підтверджуєте/.test(m.text))).toBe(false);
    expect(await handoffs(a.c)).toBeGreaterThan(0);
    // during the answer: the set changes while the model writes; the times are not sent
    const b = await servicesClinic();
    offerOf(b.ref.consult);
    const gen = app.get(AgentDraftService);
    const original = gen.generate.bind(gen);
    const spy = jest.spyOn(gen, 'generate').mockImplementation(async (...args: Parameters<typeof gen.generate>) => {
      const d = await original(...args);
      await prisma.clinic.update({ where: { id: b.c.clinicId }, data: { agentAutoServiceIds: [b.c.filling.id] } });
      return d;
    });
    await say(b.c, 'Хочу записатися на консультацію');
    spy.mockRestore();
    expect(sendsTo(b.c).some((m) => m.options.length > 0)).toBe(false);
    expect(await handoffs(b.c)).toBe(1);
  });

  it('порожній набір вимикає автономність; список діалогів і запис у Cliniccards діють як раніше', async () => {
    const a = await servicesClinic();
    await prisma.clinic.update({ where: { id: a.c.clinicId }, data: { agentAutoServiceIds: [] } });
    offerOf(a.ref.consult);
    await say(a.c, 'Хочу записатися на консультацію');
    expect(sendsTo(a.c)).toHaveLength(0);
    // a dialog that is not on AGENT_AUTO_DIALOGS
    const b = await servicesClinic();
    delete process.env.AGENT_AUTO_DIALOGS;
    await say(b.c, 'Хочу записатися на консультацію');
    expect(sendsTo(b.c)).toHaveLength(0);
    // writing to Cliniccards off: the consent leads to no visit
    const d = await servicesClinic();
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { bookingWriteEnabled: false } });
    offerOf(d.ref.filling);
    await say(d.c, 'Хочу записатися на лікування');
    expect(posts()).toHaveLength(0);
  });
});
