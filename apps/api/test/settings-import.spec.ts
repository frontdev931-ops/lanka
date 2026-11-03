import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CabinetBookingService } from '../src/booking/cabinet-booking.service';
import { clinicDate } from '../src/common/clinic-time';
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
const DEFAULT_PRICES = () => JSON.parse(JSON.stringify(mock.data.prices));
let basePrices: unknown[];
let baseSettings: unknown;

beforeAll(async () => {
  mock = await startMock({ patients: 30, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  basePrices = DEFAULT_PRICES();
  baseSettings = JSON.parse(JSON.stringify(mock.data.scheduleSettings));
});
afterAll(async () => {
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
});
beforeEach(() => {
  mock.data.prices = JSON.parse(JSON.stringify(basePrices));
  mock.data.scheduleSettings = JSON.parse(JSON.stringify(baseSettings));
});

const row = (id: string, name: string, price: string | null, group = 'Група'): Record<string, unknown> => ({ group_id: '1', group_name: group, group_color: '1', group_additional: null, item_id: id, item_name: name, item_code: null, item_additional: null, item_price: price });
type C = Awaited<ReturnType<typeof clinic>>;
async function clinic(opts: { sync?: boolean } = {}) {
  const email = `i${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  if (opts.sync !== false) await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  return { token, clinicId };
}
const sync = (c: C) => http().post('/integrations/cliniccards/sync').set(auth(c.token)).expect(201);
const info = async (c: C) => (await http().get('/clinic/work-hours/info').set(auth(c.token)).expect(200)).body;
const services = (c: C) => prisma.kbItem.findMany({ where: { clinicId: c.clinicId, kind: 'SERVICE' }, orderBy: { title: 'asc' } });
const settings = async (c: C) => (await http().get('/booking-settings').set(auth(c.token)).expect(200)).body;
const putServices = (c: C, rows: unknown[]) => http().put('/booking-settings/services').set(auth(c.token)).send({ services: rows });

describe('робочі години з Cliniccards', () => {
  it('значення за замовчуванням не видається за розклад; невідомий або нерозібраний відповідь не вгадується з візитів', async () => {
    mock.data.scheduleSettings = null; // Cliniccards does not give the method
    const c = await clinic();
    // many visits exist, and still the hours are not guessed from them
    expect(await prisma.visit.count({ where: { clinicId: c.clinicId } })).toBeGreaterThan(10);
    expect(await info(c)).toMatchObject({ configured: false, source: null, updatedAt: null, holidays: [], connected: true });
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours).toBeNull();
    // the form still returns the default week to show, but the info says it is not a setting, and the readiness agrees
    expect((await http().get('/clinic/work-hours').set(auth(c.token)).expect(200)).body['1']).toEqual({ from: '09:00', to: '20:00' });
    expect((await settings(c)).problems).toContain('no_hours');
    // the explicit import honestly fails and changes nothing
    const fail = await http().post('/clinic/work-hours/import').set(auth(c.token)).expect(400);
    expect(JSON.stringify(fail.body)).toContain('вручну');
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours).toBeNull();
    // a reply that is not understood (a bad time, a missing day) is not imported either
    mock.data.scheduleSettings = { working_days: [{ day_of_week: 1, active: 1, opening: '9', closing: '21:00' }], holidays: [] };
    await http().post('/clinic/work-hours/import').set(auth(c.token)).expect(400);
    mock.data.scheduleSettings = { working_days: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day_of_week: d, active: 1, opening: '18:00', closing: '09:00' })), holidays: [] };
    await http().post('/clinic/work-hours/import').set(auth(c.token)).expect(400);
    expect((await info(c)).configured).toBe(false);
    // a clinic that is not connected to Cliniccards at all cannot import
    const bare = await clinic({ sync: false });
    await prisma.integration.deleteMany({ where: { clinicId: bare.clinicId } });
    await http().post('/clinic/work-hours/import').set(auth(bare.token)).expect(400);
  });

  it('години й свята імпортуються із джерелом і часом; вихідний день і свято не пропонуються; ручні години не перезаписуються синхронізацією, а явний імпорт їх замінює', async () => {
    const c = await clinic();
    const i1 = await info(c);
    expect(i1).toMatchObject({ configured: true, source: 'CLINICCARDS' });
    expect(i1.updatedAt).toBeTruthy();
    expect(i1.holidays).toHaveLength(2);
    const stored = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours as Record<string, { from: string; to: string } | null>;
    expect(stored['1']).toEqual({ from: '09:00', to: '21:00' });
    expect(stored['7']).toBeNull(); // Sunday is not active in Cliniccards
    // the cabinets of the mock have no hours of their own: only the clinic's
    expect(mock.data.cabinets.every((x) => !('opening' in x) && !('hours' in x))).toBe(true);

    // the clinic types its own hours: MANUAL; the next sync keeps them even though Cliniccards says otherwise
    const week = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '10:00', to: '16:00' }]));
    await http().put('/clinic/work-hours').set(auth(c.token)).send(week).expect(200);
    expect(await info(c)).toMatchObject({ configured: true, source: 'MANUAL', holidays: [] });
    (mock.data.scheduleSettings as { working_days: { active: number }[] }).working_days[6].active = 1;
    await sync(c);
    expect(((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours as Record<string, unknown>)['1']).toEqual({ from: '10:00', to: '16:00' });
    expect((await info(c)).source).toBe('MANUAL');
    // an explicit "take them from Cliniccards" replaces them
    await http().post('/clinic/work-hours/import').set(auth(c.token)).expect(200);
    expect(await info(c)).toMatchObject({ source: 'CLINICCARDS' });
    expect(((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours as Record<string, unknown>)['7']).toEqual({ from: '09:00', to: '21:00' });
    // from now on a sync follows Cliniccards again
    (mock.data.scheduleSettings as { working_days: { active: number }[] }).working_days[6].active = 0;
    await sync(c);
    expect(((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).workHours as Record<string, unknown>)['7']).toBeNull();

    // the holidays of Cliniccards are closed days for the free times, a manual exception for that date wins
    await prisma.cabinet.updateMany({ where: { clinicId: c.clinicId, externalId: '801' }, data: { onlineBooking: true } });
    const holiday = (mock.data.scheduleSettings as { holidays: string[] }).holidays[0];
    mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) < clinicDate(new Date()) || String(v.visit_start).slice(0, 10) > clinicDate(new Date(Date.now() + 40 * 86_400_000)));
    await sync(c);
    const w = await app.get(CabinetBookingService).windows(c.clinicId, { minutes: 30, force: true, days: 25 });
    expect(w.some((x) => x.date === holiday)).toBe(false);
    const sunday = w.map((x) => x.date).find((d) => (new Date(`${d}T00:00:00Z`).getUTCDay() || 7) === 7);
    expect(sunday).toBeUndefined();
    await http().put('/booking-settings/exceptions').set(auth(c.token)).send({ exceptions: [{ date: holiday, closed: false, from: '10:00', to: '12:00' }] }).expect(200);
    const w2 = await app.get(CabinetBookingService).windows(c.clinicId, { minutes: 30, force: true, days: 25 });
    expect(w2.some((x) => x.date === holiday)).toBe(true);
  });
});

describe('прайс з Cliniccards у «Послуги»', () => {
  it('після синхронізації послуги з’являються самі (без затвердження кожної) з назвою, ціною, групою й id; для запису нічого не дозволено; довжини немає', async () => {
    const c = await clinic();
    const rows = await services(c);
    expect(rows.map((r) => r.title).sort()).toEqual(['Консультація', 'Лікування карієсу', 'Професійна гігєна "Air flow" 1 ступеня'].sort());
    const caries = rows.find((r) => r.title === 'Лікування карієсу')!;
    expect(caries).toMatchObject({ externalId: '1002', category: 'Терапія', priceUah: 1800, source: 'CLINICCARDS', approvedAt: expect.any(Date), onlineBooking: false, durationMin: null, cabinetIds: [], localFields: [], externalTitle: 'Лікування карієсу', externalPrice: 1800 });
    expect(rows.find((r) => r.externalId === '1001')!.text).toContain('AirFlow');
    // the price list of Cliniccards gives no length of a visit: none is invented
    expect(rows.every((r) => r.durationMin === null)).toBe(true);
    const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(clinicRow.priceListSyncedAt).toBeTruthy();
    expect(clinicRow.priceListCount).toBe(3);
    const s = await settings(c);
    expect(s.priceList).toMatchObject({ count: 3, imported: 3 });
    expect(s.priceList.syncedAt).toBeTruthy();
    expect(s.missingLength).toBe(3);
    expect(s.services.every((x: { fromCliniccards: boolean }) => x.fromCliniccards)).toBe(true);
    expect(s.problems).toContain('no_services'); // imported is not allowed: the warning matches what is saved
  });

  it('повторна синхронізація не дублює; нова позиція додається один раз; ручна послуга з тією самою назвою НЕ зв’язується за назвою', async () => {
    const c = await clinic();
    const manual = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Видалення зуба', durationMin: 40, active: true, approvedAt: new Date(), priceUah: 900 } });
    await sync(c);
    await sync(c);
    expect(await prisma.kbItem.count({ where: { clinicId: c.clinicId, kind: 'SERVICE' } })).toBe(4);
    mock.data.prices.push(row('2001', 'Видалення зуба', '950', 'Хірургія'), row('2002', 'Чистка ультразвуком', '700', 'Профілактика'));
    await sync(c);
    await sync(c);
    const rows = await services(c);
    expect(rows).toHaveLength(6); // 3 + the manual one + the 2 new ones, each once
    // the manual service is left exactly as it was: a name alone proves nothing (names repeat across groups)
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ externalId: null, durationMin: 40, priceUah: 900, source: 'MANUAL' });
    expect(rows.filter((r) => r.externalId === '2001')).toHaveLength(1);
    expect(rows.filter((r) => r.externalId === '2002')).toHaveLength(1);
    // the manual import button does the same and creates nothing new
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    expect(await prisma.kbItem.count({ where: { clinicId: c.clinicId, kind: 'SERVICE' } })).toBe(6);
  });

  it('повторна синхронізація: назва, опис і ціна імпортованих послуг оновлюються самі; довжина, дозвіл на онлайн-запис і кабінети зберігаються; ручні винятки не перезаписуються', async () => {
    const c = await clinic();
    const caries = (await services(c)).find((r) => r.externalId === '1002')!;
    const consult = (await services(c)).find((r) => r.externalId === '1003')!;
    const air = (await services(c)).find((r) => r.externalId === '1001')!;
    // the clinic sets the length of the caries and allows it online in cabinet 801 only; no approval is needed for any of it
    await prisma.cabinet.updateMany({ where: { clinicId: c.clinicId }, data: { onlineBooking: true } });
    await putServices(c, [{ id: caries.id, onlineBooking: true, cabinetIds: ['801'], durationMin: 45 }]).expect(200);
    // and keeps its own text of the air flow (a local exception)
    await http().patch(`/knowledge/${air.id}`).set(auth(c.token)).send({ text: 'Наш опис' }).expect(200);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: air.id } })).localFields).toEqual(['text']);
    // Cliniccards renames, reprices and re-describes the positions
    for (const r of mock.data.prices) {
      if (r.item_id === '1002') Object.assign(r, { item_name: 'Лікування карієсу (нова назва)', item_price: '2100' });
      if (r.item_id === '1003') Object.assign(r, { item_name: 'Консультація лікаря', item_price: '350' });
      if (r.item_id === '1001') Object.assign(r, { item_additional: 'Новий опис' });
    }
    await sync(c);
    const after = (await services(c)).find((r) => r.id === caries.id)!;
    expect(after).toMatchObject({ title: 'Лікування карієсу (нова назва)', priceUah: 2100, durationMin: 45, onlineBooking: true, cabinetIds: ['801'], externalTitle: 'Лікування карієсу (нова назва)', externalPrice: 2100 });
    expect(after.approvedAt).not.toBeNull();
    const s = await settings(c);
    expect(s.services.find((x: { id: string }) => x.id === caries.id)).toMatchObject({ onlineBooking: true, cabinetIds: ['801'], durationMin: 45, changedInSource: false, priceDivergence: null });
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: consult.id } })).toMatchObject({ title: 'Консультація лікаря', priceUah: 350 });
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: air.id } })).text).toBe('Наш опис'); // the local exception stays
    // the warnings match what is saved: one service with a length is allowed, so "no services" is gone
    expect(s.problems).not.toContain('no_services');
    expect(s.missingLength).toBe(2);
    // a price taken from the list that is gone (0 or empty) becomes unknown, not a stale number
    mock.data.prices.find((r) => r.item_id === '1003')!.item_price = '0';
    await sync(c);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: consult.id } })).priceUah).toBeNull();
  });

  it('старі чернетки з Cliniccards переходять на нову поведінку: імпорт сам їх затверджує й далі вони слідують за прайсом; явні локальні значення лишаються', async () => {
    const c = await clinic();
    const [caries, air] = [(await services(c)).find((r) => r.externalId === '1002')!, (await services(c)).find((r) => r.externalId === '1001')!];
    // the old state: an unapproved draft, and an approved position with a price typed by hand
    await prisma.kbItem.update({ where: { id: caries.id }, data: { approvedAt: null, priceUah: 1000 } });
    await prisma.kbItem.update({ where: { id: air.id }, data: { priceUah: 999, localFields: ['priceUah'] } });
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '1900';
    await sync(c);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).toMatchObject({ approvedAt: expect.any(Date), priceUah: 1900 });
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: air.id } })).toMatchObject({ priceUah: 999 }); // the explicit local price stays
  });

  it('довжина запитується лише там, де її бракує: без неї послугу не дозволити, з довжиною (5–480) і затвердженням — можна', async () => {
    const c = await clinic();
    // a position without a price in Cliniccards cannot be approved until the clinic types a price (the rule of the knowledge base), so the one with a price is used
    const item = (await services(c)).find((r) => r.externalId === '1002')!;
    await putServices(c, [{ id: item.id, onlineBooking: true, cabinetIds: [] }]).expect(400); // no length, not approved
    await putServices(c, [{ id: item.id, onlineBooking: false, cabinetIds: [], durationMin: 3 }]).expect(400);
    await putServices(c, [{ id: item.id, onlineBooking: false, cabinetIds: [], durationMin: 500 }]).expect(400);
    // the length alone (without allowing) is saved
    await putServices(c, [{ id: item.id, onlineBooking: false, cabinetIds: [], durationMin: 30 }]).expect(200);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ durationMin: 30, approvedAt: expect.any(Date), onlineBooking: false });
    const ok = await putServices(c, [{ id: item.id, onlineBooking: true, cabinetIds: [] }]).expect(200);
    expect(ok.body.missingLength).toBe(2);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ durationMin: 30, onlineBooking: true });
    // another clinic's service cannot be touched
    const other = await clinic();
    await putServices(other, [{ id: item.id, onlineBooking: false, cabinetIds: [], durationMin: 20 }]).expect(400);
  });

  it('кнопка імпорту: права, ізоляція, помилка Cliniccards не ламає нічого', async () => {
    const c = await clinic({ sync: false });
    expect(await services(c)).toHaveLength(0);
    const r = (await http().post('/booking-settings/import').set(auth(c.token)).expect(200)).body;
    expect(r.imported).toMatchObject({ added: 3, hours: 'imported' });
    expect(await services(c)).toHaveLength(3);
    const other = await clinic({ sync: false });
    expect(await services(other)).toHaveLength(0);
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `an${rnd()}@example.com`, role: 'ANALYST' }).expect(201);
    const analyst = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ан', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().post('/booking-settings/import').set(auth(analyst)).expect(403);
    await http().post('/clinic/work-hours/import').set(auth(analyst)).expect(403);
  });
});

describe('вільні вікна без достовірного розкладу', () => {
  it('без змін і без заданих годин відомість нічого не вигадує й каже чому; з годинами або змінами показує реальні вікна', async () => {
    mock.data.scheduleSettings = null;
    const c = await clinic({ sync: false });
    await prisma.cabinet.create({ data: { clinicId: c.clinicId, externalId: 'k1', name: 'Кабінет 1' } });
    const report = (await http().get('/reports/free-slots?days=7').set(auth(c.token)).expect(200)).body;
    expect(report.rows).toEqual([]);
    expect(report.notice).toContain('надійного розкладу немає');
    // the assistant of the chat gets no times either
    const { ReportsService } = await import('../src/reports/reports.service');
    expect(await app.get(ReportsService).freeSlots(c.clinicId, 7)).toEqual([]);
    // hours set by the clinic: real windows, no notice
    await http().put('/clinic/work-hours').set(auth(c.token)).send(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '09:00', to: '18:00' }]))).expect(200);
    const ok = (await http().get('/reports/free-slots?days=7').set(auth(c.token)).expect(200)).body;
    expect(ok.rows.length).toBeGreaterThan(0);
    expect(ok.notice).toBeNull();
    // a clinic with shifts in Cliniccards has a schedule without any hours set
    mock.data.scheduleSettings = JSON.parse(JSON.stringify(baseSettings));
    const d = await clinic();
    await prisma.clinic.update({ where: { id: d.clinicId }, data: { workHours: Prisma.DbNull, workHoursSource: null } });
    const withShifts = (await http().get('/reports/free-slots?days=7').set(auth(d.token)).expect(200)).body;
    expect(withShifts.notice).toBeNull();
    expect(withShifts.rows.length).toBeGreaterThan(0);
  });
});

describe('ціна: невідома, безкоштовна, змінена', () => {
  it('«невідома» (null) і «явно 0» різні: відсутність ціни не блокує ні затвердження, ні запис, але бот не називає вартість; безкоштовна послуга називається безкоштовною', async () => {
    const c = await clinic();
    const consult = (await services(c)).find((r) => r.externalId === '1003')!; // "0" in the price list
    expect(consult).toMatchObject({ priceUah: null, externalPrice: 0 });
    const list = (await http().get('/knowledge').set(auth(c.token)).expect(200)).body.items as { id: string; priceState: string; priceDivergence: unknown }[];
    expect(list.find((i) => i.id === consult.id)).toMatchObject({ priceState: 'UNKNOWN' });
    // approving with an unknown price works, and the model is told not to name a price
    const { KbService } = await import('../src/kb/kb.service');
    const unknown = await app.get(KbService).factsFor(c.clinicId);
    expect(unknown.text).toMatch(/Консультація[^\n]*ціна: не називати/);
    expect(unknown.allowedAmounts).not.toContain(0);
    // the booking needs the service approved, allowed and with a length; the price plays no part
    await prisma.cabinet.updateMany({ where: { clinicId: c.clinicId }, data: { onlineBooking: true } });
    await putServices(c, [{ id: consult.id, onlineBooking: true, cabinetIds: [], durationMin: 30 }]).expect(200);
    expect((await settings(c)).problems).not.toContain('no_services');
    // the administrator says it is free: an explicit 0 (an edit of the price needs a new approval, as for any price)
    await http().patch(`/knowledge/${consult.id}`).set(auth(c.token)).send({ priceUah: 0 }).expect(200);
    await http().post(`/knowledge/${consult.id}/approve`).set(auth(c.token)).expect(200);
    const free = await app.get(KbService).factsFor(c.clinicId);
    expect(free.text).toMatch(/Консультація[^\n]*безкоштовно/);
    expect(free.allowedAmounts).toContain(0);
    expect((await http().get('/knowledge').set(auth(c.token))).body.items.find((i: { id: string }) => i.id === consult.id)).toMatchObject({ priceState: 'FREE', priceUah: 0 });
    // a repeated sync does not turn the confirmed "free" back into "unknown"
    await sync(c);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: consult.id } })).toMatchObject({ priceUah: 0, externalPrice: 0, approvedAt: expect.any(Date) });
  });

  it('«безкоштовно», вказане адміністратором на чернетці, переживає повторну синхронізацію, навіть коли Cliniccards теж віддає 0', async () => {
    const c = await clinic();
    const consult = (await services(c)).find((r) => r.externalId === '1003')!; // "0" in the price list, a draft
    expect(consult).toMatchObject({ priceUah: null, externalPrice: 0, localFields: [] });
    await http().patch(`/knowledge/${consult.id}`).set(auth(c.token)).send({ priceUah: 0 }).expect(200);
    await sync(c);
    await sync(c);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: consult.id } })).toMatchObject({ priceUah: 0, externalPrice: 0 });
  });

  it('ціна імпортованої послуги слідує за Cliniccards сама; розбіжність виникає лише з ціною, яку клініка задала вручну, і стара ціна не називається до рішення', async () => {
    const c = await clinic();
    const { KbService } = await import('../src/kb/kb.service');
    const caries = (await services(c)).find((r) => r.externalId === '1002')!;
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(1800);
    // no local exception: a change in Cliniccards simply applies, and nothing is asked of the administrator
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2000';
    await sync(c);
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toEqual(expect.arrayContaining([2000]));
    expect((await http().get('/knowledge/review').set(auth(c.token)).expect(200)).body.priceChanges).toEqual([]);
    // the clinic sets its own price on purpose: a local exception
    await http().patch(`/knowledge/${caries.id}`).set(auth(c.token)).send({ priceUah: 1800 }).expect(200);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).localFields).toEqual(['priceUah']);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2100';
    await sync(c);
    const rev = (await http().get('/knowledge/review').set(auth(c.token)).expect(200)).body;
    expect(rev.priceChanges).toEqual([{ id: caries.id, title: 'Лікування карієсу', category: 'Терапія', own: 1800, source: 2100 }]);
    expect((await settings(c)).services.find((x: { id: string }) => x.id === caries.id)).toMatchObject({ priceDivergence: { own: 1800, source: 2100 }, changedInSource: true });
    // until the decision neither price is told
    const meanwhile = await app.get(KbService).factsFor(c.clinicId);
    expect(meanwhile.allowedAmounts).not.toContain(1800);
    expect(meanwhile.allowedAmounts).not.toContain(2100);
    expect(meanwhile.text).toMatch(/Лікування карієсу[^\n]*ціна: не називати/);
    // accept the source price: the position follows Cliniccards again
    await http().post(`/knowledge/${caries.id}/price-source`).set(auth(c.token)).send({ action: 'accept' }).expect(200);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).localFields).toEqual([]);
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(2100);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2300';
    await sync(c);
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(2300);
    // a local exception again, kept after the next change of the source ("keep my price"): not asked again until the source changes once more
    await http().patch(`/knowledge/${caries.id}`).set(auth(c.token)).send({ priceUah: 2000 }).expect(200);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2500';
    await sync(c);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.priceChanges).toHaveLength(1);
    await http().post(`/knowledge/${caries.id}/price-source`).set(auth(c.token)).send({ action: 'keep' }).expect(200);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.priceChanges).toEqual([]);
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(2000);
    await sync(c);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.priceChanges).toEqual([]);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2600';
    await sync(c);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.priceChanges).toHaveLength(1);
    // only the owner or a manager decides; another clinic cannot touch it
    const other = await clinic();
    await http().post(`/knowledge/${caries.id}/price-source`).set(auth(other.token)).send({ action: 'accept' }).expect(404);
  });
});

describe('позиція зникла з прайсу', () => {
  const manyRows = (n: number) => Array.from({ length: n }, (_, i) => row(`50${String(i).padStart(2, '0')}`, `Позиція ${i}`, '100'));

  it('з повного успішного прайсу — позначається відсутньою й онлайн-запис призупиняється до рішення; історія й заявки лишаються; повернулась — знімається', async () => {
    const c = await clinic();
    const caries = (await services(c)).find((r) => r.externalId === '1002')!;
    await http().post(`/knowledge/${caries.id}/approve`).set(auth(c.token)).expect(200);
    await prisma.cabinet.updateMany({ where: { clinicId: c.clinicId }, data: { onlineBooking: true } });
    await putServices(c, [{ id: caries.id, onlineBooking: true, cabinetIds: [], durationMin: 45 }]).expect(200);
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: `x${rnd()}`, kind: 'BOOKING', summary: 'x', service: 'Лікування карієсу' } });
    expect((await settings(c)).problems).not.toContain('no_services');

    mock.data.prices = mock.data.prices.filter((r) => r.item_id !== '1002');
    await sync(c);
    const gone = await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } });
    expect(gone.missingInSourceAt).not.toBeNull();
    expect(gone).toMatchObject({ onlineBooking: true, durationMin: 45, active: true }); // nothing is deleted or rewritten
    const s = await settings(c);
    expect(s.services.find((x: { id: string }) => x.id === caries.id).missingInSource).toBe(true);
    expect(s.problems).toContain('no_services'); // the warning matches: the only allowed service is paused
    await putServices(c, [{ id: caries.id, onlineBooking: true, cabinetIds: [] }]).expect(400);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.missing.map((m: { id: string }) => m.id)).toEqual([caries.id]);
    // the bot does not talk the position into a booking: the service is out of its knowledge, and the booking path refuses it
    const { KbService } = await import('../src/kb/kb.service');
    const vanished = await app.get(KbService).factsFor(c.clinicId, new Date(), 'карієс');
    expect(vanished.text).toMatch(/Лікування карієсу[^\n]*ціна: не називати, цієї позиції вже немає в актуальному прайсі/); // told to ask the administrator, no old price
    expect(vanished.allowedAmounts).not.toContain(1800);
    const { DoctorChoiceService } = await import('../src/booking/doctor-choice.service');
    const decision = await app.get(DoctorChoiceService).decide({ clinicId: c.clinicId, patientId: null, service: gone, texts: ['хочу лікування карієсу'], lang: 'uk', request: null });
    expect(decision).toMatchObject({ kind: 'HANDOFF' });
    expect((decision as { note: string }).note).toContain('призупинено');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1); // existing requests stay

    // an old time button of the vanished service stores nothing on the request
    const flow = app.get((await import('../src/automations/booking-flow.service')).BookingFlowService);
    const chatId = `s${rnd()}`;
    const req = await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId, kind: 'BOOKING', summary: 'x', service: 'Лікування карієсу', stage: 'NONE' } });
    await flow.onSlotChosen({ clinicId: c.clinicId, channel: 'INSTAGRAM', chatId, patientId: null, contactName: null } as never, { date: '2030-01-07', time: '10:00' }, 'пн 07.01, 10:00');
    expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ slotAt: null, stage: 'NONE' });

    // it comes back in a later list: the mark is removed by itself
    mock.data.prices.push(row('1002', 'Лікування карієсу', '1800', 'Терапія'));
    await sync(c);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).missingInSourceAt).toBeNull();
    // gone again, and the administrator keeps it as the clinic's own service: it is no longer tied to the price list and is bookable again
    mock.data.prices = mock.data.prices.filter((r) => r.item_id !== '1002');
    await sync(c);
    await http().post(`/knowledge/${caries.id}/missing`).set(auth(c.token)).send({ action: 'keep' }).expect(200);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).toMatchObject({ missingInSourceAt: null, externalId: null, active: true, onlineBooking: true });
    await sync(c);
    expect((await prisma.kbItem.findUniqueOrThrow({ where: { id: caries.id } })).missingInSourceAt).toBeNull(); // not tied any more: the price list says nothing about it
    // switching a vanished position off keeps it in the database
    const consult = (await services(c)).find((r) => r.externalId === '1003')!;
    mock.data.prices = mock.data.prices.filter((r) => r.item_id !== '1003');
    await sync(c);
    await http().post(`/knowledge/${consult.id}/missing`).set(auth(c.token)).send({ action: 'disable' }).expect(200);
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: consult.id } })).toMatchObject({ active: false, onlineBooking: false });
  });

  it('помилка, порожня відповідь, обрізаний прайс і масове зникнення нічого не вимикають', async () => {
    const c = await clinic();
    // the price list with many positions
    mock.data.prices = [...JSON.parse(JSON.stringify(basePrices)), ...manyRows(12)];
    await sync(c);
    expect((await services(c)).filter((r) => r.externalId)).toHaveLength(15);
    const marked = () => prisma.kbItem.count({ where: { clinicId: c.clinicId, missingInSourceAt: { not: null } } });
    // an empty answer: nothing is marked
    mock.data.prices = [];
    await sync(c);
    expect(await marked()).toBe(0);
    // an error of the price list: nothing is marked, the services stay
    const { CliniccardsConnector } = await import('../src/integrations/cliniccards.connector');
    mock.data.prices = JSON.parse(JSON.stringify(basePrices));
    const spy = jest.spyOn(CliniccardsConnector.prototype, 'fetchServiceList').mockRejectedValue(new Error('Cliniccards is down'));
    await sync(c);
    spy.mockRestore();
    expect(await marked()).toBe(0);
    // most of the list vanishes at once (an unfinished or broken answer): nothing is marked and the clinic is told why
    mock.data.prices = JSON.parse(JSON.stringify(basePrices)); // 3 of 15 remain: 12 would vanish
    await sync(c);
    expect(await marked()).toBe(0);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).priceListNote).toBe('suspicious_missing:12');
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.note).toBe('suspicious_missing:12');
    // a few positions vanishing from a list that was read in full are marked
    mock.data.prices = [...JSON.parse(JSON.stringify(basePrices)), ...manyRows(12).slice(0, 10)];
    await sync(c);
    expect(await marked()).toBe(2);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).priceListNote).toBeNull();
  });
});

describe('збіг назв: лише ручне зіставлення', () => {
  it('однакові назви в різних групах і ручна послуга з такою назвою не зв’язуються самі; неоднозначні збіги показано для ручного зіставлення', async () => {
    const c = await clinic();
    const manual = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 30, active: true, approvedAt: new Date(), priceUah: 300, text: 'наш текст' } });
    mock.data.prices.push(row('3001', 'Консультація', '500', 'Хірургія'), row('3002', 'Консультація', '450', 'Ортодонтія'));
    await sync(c);
    // three positions are called "Консультація" (the old one of the price list and two new ones in other groups); none is tied to the manual one
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ externalId: null, priceUah: 300, text: 'наш текст' });
    const imported = (await services(c)).filter((r) => r.title === 'Консультація' && r.externalId);
    expect(imported.map((r) => r.externalId).sort()).toEqual(['1003', '3001', '3002']);
    const rev = (await http().get('/knowledge/review').set(auth(c.token)).expect(200)).body;
    expect(rev.matches).toHaveLength(1);
    expect(rev.matches[0].manual.id).toBe(manual.id);
    expect(rev.matches[0].candidates.map((x: { category: string | null }) => x.category).sort()).toEqual(['Консультації', 'Ортодонтія', 'Хірургія']);
    // the administrator decides: link to the one in surgery; the clinic's own text and price stay, the imported duplicate is switched off
    const surgery = imported.find((r) => r.externalId === '3001')!;
    await http().post(`/knowledge/${manual.id}/link`).set(auth(c.token)).send({ importedId: surgery.id }).expect(200);
    const linked = await prisma.kbItem.findUniqueOrThrow({ where: { id: manual.id } });
    expect(linked).toMatchObject({ externalId: '3001', externalPrice: 500, priceUah: 300, text: 'наш текст', durationMin: 30 });
    expect(await prisma.kbItem.findUniqueOrThrow({ where: { id: surgery.id } })).toMatchObject({ externalId: null, active: false });
    await sync(c);
    expect(await prisma.kbItem.count({ where: { clinicId: c.clinicId, externalId: '3001' } })).toBe(1); // the next sync does not bring the duplicate back
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.matches).toEqual([]);
    // a hand-made service can also be left separate on purpose
    const other = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Консультація', active: true } });
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.matches).toHaveLength(1);
    await http().post(`/knowledge/${other.id}/dismiss-match`).set(auth(c.token)).expect(200);
    expect((await http().get('/knowledge/review').set(auth(c.token))).body.matches).toEqual([]);
    // another clinic cannot link or dismiss
    const foreign = await clinic();
    await http().post(`/knowledge/${other.id}/link`).set(auth(foreign.token)).send({ importedId: surgery.id }).expect(404);
    await http().post(`/knowledge/${other.id}/dismiss-match`).set(auth(foreign.token)).expect(404);
  });
});
