import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { ageOf } from '../src/patients/patients.controller';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(120_000);

const rnd = () => Math.random().toString(36).slice(2, 9);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;

// The patient card on Cliniccards data: the extra card fields from a load through the mock, the summary, the tabs, roles and clinic isolation
describe('картка пацієнта', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockHandle;
  let clinicId: string;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
    process.env.CLINICCARDS_BASE_URL = mock.url;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new I18nExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    const email = `pc${rnd()}@example.com`;
    tokens.OWNER = (await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Картка ${rnd()}`, name: 'Анна', email, password: 'password123' }).expect(201)).body.accessToken;
    clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
    for (const role of ['ADMIN', 'DOCTOR', 'ANALYST']) {
      const inv = await http().post('/team/invitations').set(auth(tokens.OWNER)).send({ email: `pc${role.toLowerCase()}${rnd()}@example.com`, role }).expect(201);
      tokens[role] = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: role, password: 'password123' }).expect(201)).body.accessToken;
    }
    // the demo load creates the integration record first (the same order as mock.spec.ts)
    await http().post('/integrations/cliniccards/sync').set(auth(tokens.OWNER)).expect(201);
    await http().put('/integrations/cliniccards/key').set(auth(tokens.OWNER)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/integrations/cliniccards/sync').set(auth(tokens.OWNER)).expect(201);
  });
  afterAll(async () => {
    await app.close();
    await mock.close();
    delete process.env.CLINICCARDS_BASE_URL;
  });

  const byExt = (ext: string) => prisma.patient.findFirstOrThrow({ where: { clinicId, externalId: ext } });

  it('завантаження бере додаткові поля картки: другий телефон, пошту, стать, статуси (назвою й номером), філію; нотатки картки не читаються', async () => {
    // mock patient i=0: email, phone2 (i % 7), status VIP as an object (i % 9), branch; i=13: status 2 as an id
    const p0 = await byExt(String(mock.data.patients[0].patient_id));
    expect(p0).toMatchObject({ email: 'patient1@example.com', gender: 'M', subclinic: 'Центр', tags: ['VIP'] });
    expect(p0.phone2).toMatch(/^38067/);
    const byId = mock.data.patients.find((x) => Array.isArray(x.statuses) && x.statuses[0] === '2')!;
    expect((await byExt(String(byId.patient_id))).tags).toEqual(['Боржник']);
    // the statuses list is read once per load, only because a status came as an id
    expect(mock.requests.filter((r) => r.path === '/patientStatuses')).toHaveLength(1);
    // nothing medical is read, nothing is written to Cliniccards
    expect(mock.requests.some((r) => r.path.startsWith('/stages') || r.path.startsWith('/files'))).toBe(false);
    expect(mock.writes).toHaveLength(0);
  });

  it('вік за датою народження в часі клініки', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    expect(ageOf(new Date('1985-05-05T00:00:00Z'), now)).toBe(41);
    expect(ageOf(new Date('1985-11-25T00:00:00Z'), now)).toBe(40);
    expect(ageOf(new Date('1985-11-24T00:00:00Z'), now)).toBe(41);
    expect(ageOf(null, now)).toBeNull();
    expect(ageOf(new Date('2030-01-01T00:00:00Z'), now)).toBeNull();
  });

  it('зведення: найближчий візит, лічильники вкладок, час завантаження; гроші й переписки за ролями', async () => {
    const p = await byExt(String(mock.data.patients[1].patient_id));
    await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `x${rnd()}`, startsAt: new Date(Date.now() + 3 * DAY), status: 'PLANNED', doctorName: 'Іваненко', serviceName: 'Гігієна' } });
    await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `x${rnd()}`, startsAt: new Date(Date.now() + 2 * DAY), status: 'CANCELLED' } });
    const card = (await http().get(`/patients/${p.id}`).set(auth(tokens.OWNER)).expect(200)).body;
    expect(card.nextVisit).toMatchObject({ doctorName: 'Іваненко', serviceName: 'Гігієна', status: 'PLANNED' });
    expect(card.lastSyncAt).toBeTruthy();
    expect(card.counts.visits).toBe(await prisma.visit.count({ where: { patientId: p.id } }));
    expect(card.counts).toHaveProperty('finance');
    expect(card.access).toEqual({ money: true, chats: true, lanka: true, write: true });
    expect(card.visits.length).toBeLessThanOrEqual(5);
    const doc = (await http().get(`/patients/${p.id}`).set(auth(tokens.DOCTOR)).expect(200)).body;
    expect(doc.access).toEqual({ money: false, chats: false, lanka: false, write: false });
    expect(doc.counts).not.toHaveProperty('finance');
    expect(doc.counts).not.toHaveProperty('chats');
    expect(doc).not.toHaveProperty('balanceIssued');
    const an = (await http().get(`/patients/${p.id}`).set(auth(tokens.ANALYST)).expect(200)).body;
    expect(an.access).toMatchObject({ money: true, chats: false, lanka: true, write: false });
  });

  it('історія візитів порціями, від нових до старих; лікар без сум', async () => {
    const p = await byExt(String(mock.data.patients[2].patient_id));
    for (let i = 0; i < 30; i++) await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `h${rnd()}`, startsAt: new Date(Date.now() - (i + 40) * DAY), status: 'VISITED', amount: 500 } });
    const total = await prisma.visit.count({ where: { patientId: p.id } });
    const one = (await http().get(`/patients/${p.id}/visits?page=1`).set(auth(tokens.OWNER)).expect(200)).body;
    const two = (await http().get(`/patients/${p.id}/visits?page=2`).set(auth(tokens.OWNER)).expect(200)).body;
    expect(one).toMatchObject({ total, page: 1, pageSize: 25 });
    expect(one.rows).toHaveLength(25);
    expect(two.rows).toHaveLength(total - 25);
    const dates = [...one.rows, ...two.rows].map((v: { startsAt: string }) => Date.parse(v.startsAt));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(new Set([...one.rows, ...two.rows].map((v: { id: string }) => v.id)).size).toBe(total);
    const doc = (await http().get(`/patients/${p.id}/visits?page=1`).set(auth(tokens.DOCTOR)).expect(200)).body;
    expect(doc.rows[0]).not.toHaveProperty('amount');
    expect(one.rows.find((v: { amount?: string }) => v.amount)).toBeTruthy();
  });

  it('плани лікування згруповано за планом з виконаними роботами; ціни й підсумки плану лікарю не видно', async () => {
    const withPlan = await prisma.planItem.findFirstOrThrow({ where: { clinicId }, select: { patientId: true } });
    const own = (await http().get(`/patients/${withPlan.patientId}/treatment`).set(auth(tokens.OWNER)).expect(200)).body;
    const items = await prisma.planItem.count({ where: { patientId: withPlan.patientId } });
    expect(own.plans.flatMap((pl: { items: unknown[] }) => pl.items)).toHaveLength(items);
    expect(own.plans[0].items[0]).toHaveProperty('price');
    const doc = (await http().get(`/patients/${withPlan.patientId}/treatment`).set(auth(tokens.DOCTOR)).expect(200)).body;
    expect(doc.plans[0].items[0]).not.toHaveProperty('price');
    expect(doc.plans[0]).not.toHaveProperty('total');
  });

  it('рахунки й оплати разом за датою, порціями, з балансом картки; лікарю закрито', async () => {
    const pay = await prisma.payment.findFirstOrThrow({ where: { clinicId, patientId: { not: null } }, select: { patientId: true } });
    const pid = pay.patientId!;
    const f = (await http().get(`/patients/${pid}/finance`).set(auth(tokens.OWNER)).expect(200)).body;
    const n = (await prisma.payment.count({ where: { patientId: pid } })) + (await prisma.invoice.count({ where: { patientId: pid } }));
    expect(f.total).toBe(n);
    expect(f.rows.length).toBe(Math.min(n, 25));
    expect(f.rows[0]).toHaveProperty('currency');
    expect(f.balance === null || typeof f.balance.debt === 'number').toBe(true);
    const dates = f.rows.map((r: { date: string }) => Date.parse(r.date));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    await http().get(`/patients/${pid}/finance`).set(auth(tokens.DOCTOR)).expect(403);
    await http().get(`/patients/${pid}/finance`).set(auth(tokens.ANALYST)).expect(200);
  });

  it('LANKA: переписки лише через прив’язку месенджера (не за іменем), заявки й звернення; ролі', async () => {
    const p = await byExt(String(mock.data.patients[3].patient_id));
    await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `tg${rnd()}` } });
    const link = await prisma.patientChannel.findFirstOrThrow({ where: { patientId: p.id } });
    await prisma.chatMessage.create({ data: { clinicId, channel: 'TELEGRAM', chatId: link.externalId, direction: 'IN', text: 'Добрий день', contactName: p.fullName } });
    // a chat of a stranger with the same name, not linked to this card: never shown
    await prisma.chatMessage.create({ data: { clinicId, channel: 'INSTAGRAM', chatId: `ig${rnd()}`, direction: 'IN', text: 'Привіт', contactName: p.fullName } });
    await prisma.bookingRequest.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', chatId: link.externalId, kind: 'BOOKING', summary: 'Гігієна в четвер' } });
    const v = (await http().get(`/patients/${p.id}/lanka`).set(auth(tokens.ADMIN)).expect(200)).body;
    expect(v.conversations).toEqual([expect.objectContaining({ channel: 'TELEGRAM', chatId: link.externalId, lastIn: true })]);
    expect(v.requests).toEqual([expect.objectContaining({ summary: 'Гігієна в четвер', status: 'NEW' })]);
    const an = (await http().get(`/patients/${p.id}/lanka`).set(auth(tokens.ANALYST)).expect(200)).body;
    expect(an).toMatchObject({ access: { chats: false }, conversations: [], requests: [] });
    await http().get(`/patients/${p.id}/lanka`).set(auth(tokens.DOCTOR)).expect(403);
  });

  it('інша клініка не бачить картки й вкладок', async () => {
    const p = await byExt(String(mock.data.patients[4].patient_id));
    const other = (await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Інша ${rnd()}`, name: 'Борис', email: `pco${rnd()}@example.com`, password: 'password123' }).expect(201)).body.accessToken;
    for (const path of ['', '/visits', '/treatment', '/finance', '/lanka']) await http().get(`/patients/${p.id}${path}`).set(auth(other)).expect(404);
    expect(mock.writes).toHaveLength(0);
  });
});
