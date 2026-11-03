import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { BookingService } from '../src/booking/booking.service';
import { CabinetBookingService } from '../src/booking/cabinet-booking.service';
import { slotPayload } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(120_000);

let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const MIN = 60_000;

const ai = { configured: true, service: 'Консультація', complete: async () => ({ text: JSON.stringify({ intent: 'booking', reply: 'Оберіть, будь ласка, час.', summary: 'хоче записатися', service: ai.service, options: [] }), inputTokens: 1, outputTokens: 1 }) };
const sent: { chatId: string; text: string; buttons: { label: string; payload: string }[] }[] = [];

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(ai).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    sent.push({ chatId, text, buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) });
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
  mock.writes.length = 0;
  mock.control.failWith = undefined;
  mock.control.dropReplyAfterWrite = false;
  ai.service = 'Консультація';
  // a clean schedule for the next days: only what a test adds is in it
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon || String(v.note).includes('LANKA-test-keep'));
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

type C = Awaited<ReturnType<typeof clinic>>;
const day = (n: number) => clinicDate(new Date(Date.now() + n * 86_400_000));
const put = (c: C, path: string, body: unknown) => http().put(path).set(auth(c.token)).send(body as object);
const WEEK = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '09:00', to: '18:00' }]));

// A clinic that keeps its schedule by cabinets through ONE shared account (503) of the mock Cliniccards, with two online cabinets (801, 802)
async function clinic(opts: { mode?: 'CABINETS' | 'DOCTORS'; hours?: boolean; auto?: boolean } = {}) {
  const email = `c${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', aiEnabled: true, aiAutoReply: true, sendingEnabled: true, ...(opts.auto ? { bookingWriteEnabled: true, aiAutoBooking: true } : {}) } });
  const consult = await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 30, active: true, approvedAt: new Date() } });
  const long = await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Лікування карієсу', durationMin: 60, active: true, approvedAt: new Date() } });
  const c = { token, clinicId, chat: `ig${rnd()}`, consult, long };
  await http().get('/booking-settings').set(auth(token)).expect(200); // reads the accounts from Cliniccards
  if (opts.mode !== 'DOCTORS') {
    await put(c, '/booking-settings/shared-account', { doctorId: '503' }).expect(200);
    await put(c, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: true, acceptsUrgent: false }, { externalId: '802', onlineBooking: true, acceptsUrgent: false }] }).expect(200);
    await put(c, '/booking-settings/services', { services: [{ id: consult.id, onlineBooking: true, cabinetIds: [] }] }).expect(200);
    if (opts.hours !== false) await put(c, '/clinic/work-hours', WEEK).expect(200);
    await put(c, '/booking-settings/mode', { mode: 'CABINETS' }).expect(200);
  }
  return c;
}
const visit = (cabinet: string, doctorId: string, date: string, from: string, to: string) =>
  mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: doctorId, doctor: 'x', cabinet_id: cabinet, visit_start: `${date} ${from}:00`, visit_end: `${date} ${to}:00`, note: 'test', price_items: null, date_created: `${date} 08:00:00`, date_edited: `${date} 08:00:00` });
const block = (cabinet: string, date: string, from: string, to: string) =>
  mock.data.spaces.push({ schedule_space_id: `9${rnd()}`, schedule_cabinets_id: cabinet, schedule_cabinet_name: 'x', created_by: 'x', created_by_id: '1', note: '', type: 'Break', space_start: `${date} ${from}:00`, space_end: `${date} ${to}:00` });
const win = async (c: C, minutes: number, extra: object = {}) => app.get(CabinetBookingService).windows(c.clinicId, { minutes, force: true, ...extra });
const covers = (w: { startMin: number; endMin: number }[], from: number, to: number) => w.some((x) => x.startMin <= from && to <= x.endMin);

let mid = 0;
const write = (c: C, text: string, payload?: string) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const last = () => sent[sent.length - 1];
const reqOf = (c: C) => prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'desc' } });
const slots = (m: { buttons: { payload: string }[] }) => m.buttons.map((b) => b.payload).filter((p) => p.startsWith('slot|'));
const link = async (c: C, skip = 0) => {
  const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' }, skip });
  await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: c.chat } });
  return p;
};

describe('налаштування запису за кабінетами', () => {
  it('новий спосіб не вмикається сам, лише власний вибір; спільний обліковий запис і кабінети беруться з Cliniccards; недостатні налаштування названо', async () => {
    const c = await clinic({ mode: 'DOCTORS' });
    const s0 = (await http().get('/booking-settings').set(auth(c.token)).expect(200)).body;
    // Cliniccards returned doctors, and yet the mode stays "by doctors": nothing is switched on because the API returned one doctor
    expect(s0.mode).toBe('DOCTORS');
    expect(s0.accounts.map((a: { externalId: string }) => a.externalId).sort()).toEqual(['501', '502', '503']);
    // the working hours came from Cliniccards with the sync, so they are not missing; the services are imported but none is allowed yet
    expect(s0.problems.sort()).toEqual(['no_cabinets', 'no_services', 'no_shared_account']);
    expect(s0.hours).toMatchObject({ source: 'CLINICCARDS' });
    // the way a request is handled is a different setting and is not touched
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiAutoBooking: false, scheduleMode: 'DOCTORS' });

    await put(c, '/booking-settings/shared-account', { doctorId: '999999' }).expect(400); // an arbitrary id is refused
    await put(c, '/booking-settings/shared-account', { doctorId: '509' }).expect(400); // not a doctor account
    await put(c, '/booking-settings/shared-account', { doctorId: '503' }).expect(200);
    await put(c, '/booking-settings/cabinets', { cabinets: [{ externalId: 'nope', onlineBooking: true, acceptsUrgent: false }] }).expect(400);
    // urgent only in a cabinet that is open for online booking
    const s1 = (await put(c, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: false, acceptsUrgent: true }, { externalId: '802', onlineBooking: true, acceptsUrgent: true }] }).expect(200)).body;
    expect(s1.cabinets.find((x: { externalId: string }) => x.externalId === '801')).toMatchObject({ onlineBooking: false, acceptsUrgent: false });
    expect(s1.cabinets.find((x: { externalId: string }) => x.externalId === '802')).toMatchObject({ onlineBooking: true, acceptsUrgent: true });
    // a service is allowed only when approved and with a known length
    const noLength = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Без тривалості', active: true, approvedAt: new Date() } });
    const draft = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Чернетка', durationMin: 30, active: true } });
    await put(c, '/booking-settings/services', { services: [{ id: noLength.id, onlineBooking: true, cabinetIds: [] }] }).expect(400);
    await put(c, '/booking-settings/services', { services: [{ id: draft.id, onlineBooking: true, cabinetIds: [] }] }).expect(400);
    await put(c, '/booking-settings/services', { services: [{ id: c.consult.id, onlineBooking: true, cabinetIds: ['nope'] }] }).expect(400);
    await put(c, '/booking-settings/services', { services: [{ id: c.consult.id, onlineBooking: true, cabinetIds: ['802'] }] }).expect(200);
    await put(c, '/booking-settings/exceptions', { exceptions: [{ date: 'завтра', closed: true }] }).expect(400);
    await put(c, '/booking-settings/exceptions', { exceptions: [{ date: day(3), closed: false, from: '14:00', to: '10:00' }] }).expect(400);
    const s2 = (await put(c, '/booking-settings/exceptions', { exceptions: [{ date: day(3), closed: true }, { date: day(4), closed: false, from: '10:00', to: '14:00' }] }).expect(200)).body;
    expect(s2.exceptions).toHaveLength(2);
    expect(s2.problems).toEqual([]); // the hours came from Cliniccards, so nothing is missing any more
    await put(c, '/clinic/work-hours', WEEK).expect(200);
    expect((await http().get('/booking-settings').set(auth(c.token))).body.problems).toEqual([]);
    expect((await put(c, '/booking-settings/mode', { mode: 'CABINETS' }).expect(200)).body.mode).toBe('CABINETS');
    await put(c, '/booking-settings/mode', { mode: 'both' }).expect(400);
  });

  it('права й ізоляція клінік', async () => {
    const a = await clinic();
    const b = await clinic({ mode: 'DOCTORS' });
    expect((await http().get('/booking-settings').set(auth(b.token))).body).toMatchObject({ mode: 'DOCTORS', shared: null });
    expect((await http().get('/booking-settings').set(auth(a.token))).body.shared).toMatchObject({ doctorId: '503' });
    await put(b, '/booking-settings/services', { services: [{ id: a.consult.id, onlineBooking: true, cabinetIds: [] }] }).expect(400); // a service of another clinic
    const inv = await http().post('/team/invitations').set(auth(a.token)).send({ email: `an${rnd()}@example.com`, role: 'ANALYST' }).expect(201);
    const analyst = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ан', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/booking-settings').set(auth(analyst)).expect(200);
    await http().put('/booking-settings/mode').set(auth(analyst)).send({ mode: 'DOCTORS' }).expect(403);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: a.clinicId } })).scheduleMode).toBe('CABINETS');
  });
});

describe('вільні вікна за кабінетами', () => {
  it('один спільний обліковий запис і два кабінети: зайнятість одного кабінету не блокує інший через спільний doctor_id; візит з будь-яким doctor_id і блокування займають свій кабінет', async () => {
    const c = await clinic();
    const d = day(2);
    visit('801', '503', d, '10:00', '10:30'); // the shared account, cabinet 1
    visit('801', '501', d, '12:00', '12:30'); // ANOTHER doctor_id in the same cabinet: still the cabinet is busy
    block('802', d, '11:00', '12:00');
    const w = (await win(c, 30)).filter((x) => x.date === d);
    const of = (cab: string) => w.filter((x) => x.cabinetId === cab);
    expect(covers(of('801'), 600, 630)).toBe(false); // cabinet 1 is busy at 10:00-10:30
    expect(covers(of('802'), 600, 630)).toBe(true); // cabinet 2 is free then: the shared doctor_id is NOT one busy physical doctor
    expect(covers(of('801'), 720, 750)).toBe(false); // the visit of doctor 501 in cabinet 1
    expect(covers(of('802'), 720, 750)).toBe(true);
    expect(covers(of('802'), 660, 690)).toBe(false); // the block of cabinet 2
    expect(covers(of('801'), 660, 690)).toBe(true);
    // a cancelled visit does not occupy
    mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'CANCELLED', doctor_id: '503', doctor: 'x', cabinet_id: '801', visit_start: `${d} 15:00:00`, visit_end: `${d} 16:00:00`, note: 'test', price_items: null, date_created: `${d} 08:00:00`, date_edited: `${d} 08:00:00` });
    expect(covers((await win(c, 30)).filter((x) => x.date === d && x.cabinetId === '801'), 900, 960)).toBe(true);
  });

  it('тривалість послуги, винятки за датами, непідходящі послуги й неналаштовані години: це не пропонується', async () => {
    const c = await clinic();
    const d = day(2);
    visit('801', '503', d, '10:00', '10:30');
    visit('802', '503', d, '10:00', '10:30');
    // a 90-minute service does not fit between 9:00 and 10:00 (60 minutes) in either cabinet, but fits after 10:30
    const long = (await win(c, 90)).filter((x) => x.date === d);
    expect(covers(long, 540, 630)).toBe(false);
    expect(covers(long, 660, 750)).toBe(true);
    // a day off and other hours by date
    await put(c, '/booking-settings/exceptions', { exceptions: [{ date: day(3), closed: true }, { date: day(4), closed: false, from: '10:00', to: '12:00' }] }).expect(200);
    expect((await win(c, 30)).filter((x) => x.date === day(3))).toEqual([]);
    const short = (await win(c, 30)).filter((x) => x.date === day(4));
    expect(Math.min(...short.map((x) => x.startMin))).toBe(600);
    expect(Math.max(...short.map((x) => x.endMin))).toBe(720);
    // a service restricted to one cabinet is offered only there
    const only = await win(c, 30, { service: { cabinetIds: ['802'] } });
    expect(only.every((x) => x.cabinetId === '802')).toBe(true);
    // urgent: only the cabinets the clinic allowed for urgent patients (none yet)
    expect(await win(c, 30, { urgent: true })).toEqual([]);
    // hours not configured (Cliniccards does not give them and nobody typed them): nothing is offered
    const keep = mock.data.scheduleSettings;
    mock.data.scheduleSettings = null;
    const bare = await clinic({ hours: false });
    mock.data.scheduleSettings = keep;
    expect((await http().get('/booking-settings').set(auth(bare.token))).body.problems).toContain('no_hours');
    expect(await win(bare, 30)).toEqual([]);
    // no cabinet open for online booking: nothing
    await put(c, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: false, acceptsUrgent: false }, { externalId: '802', onlineBooking: false, acceptsUrgent: false }] }).expect(200);
    expect(await win(c, 30)).toEqual([]);
  });

  it('пересечення в одному кабінеті заборонене: другий запис у той самий кабінет і час не створюється; у інший кабінет з тим самим doctor_id створюється', async () => {
    const c = await clinic({ auto: true });
    const patients = await prisma.patient.findMany({ where: { clinicId: c.clinicId, removedAt: null }, orderBy: { externalId: 'asc' }, take: 3 });
    const at = localToUtc(`${day(2)} 10:00:00`);
    const book = (patientId: string, cabinetId: string) => app.get(BookingService).book(c.clinicId, 'staff', { patientId, startsAt: at, durationMin: 30, cabinetId, doctorId: '503', sharedAccount: true });
    await book(patients[0].id, '801');
    await expect(book(patients[1].id, '801')).rejects.toThrow('booking_slot_taken'); // the same cabinet and time
    await book(patients[2].id, '802'); // another cabinet, the same shared doctor_id: allowed by LANKA (the real API is to be checked live)
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(2);
    // for an ordinary doctor the same doctor_id in two cabinets at once stays a conflict (booking by doctors is unchanged)
    const p4 = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null }, orderBy: { externalId: 'desc' } });
    await expect(app.get(BookingService).book(c.clinicId, 'staff', { patientId: p4.id, startsAt: at, durationMin: 30, cabinetId: '802', doctorId: '503' })).rejects.toThrow(/booking_slot_taken/);
  });
});

describe('розмова в режимі за кабінетами', () => {
  it('пацієнт без побажань: пропонуються найближчі часи за кабінетами без імені лікаря; заявка адміністратору не обіцяє підтверджений візит', async () => {
    const c = await clinic();
    await write(c, 'Хочу записатися на консультацію');
    expect(slots(last()).length).toBeGreaterThan(0);
    expect(slots(last()).every((p) => p.split('|').length === 3)).toBe(true); // time only: no doctor, no cabinet in the button
    expect(last().text).toContain('Конкретного лікаря призначає клініка');
    expect(JSON.stringify(sent)).not.toMatch(/Шевченко|Іваненко|Петренко|#503/); // the shared account is never shown as a doctor
    expect(await reqOf(c)).toMatchObject({ scheduleMode: 'CABINETS', doctorId: null, kind: 'BOOKING' });
    // the person chooses a time: the data is collected, then ONE request with the time, no promise
    const slot = slots(last())[0].split('|');
    await write(c, '', slots(last())[0]);
    await write(c, 'Прізвище Коваль, ім’я Ірина, телефон 0971234567');
    expect(last().text).toContain('Передали заявку');
    expect(last().text).not.toContain('Ваш запис підтверджено');
    expect(mock.writes).toHaveLength(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);
    expect((await reqOf(c)).slotAt).toEqual(localToUtc(`${slot[1]} ${slot[2]}:00`));
  });

  it('автоматичний запис: явне «так» з адресою й поясненням про лікаря, візит із спільним doctor_id і кабінетом, підтвердження без імені лікаря, у примітці й аудиті контекст', async () => {
    const c = await clinic({ auto: true });
    await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'LOCATION', title: 'Головний кабінет', text: 'м. Київ, вул. Тестова, 12', active: true, approvedAt: new Date() } });
    await link(c);
    await write(c, 'Хочу записатися на консультацію');
    const offered = slots(last());
    await write(c, '', offered[0]);
    expect(last().text).toContain('Підтверджуєте запис на Консультація');
    expect(last().text).toContain('вул. Тестова, 12');
    expect(last().text).toContain('Конкретного лікаря призначає клініка');
    expect(mock.writes).toHaveLength(0);
    await write(c, 'так');
    const w = mock.writes.filter((x) => x.path === '/visits');
    expect(w).toHaveLength(1);
    expect(w[0].body).toMatchObject({ doctor_id: 503, status: 'PLANNED' });
    expect(['801', '802']).toContain(String(w[0].body.cabinet_id));
    expect(String(w[0].body.note)).toContain('Лікаря призначає клініка');
    expect(String(w[0].body.note)).not.toMatch(/лікар\s+dental|до лікаря/i);
    const text = last().text;
    expect(text).toContain('Ваш запис підтверджено ✅');
    expect(text).toContain('Лікар: Лікаря призначить клініка');
    expect(text).not.toMatch(/Шевченко|Андрій|503/);
    const done = await reqOf(c);
    expect(done).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', scheduleMode: 'CABINETS', confirmedDoctor: null, noticeStatus: 'SENT' });
    expect(done.cabinetId).toBe(String(w[0].body.cabinet_id));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'booking_request.confirmed' } });
    expect(audit.details).toMatchObject({ by: 'auto', scheduleMode: 'CABINETS', cabinetId: done.cabinetId, sharedAccount: '503' });
    // repeated events: the same time again, a second "так", a repeated confirm button: still ONE visit and ONE confirmation
    await write(c, '', offered[0]);
    await write(c, 'так');
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(1);
    expect(sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);
  });

  it('пацієнт хоче конкретного лікаря: це лише побажання; заявка адміністратору без обіцянок, або згода на будь-якого веде до звичайного запису; продовження лікування не вгадується', async () => {
    const c = await clinic({ auto: true });
    await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'DOCTOR', title: 'Іваненко Олег', text: 'терапевт', active: true, approvedAt: new Date() } });
    await link(c);
    await write(c, 'Хочу до лікаря Іваненка на консультацію');
    expect(last().text).toContain('Іваненко Олег');
    expect(last().text).toContain('не можемо обіцяти запис саме до нього');
    expect(last().buttons.map((b) => b.payload)).toEqual(['docany|0', 'docwish|0']);
    expect(slots(last())).toEqual([]); // no time is promised yet
    expect(await reqOf(c)).toMatchObject({ wishedDoctor: 'Іваненко Олег', doctorState: 'WISH_ASKED', doctorId: null });
    // the wish goes to an administrator: no times, no booking, the wish is kept
    await write(c, '', 'docwish|0');
    expect(last().text).toContain('з побажанням: лікар Іваненко Олег');
    expect(last().text).not.toContain('Ваш запис підтверджено');
    expect(await reqOf(c)).toMatchObject({ doctorState: 'WISH_ADMIN', wishedDoctor: 'Іваненко Олег' });
    await write(c, 'Дякую, чекаю');
    expect(slots(last())).toEqual([]);
    expect(mock.writes).toHaveLength(0);
    // a repeated tap of the same button changes nothing
    const n = sent.length;
    await write(c, '', 'docwish|0');
    expect(sent.length).toBe(n);

    // another person agrees to any doctor: the ordinary booking by cabinets, the wish stays on the request and in the note of the visit
    const d = await clinic({ auto: true });
    await prisma.kbItem.create({ data: { clinicId: d.clinicId, kind: 'DOCTOR', title: 'Іваненко Олег', text: '', active: true, approvedAt: new Date() } });
    await link(d);
    await write(d, 'Хочу до лікаря Іваненка на консультацію');
    await write(d, '', 'docany|0');
    expect(slots(last()).length).toBeGreaterThan(0);
    await write(d, '', slots(last())[0]);
    await write(d, 'так');
    const w = mock.writes.filter((x) => x.path === '/visits');
    expect(w).toHaveLength(1);
    expect(String(w[0].body.note)).toContain('Побажання пацієнта: Іваненко Олег');
    expect(last().text).not.toMatch(/Іваненко/); // the confirmation does not claim the wished doctor
    expect(await reqOf(d)).toMatchObject({ doctorState: 'ANY_DOCTOR', wishedDoctor: 'Іваненко Олег', confirmedDoctor: null });

    // treatment history of the shared account is not read as a real treating doctor: no "continue with ..." question, no doctor name
    const e = await clinic();
    const p = await link(e);
    await prisma.planItem.create({ data: { clinicId: e.clinicId, patientId: p.id, externalId: `pi${rnd()}`, planId: 'pl1', name: 'Консультація', status: 'DONE', createdAtExt: new Date(Date.now() - 30 * 86_400_000), markedDoneAt: new Date(), doneByDoctorId: '503' } });
    await write(e, 'Хочу продовжити консультацію');
    expect(JSON.stringify(sent.filter((m) => m.chatId === e.chat))).not.toMatch(/Продовжимо|docyes/);
  });

  it('термінове звернення: лише кабінети, дозволені для термінових; одна пріоритетна заявка; автозапису немає; без дозволених кабінетів — передача людині', async () => {
    const c = await clinic({ auto: true });
    await link(c);
    await write(c, 'У мене гострий біль і флюс');
    expect(slots(last())).toEqual([]); // no cabinet is allowed for urgent patients yet: a person takes it
    expect(await reqOf(c)).toMatchObject({ urgent: true });
    await put(c, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: true, acceptsUrgent: false }, { externalId: '802', onlineBooking: true, acceptsUrgent: true }] }).expect(200);
    const d = day(2);
    block('802', d, '09:00', '12:00'); // cabinet 2 (the urgent one) is busy in the morning
    app.get(CabinetBookingService).invalidate(c.clinicId);
    const u = { ...c, chat: `ig${rnd()}` };
    await link(u, 1);
    await write(u, 'У мене гострий біль і флюс');
    const offered = slots(last());
    expect(offered.length).toBeGreaterThan(0);
    for (const o of offered) {
      const [, date, time] = o.split('|');
      const at = localToUtc(`${date} ${time}:00`);
      const place = await app.get(CabinetBookingService).placeFor(c.clinicId, at, 30, null);
      expect(place).not.toBeNull();
    }
    // every offered time is free in cabinet 2 itself (the only urgent cabinet), not just in some cabinet
    for (const o of offered) {
      const [, date, time] = o.split('|');
      const start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      expect(covers((await win(c, 30, { urgent: true })).filter((x) => x.date === date), start, start + 30)).toBe(true);
    }
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: u.chat } })).toBe(1);
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: u.chat } })).toMatchObject({ urgent: true, doctorReason: 'URGENT', scheduleMode: 'CABINETS' });
    // the person taps a time and gives the data: a priority request for a person, never a booking by the bot
    await write(u, '', offered[0]);
    await write(u, 'Прізвище Коваль, ім’я Ірина, телефон 0971234567');
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(0);
    expect(sent.filter((m) => m.chatId === u.chat).map((m) => m.text).join('\n')).not.toContain('Підтверджуєте запис');
    expect((await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: u.chat } })).summary).toContain('термінове звернення');
    // a sudden-problem question about medicines stays with a person
    const before = sent.length;
    await write(u, 'Який антибіотик пити?');
    expect(sent.slice(before).map((m) => m.text).join('\n')).not.toContain('103');
  });

  it('неналаштована послуга й відсутній обліковий запис: пропозицій немає, заявка йде людині з причиною', async () => {
    const c = await clinic();
    ai.service = 'Лікування карієсу'; // approved and with a length, but NOT allowed for booking by cabinets
    await write(c, 'Хочу записатися на лікування карієсу');
    expect(slots(last())).toEqual([]);
    expect(last().text).toContain('Передали заявку');
    expect((await reqOf(c)).summary).toContain('не дозволено для запису за кабінетами');
    ai.service = 'Консультація';
    const d = await clinic();
    await put(d, '/booking-settings/shared-account', { doctorId: null }).expect(200);
    await write(d, 'Хочу записатися на консультацію');
    expect(slots(last())).toEqual([]);
    expect((await reqOf(d)).summary).toContain('спільний обліковий запис');
  });

  it('розклад не вдалося оновити: часи не пропонуються, запис за застарілими даними не підтверджується', async () => {
    const c = await clinic({ auto: true });
    await link(c);
    await write(c, 'Хочу записатися на консультацію');
    const offered = slots(last());
    await write(c, '', offered[0]);
    expect(last().text).toContain('Підтверджуєте запис');
    // Cliniccards cannot be read when the person says yes: nothing is confirmed on the old picture
    const spy = jest.spyOn(CabinetBookingService.prototype, 'fresh').mockRejectedValue(new Error('schedule_unavailable'));
    await write(c, 'так');
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(0);
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Ваш запис підтверджено');
    expect(last().text).toContain('Передали заявку');
    expect((await reqOf(c)).summary).toContain('не вдалося оновити розклад');
    // and no times are offered while the schedule cannot be read
    const d = { ...c, chat: `ig${rnd()}` };
    await write(d, 'Хочу записатися на консультацію');
    expect(slots(last())).toEqual([]);
    expect(last().text).toContain('Не вдалося перевірити актуальний розклад');
    spy.mockRestore();
  });

  it('таймаут після створення візиту: один візит; місце, зайняте в Cliniccards, зупиняє запис; старі кнопки після зміни налаштування не діють', async () => {
    const c = await clinic({ auto: true });
    await link(c);
    await write(c, 'Хочу записатися на консультацію');
    const offered = slots(last());
    await write(c, '', offered[0]);
    mock.control.dropReplyAfterWrite = true;
    await write(c, 'так');
    mock.control.dropReplyAfterWrite = false;
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(1); // the lost answer is checked, not repeated
    expect(sent.filter((m) => m.text.includes('Ваш запис підтверджено'))).toHaveLength(1);

    // somebody takes the time in BOTH cabinets in Cliniccards meanwhile: after "так" the fresh check stops the write
    const e = await clinic({ auto: true });
    await link(e);
    await write(e, 'Хочу записатися на консультацію');
    const o2 = slots(last());
    await write(e, '', o2[1] ?? o2[0]);
    const [, date, time] = (o2[1] ?? o2[0]).split('|');
    visit('801', '501', date, time, `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:${time.slice(3)}`);
    visit('802', '502', date, time, `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:${time.slice(3)}`);
    app.get(CabinetBookingService).invalidate(e.clinicId);
    mock.writes.length = 0;
    await write(e, 'так');
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(0);
    expect(last().text).toContain('зайнятий');
    expect(sent.some((m) => m.text.includes('Ваш запис підтверджено') && m.chatId === e.chat)).toBe(false);

    // the setting changes while the person still holds old buttons: the old choice is dropped and new times are offered
    const f = await clinic({ auto: true });
    await link(f);
    await write(f, 'Хочу записатися на консультацію');
    const old = slots(last())[0];
    await put(f, '/booking-settings/mode', { mode: 'DOCTORS' }).expect(200);
    sent.length = 0;
    await write(f, '', old);
    expect(last().text).toContain('Налаштування запису змінилися');
    expect(await reqOf(f)).toMatchObject({ slotAt: null, scheduleMode: null, stage: 'NONE', confirmedAt: null });
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(0);
    // the other way: a button of booking by doctors after the switch to cabinets
    const g = await clinic({ mode: 'DOCTORS', auto: true });
    await prisma.bookingRequest.create({ data: { clinicId: g.clinicId, channel: 'INSTAGRAM', chatId: g.chat, kind: 'BOOKING', summary: 'x', service: 'Консультація', scheduleMode: 'DOCTORS', doctorId: '501', doctorState: 'AGREED' } });
    await put(g, '/booking-settings/shared-account', { doctorId: '503' }).expect(200);
    await put(g, '/booking-settings/cabinets', { cabinets: [{ externalId: '801', onlineBooking: true, acceptsUrgent: false }] }).expect(200);
    await put(g, '/booking-settings/services', { services: [{ id: g.consult.id, onlineBooking: true, cabinetIds: [] }] }).expect(200);
    await put(g, '/clinic/work-hours', WEEK).expect(200);
    await put(g, '/booking-settings/mode', { mode: 'CABINETS' }).expect(200);
    sent.length = 0;
    await write(g, '', `slot|${day(2)}|11:00|#501`);
    expect(last().text).toContain('Налаштування запису змінилися');
    expect((await reqOf(g)).doctorId).toBeNull();
    expect(mock.writes.filter((x) => x.path === '/visits')).toHaveLength(0);
  });
});
