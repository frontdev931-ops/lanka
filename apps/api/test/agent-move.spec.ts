import { BookingService } from '../src/booking/booking.service';
import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bookingStatusOf } from '../src/ai/booking-status';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { SendError } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { clinicDate, clinicHm, localToUtc } from '../src/common/clinic-time';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// The agent MOVES one future visit that THIS dialogue created to another time: the same visit (one PUT of the same visit_id), patient, service, doctor and
// length, only after the patient's "yes" to the confirmation "now → new time", with fresh checks before the PUT. Everything else becomes one reschedule request
// for the staff. Scripted model, fake transport, Cliniccards mock: nothing here proves the behaviour of the real Cliniccards API.
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
// the owner's rule for the agent's move (2026-11-16): a NEW visit (POST), then the old one cancelled (PUT with status CANCELLED); a PUT of a new time is
// the staff action only
const cancels = () => puts().filter((w) => (w.body as { status?: string }).status === 'CANCELLED');
const timePuts = () => puts().filter((w) => (w.body as { status?: string }).status !== 'CANCELLED');
const stateOf = (c: C) => prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } });
const lastButtons = async (c: C) => {
  const m = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return (Array.isArray(m.buttons) ? m.buttons : []) as { label: string; payload: string }[];
};
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

const reqs = (c: C) => prisma.bookingRequest.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'RESCHEDULE' } });
const buttonOf = async (c: C, prefix: string, i = 0) => (await lastButtons(c)).filter((b) => b.payload.startsWith(prefix))[i];
const lastText = (c: C) => sendsTo(c)[sendsTo(c).length - 1].text;
// the time of a moveslot button
const slotOf = (p: string) => ({ date: p.split('|')[2], time: p.split('|')[3] });

// up to the confirmation: "move my visit" → "which day?" → "any day" → a time of the offer → "now → new time?"
async function toConfirm(c: C) {
  await say(c, 'Можна перенести мій запис на інший день?');
  expect(lastText(c)).toContain('На який день і час вам зручно його перенести?');
  await say(c, 'У будь-який день');
  const slot = await buttonOf(c, 'moveslot|');
  expect(slot).toBeTruthy();
  await say(c, slot.label, slot.payload);
  expect(lastText(c)).toContain('Перенести запис?');
  return slotOf(slot.payload);
}

describe('агент переносить запис, створений у цьому діалозі', () => {
  it('кабінети: спершу новий візит, потім скасування старого; заявка й наступні відповіді — з новим часом; аудит зі старим і новим часом', async () => {
    const { c, done, visit, raw } = await booked();
    const to = await toConfirm(c);
    const conf = lastText(c);
    expect(conf).toContain(`Зараз: Тестова консультація, ${when(visit.startsAt)}`);
    expect(conf).toContain(`Новий час: Тестова консультація, ${to.date.split('-').reverse().join('.')} о ${to.time}`);
    expect((await lastButtons(c)).map((b) => b.label)).toEqual(['Так, перенести', 'Ні, залишити як є']);
    expect(puts()).toHaveLength(0);
    expect(modelCalls).toBe(0);
    await say(c, 'Так, перенести', (await buttonOf(c, 'moveyes|')).payload);
    // the new visit first (the same doctor), then the old one cancelled; no PUT of a new time
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ date: to.date, time_start: to.time, doctor_id: Number(raw().doctor_id) });
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0].body).toMatchObject({ visit_id: Number(done.externalVisitId), status: 'CANCELLED' });
    expect(mock.writes.indexOf(posts()[0])).toBeLessThan(mock.writes.indexOf(cancels()[0]));
    expect(timePuts()).toHaveLength(0);
    expect(raw().status).toBe('CANCELLED');
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('CANCELLED');
    // the dialogue's booking now names the new visit, at the new time, with the same length
    const req = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: done.id } });
    expect(req.externalVisitId).not.toBe(done.externalVisitId);
    const moved = await prisma.visit.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: req.externalVisitId! } });
    expect(clinicDate(moved.startsAt)).toBe(to.date);
    expect(moved.endsAt!.getTime() - moved.startsAt.getTime()).toBe(visit.endsAt!.getTime() - visit.startsAt.getTime());
    expect(req.confirmedStartsAt!.getTime()).toBe(moved.startsAt.getTime());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'booking.rescheduled' } });
    expect(audit.details).toMatchObject({ visit: done.externalVisitId, newVisit: req.externalVisitId, from: visit.startsAt.toISOString(), to: moved.startsAt.toISOString(), by: 'agent', oldCancelled: true });
    expect(lastText(c)).toMatch(/^Запис перенесено: Тестова консультація/);
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toMatchObject({ kind: 'CONFIRMED', time: to.time });
    // the model's next answer is told the NEW time
    let system = '';
    fake.complete = (async (sys: string) => {
      system = sys;
      return { text: fake.script(), inputTokens: 1, outputTokens: 1 };
    }) as never;
    scriptedModel(() => decision({ reply: 'Консультація триває близько 30 хвилин.' }));
    await say(c, 'А скільки триває консультація?');
    expect(system).toContain(`${to.date.split('-').reverse().join('.')} о ${to.time}`);
    fake.complete = async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 });
    // a repeated yes (the old button) writes nothing
    const k = mock.writes.length;
    await say(c, 'Так, перенести', `moveyes|${(await prisma.agentDraft.findFirstOrThrow({ where: { clinicId: c.clinicId, choice: 'ASK_MOVE' } })).id}`);
    expect(mock.writes).toHaveLength(k);
    expect(lastText(c)).toContain('кнопка вже неактуальна');
  });

  it('пацієнт відмовляється: запис без змін', async () => {
    const { c, visit, raw } = await booked();
    await toConfirm(c);
    await say(c, 'Ні, залишити як є', (await buttonOf(c, 'moveno|')).payload);
    expect(lastText(c)).toMatch(/^Добре, запис залишається без змін/);
    expect(puts()).toHaveLength(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).startsAt.getTime()).toBe(visit.startsAt.getTime());
    expect(String(raw().visit_start)).not.toBe('');
  });

  it('новий час тим часом зайняли: оригінал без змін, пропонуються інші часи', async () => {
    const { c, visit, raw } = await booked();
    const to = await toConfirm(c);
    const yes = (await buttonOf(c, 'moveyes|')).payload;
    // both cabinets taken at the new time by other patients
    for (const cab of ['801', '802']) mock.data.visits.push({ ...raw(), visit_id: String(900000 + Math.floor(Math.random() * 99999)), patient_id: String(Number(raw().patient_id) === 1 ? 2 : 1), cabinet_id: cab, status: 'PLANNED', visit_start: `${to.date} ${to.time}:00`, visit_end: `${to.date} ${String(Number(to.time.slice(0, 2)) + 1).padStart(2, '0')}:${to.time.slice(3)}:00` });
    await say(c, 'Так, перенести', yes);
    expect(puts()).toHaveLength(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).startsAt.getTime()).toBe(visit.startsAt.getTime());
    expect(lastText(c)).toContain('цей час уже недоступний');
    expect((await lastButtons(c)).every((b) => b.payload.startsWith('moveslot|') && b.payload !== `moveslot|x|${to.date}|${to.time}`)).toBe(true);
  });

  it('оригінальний візит змінили в Cliniccards: нічого не створюється й не скасовується, заявка на перенесення з причиною', async () => {
    const { c, raw } = await booked();
    await toConfirm(c);
    const yes = (await buttonOf(c, 'moveyes|')).payload;
    raw().visit_start = String(raw().visit_start).replace(/ (\d{2}):/, (_m, h: string) => ` ${String((Number(h) + 1) % 24).padStart(2, '0')}:`);
    await say(c, 'Так, перенести', yes);
    expect(posts()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    const r = await reqs(c);
    expect(r).toHaveLength(1);
    expect(r[0].summary).toContain('візит змінено або не знайдено в Cliniccards');
    expect(lastText(c)).toContain('запис не змінено');
    expect(await stateOf(c)).toMatchObject({ owner: 'HUMAN' });
  });

  it('повторні й застарілі підтвердження: одночасні «так» — один новий візит і одне скасування; стара кнопка пропозиції, стара кнопка запису й кнопка скасування нічого не переносять', async () => {
    const { c, done } = await booked();
    await toConfirm(c);
    const oldSlot = (await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, direction: 'OUT' }, orderBy: { createdAt: 'asc' } })).flatMap((m) => (Array.isArray(m.buttons) ? (m.buttons as { label: string; payload: string }[]) : [])).find((b) => b.payload.startsWith('moveslot|'))!;
    await say(c, oldSlot.label, oldSlot.payload); // the offer is no longer the open question
    expect(lastText(c)).toContain('кнопка вже неактуальна');
    await say(c, 'Так, підтверджую', `bookyes|${done.id}`); // the booking's old consent (nothing is open now): the booking as it stands, nothing moved
    expect(lastText(c)).toContain('Ваш запис уже підтверджено');
    await say(c, 'Так, скасувати', 'cancelyes|abcdefghijklmnop'); // a cancellation button: not this question
    expect(lastText(c)).toContain('кнопка вже неактуальна');
    const before = posts().length;
    expect(puts()).toHaveLength(0);
    scriptedModel(() => decision({ reply: 'Консультація триває близько 30 хвилин.' }));
    await say(c, 'А скільки триває консультація?'); // something else while nothing is open: the model answers, nothing moves
    expect(puts()).toHaveLength(0);
    expect(posts()).toHaveLength(before);
    // a new confirmation, then three simultaneous yes
    const to = await toConfirm(c);
    const yes = (await buttonOf(c, 'moveyes|')).payload;
    await Promise.all([say(c, 'Так, перенести', yes), say(c, 'Так, перенести', yes), say(c, 'Так, перенести', yes)]);
    expect(posts()).toHaveLength(before + 1);
    expect(posts()[posts().length - 1].body).toMatchObject({ date: to.date, time_start: to.time });
    expect(cancels()).toHaveLength(1);
    expect(sendsTo(c).filter((m) => m.text.startsWith('Запис перенесено')).length).toBe(1);
  });

  it('відповідь Cliniccards втрачено при створенні нового візиту: НЕВІДОМО — старий не скасовано, жоден час не підтверджено, одна заявка, повтору немає; звірка без другого створення', async () => {
    const { c, visit } = await booked();
    const to = await toConfirm(c);
    const yes = (await buttonOf(c, 'moveyes|')).payload;
    const n = sendsTo(c).length;
    mock.control.dropReplyAfterWrite = true;
    await say(c, 'Так, перенести', yes);
    mock.control.dropReplyAfterWrite = false;
    // the new visit was sent, its answer lost: the old one is NOT cancelled, nothing is claimed
    expect(posts()).toHaveLength(1);
    expect(puts()).toHaveLength(0);
    expect(sendsTo(c).length).toBe(n);
    const r = await reqs(c);
    expect(r).toHaveLength(1);
    expect(r[0].summary).toContain('результат перенесення невідомий');
    expect(await bookingStatusOf(prisma, c.clinicId, 'INSTAGRAM', c.chat)).toEqual({ kind: 'UNKNOWN', move: true });
    const old = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(old.startsAt.getTime()).toBe(visit.startsAt.getTime());
    expect(old.status).not.toBe('CANCELLED');
    await say(c, 'Так, перенести', yes);
    expect(posts()).toHaveLength(1);
    // the same operation tried again reconciles first: the visit created at the new time IS found, nothing is created a second time
    const ask = await prisma.agentDraft.findFirstOrThrow({ where: { clinicId: c.clinicId, choice: 'ASK_MOVE' }, orderBy: { createdAt: 'desc' } });
    const step = (await prisma.agentDraft.findFirstOrThrow({ where: { clinicId: c.clinicId, choice: 'MOVE_VISIT' } })).snapshot as { step: { to: { cabinetId: string; startsAt: string } } };
    const again = await app.get(BookingService).book(c.clinicId, null, { patientId: old.patientId, startsAt: new Date(step.step.to.startsAt), durationMin: Math.round((old.endsAt!.getTime() - old.startsAt.getTime()) / 60_000), cabinetId: step.step.to.cabinetId, doctorId: old.doctorId!, operationId: `rebook:${ask.id}` });
    expect(again.externalVisitId).toBeTruthy();
    expect(posts()).toHaveLength(1);
    expect(clinicDate(new Date(step.step.to.startsAt))).toBe(to.date);
  });

  it('перенесено, але повідомлення не надіслано: Cliniccards не змінюється вдруге; заявка «перенесено, повідомте пацієнта»', async () => {
    const { c } = await booked();
    await toConfirm(c);
    const yes = (await buttonOf(c, 'moveyes|')).payload;
    transport.mode = 'fail';
    await say(c, 'Так, перенести', yes);
    transport.mode = 'ok';
    expect(puts()).toHaveLength(1);
    const r = await reqs(c);
    expect(r).toHaveLength(1);
    expect(r[0].summary).toContain('ПЕРЕНЕСЕНО в Cliniccards, але повідомлення пацієнту не надіслано');
    await say(c, 'Так, перенести', yes);
    expect(puts()).toHaveLength(1);
  });

  it('лише текст (без кнопок): набраний час із пропозиції, набране «Так, перенести»; підтвердження іншою мовою; набране «так» нічого не переносить', async () => {
    const { c } = await booked();
    await say(c, 'Перенесіть, будь ласка, мій запис');
    await say(c, 'будь-який день');
    const slot = await buttonOf(c, 'moveslot|');
    await say(c, slot.label); // typed, no payload
    expect(lastText(c)).toContain('Перенести запис?');
    await say(c, 'так'); // a bare yes: the confirmation again
    expect(lastText(c)).toContain('Щоб перенести запис, оберіть, будь ласка, відповідь кнопкою.');
    expect(posts()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    await say(c, 'Да, перенести'); // the button's words in the other language
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject(slotBody(slotOf(slot.payload)));
    expect(cancels()).toHaveLength(1);
    expect(lastText(c)).toMatch(/^Запис перенесено/);
  });

  it('лікар у побажанні інший — завдання персоналу; кілька записів — завдання персоналу; без побажання — питання про день', async () => {
    const a = await booked();
    await prisma.doctor.upsert({ where: { clinicId_externalId: { clinicId: a.c.clinicId, externalId: '902' } }, create: { clinicId: a.c.clinicId, externalId: '902', lastName: 'Бондар', firstName: 'Ігор', serviceIds: [a.c.consult.id] }, update: {} });
    await say(a.c, 'Перенесіть мій запис до лікаря Бондар');
    expect((await reqs(a.c))[0].summary).toContain('іншого лікаря');
    expect(puts()).toHaveLength(0);
    const b = await booked();
    const at = new Date(b.visit.startsAt.getTime() + 86_400_000);
    const other = await prisma.visit.create({ data: { clinicId: b.c.clinicId, patientId: b.visit.patientId, externalId: `8${Date.now() % 1_000_000}`, doctorId: b.visit.doctorId, cabinetId: b.visit.cabinetId, startsAt: at, endsAt: new Date(at.getTime() + 1_800_000), status: 'PLANNED' } });
    await prisma.bookingRequest.create({ data: { clinicId: b.c.clinicId, channel: 'INSTAGRAM', chatId: b.c.chat, kind: 'BOOKING', summary: 'друга', status: 'DONE', confirmedAt: new Date(), confirmedStartsAt: at, confirmedService: 'Тестова консультація', externalVisitId: other.externalId } });
    await say(b.c, 'Перенесіть запис');
    expect((await reqs(b.c))[0].summary).toContain('кілька');
    expect(puts()).toHaveLength(0);
  });

  it('режим лікарів: часи лише того самого лікаря; підтвердження з лікарем; новий візит з тим самим doctor_id, старий скасовано', async () => {
    const c = await createAgentClinic({ http, prisma });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: true, agentAutoServiceId: c.consult.id, scheduleMode: 'DOCTORS' } });
    allow(c);
    for (const [id, last, first, cab] of [['901', 'Мельник', 'Олена', '801'], ['902', 'Бондар', 'Ігор', '802']]) {
      await prisma.doctor.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: id } }, create: { clinicId: c.clinicId, externalId: id, lastName: last, firstName: first, serviceIds: [c.consult.id] }, update: { lastName: last, firstName: first, serviceIds: [c.consult.id], active: true } });
      await prisma.doctorAvailability.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinicId: c.clinicId, doctorId: id, weekday, fromHm: '10:00', toHm: '17:00', cabinetId: cab })) });
    }
    const s = await refOf(c, 'Тестова консультація');
    scriptedModel(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }));
    await say(c, 'Хочу записатися на консультацію до лікаря Мельник');
    const first = (await lastButtons(c))[0];
    await say(c, first.label, first.payload);
    await say(c, `Прізвище Петренко, ім’я Олег, телефон ${phone()}`);
    await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
    const done = (await bookingReq(c))!;
    expect(done).toMatchObject({ status: 'DONE', doctorId: '901' });
    mock.writes.length = 0;
    await say(c, 'Перенесіть мій запис');
    await say(c, 'будь-який день');
    const offer = (await lastButtons(c)).filter((b) => b.payload.startsWith('moveslot|'));
    expect(offer.length).toBeGreaterThan(0);
    await say(c, offer[0].label, offer[0].payload);
    expect(lastText(c)).toMatch(/Зараз: Тестова консультація, лікар Мельник Олена/);
    expect(lastText(c)).toMatch(/Новий час: Тестова консультація, лікар Мельник Олена/);
    await say(c, 'Так, перенести', (await buttonOf(c, 'moveyes|')).payload);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ doctor_id: 901, cabinet_id: 801, ...slotBody(slotOf(offer[0].payload)) });
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0].body).toMatchObject({ visit_id: Number(done.externalVisitId) });
    expect(timePuts()).toHaveLength(0);
  });

  it('чернетка персоналу нічого не змінює; ізоляція: кнопка іншої клініки не діє', async () => {
    const a = await booked();
    await toConfirm(a.c);
    const yesA = (await buttonOf(a.c, 'moveyes|')).payload;
    const b = await booked();
    await say(b.c, 'Так, перенести', yesA);
    expect(lastText(b.c)).toContain('кнопка вже неактуальна');
    expect(puts()).toHaveLength(0);
    const m = await booked();
    await prisma.clinic.update({ where: { id: m.c.clinicId }, data: { aiAgentAuto: false } });
    scriptedModel(() => decision({ reply: 'Передамо адміністратору.' }, { action: 'HAND_OFF', reason: 'needs_clarification' }));
    await say(m.c, 'Перенесіть мій запис на завтра');
    const before = await prisma.bookingRequest.count({ where: { clinicId: m.c.clinicId } });
    await http().post(`/conversations/INSTAGRAM/${m.c.chat}/draft`).set(auth(m.c.token)).expect(200);
    expect(await prisma.bookingRequest.count({ where: { clinicId: m.c.clinicId } })).toBe(before);
    expect(puts()).toHaveLength(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: m.visit.id } })).startsAt.getTime()).toBe(m.visit.startsAt.getTime());
  });
});

describe('ідентичність операції перенесення й нагадування після нього', () => {
  const moveTo = (c: C, visitId: string, at: Date, cabinetId?: string) => http().post(`/bookings/visits/${visitId}/reschedule`).set(auth(c.token)).send({ startsAt: at.toISOString(), ...(cabinetId ? { cabinetId } : {}) });
  const audits = (c: C) => prisma.auditLog.findMany({ where: { clinicId: c.clinicId, action: 'booking.rescheduled' }, orderBy: { createdAt: 'asc' } });

  it('персонал: A→B→A→B — три справжні перенесення (три PUT), візит на B; кожен запис аудиту прив’язаний до своєї спроби', async () => {
    const { c, visit, raw } = await booked();
    const A = visit.startsAt;
    const B = new Date(A.getTime() + 2 * 3_600_000);
    await moveTo(c, visit.id, B).expect(200);
    await moveTo(c, visit.id, A).expect(200);
    await moveTo(c, visit.id, B).expect(200);
    expect(puts()).toHaveLength(3);
    expect(String(raw().visit_start)).toBe(`${clinicDate(B)} ${clinicHm(B)}:00`);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).startsAt.getTime()).toBe(B.getTime());
    const a = await audits(c);
    expect(a.map((x) => (x.details as { to: string }).to)).toEqual([B, A, B].map((d) => d.toISOString()));
    const attempts = await prisma.bookingAttempt.findMany({ where: { clinicId: c.clinicId, kind: 'RESCHEDULE', status: 'DONE' } });
    expect(attempts).toHaveLength(3);
    expect(new Set(a.map((x) => (x.details as { attempt: string }).attempt))).toEqual(new Set(attempts.map((x) => x.id)));
    // a repeated click after the move: nothing to move, nothing written
    await moveTo(c, visit.id, B).expect(200);
    expect(puts()).toHaveLength(3);
  });

  it('агент: A→B→A→B — три підтвердження, три нові візити й три скасування, діючий візит на B; операція = підтвердження пацієнта', async () => {
    const { c, visit, raw } = await booked();
    const pick = async (want?: { date: string; time: string }) => {
      await say(c, 'Перенесіть мій запис');
      await say(c, 'будь-який день');
      const slots = (await lastButtons(c)).filter((b) => b.payload.startsWith('moveslot|'));
      const b = want ? slots.find((x) => x.payload.endsWith(`|${want.date}|${want.time}`)) : slots[0];
      expect(b).toBeTruthy();
      await say(c, b!.label, b!.payload);
      await say(c, 'Так, перенести', (await buttonOf(c, 'moveyes|')).payload);
      return slotOf(b!.payload);
    };
    const A = { date: clinicDate(visit.startsAt), time: clinicHm(visit.startsAt) };
    const B = await pick();
    await pick(A);
    await pick(B);
    // back to the original time A is a NEW visit too (each confirmation is its own operation, never answered by the original booking)
    expect(posts()).toHaveLength(3);
    expect(cancels()).toHaveLength(3);
    expect(raw().status).toBe('CANCELLED');
    const live = mock.data.visits.filter((v) => String(v.patient_id) === String(raw().patient_id) && v.status !== 'CANCELLED');
    expect(live.map((v) => String(v.visit_start))).toEqual([`${B.date} ${B.time}:00`]);
    const a = await audits(c);
    expect(a).toHaveLength(3);
    const ops = a.map((x) => (x.details as { operation?: string }).operation);
    expect(new Set(ops).size).toBe(3);
    const asks = await prisma.agentDraft.findMany({ where: { clinicId: c.clinicId, choice: 'ASK_MOVE' }, select: { id: true } });
    expect(ops.every((o) => asks.some((x) => x.id === o))).toBe(true);
  });

  it('невідомий результат: дві одночасні звірки — один зарахований успіх, один запис аудиту, без другого PUT', async () => {
    const { c, visit } = await booked();
    const B = new Date(visit.startsAt.getTime() + 2 * 3_600_000);
    mock.control.dropReplyAfterWrite = true;
    await moveTo(c, visit.id, B).expect(409);
    mock.control.dropReplyAfterWrite = false;
    expect(puts()).toHaveLength(1);
    expect(await audits(c)).toHaveLength(0);
    const [r1, r2] = await Promise.all([moveTo(c, visit.id, B), moveTo(c, visit.id, B)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    expect(puts()).toHaveLength(1);
    const a = await audits(c);
    expect(a).toHaveLength(1);
    const attempt = await prisma.bookingAttempt.findFirstOrThrow({ where: { clinicId: c.clinicId, kind: 'RESCHEDULE' } });
    expect(attempt.status).toBe('DONE');
    expect((a[0].details as { attempt: string }).attempt).toBe(attempt.id);
  });

  it('перенесення через LANKA знімає напоминання про старий час; новий час, отриманий синхронізацією, теж', async () => {
    const { c, visit, raw } = await booked();
    const reminder = (v: { id: string; startsAt: Date }) => prisma.outboundMessage.create({ data: { clinicId: c.clinicId, patientId: visit.patientId, ruleKey: 'visit-reminder', channel: 'TELEGRAM', text: 'Нагадуємо', status: 'APPROVED', scheduledFor: new Date(), expiresAt: v.startsAt, dedupeKey: `visit-reminder:${v.id}:24:${v.startsAt.toISOString()}`, visitId: v.id } });
    const r1 = await reminder(visit);
    await moveTo(c, visit.id, new Date(visit.startsAt.getTime() + 2 * 3_600_000)).expect(200);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe('CANCELLED');
    // a new time made in Cliniccards, learned by the sync
    const now = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    const r2 = await reminder(now);
    raw().visit_start = String(raw().visit_start).replace(/ (\d{2}):/, (_m, h: string) => ` ${String((Number(h) + 1) % 24).padStart(2, '0')}:`);
    raw().visit_end = String(raw().visit_end).replace(/ (\d{2}):/, (_m, h: string) => ` ${String((Number(h) + 1) % 24).padStart(2, '0')}:`);
    await http().post('/integrations/cliniccards/sync').set(auth(c.token)).expect(201);
    for (let i = 0; i < 50 && (await prisma.syncRun.findFirst({ where: { clinicId: c.clinicId }, orderBy: { startedAt: 'desc' } }))?.status === 'RUNNING'; i++) await new Promise((r) => setTimeout(r, 100));
    const synced = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(synced.startsAt.getTime()).not.toBe(now.startsAt.getTime());
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe('CANCELLED');
    const seen = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'visit.time_changed' } });
    expect(seen.details).toMatchObject({ visit: visit.externalId, from: now.startsAt.toISOString(), to: synced.startsAt.toISOString(), source: 'sync' });
  });
});

const slotBody = (s: { date: string; time: string }) => ({ date: s.date, time_start: s.time });
const localIso = (s: { date: string; time: string }) => localToUtc(`${s.date} ${s.time}:00`).toISOString();

describe('перенесення: новий візит створено, а старий скасувати не вдалося (2026-11-16)', () => {
  it('пацієнт лишається з новим записом, старий — завданням персоналу; нічого не повторюється само', async () => {
    const { c, done } = await booked();
    await toConfirm(c);
    const spy = jest.spyOn(app.get(BookingService), 'cancel').mockRejectedValueOnce(new BadRequestException('booking_failed'));
    await say(c, 'Так, перенести', (await buttonOf(c, 'moveyes|')).payload);
    spy.mockRestore();
    expect(posts()).toHaveLength(1);
    expect(cancels()).toHaveLength(0);
    const req = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: done.id } });
    expect(req.externalVisitId).not.toBe(done.externalVisitId);
    const r = (await reqs(c)).find((x) => x.summary.includes('скасуйте вручну'));
    expect(r).toBeTruthy();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'booking.rescheduled' } })).details).toMatchObject({ oldCancelled: false });
  });
});
