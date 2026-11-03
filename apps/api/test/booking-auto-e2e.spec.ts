import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { clinicDate, clinicHm, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';
import { BookingService } from '../src/booking/booking.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

// A local end-to-end check of the automatic booking against the Cliniccards mock, in the isolated test database.
// The free times come from the schedule the mock API returns (shifts, visits, reserved blocks), through the real sync and the real report:
// nothing about the schedule is faked. No key, no data and no settings of a real clinic are used.
// The report at the end lists what the mock received and what the client was told.

jest.setTimeout(120_000);

let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const fmt = (ymd: string) => ymd.split('-').reverse().join('.');
const MIN = 60_000;

const fakeAi = {
  configured: true,
  calls: 0,
  complete: async () => {
    fakeAi.calls++;
    return { text: JSON.stringify({ intent: 'info', reply: 'Будь ласка! Звертайтеся, якщо знадобиться допомога.', summary: '', options: [] }), inputTokens: 1, outputTokens: 1 };
  },
};
const sent: { chatId: string; text: string; buttons: string[] }[] = [];
const report: string[] = [];
const out = (line = '') => report.push(line);

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fakeAi).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    sent.push({ chatId, text, buttons: options.map((o) => o.label) });
  });
});
afterAll(async () => {
  process.stdout.write(`\n${report.join('\n')}\n`);
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
});
beforeEach(() => {
  sent.length = 0;
  mock.writes.length = 0;
  mock.requests.length = 0;
  mock.control.failWith = undefined;
  mock.control.dropReplyAfterWrite = false;
});

type Slot = { date: string; time: string; at: Date; doctorId: string; doctorName: string; cabinetId: string };

// What the mock itself says about a place: a doctor's shift that covers the whole visit, no visit of that doctor or in that cabinet,
// no reserved block in that cabinet. Computed from the raw data of the mock, independent of our own schedule code.
function mockFreeFor(at: Date, minutes: number, extraBusy: { doctorId?: string; cabinetId?: string }[] = []) {
  const end = new Date(at.getTime() + minutes * MIN);
  const t = (v: unknown) => localToUtc(String(v));
  const overlaps = (a: Date, b: Date) => a < end && b > at;
  const free: { doctorId: string; doctorName: string; cabinetId: string }[] = [];
  for (const s of mock.data.shifts) {
    if (t(s.shift_start) > at || t(s.shift_end) < end) continue;
    const doctorId = String(s.doctor_id);
    const cabinetId = String(s.schedule_cabinets_id);
    const busyVisit = mock.data.visits.some((v) => !['CANCELLED', 'MOVED', 'DID_NOT_COME'].includes(String(v.status)) && (String(v.doctor_id) === doctorId || String(v.cabinet_id) === cabinetId) && overlaps(t(v.visit_start), v.visit_end ? t(v.visit_end) : new Date(t(v.visit_start).getTime() + 30 * MIN)));
    const blocked = mock.data.spaces.some((b) => String(b.schedule_cabinets_id) === cabinetId && overlaps(t(b.space_start), t(b.space_end)));
    if (busyVisit || blocked || extraBusy.some((x) => x.doctorId === doctorId || x.cabinetId === cabinetId)) continue;
    free.push({ doctorId, doctorName: String(s.doctor), cabinetId });
  }
  return free;
}

async function clinic(service: string | null, opts: { shifts?: boolean } = {}) {
  const email = `e${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  // the clinic asked for the automatic mode and the service owner allowed writing; the AI autoreply is on for the dialog after the booking
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', bookingWriteEnabled: true, aiAutoBooking: true, aiEnabled: true, aiAutoReply: true, sendingEnabled: true, publicAddress: 'м. Київ, вул. Тестова, 12' } });
  if (service) await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 45, active: true, approvedAt: new Date() } });
  if (opts.shifts === false) await prisma.shift.deleteMany({ where: { clinicId } });
  const patients = await prisma.patient.findMany({ where: { clinicId, removedAt: null, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' }, take: 6 });
  return { token, clinicId, patients, chat: `ig${rnd()}`, slot: null as Slot | null };
}
type C = Awaited<ReturnType<typeof clinic>>;

// A time the clinic really offers: the first free half hour of a later day in the schedule the bot reads (real report over the synced mock data),
// confirmed against the raw data of the mock
async function offeredSlot(c: C, minutes = 45, skip = 0): Promise<Slot> {
  const rows = await app.get(ReportsService).freeSlots(c.clinicId, 7);
  const today = clinicDate(new Date());
  let seen = 0;
  for (const r of rows) {
    if (String(r.dayAt) <= today || !r.doctor) continue;
    for (const w of String(r.windows).split(', ')) {
      const [a, b] = w.split('–');
      const from = Math.ceil((Number(a.slice(0, 2)) * 60 + Number(a.slice(3))) / 30) * 30;
      if (!b || from + minutes > Number(b.slice(0, 2)) * 60 + Number(b.slice(3))) continue;
      const time = `${String(Math.floor(from / 60)).padStart(2, '0')}:${String(from % 60).padStart(2, '0')}`;
      const at = localToUtc(`${r.dayAt} ${time}:00`);
      const real = mockFreeFor(at, minutes);
      if (!real.length) continue;
      if (seen++ < skip) continue;
      return { date: String(r.dayAt), time, at, doctorId: real[0].doctorId, doctorName: real[0].doctorName, cabinetId: real[0].cabinetId };
    }
  }
  throw new Error('the mock schedule has no free time in the next days');
}

let mid = 0;
const say = (c: C, text: string, payload?: string) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const tap = (c: C) => say(c, '', `slot|${c.slot!.date}|${c.slot!.time}`);
const seed = (c: C, service: string) => prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'хоче записатися', service } });
const link = (c: C, i = 0) => prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: c.patients[i].id, channel: 'INSTAGRAM', externalId: c.chat } });
const visitWrites = () => mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits');
const request0 = (c: C) => prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'desc' } });
const mask = (v: unknown) => String(v).replace(/(\d{3})\d{4}(\d{2})/, '$1****$2');
function writeReport(title: string, c: C) {
  out(`### ${title}`);
  out('Запити до Cliniccards (mock):');
  const reads = mock.requests.map((r) => r.path).filter((p, i, a) => a.indexOf(p) === i);
  out(`  читання: ${reads.join(', ') || 'немає'}`);
  if (!mock.writes.length) out('  запис: жодного');
  for (const w of mock.writes) {
    const b = w.body as Record<string, unknown>;
    out(`  ${w.method} ${w.path} ${w.path === '/visits' ? `status=${b.status} date=${b.date} ${b.time_start}–${b.time_end} patient_id=${b.patient_id} doctor_id=${b.doctor_id} cabinet_id=${b.cabinet_id} note="${b.note}"` : `lastname=${b.lastname} firstname=${b.firstname} phone=${mask(b.phone)} preferred_contact=${b.preferred_contact}`}`);
  }
  out('Повідомлення клієнту:');
  for (const m of sent) out(`  > ${m.text.replace(/\n/g, '\n    ')}${m.buttons.length ? `\n    [кнопки: ${m.buttons.join(' | ')}]` : ''}`);
  if (c.slot) out(`Слот, обраний клієнтом: ${fmt(c.slot.date)} ${c.slot.time}${c.slot.doctorName ? ` (за розкладом мока вільний у ${c.slot.doctorName}, кабінет ${c.slot.cabinetId})` : ''}`);
  out('');
}

describe('вільні вікна беруться з розкладу, який повертає мок API', () => {
  it('S. зміни лікарів, візити й зарезервовані блоки з мока дають ті вікна, які бот пропонує; кожне запропоноване вікно справді вільне за даними мока', async () => {
    const c = await clinic('Консультація');
    // the sync read the schedule of the mock
    expect(mock.requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/schedule-shifts', '/schedule-spaces', '/visits']));
    const rows = await app.get(ReportsService).freeSlots(c.clinicId, 7);
    expect(rows.length).toBeGreaterThan(0);
    const options = await app.get(ChatAssistantService).freshOptions(c.clinicId);
    expect(options.length).toBeGreaterThan(0);
    const lines: string[] = [];
    for (const o of options) {
      // every offered 30-minute place is free by the raw data of the mock, and the lunch break of cabinet 1 (13:00–14:00 in the mock) is never offered there
      const at = localToUtc(`${o.date} ${o.time}:00`);
      const free = mockFreeFor(at, 30);
      expect(free.length).toBeGreaterThan(0);
      lines.push(`${o.label}: вільний у ${free.map((f) => `${f.doctorName} (кабінет ${f.cabinetId})`).join(', ')}`);
    }
    // a time inside a reserved block (the break of cabinet 1) is not free in cabinet 1 in the mock, and the bot's windows agree
    const day = rows.find((r) => r.cabinet === 'Кабінет 1' && r.doctor)?.dayAt as string;
    const inBreak = localToUtc(`${day} 13:15:00`);
    expect(mockFreeFor(inBreak, 30).every((f) => f.cabinetId !== '801')).toBe(true);
    for (const r of rows.filter((x) => String(x.dayAt) === day && x.cabinet === 'Кабінет 1')) expect(String(r.windows)).not.toMatch(/13:(15|30)/);
    out('### S. Вільні вікна з розкладу мока');
    out(`  мок віддав: ${mock.data.shifts.length} змін, ${mock.data.visits.length} візитів, ${mock.data.spaces.length} зарезервованих блоків; звіт «Вільні вікна» дав ${rows.length} рядків`);
    for (const l of lines) out(`  пропозиція: ${l}`);
    out('');
  });
});

describe('автоматичний запис: перевірка на mock:cliniccards', () => {
  it('A. повний сценарій: час → прізвище, ім’я, телефон окремо → явне «так» → один візит → повідомлення з фактичними датою й часом', async () => {
    const c = await clinic('Консультація');
    c.slot = await offeredSlot(c);
    await seed(c, 'Консультація');
    await tap(c);
    expect(mock.writes).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('прізвище, ім’я та номер телефону');
    // two bare words are not split by their order
    await say(c, 'Наталія Бойко');
    expect(sent.at(-1)!.text).toContain('ваше прізвище');
    await say(c, 'Бойко');
    expect(sent.at(-1)!.text).toContain('ваше ім’я');
    await say(c, 'Наталія');
    expect(sent.at(-1)!.text).toContain('номер телефону');
    await say(c, phone());
    expect(sent.at(-1)!.text).toContain('Підтверджуєте запис на Консультація');
    expect(mock.writes).toHaveLength(0);
    await say(c, 'так');

    expect(visitWrites()).toHaveLength(1);
    const patientWrites = mock.writes.filter((w) => w.path === '/patients');
    expect(patientWrites).toHaveLength(1);
    // the surname and the first name are in the right fields
    expect(patientWrites[0].body).toMatchObject({ lastname: 'Бойко', firstname: 'Наталія', preferred_contact: 'INSTAGRAM' });
    expect(patientWrites[0].body).not.toHaveProperty('source');
    const w = visitWrites()[0].body as Record<string, unknown>;
    // every REQUIRED field of the documentation, with the doctor and the cabinet of the shift that covers the time
    for (const f of ['status', 'patient_id', 'cabinet_id', 'doctor_id', 'note', 'date', 'time_start', 'time_end']) expect(w).toHaveProperty(f);
    expect(w).toMatchObject({ status: 'PLANNED', date: c.slot.date, time_start: c.slot.time });
    const shift = mock.data.shifts.find((s) => String(s.doctor_id) === String(w.doctor_id) && String(s.schedule_cabinets_id) === String(w.cabinet_id));
    expect(shift).toBeTruthy();
    const mins = (hm: unknown) => Number(String(hm).slice(0, 2)) * 60 + Number(String(hm).slice(3, 5));
    expect(mins(w.time_end) - mins(w.time_start)).toBe(45);
    expect(mockFreeFor(c.slot.at, 45).some((f) => String(f.doctorId) === String(w.doctor_id) && f.cabinetId === String(w.cabinet_id))).toBe(false); // now it is taken
    const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    // the doctor in the message is the doctor of the visit in Cliniccards (the mock names him in its answer)
    const doctorOf = (await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } })).confirmedDoctor;
    expect(doctorOf).toBe(c.slot.doctorName);
    expect(sent.at(-1)!.text).toBe(`Ваш запис підтверджено ✅\nПослуга: Консультація\nДата: ${fmt(c.slot.date)}\nЧас: ${c.slot.time}\nЛікар: ${doctorOf}\nКлініка: ${clinicRow.name}`);
    expect(await request0(c)).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', confirmSource: 'AUTO', noticeStatus: 'SENT', lastName: 'Бойко', firstName: 'Наталія' });
    writeReport('A. Повний сценарій', c);

    // the dialog goes on after the booking: the same time pressed again, a thanks and a question about the address
    sent.length = 0;
    mock.writes.length = 0;
    await tap(c);
    await say(c, 'Дякую!');
    await say(c, 'А де ви знаходитесь?');
    expect(visitWrites()).toHaveLength(0);
    expect(sent.some((m) => m.text.includes('підтверджено'))).toBe(false);
    expect(sent.map((m) => m.text)).toContain('Будь ласка! Звертайтеся, якщо знадобиться допомога.');
    expect(sent.at(-1)!.text).toContain('м. Київ, вул. Тестова, 12');
    out('A2. Розмова після запису: повторний тап того ж часу, «Дякую!» і питання про адресу');
    out(`  нових записів у мок: ${visitWrites().length}`);
    for (const m of sent) out(`  > ${m.text.replace(/\n/g, ' ')}`);
    out('');
  });

  it('B1. вікно зайняте за нашою копією розкладу: питання «підтверджуєте?» не ставиться, клієнт отримує свіжі варіанти', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    // everybody who could take this time is already booked (booked through the staff booking, so our copy knows it)
    const free = mockFreeFor(c.slot.at, 45);
    for (const [i, f] of free.entries()) await app.get(BookingService).book(c.clinicId, 'staff', { patientId: c.patients[i + 1].id, startsAt: c.slot.at, durationMin: 45, cabinetId: f.cabinetId, doctorId: f.doctorId });
    mock.writes.length = 0;
    mock.requests.length = 0;
    await seed(c, 'Консультація');
    await tap(c);
    expect(visitWrites()).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('зайнятий');
    expect(sent.some((m) => m.text.includes('Підтверджуєте'))).toBe(false);
    expect(sent.some((m) => m.text.includes('підтверджено'))).toBe(false);
    writeReport('B1. Зайняте вікно (за нашою копією розкладу)', c);
  });

  it('B2. вікно зайняте в Cliniccards, а наша копія ще не знає: після «так» свіжа перевірка не пускає запис, клієнт отримує варіанти', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    await seed(c, 'Консультація');
    await tap(c);
    expect(sent.at(-1)!.text).toContain('Підтверджуєте запис');
    // somebody books the same time directly in Cliniccards in the meantime (not synced yet), in every place that was free
    const end = new Date(c.slot.at.getTime() + 45 * MIN);
    const stamp = (d: Date) => `${clinicDate(d)} ${clinicHm(d)}:00`;
    for (const [i, f] of mockFreeFor(c.slot.at, 45).entries()) {
      mock.data.visits.push({ visit_id: `7${i}${rnd()}`, patient_id: c.patients[i + 1].externalId, status: 'PLANNED', doctor_id: f.doctorId, doctor: f.doctorName, cabinet_id: f.cabinetId, visit_start: stamp(c.slot.at), visit_end: stamp(end), note: 'зайнято в Cliniccards', price_items: null, date_created: stamp(new Date()), date_edited: stamp(new Date()) });
    }
    mock.requests.length = 0;
    await say(c, 'так');
    expect(visitWrites()).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('зайнятий');
    expect(sent.some((m) => m.text.includes('підтверджено'))).toBe(false);
    expect(mock.requests.map((r) => r.path)).toContain('/visits'); // the place was re-read from Cliniccards
    expect(await request0(c)).toMatchObject({ status: 'NEW', confirmedAt: null });
    writeReport('B2. Вікно зайняте в Cliniccards (наша копія відстала)', c);
  });

  it('C. повторний клік на «Так, підтверджую» і напечатане «так»: рівно один візит', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    await seed(c, 'Консультація');
    await tap(c);
    const ask = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, text: { startsWith: 'Підтверджуєте' } } });
    const yes = (ask.buttons as { payload: string }[])[0].payload;
    await Promise.all([say(c, '', yes), say(c, '', yes)]);
    await say(c, 'так');
    await say(c, '', yes);
    expect(visitWrites()).toHaveLength(1);
    expect(sent.filter((m) => m.text.includes('підтверджено'))).toHaveLength(1);
    writeReport('C. Повторний клік (два одночасні кліки, потім «так» і ще один клік)', c);
  });

  it('D. таймаут після створення візиту: перевірка замість повтору, один візит, одне повідомлення', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    await seed(c, 'Консультація');
    await tap(c);
    mock.control.dropReplyAfterWrite = true;
    await say(c, 'так');
    mock.control.dropReplyAfterWrite = false;
    expect(visitWrites()).toHaveLength(1);
    expect(mock.data.visits.filter((x) => String(x.visit_start) === `${c.slot!.date} ${c.slot!.time}:00` && String(x.patient_id) === c.patients[0].externalId)).toHaveLength(1);
    expect(sent.filter((m) => m.text.includes('підтверджено'))).toHaveLength(1);
    expect(await request0(c)).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO' });
    writeReport('D. Відповідь Cliniccards загубилась після створення візиту', c);
  });

  it('E. тривалість послуги невідома: 30 хвилин не підставляються, заявка йде адміністратору', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    await seed(c, 'Незнайома послуга');
    mock.requests.length = 0;
    await tap(c);
    expect(mock.writes).toHaveLength(0);
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Ваш запис підтверджено');
    expect(sent.at(-1)!.text).toContain('Передали заявку');
    const r = await request0(c);
    expect(r).toMatchObject({ status: 'NEW', stage: 'READY', autoState: 'FAILED', confirmedAt: null });
    expect(r.summary).toContain('тривалість послуги невідома');
    writeReport('E. Невідома тривалість послуги (немає в довіднику)', c);
    // no service at all: the same
    const d = await clinic('Консультація');
    await link(d);
    d.slot = c.slot;
    await tap(d);
    expect(mock.writes).toHaveLength(0);
    expect(await request0(d)).toMatchObject({ autoState: 'FAILED', confirmedAt: null });
  });

  it('F. «ні, інший час»: запису немає, клієнт отримує нові варіанти', async () => {
    const c = await clinic('Консультація');
    await link(c);
    c.slot = await offeredSlot(c);
    await seed(c, 'Консультація');
    await tap(c);
    await say(c, 'ні');
    expect(mock.writes).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('інший зручний час');
    expect(await request0(c)).toMatchObject({ stage: 'NONE', status: 'NEW', slotAt: null });
    writeReport('F. Клієнт відмовився («ні»)', c);
  });

  it('G. лікар не визначений (у Cliniccards немає змін лікарів): Cliniccards вимагає doctor_id, тому запис не створюється, заявка йде адміністратору, клієнту не обіцяють запис', async () => {
    const c = await clinic('Консультація', { shifts: false });
    await link(c);
    // without shifts the free time comes from the working hours of the clinic; the time is far enough in the future
    const day = clinicDate(new Date(Date.now() + 5 * 86_400_000));
    c.slot = { date: day, time: '11:00', at: localToUtc(`${day} 11:00:00`), doctorId: '', doctorName: '', cabinetId: '' };
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { workHours: { '1': { from: '09:00', to: '20:00' }, '2': { from: '09:00', to: '20:00' }, '3': { from: '09:00', to: '20:00' }, '4': { from: '09:00', to: '20:00' }, '5': { from: '09:00', to: '20:00' }, '6': { from: '09:00', to: '20:00' }, '7': { from: '09:00', to: '20:00' } } } });
    await seed(c, 'Консультація');
    mock.requests.length = 0;
    await tap(c);
    expect(mock.writes).toHaveLength(0);
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Підтверджуєте');
    expect(sent.at(-1)!.text).toContain('Передали заявку');
    const r = await request0(c);
    expect(r).toMatchObject({ status: 'NEW', autoState: 'FAILED', confirmedAt: null });
    expect(r.summary).toContain('лікаря не визначено');
    writeReport('G. Лікаря не визначено (немає змін лікарів)', c);
  });
});
