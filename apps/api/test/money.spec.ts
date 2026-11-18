import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DigestService } from '../src/automations/digest.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

// Currency of the amounts from Cliniccards (common/money.ts). Cliniccards sends amounts without a currency: nothing is assumed, the clinic's owner
// states it, every loaded amount keeps its own stamp, amounts in different currencies are never added up, service prices are never labelled.
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => app.close());

// a clinic with the made-up data loaded (the demo connector: no Cliniccards key)
async function clinic() {
  const email = `m${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  const token = res.body.accessToken as string;
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  return { token, clinicId };
}
const member = async (owner: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(owner)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201)).body.accessToken as string;
};
const head = (csv: string) => csv.split('\r\n')[0];
const report = (token: string, id: string, lang = 'uk') => http().get(`/reports/${id}`).set(auth(token)).set('Accept-Language', lang).expect(200).then((r) => r.body);
const setCurrency = (token: string, currency: string, correct = false, scope?: 'finance' | 'plans') => http().put('/integrations/cliniccards/currency').set(auth(token)).send({ currency, correct, ...(scope ? { scope } : {}) });

describe('валюта сум із Cliniccards', () => {
  it('не вказана: нічого не вважається гривнею — підписи й правило кажуть «валюта не підтверджена», у CSV так само', async () => {
    const c = await clinic();
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, NOT: { currency: null } } })).toBe(0);
    const debtors = await report(c.token, 'debtors');
    expect(debtors.currency).toEqual({ code: null, state: 'unknown' });
    const debt = debtors.columns.find((x: { key: string }) => x.key === 'debt');
    expect(debt.label).toBe('Борг (валюта не підтверджена)');
    expect(debtors.rule).toContain('Валюту сум не підтверджено');
    const csv = head((await http().get('/reports/debtors/csv').set(auth(c.token)).expect(200)).text);
    expect(csv).toContain('"Борг (валюта не підтверджена)"');
    expect(csv).not.toMatch(/грн|UAH/);
    expect((await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200)).body.currency).toMatchObject({ code: null, options: expect.arrayContaining(['UAH', 'USD']) });
  });

  it('власник вказує валюту: суми позначаються, у журналі дій хто й коли; керуючий і адміністратор не можуть; невідомий код — 400; інша клініка не зачеплена', async () => {
    const a = await clinic();
    const b = await clinic();
    await setCurrency(await member(a.token, 'MANAGER'), 'UAH').expect(403);
    await setCurrency(await member(a.token, 'ADMIN'), 'UAH').expect(403);
    await setCurrency(a.token, 'XYZ').expect(400);
    const st = (await setCurrency(a.token, 'UAH').expect(200)).body;
    expect(st.currency.code).toBe('UAH');
    expect(await prisma.payment.count({ where: { clinicId: a.clinicId, currency: null } })).toBe(0);
    expect(await prisma.patient.count({ where: { clinicId: a.clinicId, balanceCurrency: null } })).toBe(0);
    expect(await prisma.payment.count({ where: { clinicId: b.clinicId, NOT: { currency: null } } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { clinicId: a.clinicId, action: 'clinic.currency' } })).toMatchObject({ details: expect.objectContaining({ before: null, after: 'UAH' }) });

    const uk = await report(a.token, 'debtors');
    expect(uk.currency).toEqual({ code: 'UAH', state: 'one' });
    expect(uk.columns.find((x: { key: string }) => x.key === 'debt').label).toBe('Борг, грн');
    expect(head((await http().get('/reports/debtors/csv').set(auth(a.token)).set('Accept-Language', 'en').expect(200)).text)).toContain('"Debt, UAH"');
    // the sources report sums visit amounts (service prices): never labelled with a currency, the rule says why
    const sources = await report(a.token, 'sources');
    expect(sources.columns.find((x: { key: string }) => x.key === 'revenue').label).toBe('Сума послуг (ціни послуг, без конвертації)');
    expect(sources.rule).toContain('не конвертовано');
  });

  it('плани — окремою заявою: валюта оплат не позначає підсумки планів; плани можна лишити непідтвердженими або вказати іншу валюту; ціни позицій не позначаються ніколи', async () => {
    const c = await clinic();
    const plans = () => prisma.treatmentPlan.findMany({ where: { clinicId: c.clinicId }, select: { currency: true } });
    expect((await plans()).length).toBeGreaterThan(0);
    await setCurrency(c.token, 'UAH').expect(200);
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, currency: null } })).toBe(0);
    // the payments statement leaves every plan total unconfirmed, also after the next load
    await http().post('/integrations/cliniccards/sync').set(auth(c.token)).expect(201);
    expect((await plans()).every((p) => p.currency === null)).toBe(true);
    const unfinished = await report(c.token, 'unfinished-treatment');
    expect(unfinished.columns.find((x: { key: string }) => x.key === 'openSum').label).toBe('Сума невиконаного (валюта не підтверджена)');
    // a clinic that keeps its plans in USD says so for plans only; payments keep UAH
    const st = (await setCurrency(c.token, 'USD', false, 'plans').expect(200)).body.currency;
    expect(st).toMatchObject({ code: 'UAH', planCode: 'USD' });
    expect((await plans()).every((p) => p.currency === 'USD')).toBe(true);
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, NOT: { currency: 'UAH' } } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { clinicId: c.clinicId, action: 'clinic.currency' }, orderBy: { createdAt: 'desc' } })).toMatchObject({ details: expect.objectContaining({ scope: 'plans', after: 'USD' }) });
    await setCurrency(c.token, 'UAH', false, 'everything' as never).expect(400);
    // plan item prices and visit amounts stay unlabelled
    const items = await http().post('/report-builder/run').set(auth(c.token)).send({ spec: { dataset: 'treatment', columns: ['name', 'price'] } }).expect(200);
    expect(items.body.columns.find((x: { key: string }) => x.key === 'price').label).toContain('без конвертації');
  });

  it('зміна валюти: без виправлення старі суми лишаються зі своєю позначкою, нові — з новою; разом не додаються; виправлення переписує все й записується', async () => {
    const c = await clinic();
    await setCurrency(c.token, 'UAH').expect(200);
    await setCurrency(c.token, 'USD').expect(200);
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, currency: 'USD' } })).toBe(0);
    // a payment loaded after the change gets USD (the load stamps only amounts without a stamp)
    const p = (await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId } })).id;
    await prisma.payment.create({ data: { clinicId: c.clinicId, patientId: p, externalId: `new-${rnd()}`, paidAt: new Date(), amount: 100 } });
    await http().post('/integrations/cliniccards/sync').set(auth(c.token)).expect(201);
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, currency: 'USD' } })).toBe(1);

    // revenue: this month is two rows, one per currency, with a currency column; no unit in the labels; the rule says amounts are kept apart
    const rev = await report(c.token, 'revenue');
    expect(rev.currency.state).toBe('mixed');
    expect(rev.columns.map((x: { key: string }) => x.key)).toContain('currency');
    expect(rev.columns.find((x: { key: string }) => x.key === 'paid').label).toBe('Сплачено');
    const month = rev.rows[0].month;
    const thisMonth = rev.rows.filter((r: { month: string }) => r.month === month);
    expect(thisMonth.map((r: { currency: string }) => r.currency).sort()).toEqual(['UAH', 'USD']);
    expect(thisMonth.find((r: { currency: string }) => r.currency === 'USD').paid).toBe(100);
    expect(rev.rule).toContain('не додаються');
    expect(head((await http().get('/reports/revenue/csv').set(auth(c.token)).expect(200)).text)).toContain('"Валюта"');

    // the digest: one line per currency, never one sum
    const n = await app.get(DigestService).numbers(c.clinicId, 'WEEKLY', new Date(Date.now() + 86_400_000));
    expect(n.paid.find((x) => x.currency === 'USD')?.amount).toBe(100);
    const text = app.get(DigestService).format(n, 'Клініка', 'WEEKLY', 'uk', 'https://example.com');
    expect(text).toContain('100 USD');

    // a correction relabels everything, and says so in the log
    await setCurrency(c.token, 'EUR', true).expect(200);
    expect(await prisma.payment.count({ where: { clinicId: c.clinicId, NOT: { currency: 'EUR' } } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { clinicId: c.clinicId, action: 'clinic.currency' }, orderBy: { createdAt: 'desc' } })).toMatchObject({ details: expect.objectContaining({ before: 'USD', after: 'EUR', correct: true }) });
  });

  it('конструктор: суми платежів діляться за валютою; суми візитів позначено «без конвертації»; один рядок пацієнта з різними валютами — текстом по валютах', async () => {
    const c = await clinic();
    await setCurrency(c.token, 'UAH').expect(200);
    // a fresh card of its own (the made-up ones already have plans)
    const p = (await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `own-${rnd()}`, fullName: 'Окремий Пацієнт', balanceCurrency: 'UAH' } })).id;
    await prisma.payment.create({ data: { clinicId: c.clinicId, patientId: p, externalId: `usd-${rnd()}`, paidAt: new Date(), amount: 50, currency: 'USD' } });
    const run = (spec: object) => http().post('/report-builder/run').set(auth(c.token)).send({ spec }).expect(200).then((r) => r.body);
    const pay = await run({ dataset: 'payments', aggregates: [{ fn: 'sum', field: 'amount' }] });
    expect(pay.rows.map((r: { currency: string }) => r.currency).sort()).toEqual(['UAH', 'USD']);
    expect(pay.rows.find((r: { currency: string }) => r.currency === 'USD').a0).toBe(50);
    expect(pay.columns.map((x: { key: string }) => x.key)).toContain('currency');
    const visits = await run({ dataset: 'visits', aggregates: [{ fn: 'sum', field: 'amount' }] });
    expect(visits.columns[0].label).toContain('без конвертації');
    expect(visits.rows).toHaveLength(1);
    const one = await run({ dataset: 'payments', columns: ['patientName', 'amount'], filters: [{ field: 'amount', op: 'eq', value: 50 }] });
    expect(one.currency).toEqual({ code: 'USD', state: 'one' });
    expect(one.columns.find((x: { key: string }) => x.key === 'amount').label).toBe('Сума, USD');

    // a lapsed patient whose open plan is in USD while the card balance is in UAH: no number that adds them, each currency as text
    await prisma.patient.update({ where: { id: p }, data: { lastVisitAt: new Date(Date.now() - 300 * 86_400_000), balancePaid: 1000 } });
    await prisma.planItem.create({ data: { clinicId: c.clinicId, externalId: `pi-${rnd()}`, patientId: p, planId: `PL-${rnd()}`, name: 'Імплант', price: 999, status: 'NEW', createdAtExt: new Date() } });
    const item = await prisma.planItem.findFirstOrThrow({ where: { clinicId: c.clinicId, patientId: p, name: 'Імплант' } });
    await prisma.treatmentPlan.create({ data: { clinicId: c.clinicId, externalId: item.planId, total: 700, totalDone: 0, createdAtExt: new Date(), currency: 'USD' } });
    const lapsed = await report(c.token, 'lapsed-patients');
    const row = lapsed.rows.find((r: { patientId: string }) => r.patientId === p);
    expect(row.currency).toBe('MIXED');
    expect(row.openSum).toBe('700 USD');
    expect(row.lifetimePaid).toMatch(/^1[\s ]000 грн$/);
    expect(lapsed.columns.map((x: { key: string }) => x.key)).toContain('currency');
  });

  it('незавершене лікування й воронка: залишок лише з підсумків плану з їхньою валютою; ціни позицій не додаються; без підсумку — суми немає', async () => {
    const c = await clinic();
    await setCurrency(c.token, 'UAH').expect(200);
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `own-${rnd()}`, fullName: 'Окремий Пацієнт' } });
    const planId = `PLX-${rnd()}`;
    await prisma.planItem.createMany({
      data: [
        { clinicId: c.clinicId, externalId: `a-${rnd()}`, patientId: p.id, planId, name: 'Коронка', price: 12345, status: 'NEW', createdAtExt: new Date() },
        { clinicId: c.clinicId, externalId: `b-${rnd()}`, patientId: p.id, planId, name: 'Пломба', price: 1, status: 'DONE', markedDoneAt: new Date(), createdAtExt: new Date() },
      ],
    });
    const rows = async () => (await report(c.token, 'unfinished-treatment')).rows.find((r: { patientId: string }) => r.patientId === p.id);
    expect((await rows())?.openSum ?? null).toBeNull();
    await prisma.treatmentPlan.create({ data: { clinicId: c.clinicId, externalId: planId, total: 9000, totalDone: 1000, createdAtExt: new Date(), currency: 'UAH' } });
    expect(await rows()).toMatchObject({ openSum: 8000, currency: 'UAH' });

    const f = (await http().get('/funnel?months=24').set(auth(c.token)).expect(200)).body;
    for (const list of [f.money.paid, f.money.openPlanStarted, f.money.openPlanNotStarted]) for (const x of list) expect(['UAH', null]).toContain(x.currency);
    expect(f.bySource[0].paidSum).toEqual(expect.any(Array));
    const pb = (await http().get('/messages/payback').set(auth(c.token)).expect(200)).body;
    expect(pb.paid).toEqual(expect.any(Array));
  });
});
