import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => app.close());

async function clinic() {
  const email = `b${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Власниця', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { token: res.body.accessToken as string, clinicId };
}
async function member(ownerToken: string, role: string) {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
}

async function seed(clinicId: string) {
  const mk = (name: string, over: Record<string, unknown> = {}) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: name, ...over } });
  const a = await mk('Антоненко Іван', { source: 'Instagram', lastVisitAt: ago(300), phone: '+380501110001', balanceIssued: 5000, balancePaid: 3000 });
  const b = await mk('=Формула Петро', { source: 'Google', lastVisitAt: ago(20), phone: '+380501110002', balanceIssued: 1000, balancePaid: 1000 });
  const c = await mk('Мельник Оксана', { source: 'Instagram', lastVisitAt: ago(400), phone: '+380501110003' });
  const visit = (patientId: string, status: string, days: number, amount: number, doctor: string) =>
    prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: ago(days), endsAt: ago(days), status, amount, doctorName: doctor, bookedAt: ago(days + 3) } });
  await visit(a.id, 'VISITED', 40, 1200, 'Лікар Перший');
  await visit(a.id, 'VISITED', 10, 800, 'Лікар Перший');
  await visit(b.id, 'DID_NOT_COME', 15, 0, 'Лікар Другий');
  await visit(b.id, 'VISITED', 70, 500, 'Лікар Другий');
  await prisma.planItem.create({ data: { clinicId, patientId: a.id, externalId: `i${rnd()}`, planId: 'pl1', name: 'Пломба', status: 'DONE', groupName: 'Терапія', price: 900, createdAtExt: ago(50), markedDoneAt: ago(40) } });
  await prisma.payment.create({ data: { clinicId, patientId: a.id, externalId: `pay${rnd()}`, paidAt: ago(10), amount: 2000, type: 'cash' } });
  return { a, b, c };
}

describe('конструктор отчётов', () => {
  it('каталог по ролям: деньги и платежи видит только руководство; врачу конструктор недоступен', async () => {
    const o = await clinic();
    const owner = (await http().get('/report-builder/catalog').set(auth(o.token)).expect(200)).body;
    expect(owner.map((d: { id: string }) => d.id)).toEqual(['patients', 'visits', 'treatment', 'payments', 'inquiries', 'requests', 'reviews']);
    expect(owner[0].fields.map((f: { key: string }) => f.key)).toContain('debt');
    const admin = await member(o.token, 'ADMIN');
    const adminCat = (await http().get('/report-builder/catalog').set(auth(admin)).expect(200)).body;
    expect(adminCat.map((d: { id: string }) => d.id)).not.toContain('payments');
    expect(JSON.stringify(adminCat)).not.toContain('"debt"');
    expect(JSON.stringify(adminCat)).not.toContain('"amount"');
    const doctor = await member(o.token, 'DOCTOR');
    await http().get('/report-builder/catalog').set(auth(doctor)).expect(403);
    const ru = (await http().get('/report-builder/catalog').set(auth(o.token)).set('Accept-Language', 'ru')).body;
    expect(ru[0].label).toBe('Пациенты');
  });

  it('отчёт со списком: фильтры, сортировка, подписи, относительные даты; чужие данные не попадают', async () => {
    const o = await clinic();
    const other = await clinic();
    await seed(o.clinicId);
    await seed(other.clinicId);
    const spec = { dataset: 'patients', columns: ['patientName', 'source', 'lastVisitAt', 'debt'], filters: [{ field: 'lastVisitAt', op: 'lte', value: '-180d' }, { field: 'source', op: 'eq', value: 'instagram' }], sort: { field: 'lastVisitAt', dir: 'asc' } };
    const res = (await http().post('/report-builder/run').set(auth(o.token)).send({ spec }).expect(200)).body;
    expect(res.rows.map((r: { patientName: string }) => r.patientName)).toEqual(['Мельник Оксана', 'Антоненко Іван']); // от старых к новым, чужая клиника не попала
    expect(res.rows[1].debt).toBe(2000);
    expect(res.columns.map((c: { label: string }) => c.label)).toEqual(['Пацієнт', 'Джерело звернення', 'Останній візит', 'Борг']);
    expect(res.rule).toContain('Набір даних: Пацієнти');
    expect(res.rule).toContain('Останній візит ≤ 180 дн. тому');
    expect(res.dataUpdatedAt).toBeNull();
  });

  it('группировка и итоги: по месяцам и по врачам, подписи статусов на языке запроса', async () => {
    const o = await clinic();
    await seed(o.clinicId);
    const byDoctor = (await http().post('/report-builder/run').set(auth(o.token)).send({ spec: { dataset: 'visits', filters: [{ field: 'status', op: 'eq', value: 'VISITED' }], groupBy: { field: 'doctorName' }, aggregates: [{ fn: 'count' }, { fn: 'sum', field: 'amount' }] } }).expect(200)).body;
    expect(byDoctor.rows).toEqual([
      { group: 'Лікар Перший', a0: 2, a1: 2000 },
      { group: 'Лікар Другий', a0: 1, a1: 500 },
    ]);
    expect(byDoctor.columns.map((c: { label: string }) => c.label)).toEqual(['Лікар', 'Кількість', 'Сума: Сума']);
    const byStatus = (await http().post('/report-builder/run').set(auth(o.token)).set('Accept-Language', 'en').send({ spec: { dataset: 'visits', groupBy: { field: 'status' }, aggregates: [{ fn: 'count' }] } }).expect(200)).body;
    expect(byStatus.rows.find((r: { group: string }) => r.group === 'No-show')).toMatchObject({ a0: 1 });
    const byMonth = (await http().post('/report-builder/run').set(auth(o.token)).send({ spec: { dataset: 'payments', groupBy: { field: 'paidAt', bucket: 'month' }, aggregates: [{ fn: 'sum', field: 'amount' }, { fn: 'max', field: 'paidAt' }] } }).expect(200)).body;
    expect(byMonth.rows).toHaveLength(1);
    expect(byMonth.rows[0].a0).toBe(2000);
    expect(byMonth.rows[0].group).toMatch(/^\d{4}-\d{2}$/);
  });

  it('неверные описания отклоняются с причиной; деньги недоступны администратору; в «Платежах» тоже', async () => {
    const o = await clinic();
    const admin = await member(o.token, 'ADMIN');
    const run = (token: string, spec: object) => http().post('/report-builder/run').set(auth(token)).send({ spec });
    const detail = async (token: string, spec: object) => (await run(token, spec).expect(400)).body.detail as string;
    expect(await detail(o.token, { dataset: 'nope', columns: ['x'] })).toContain('dataset');
    expect(await detail(o.token, { dataset: 'patients', columns: ['password'] })).toContain('field: password');
    expect(await detail(o.token, { dataset: 'patients', columns: ['patientName'], filters: [{ field: 'phone', op: 'gt', value: 1 }] })).toContain('op gt');
    expect(await detail(o.token, { dataset: 'patients', columns: ['patientName'], filters: [{ field: 'lastVisitAt', op: 'gte', value: 'вчора' }] })).toContain('date');
    expect(await detail(o.token, { dataset: 'patients', groupBy: { field: 'source' } })).toContain('aggregates required');
    expect(await detail(o.token, { dataset: 'patients', groupBy: { field: 'source' }, aggregates: [{ fn: 'sum', field: 'source' }] })).toContain('aggregate sum');
    expect(await detail(o.token, { dataset: 'patients' })).toContain('columns required');
    expect(await detail(admin, { dataset: 'patients', columns: ['patientName', 'debt'] })).toContain('forbidden field');
    expect(await detail(admin, { dataset: 'payments', columns: ['amount'] })).toContain('forbidden');
    await run(admin, { dataset: 'patients', columns: ['patientName', 'visitsCount'] }).expect(200);
  });

  it('выгрузка: Excel, PDF и CSV; всё пишется в историю действий; формулы в CSV обезврежены', async () => {
    const o = await clinic();
    await seed(o.clinicId);
    const body = { spec: { dataset: 'patients', columns: ['patientName', 'phone', 'balanceIssued'], sort: { field: 'patientName', dir: 'asc' } }, title: 'Мої пацієнти' };
    const xl = await http().post('/report-builder/export').set(auth(o.token)).send({ ...body, format: 'xlsx' }).buffer(true).parse(binary).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('Мої пацієнти');
    expect(ws.getRow(5).getCell(3).value).toBe('Виставлено');
    expect(ws.getRow(6).getCell(1).value).toBe('=Формула Петро'); // текст, а не формула
    expect(ws.getRow(6).getCell(3).value).toBe(1000); // число остаётся числом
    const pdf = await http().post('/report-builder/export').set(auth(o.token)).send({ ...body, format: 'pdf' }).buffer(true).parse(binary).expect(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const csv = await http().post('/report-builder/export').set(auth(o.token)).send({ ...body, format: 'csv' }).expect(200);
    expect(csv.text).toContain(`"'=Формула Петро"`);
    expect(await prisma.auditLog.count({ where: { clinicId: o.clinicId, action: 'report.exported' } })).toBe(3);
    await http().post('/report-builder/export').set(auth(o.token)).send({ ...body, format: 'docx' }).expect(400);
  });

  it('сохранённые отчёты: проверяются при сохранении, изолированы по клиникам, удаляются', async () => {
    const o = await clinic();
    const other = await clinic();
    await http().post('/report-builder/saved').set(auth(o.token)).send({ name: 'Плохой', spec: { dataset: 'patients', columns: ['zzz'] } }).expect(400);
    const saved = (await http().post('/report-builder/saved').set(auth(o.token)).send({ name: 'Давно не були', spec: { dataset: 'patients', columns: ['patientName'], filters: [{ field: 'lastVisitAt', op: 'lte', value: '-180d' }] } }).expect(201)).body;
    expect((await http().get('/report-builder/saved').set(auth(o.token))).body).toHaveLength(1);
    expect((await http().get('/report-builder/saved').set(auth(other.token))).body).toHaveLength(0);
    await http().delete(`/report-builder/saved/${saved.id}`).set(auth(other.token)).expect(404);
    await http().delete(`/report-builder/saved/${saved.id}`).set(auth(o.token)).expect(200);
    expect((await http().get('/report-builder/saved').set(auth(o.token))).body).toHaveLength(0);
  });
});

describe('конструктор: обращения, заявки, оценки и фильтр «один из»', () => {
  it('новые наборы считаются по своей клинике; «один из» работает для кодов и текста; итоги без денег доступны администратору', async () => {
    const o = await clinic();
    const other = await clinic();
    const p = await prisma.patient.create({ data: { clinicId: o.clinicId, externalId: `p${rnd()}`, fullName: 'Оцінений Пацієнт' } });
    const mkInq = (clinicId: string, channel: string, status: string) => prisma.inquiry.create({ data: { clinicId, channel, status, phone: '0501234567', note: 'x' } });
    await mkInq(o.clinicId, 'INSTAGRAM', 'OPEN');
    await mkInq(o.clinicId, 'PHONE', 'LOST');
    await mkInq(o.clinicId, 'GOOGLE', 'OPEN');
    await mkInq(other.clinicId, 'INSTAGRAM', 'OPEN');
    const run = (token: string, spec: object) => http().post('/report-builder/run').set(auth(token)).send({ spec }).expect(200);

    const byChannel = (await run(o.token, { dataset: 'inquiries', filters: [{ field: 'channel', op: 'in', value: ['INSTAGRAM', 'PHONE'] }], groupBy: { field: 'channel' }, aggregates: [{ fn: 'count' }] })).body;
    expect(byChannel.rows.map((r: { group: string }) => r.group).sort()).toEqual(['INSTAGRAM', 'PHONE']);
    const lost = (await run(o.token, { dataset: 'inquiries', columns: ['channel', 'status'], filters: [{ field: 'status', op: 'in', value: ['LOST'] }] })).body;
    expect(lost.rows).toEqual([{ channel: 'PHONE', status: 'Втрачене' }]);

    await prisma.bookingRequest.create({ data: { clinicId: o.clinicId, patientId: p.id, channel: 'TELEGRAM', chatId: 'c', kind: 'RESCHEDULE', summary: 'Перенести' } });
    await prisma.bookingRequest.create({ data: { clinicId: o.clinicId, channel: 'TELEGRAM', chatId: 'd', kind: 'REVIEW', summary: 'Низька', contactName: 'Анонім', status: 'DONE' } });
    const req = (await run(o.token, { dataset: 'requests', columns: ['kind', 'status', 'patientName'], sort: { field: 'createdAt', dir: 'asc' } })).body;
    expect(req.rows).toHaveLength(2);
    expect(req.rows.map((r: { patientName: string }) => r.patientName).sort()).toEqual(['Анонім', 'Оцінений Пацієнт']);

    const v1 = await prisma.visit.create({ data: { clinicId: o.clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: new Date(), status: 'VISITED' } });
    await prisma.review.create({ data: { clinicId: o.clinicId, patientId: p.id, visitId: v1.id, rating: 2, doctorName: 'Лікар', comment: 'Довго' } });
    const admin = await member(o.token, 'ADMIN');
    const rev = (await run(admin, { dataset: 'reviews', groupBy: { field: 'doctorName' }, aggregates: [{ fn: 'count' }, { fn: 'avg', field: 'rating' }] })).body;
    expect(rev.rows).toEqual([{ group: 'Лікар', a0: 1, a1: 2 }]);
    expect((await run(other.token, { dataset: 'reviews', columns: ['rating'] })).body.rows).toEqual([]);
    await http().post('/report-builder/run').set(auth(o.token)).send({ spec: { dataset: 'inquiries', columns: ['channel'], filters: [{ field: 'channel', op: 'in', value: 'INSTAGRAM' }] } }).expect(400); // «один из» требует список
  });
});
