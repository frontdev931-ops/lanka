import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { CliniccardsClient } from '../src/integrations/cliniccards.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(90_000);

let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
});

beforeEach(() => {
  mock.writes.length = 0;
  mock.control.failWith = undefined;
  mock.control.dropReplyAfterWrite = false;
});

// A clinic connected to the mock Cliniccards and synced; writing is switched on by the service owner (here directly)
async function clinic(writeOn = true) {
  const email = `b${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200); // creates the integration row
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  if (writeOn) await prisma.clinic.update({ where: { id: clinicId }, data: { bookingWriteEnabled: true } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { clinicId, removedAt: null }, orderBy: { externalId: 'asc' } });
  const cabinet = await prisma.cabinet.findFirstOrThrow({ where: { clinicId }, orderBy: { externalId: 'asc' } });
  return { token, clinicId, patient, cabinet };
}
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};
// A free day far enough from the made-up visits (they end 60 days ahead at most), clinic-local 10:00 UTC+2/3 is fine for any season
let dayOffset = 100;
const nextStart = () => {
  const d = new Date(Date.now() + ++dayOffset * 86_400_000);
  d.setUTCHours(8, 0, 0, 0);
  return d;
};
const body = (c: Awaited<ReturnType<typeof clinic>>, startsAt: Date, over: Record<string, unknown> = {}) => ({ patientId: c.patient.id, startsAt: startsAt.toISOString(), durationMin: 30, cabinetId: c.cabinet.externalId, ...over });

describe('запис у Cliniccards (на імітації)', () => {
  it('вимкнений за замовчуванням: ні запису, ні виклику Cliniccards; вмикає лише власник сервісу (прапорець клініки)', async () => {
    const c = await clinic(false);
    expect((await http().get('/bookings/status').set(auth(c.token)).expect(200)).body.enabled).toBe(false);
    await http().post('/bookings').set(auth(c.token)).send(body(c, nextStart())).expect(400);
    expect(mock.writes).toHaveLength(0);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true } });
    expect((await http().get('/bookings/status').set(auth(c.token))).body.enabled).toBe(true);
  });

  it('створює запис один раз: повторний запит повертає той самий результат, у Cliniccards один візит; заявка закривається', async () => {
    const c = await clinic();
    const start = nextStart();
    const req = await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, patientId: c.patient.id, channel: 'TELEGRAM', chatId: 'x1', kind: 'BOOKING', summary: 'Хоче чистку' } });
    const a = await http().post('/bookings').set(auth(c.token)).send(body(c, start, { requestId: req.id })).expect(200);
    expect(a.body).toMatchObject({ duplicate: false, verified: true });
    const b = await http().post('/bookings').set(auth(c.token)).send(body(c, start, { requestId: req.id })).expect(200);
    expect(b.body).toMatchObject({ duplicate: true, externalVisitId: a.body.externalVisitId });
    expect(mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits')).toHaveLength(1);
    expect(mock.data.visits.filter((v) => String(v.visit_id) === a.body.externalVisitId)).toHaveLength(1);
    expect(await prisma.visit.findFirst({ where: { clinicId: c.clinicId, externalId: a.body.externalVisitId } })).toMatchObject({ patientId: c.patient.id, status: 'PLANNED' });
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('DONE');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking.created' } })).toBe(1);
  });

  it('два одночасні запити на один час дають один запис', async () => {
    const c = await clinic();
    const start = nextStart();
    const rs = await Promise.all([1, 2, 3].map(() => http().post('/bookings').set(auth(c.token)).send(body(c, start))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(1);
  });

  it('перед записом перевіряється актуальний розклад: зайнятий кабінет, закритий блок і подвійний запис пацієнта відхиляються без запису', async () => {
    const c = await clinic();
    const start = nextStart();
    const first = await http().post('/bookings').set(auth(c.token)).send(body(c, start)).expect(200);
    expect(first.body.verified).toBe(true);
    mock.writes.length = 0;
    // another patient, the same cabinet, overlapping time: taken (the check reads fresh data, our copy is not used)
    const other = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, id: { not: c.patient.id } }, orderBy: { externalId: 'asc' } });
    const r1 = await http().post('/bookings').set(auth(c.token)).send(body(c, new Date(start.getTime() + 15 * 60_000), { patientId: other.id })).expect(409);
    expect(JSON.stringify(r1.body)).toContain('зайнято');
    // the same patient in another cabinet at the same time
    const cabs = await prisma.cabinet.findMany({ where: { clinicId: c.clinicId } });
    const r2 = await http().post('/bookings').set(auth(c.token)).send(body(c, new Date(start.getTime() + 15 * 60_000), { cabinetId: cabs.find((x) => x.externalId !== c.cabinet.externalId)!.externalId })).expect(409);
    expect(JSON.stringify(r2.body)).toContain('вже є запис');
    // a visit made directly in Cliniccards after our last sync is seen too
    const start2 = nextStart();
    mock.data.visits.push({ visit_id: '777001', patient_id: '1', status: 'PLANNED', doctor_id: null, doctor: '', cabinet_id: c.cabinet.externalId, cabinet: c.cabinet.name, date_created: '2026-01-01 00:00:00', date_edited: '2026-01-01 00:00:00', visit_start: `${start2.toISOString().slice(0, 10)} ${String(start2.getUTCHours() + 2).padStart(2, '0')}:00:00`, visit_end: `${start2.toISOString().slice(0, 10)} ${String(start2.getUTCHours() + 2).padStart(2, '0')}:30:00`, note: '', price_items: null });
    await http().post('/bookings').set(auth(c.token)).send(body(c, start2, { patientId: other.id })).expect(409);
    expect(mock.writes).toHaveLength(0);
    // a different time is fine
    await http().post('/bookings').set(auth(c.token)).send(body(c, new Date(start.getTime() + 2 * 3_600_000))).expect(200);
  });

  it('відповідь загубилась після запису: стан невідомий, повтор не створює другий запис, а знаходить перший', async () => {
    const c = await clinic();
    const start = nextStart();
    mock.control.dropReplyAfterWrite = true;
    const lost = await http().post('/bookings').set(auth(c.token)).send(body(c, start)).expect(409);
    expect(JSON.stringify(lost.body)).toContain('вручну');
    const attempt = await prisma.bookingAttempt.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(attempt.status).toBe('UNKNOWN');
    expect(mock.data.visits.filter((v) => String(v.visit_start).startsWith(start.toISOString().slice(0, 10)) && String(v.patient_id) === c.patient.externalId)).toHaveLength(1);

    mock.control.dropReplyAfterWrite = false;
    const retry = await http().post('/bookings').set(auth(c.token)).send(body(c, start)).expect(200);
    expect(retry.body.duplicate).toBe(true);
    expect(mock.writes.filter((w) => w.method === 'POST' && w.path === '/visits')).toHaveLength(1);
    expect(await prisma.visit.count({ where: { clinicId: c.clinicId, patientId: c.patient.id, startsAt: start } })).toBe(1);
  });

  it('Cliniccards відмовив: нічого не збережено, повтор після виправлення працює', async () => {
    const c = await clinic();
    const start = nextStart();
    mock.control.failWith = 400;
    await http().post('/bookings').set(auth(c.token)).send(body(c, start)).expect(400);
    expect((await prisma.bookingAttempt.findFirstOrThrow({ where: { clinicId: c.clinicId } })).status).toBe('FAILED');
    expect(await prisma.visit.count({ where: { clinicId: c.clinicId, startsAt: start } })).toBe(0);
    mock.control.failWith = undefined;
    await http().post('/bookings').set(auth(c.token)).send(body(c, start)).expect(200);
    expect(mock.data.visits.filter((v) => String(v.visit_start).startsWith(start.toISOString().slice(0, 10)))).toHaveLength(1);
  });

  it('перенесення, підтвердження й скасування змінюють запис у Cliniccards, примітка зберігається; повторна дія нічого не дублює', async () => {
    const c = await clinic();
    const start = nextStart();
    const made = (await http().post('/bookings').set(auth(c.token)).send(body(c, start, { note: 'Біль у зубі, не чіпати' })).expect(200)).body;
    const visit = await prisma.visit.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: made.externalVisitId } });

    const moved = new Date(start.getTime() + 3 * 3_600_000);
    await http().post(`/bookings/visits/${visit.id}/reschedule`).set(auth(c.token)).send({ startsAt: moved.toISOString() }).expect(200);
    await http().post(`/bookings/visits/${visit.id}/reschedule`).set(auth(c.token)).send({ startsAt: moved.toISOString() }).expect(200);
    expect(mock.writes.filter((w) => w.method === 'PUT')).toHaveLength(1);
    const raw = mock.data.visits.find((v) => String(v.visit_id) === made.externalVisitId)!;
    expect(raw.note).toBe('Біль у зубі, не чіпати');
    expect(String(raw.visit_start)).toContain(':00:00');
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).startsAt.getTime()).toBe(moved.getTime());

    await http().post(`/bookings/visits/${visit.id}/confirm`).set(auth(c.token)).expect(200);
    expect(raw.status).toBe('CONFIRMED');
    await http().post(`/bookings/visits/${visit.id}/cancel`).set(auth(c.token)).expect(200);
    await http().post(`/bookings/visits/${visit.id}/cancel`).set(auth(c.token)).expect(400); // already cancelled: no longer changeable
    expect(raw.status).toBe('CANCELLED');
    expect(mock.data.visits.filter((v) => String(v.visit_id) === made.externalVisitId)).toHaveLength(1);
    // the freed place can be booked again
    await http().post('/bookings').set(auth(c.token)).send(body(c, moved)).expect(200);
  });

  it('права й ізоляція: лікар не записує; чужа клініка не бачить і не змінює візити', async () => {
    const a = await clinic();
    const b = await clinic();
    const doctor = await member(a.token, 'DOCTOR');
    await http().post('/bookings').set(auth(doctor)).send(body(a, nextStart())).expect(403);
    const made = (await http().post('/bookings').set(auth(a.token)).send(body(a, nextStart())).expect(200)).body;
    const visit = await prisma.visit.findFirstOrThrow({ where: { clinicId: a.clinicId, externalId: made.externalVisitId } });
    await http().post(`/bookings/visits/${visit.id}/cancel`).set(auth(b.token)).expect(400);
    await http().post('/bookings').set(auth(b.token)).send(body(a, nextStart())).expect(400); // a's patient is unknown to b
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('PLANNED');
  });

  it('погані дані: минулий час, не кратний 5 хвилинам, чужий день', async () => {
    const c = await clinic();
    await http().post('/bookings').set(auth(c.token)).send(body(c, new Date(Date.now() - 86_400_000))).expect(400);
    const odd = nextStart();
    odd.setUTCMinutes(7);
    await http().post('/bookings').set(auth(c.token)).send(body(c, odd)).expect(400);
    await http().post('/bookings').set(auth(c.token)).send(body(c, nextStart(), { durationMin: 600 })).expect(400);
    expect(mock.writes).toHaveLength(0);
  });
});

describe('пацієнт при записі', () => {
  it('за телефоном знаходить картку; особа перевіряється кодом (прізвище або дата народження), лише тоді чат прив’язується', async () => {
    const c = await clinic();
    await prisma.patient.update({ where: { id: c.patient.id }, data: { phone: '0507776655', phoneNorm: '380507776655', fullName: 'Мельник Олена Іванівна', birthDate: new Date('1990-03-05T00:00:00Z') } });
    const m = (await http().post('/bookings/patients/match').set(auth(c.token)).send({ phone: '+38 (050) 777-66-55' }).expect(200)).body;
    expect(m).toHaveLength(1);
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'v1', direction: 'IN', text: 'Привіт' } });
    const bad = (await http().post('/bookings/patients/verify').set(auth(c.token)).send({ patientId: c.patient.id, answer: 'Петренко', channel: 'TELEGRAM', chatId: 'v1' }).expect(200)).body;
    expect(bad.verified).toBe(false);
    expect(await prisma.patientChannel.count({ where: { patientId: c.patient.id } })).toBe(0);
    expect((await http().post('/bookings/patients/verify').set(auth(c.token)).send({ patientId: c.patient.id, answer: 'я мельник', channel: 'TELEGRAM', chatId: 'v1' }).expect(200)).body.verified).toBe(true);
    expect(await prisma.patientChannel.findFirst({ where: { patientId: c.patient.id } })).toMatchObject({ channel: 'TELEGRAM', externalId: 'v1' });
    expect((await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: 'v1' } })).patientId).toBe(c.patient.id);
    expect((await http().post('/bookings/patients/verify').set(auth(c.token)).send({ patientId: c.patient.id, answer: '05.03.1990' }).expect(200)).body.verified).toBe(true);
  });

  it('нова картка створюється в Cliniccards один раз і без дублів: той самий телефон повертає наявну', async () => {
    const c = await clinic();
    const phone = `050${Math.floor(1000000 + Math.random() * 8999999)}`;
    const a = (await http().post('/bookings/patients').set(auth(c.token)).send({ fullName: 'Новак Тарас', phone, source: 'Instagram', channel: 'INSTAGRAM', chatId: 'n1' }).expect(200)).body;
    expect(a.existing).toBe(false);
    const b = (await http().post('/bookings/patients').set(auth(c.token)).send({ fullName: 'Новак Тарас', phone: `+38${phone}` }).expect(200)).body;
    expect(b).toMatchObject({ existing: true, patientId: a.patientId });
    expect(mock.writes.filter((w) => w.path === '/patients')).toHaveLength(1);
    expect(mock.writes.find((w) => w.path === '/patients')!.body).toMatchObject({ lastname: 'Новак', firstname: 'Тарас', source: 'Instagram' });
    expect(await prisma.patientChannel.findFirst({ where: { patientId: a.patientId } })).toMatchObject({ channel: 'INSTAGRAM', externalId: 'n1' });
    await http().post('/bookings/patients').set(auth(c.token)).send({ fullName: 'Одинслово', phone: '0501234567' }).expect(400);
  });

  it('втрачена відповідь при створенні картки: повтор знаходить створену, а не робить другу', async () => {
    const c = await clinic();
    const phone = `067${Math.floor(1000000 + Math.random() * 8999999)}`;
    mock.control.dropReplyAfterWrite = true;
    await http().post('/bookings/patients').set(auth(c.token)).send({ fullName: 'Втрата Відповіді', phone }).expect(409);
    mock.control.dropReplyAfterWrite = false;
    // the phone filter of the mock finds the card; the retry reconciles instead of writing again
    const r = await http().post('/bookings/patients').set(auth(c.token)).send({ fullName: 'Втрата Відповіді', phone }).expect(200);
    expect(r.body.existing).toBe(false);
    expect(mock.writes.filter((w) => w.path === '/patients')).toHaveLength(1);
  });
});

describe('захист справжнього Cliniccards', () => {
  it('клієнт не пише на справжню адресу без другого ключа; шляхи платежів і видалення недоступні в будь-якому випадку', async () => {
    const saved = process.env.CLINICCARDS_BASE_URL;
    delete process.env.CLINICCARDS_BASE_URL;
    try {
      const real = new CliniccardsClient('k', { minIntervalMs: 0 });
      delete process.env.CLINICCARDS_WRITE_LIVE;
      await expect(real.post('/visits', {})).rejects.toThrow('не разрешена');
      await expect(real.put('/visits', {})).rejects.toThrow('не разрешена');
    } finally {
      process.env.CLINICCARDS_BASE_URL = saved;
    }
    const c = new CliniccardsClient(MOCK_KEY, { baseUrl: mock.url, minIntervalMs: 0 });
    for (const p of ['/receive-patients-payment', '/invoice', '/save-deposit', '/spendings']) await expect(c.post(p, {})).rejects.toThrow('не разрешён');
    process.env.CLINICCARDS_WRITE_ENABLED = 'false';
    await expect(c.post('/visits', {})).rejects.toThrow('отключена');
    process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  });

  it('прапорець клініки вмикає лише власник сервісу', async () => {
    const c = await clinic(false);
    await http().patch(`/platform/clinics/${c.clinicId}`).set(auth(c.token)).send({ bookingWriteEnabled: true }).expect(403);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).bookingWriteEnabled).toBe(false);
  });
});
