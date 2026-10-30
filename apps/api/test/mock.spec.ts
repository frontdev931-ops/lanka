import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { CliniccardsClient, CliniccardsError } from '../src/integrations/cliniccards.client';
import { CliniccardsConnector } from '../src/integrations/cliniccards.connector';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(120_000);

const rnd = () => Math.random().toString(36).slice(2, 9);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;

describe('коннектор против имитации Cliniccards', () => {
  let mock: MockHandle;
  const client = () => new CliniccardsClient(MOCK_KEY, { baseUrl: mock.url, minIntervalMs: 0 });

  beforeAll(async () => {
    mock = await startMock({ patients: 450 });
  });
  afterAll(() => mock.close());

  it('читает пациентов крупными страницами: 450 пациентов — одна страница и пустая, ничего не теряется', async () => {
    const before = mock.requests.filter((r) => r.path === '/patients').length;
    const patients = await new CliniccardsConnector(client()).fetchPatients();
    expect(patients).toHaveLength(450);
    expect(new Set(patients.map((p) => p.externalId)).size).toBe(450);
    expect(mock.requests.filter((r) => r.path === '/patients').length - before).toBe(2);
  });

  it('если сервер отдаёт страницы меньше запрошенного, пациенты всё равно читаются полностью', async () => {
    const capped = await startMock({ patients: 450, rateLimitPerMinute: 1_000_000, maxPageSize: 200 });
    try {
      const patients = await new CliniccardsConnector(new CliniccardsClient(MOCK_KEY, { baseUrl: capped.url, minIntervalMs: 0 })).fetchPatients();
      expect(patients).toHaveLength(450);
      expect(new Set(patients.map((p) => p.externalId)).size).toBe(450);
    } finally {
      await capped.close();
    }
  });

  it('большой период читается одним запросом; если сервер отказал, коннектор переходит на мелкие отрезки с тем же результатом', async () => {
    const win = { from: new Date(Date.now() - 1000 * 86_400_000), to: new Date() };
    const before = mock.requests.filter((r) => r.path === '/planItems').length;
    const all = await new CliniccardsConnector(client()).fetchTreatment(win);
    const bigRequests = mock.requests.filter((r) => r.path === '/planItems').length - before;
    expect(bigRequests).toBeLessThanOrEqual(3); // три года — не больше трёх годовых отрезков

    const strict = await startMock({ patients: 450, rateLimitPerMinute: 1_000_000, maxPeriodDays: 31 });
    try {
      const viaSmall = await new CliniccardsConnector(new CliniccardsClient(MOCK_KEY, { baseUrl: strict.url, minIntervalMs: 0 })).fetchTreatment(win);
      expect(viaSmall.length).toBe(all.length);
      expect(strict.requests.filter((r) => r.path === '/planItems').length).toBeGreaterThan(bigRequests);
    } finally {
      await strict.close();
    }
  });

  it('разбирает «грязные» данные: пустой телефон, дата 0000-00-00, записи без услуг, ID числом', async () => {
    const connector = new CliniccardsConnector(client());
    const patients = await connector.fetchPatients();
    const first = patients.find((p) => p.externalId === '100000')!; // i = 0: пустой телефон и 0000-00-00
    expect(first.phone).toBeUndefined();
    expect(first.lastVisitAt).toBeUndefined();

    const visits = await connector.fetchVisits({ from: new Date(Date.now() - 200 * DAY), to: new Date(Date.now() + 70 * DAY) });
    expect(visits.length).toBeGreaterThan(300);
    expect(visits.every((v) => typeof v.patientExternalId === 'string')).toBe(true); // числовые ID приведены к строкам
    expect(visits.some((v) => v.serviceName === undefined)).toBe(true); // price_items = null
    expect(visits.some((v) => v.serviceName && v.amount && v.amount > 0)).toBe(true);
    expect(new Set(visits.map((v) => v.externalId)).size).toBe(visits.length); // нет повторов на границах отрезков
  });

  it('читает планы лечения, платежи, акты и расписание', async () => {
    const connector = new CliniccardsConnector(client());
    const window = { from: new Date(Date.now() - 365 * DAY), to: new Date(Date.now() + 60 * DAY) };
    const plan = await connector.fetchTreatment({ from: window.from, to: new Date() });
    expect(plan.length).toBeGreaterThan(50);
    expect(plan.some((i) => i.status === 'NEW' || i.status === 'PLANNED_TO_DO')).toBe(true);
    expect(plan.some((i) => i.markedDoneAt)).toBe(true);

    const { payments, invoices } = await connector.fetchFinance({ from: window.from, to: new Date() });
    expect(payments.length).toBeGreaterThan(50);
    expect(payments.some((p) => p.patientExternalId === undefined)).toBe(true); // платёж без пациента
    expect(invoices.every((i) => i.amount > 0)).toBe(true);

    const { shifts, blocks } = await connector.fetchSchedule({ from: new Date(), to: new Date(Date.now() + 14 * DAY) });
    expect(shifts.length).toBeGreaterThan(10);
    expect(blocks.length).toBeGreaterThan(5);
    expect(shifts.every((s) => s.endsAt > s.startsAt)).toBe(true);
  });

  it('неверный ключ: понятная ошибка без ключа в тексте', async () => {
    const bad = new CliniccardsClient('SECRET-WRONG-KEY', { baseUrl: mock.url, minIntervalMs: 0 });
    const err = (await bad.get('/staff').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(CliniccardsError);
    expect(err.message).toContain('Wrong API key');
    expect(err.message).not.toContain('SECRET-WRONG-KEY');
  });

  it('превышение лимита запросов: повторяет попытки, затем сообщает об ошибке', async () => {
    const limited = await startMock({ patients: 5, rateLimitPerMinute: 2 });
    try {
      const c = new CliniccardsClient(MOCK_KEY, { baseUrl: limited.url, minIntervalMs: 0, retryDelayMs: 5 });
      await c.get('/staff');
      await c.get('/staff');
      await expect(c.get('/staff')).rejects.toThrow('Too many requests');
      expect(limited.requests.length).toBe(2); // сверх лимита сервер ничего не обработал
    } finally {
      await limited.close();
    }
  });

  it('соблюдает паузу между запросами', async () => {
    const slow = new CliniccardsClient(MOCK_KEY, { baseUrl: mock.url, minIntervalMs: 120 });
    const t0 = Date.now();
    await slow.get('/staff');
    await slow.get('/staff');
    await slow.get('/staff');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(230); // три запроса: две паузы по 120 мс
  });

  it('недоступный сервер: ошибка про связь', async () => {
    const dead = new CliniccardsClient(MOCK_KEY, { baseUrl: 'http://127.0.0.1:1', minIntervalMs: 0 });
    await expect(dead.get('/staff')).rejects.toThrow('нет связи');
  });
});

describe('синхронизация и отчёты на данных имитации', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockHandle;
  let owner: string;
  let admin: string;
  let clinicId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    // Паузы между запросами в тестах отключены, поэтому лимит имитации снят (сам лимит проверен отдельным тестом выше)
    mock = await startMock({ patients: 450, rateLimitPerMinute: 1_000_000 });
    process.env.CLINICCARDS_BASE_URL = mock.url;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new I18nExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const email = `m${rnd()}@example.com`;
    const reg = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Мок ${rnd()}`, name: 'Анна', email, password: 'password123' }).expect(201);
    owner = reg.body.accessToken;
    clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;

    const adminEmail = `a${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner)).send({ email: adminEmail, role: 'ADMIN' }).expect(201);
    const inviteToken = (inv.body.link as string).split('/invite/')[1];
    admin = (await http().post(`/invites/${inviteToken}/accept`).send({ name: 'Адмін', password: 'password123' }).expect(201)).body.accessToken;

    // Демо-данные до подключения ключа
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect(await prisma.patient.count({ where: { clinicId, externalId: { startsWith: 'demo-' } } })).toBeGreaterThan(0);

    await http().put('/integrations/cliniccards/key').set(auth(owner)).send({ apiKey: 'wrong-key-for-mock' }).expect(400);
    await http().put('/integrations/cliniccards/key').set(auth(owner)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
  });

  afterAll(async () => {
    await app.close();
    await mock.close();
    delete process.env.CLINICCARDS_BASE_URL;
  });

  it('остаток лечения берётся из итогов плана, а не суммой цен пунктов (валюта)', async () => {
    const before = (await http().get('/reports/unfinished-treatment').set(auth(owner)).expect(200)).body.rows as { patientId: string; openSum: number }[];
    const target = before[0];
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: target.patientId } });
    const item = await prisma.planItem.findFirstOrThrow({ where: { patientId: target.patientId, status: { in: ['NEW', 'PLANNED_TO_DO'] } } });

    // В Cliniccards часть пунктов в долларах: итог плана в гривнах (с курсом) больше суммы «сырых» цен
    const plan = mock.data.plans.find((p) => String(p.plan_id) === item.planId)!;
    const original = { ...plan };
    plan.plan_total_with_discount = String(Number(plan.plan_total_done_with_discount) + 250_000);
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    const row = ((await http().get('/reports/unfinished-treatment').set(auth(owner)).expect(200)).body.rows as { patientId: string; openSum: number }[]).find((r) => r.patientId === patient.id)!;
    // 250 000 по плану (плюс остаток других планов пациента, если они есть)
    expect(row.openSum).toBeGreaterThanOrEqual(250_000);

    Object.assign(plan, original);
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
  });

  it('оборванная загрузка («идёт» больше 30 минут) помечается ошибкой и не блокирует новый запуск', async () => {
    const integration = await prisma.integration.findFirstOrThrow({ where: { clinicId } });
    const stuck = await prisma.syncRun.create({ data: { clinicId, integrationId: integration.id, startedAt: new Date(Date.now() - 31 * 60_000) } });
    const runs = (await http().get('/integrations/cliniccards/runs').set(auth(owner)).expect(200)).body as { id: string; status: string; error: string | null }[];
    const row = runs.find((r) => r.id === stuck.id)!;
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('прервана');
    // свежая загрузка («идёт» две минуты) остаётся как есть
    const fresh = await prisma.syncRun.create({ data: { clinicId, integrationId: integration.id, startedAt: new Date(Date.now() - 2 * 60_000) } });
    const again = (await http().get('/integrations/cliniccards/runs').set(auth(owner)).expect(200)).body as { id: string; status: string }[];
    expect(again.find((r) => r.id === fresh.id)!.status).toBe('RUNNING');
    await prisma.syncRun.delete({ where: { id: fresh.id } });
  });

  it('рабочие часы клиники: проверка, роли, изоляция', async () => {
    const week = (from: string, to: string) => Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, { from, to }]));
    // по умолчанию 9:00–20:00 каждый день
    const def = (await http().get('/clinic/work-hours').set(auth(owner)).expect(200)).body;
    expect(def['1']).toEqual({ from: '09:00', to: '20:00' });
    expect(def['7']).toEqual({ from: '09:00', to: '20:00' });

    await http().put('/clinic/work-hours').set(auth(admin)).send(week('10:00', '18:00')).expect(403); // администратор не меняет
    await http().put('/clinic/work-hours').set(auth(owner)).send({ ...week('10:00', '18:00'), '3': { from: '18:00', to: '10:00' } }).expect(400); // начало позже конца
    await http().put('/clinic/work-hours').set(auth(owner)).send({ ...week('10:00', '18:00'), '3': { from: '9', to: '18:00' } }).expect(400); // не ЧЧ:ММ
    await http().put('/clinic/work-hours').set(auth(owner)).send({ '1': { from: '09:00', to: '20:00' } }).expect(400); // не все дни

    await http().put('/clinic/work-hours').set(auth(owner)).send({ ...week('10:00', '18:00'), '7': null }).expect(200);
    const saved = (await http().get('/clinic/work-hours').set(auth(owner)).expect(200)).body;
    expect(saved['1']).toEqual({ from: '10:00', to: '18:00' });
    expect(saved['7']).toBeNull();

    // другая клиника своих часов не меняет и чужих не видит
    const other = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Часы ${rnd()}`, name: 'Ольга', email: `h${rnd()}@example.com`, password: 'password123' }).expect(201);
    expect((await http().get('/clinic/work-hours').set(auth(other.body.accessToken)).expect(200)).body['1']).toEqual({ from: '09:00', to: '20:00' });
    await http().put('/clinic/work-hours').set(auth(owner)).send(week('09:00', '20:00')).expect(200);
  });

  it('свободные окна без смен врачей считаются по рабочим часам кабинетов', async () => {
    await prisma.shift.deleteMany({ where: { clinicId } }); // в Cliniccards смен нет (профили врачей не заведены)
    const week = (from: string, to: string) => Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, { from, to }]));
    await http().put('/clinic/work-hours').set(auth(owner)).send(week('10:00', '14:00')).expect(200);

    const body = (await http().get('/reports/free-slots?days=7').set(auth(owner)).expect(200)).body;
    expect(body.rows.length).toBeGreaterThan(0);
    // без смен у окон нет врача: колонки «Лікар» нет, кабинеты подписаны названиями из Cliniccards
    expect(body.columns.map((c: { key: string }) => c.key)).not.toContain('doctor');
    expect(body.rows.every((r: { cabinet: string }) => /^Кабінет [12]$/.test(r.cabinet))).toBe(true);
    const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    for (const r of body.rows as { windows: string; freeMinutes: number }[]) {
      const ranges = r.windows.split(', ').map((w) => w.split('–').map(toMin));
      expect(ranges.every(([a, b]) => a >= 10 * 60 && b <= 14 * 60 && b - a >= 30)).toBe(true); // не выходят за рабочие часы
      expect(r.freeMinutes).toBeLessThanOrEqual(4 * 60);
    }

    // выходные дни не попадают в отчёт
    await http().put('/clinic/work-hours').set(auth(owner)).send(Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, null]))).expect(200);
    expect((await http().get('/reports/free-slots?days=7').set(auth(owner)).expect(200)).body.rows).toHaveLength(0);

    await http().put('/clinic/work-hours').set(auth(owner)).send(week('09:00', '20:00')).expect(200);
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201); // смены вернулись
  });

  it('пациент, исчезнувший из Cliniccards, скрывается из списков и отчётов, но данные остаются; вернулся — снова виден', async () => {
    const rows = async () => (await http().get('/reports/lapsed-patients?days=1').set(auth(owner)).expect(200)).body.rows as { patientId: string }[];
    const listTotal = async () => (await http().get('/patients').set(auth(owner)).expect(200)).body.total as number;
    const before = await rows();
    const totalBefore = await listTotal();
    expect(before.length).toBeGreaterThan(0);
    const target = await prisma.patient.findUniqueOrThrow({ where: { id: before[0].patientId } });
    // у пациента есть своя задача: она не должна пропасть
    const task = await prisma.task.create({ data: { clinicId, patientId: target.id, title: 'Позвонить', dueDate: new Date(), createdById: (await prisma.user.findFirstOrThrow({ where: { memberships: { some: { clinicId } } } })).id } });

    const saved = [...mock.data.patients];
    try {
      mock.data.patients.splice(0, mock.data.patients.length, ...saved.filter((p) => String(p.patient_id) !== target.externalId));
      await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);

      expect((await prisma.patient.findUniqueOrThrow({ where: { id: target.id } })).removedAt).toBeTruthy();
      expect((await rows()).some((r) => r.patientId === target.id)).toBe(false);
      expect(await listTotal()).toBe(totalBefore - 1);
      expect(await prisma.task.count({ where: { id: task.id } })).toBe(1); // данные сохранены
      const run = await prisma.syncRun.findFirstOrThrow({ where: { clinicId }, orderBy: { startedAt: 'desc' } });
      expect(run.extra).toMatchObject({ removedPatients: 1 });
      // по ссылке карточка открывается (с пометкой), чтобы не терять историю
      expect((await http().get(`/patients/${target.id}`).set(auth(owner)).expect(200)).body.removedAt).toBeTruthy();

      // Сбой: пришёл пустой список. Никого не скрываем.
      mock.data.patients.splice(0, mock.data.patients.length);
      await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
      const stillVisible = await prisma.patient.count({ where: { clinicId, removedAt: null } });
      expect(stillVisible).toBeGreaterThan(100);
      expect((await prisma.syncRun.findFirstOrThrow({ where: { clinicId }, orderBy: { startedAt: 'desc' } })).extra).toMatchObject({ removalSkipped: true });
    } finally {
      mock.data.patients.splice(0, mock.data.patients.length, ...saved);
    }
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: target.id } })).removedAt).toBeNull();
    expect(await listTotal()).toBe(totalBefore);
    await prisma.task.delete({ where: { id: task.id } });
  });

  it('две загрузки одной клиники не идут одновременно: вторая получает отказ, после завершения первой можно снова', async () => {
    const results = await Promise.all([
      http().post('/integrations/cliniccards/sync').set(auth(owner)),
      http().post('/integrations/cliniccards/sync').set(auth(owner)),
      http().post('/integrations/cliniccards/sync').set(auth(owner)),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((c) => c === 409).length).toBeGreaterThanOrEqual(1);
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
    // по окончании блокировки нет
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect(await prisma.syncRun.count({ where: { clinicId, status: 'RUNNING' } })).toBe(0);
  });

  it('пациент с активным напоминанием не попадает в списки «вернуть пациента»', async () => {
    const rows = async () => (await http().get('/reports/no-next-visit?days=90').set(auth(owner)).expect(200)).body.rows as { patientId: string }[];
    const before = await rows();
    expect(before.length).toBeGreaterThan(2);
    const target = before[0].patientId;
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: target } });

    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const reminder = { id: 9_900_001, patient_id: Number(patient.externalId), date: inTenDays, note: 'Позвонить', status: 'NEW', priority: 1, executors: ['ALL'] };
    mock.data.reminders.push(reminder);
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect((await rows()).some((r) => r.patientId === target)).toBe(false);
    expect(await prisma.reminder.count({ where: { clinicId, externalId: '9900001' } })).toBe(1);

    // Напоминание выполнено — пациент снова в списке
    reminder.status = 'DONE';
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect((await rows()).some((r) => r.patientId === target)).toBe(true);

    // Напоминание удалено в Cliniccards — пропадает и у нас; чужая клиника его не видит
    mock.data.reminders.length = 0;
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect(await prisma.reminder.count({ where: { clinicId } })).toBe(0);
  });

  it('логотип клиники подтягивается из профиля и виден только своей клинике', async () => {
    const mine = await http().get('/auth/me').set(auth(owner)).expect(200);
    expect(mine.body.clinicLogo).toMatch(/^data:image\/png;base64,/);

    const other = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Без логотипа ${rnd()}`, name: 'Ольга', email: `o${rnd()}@example.com`, password: 'password123' }).expect(201);
    const theirs = await http().get('/auth/me').set(auth(other.body.accessToken)).expect(200);
    expect(theirs.body.clinicLogo).toBeNull();
  });

  it('небезопасный или слишком большой логотип не принимается', async () => {
    const { CliniccardsConnector } = await import('../src/integrations/cliniccards.connector');
    const connectorWith = (logo: unknown) => new CliniccardsConnector({ get: async () => ({ logo }) } as never);
    expect((await connectorWith('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').fetchProfile()).logo).toBeUndefined();
    expect((await connectorWith('javascript:alert(1)').fetchProfile()).logo).toBeUndefined();
    expect((await connectorWith('data:image/png;base64,' + 'A'.repeat(1_000_001)).fetchProfile()).logo).toBeUndefined();
    expect((await connectorWith('data:image/jpeg;base64,/9j/4AAQ').fetchProfile()).logo).toBeDefined();
  });

  it('подключение ключа удаляет демо-данные (пациентов, платежи, акты, смены)', async () => {
    const demo = { clinicId, externalId: { startsWith: 'demo-' } };
    expect(await prisma.patient.count({ where: demo })).toBe(0);
    expect(await prisma.payment.count({ where: demo })).toBe(0);
    expect(await prisma.invoice.count({ where: demo })).toBe(0);
    expect(await prisma.shift.count({ where: demo })).toBe(0);
    const status = await http().get('/integrations/cliniccards').set(auth(owner)).expect(200);
    expect(status.body.mode).toBe('cliniccards');
  });

  it('загружает все сущности; пункты плана неизвестного пациента пропускаются', async () => {
    expect(await prisma.patient.count({ where: { clinicId } })).toBe(450);
    expect(await prisma.visit.count({ where: { clinicId } })).toBeGreaterThan(300);
    expect(await prisma.shift.count({ where: { clinicId } })).toBeGreaterThan(10);
    const items = await prisma.planItem.count({ where: { clinicId } });
    expect(items).toBeGreaterThan(50);
    expect(items).toBeLessThan(mock.data.planItems.length); // архивный пациент 999999 не загружен
    const run = (await http().get('/integrations/cliniccards/runs').set(auth(owner)).expect(200)).body[0];
    expect(run.status).toBe('OK');
    expect(run.extra.planItems).toBe(items);
  });

  it('повторная синхронизация не создаёт дублей', async () => {
    const count = async () => ({
      patients: await prisma.patient.count({ where: { clinicId } }),
      visits: await prisma.visit.count({ where: { clinicId } }),
      planItems: await prisma.planItem.count({ where: { clinicId } }),
      payments: await prisma.payment.count({ where: { clinicId } }),
      invoices: await prisma.invoice.count({ where: { clinicId } }),
      shifts: await prisma.shift.count({ where: { clinicId } }),
    });
    const before = await count();
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect(await count()).toEqual(before);
  });

  it('запись, удалённая в Cliniccards, исчезает и у нас; платёж без пациента сохраняется', async () => {
    const future = mock.data.visits.find((v) => String(v.visit_start) > new Date().toISOString().slice(0, 10) && v.status !== 'CANCELLED')!;
    const id = String(future.visit_id);
    expect(await prisma.visit.findUnique({ where: { clinicId_externalId: { clinicId, externalId: id } } })).not.toBeNull();

    mock.data.visits = mock.data.visits.filter((v) => v !== future);
    const run = await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201);
    expect(run.body.extra.removedVisits).toBeGreaterThanOrEqual(1);
    expect(await prisma.visit.findUnique({ where: { clinicId_externalId: { clinicId, externalId: id } } })).toBeNull();

    expect(await prisma.payment.count({ where: { clinicId, patientId: null } })).toBeGreaterThan(0);
  });

  it('если Cliniccards недоступен, ничего не удаляется и ошибка видна в истории', async () => {
    const visitsBefore = await prisma.visit.count({ where: { clinicId } });
    process.env.CLINICCARDS_BASE_URL = 'http://127.0.0.1:1';
    try {
      await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(500);
    } finally {
      process.env.CLINICCARDS_BASE_URL = mock.url;
    }
    expect(await prisma.visit.count({ where: { clinicId } })).toBe(visitsBefore);
    const status = await http().get('/integrations/cliniccards').set(auth(owner)).expect(200);
    expect(status.body.lastRun.status).toBe('FAILED');
    expect(status.body.lastRun.error).toContain('нет связи');
    await http().post('/integrations/cliniccards/sync').set(auth(owner)).expect(201); // и дальше всё работает
  });

  it('отчёты считаются на загруженных данных', async () => {
    const get = async (id: string, token = owner) => (await http().get(`/reports/${id}`).set(auth(token)).expect(200)).body;

    expect((await get('no-next-visit')).rows.length).toBeGreaterThan(0);
    expect((await get('missed-visits')).rows.length).toBeGreaterThan(0);
    expect((await get('sources')).rows.length).toBeGreaterThan(1);

    const unfinished = await get('unfinished-treatment');
    expect(unfinished.rows.length).toBeGreaterThan(0);
    for (const r of unfinished.rows) {
      expect(r.openItems).toBeGreaterThanOrEqual(1);
      expect(r.lastDoneAt).toBeTruthy();
    }
    // у пациентов из отчёта нет будущих действующих записей
    const ids = unfinished.rows.map((r: { patientId: string }) => r.patientId);
    const booked = await prisma.visit.count({
      where: { clinicId, patientId: { in: ids }, startsAt: { gt: new Date() }, status: { notIn: ['CANCELLED', 'DID_NOT_COME', 'MOVED'] } },
    });
    expect(booked).toBe(0);

    const debtors = await get('debtors');
    expect(debtors.rows.length).toBeGreaterThan(0);
    const debts = debtors.rows.map((r: { debt: number }) => r.debt);
    expect(debts.every((d: number) => d > 0)).toBe(true);
    expect(debts).toEqual([...debts].sort((a: number, b: number) => b - a));

    const revenue = await get('revenue');
    expect(revenue.rows.length).toBeGreaterThan(3);
    expect(revenue.rows[0].month > revenue.rows[1].month).toBe(true); // свежие месяцы сверху
    expect(revenue.rows.every((r: { invoiced: number; paid: number }) => r.invoiced >= 0 && r.paid >= 0)).toBe(true);
  });

  it('свободные окна: смена минус записи врача минус обед кабинета', async () => {
    const slots = (await http().get('/reports/free-slots?days=7').set(auth(owner)).expect(200)).body;
    expect(slots.rows.length).toBeGreaterThan(3);
    const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

    for (const r of slots.rows as { cabinet: string; windows: string; freeMinutes: number }[]) {
      const ranges = r.windows.split(', ').map((w) => w.split('–').map(toMin));
      expect(ranges.every(([a, b]) => b - a >= 30)).toBe(true);
      expect(ranges.reduce((s, [a, b]) => s + (b - a), 0)).toBe(r.freeMinutes);
      if (r.cabinet === 'Кабінет 1') {
        // в первом кабинете с 13:00 до 14:00 обед: ни одно окно не должно его пересекать
        expect(ranges.every(([a, b]) => b <= 13 * 60 || a >= 14 * 60)).toBe(true);
      }
    }
    // сумма свободного не больше длины смены (9 часов)
    expect(slots.rows.every((r: { freeMinutes: number }) => r.freeMinutes <= 9 * 60)).toBe(true);
  });

  it('финансовый отчёт закрыт для администратора и скрыт в каталоге; остальное доступно', async () => {
    await http().get('/reports/revenue').set(auth(admin)).expect(403);
    await http().get('/reports/revenue/csv').set(auth(admin)).expect(403);
    await http().get('/reports/revenue/xlsx').set(auth(admin)).expect(403);
    await http().get('/reports/revenue/pdf').set(auth(admin)).expect(403);
    const catalog = (await http().get('/reports').set(auth(admin)).expect(200)).body.map((c: { id: string }) => c.id);
    expect(catalog).not.toContain('revenue');
    expect(catalog).toEqual(expect.arrayContaining(['debtors', 'unfinished-treatment', 'free-slots']));
    const ownerCatalog = (await http().get('/reports').set(auth(owner)).expect(200)).body;
    expect(ownerCatalog).toHaveLength(9);
    expect(ownerCatalog.find((c: { id: string }) => c.id === 'debtors').usesDays).toBe(false);

    const err = await http().get('/reports/revenue').set(auth(admin)).set('Accept-Language', 'en').expect(403);
    expect(err.body.message).toBe('This report is not available for your role');
  });

  it('задачи из отчётов «Незавершённое лечение» и «Задолженность»; из финансов задач нет', async () => {
    const t1 = await http().post('/tasks/from-report').set(auth(admin)).send({ reportId: 'unfinished-treatment' }).expect(201);
    expect(t1.body.created).toBeGreaterThan(0);
    const t2 = await http().post('/tasks/from-report').set(auth(admin)).send({ reportId: 'debtors' }).expect(201);
    expect(t2.body.created).toBeGreaterThan(0);
    await http().post('/tasks/from-report').set(auth(admin)).send({ reportId: 'revenue' }).expect(400);
    const titles = (await http().get('/tasks?status=OPEN').set(auth(admin)).expect(200)).body.map((t: { title: string }) => t.title);
    expect(titles).toContain('Запропонувати продовжити лікування'); // язык по умолчанию — украинский
    expect(titles).toContain('Нагадати про заборгованість');
  });

  it('CSV новых отчётов подписан на языке запроса', async () => {
    const en = await http().get('/reports/debtors/csv').set(auth(owner)).set('Accept-Language', 'en').expect(200);
    expect(en.text.split('\r\n')[0]).toContain('"Patient";"Phone";"Billed";"Paid";"Debt"');
    const uk = await http().get('/reports/free-slots/csv').set(auth(owner)).expect(200);
    expect(uk.text.split('\r\n')[0]).toContain('"Дата";"Лікар";"Кабінет"');
  });
});
