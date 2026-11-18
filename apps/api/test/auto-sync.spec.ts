import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { localToUtc } from '../src/common/clinic-time';
import { encrypt } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { AppModule } from '../src/app.module';
import { LlmClient } from '../src/ai/llm.client';
import { TelegramApi } from '../src/automations/telegram.api';
import { OutboxService } from '../src/automations/outbox.service';
import { reminderKey } from '../src/automations/visit-reminders';
import { AutoSyncService } from '../src/integrations/auto-sync.service';
import { autoSyncSlot } from '../src/integrations/auto-sync-schedule';
import { ClinicConnector, ExternalVisit } from '../src/integrations/connector';
import { SyncService } from '../src/integrations/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// The daily automatic Cliniccards load (03:00 in the clinic's zone, one run a day, bounded retries) and the fresh check of each appointment reminder.
// Nothing goes to Cliniccards or Telegram: the load itself and the connector are replaced, Telegram is a fake.
const tg = {
  sent: [] as { chatId: string; text: string }[],
  getMe: async () => ({ id: 1, username: 'sync_test_bot' }), getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
  sendMessage: async (_t: string, chatId: string | number, text: string) => void tg.sent.push({ chatId: String(chatId), text }),
  answerCallbackQuery: async () => undefined,
  getUpdates: async () => [],
  setWebhook: async () => true,
  deleteWebhook: async () => true,
};

let app: INestApplication;
let prisma: PrismaService;
let sync: SyncService;
let auto: AutoSyncService;
let outbox: OutboxService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const MIN = 60_000;
// the clinics made by the current test: the scheduler is checked only on them (the test database holds the clinics of every other test file)
let ids: string[] = [];

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TelegramApi)
    .useValue(tg)
    .overrideProvider(LlmClient)
    .useValue({ configured: false, complete: async () => { throw new Error('no AI in tests'); } })
    .compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  sync = app.get(SyncService);
  auto = app.get(AutoSyncService);
  outbox = app.get(OutboxService);
});
afterAll(async () => app.close());
beforeEach(() => {
  ids = [];
});
afterEach(() => {
  jest.restoreAllMocks();
  tg.sent.length = 0;
});

async function clinic(opts: { cliniccards?: boolean } = {}) {
  const email = `s${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  ids.push(clinicId);
  if (opts.cliniccards !== false) await prisma.integration.create({ data: { clinicId, provider: 'CLINICCARDS', apiKeyEnc: encrypt(`key-${rnd()}`) } });
  return { token: res.body.accessToken as string, clinicId };
}

// a moment of the clinic's day in Kyiv time
const kyiv = (s: string) => localToUtc(s);
// the load itself is replaced: it only records the call (or fails) and stamps the load as the real one does
function fakeLoads(fail: (clinicId: string) => Error | null = () => null) {
  const calls: string[] = [];
  jest.spyOn(sync, 'run').mockImplementation(async (clinicId: string) => {
    calls.push(clinicId);
    const e = fail(clinicId);
    if (e) throw e;
    await prisma.integration.updateMany({ where: { clinicId, provider: 'CLINICCARDS' }, data: { lastSyncAt: new Date() } });
    return {} as never;
  });
  return calls;
}
const mine = (calls: string[], clinicId: string) => calls.filter((c) => c === clinicId).length;
const state = (clinicId: string) => prisma.integration.findFirstOrThrow({ where: { clinicId, provider: 'CLINICCARDS' }, select: { autoSyncDay: true, autoSyncAttempts: true, autoSyncRetryAt: true } });

describe('щоденне автоматичне оновлення Cliniccards', () => {
  it('03:00 за часовим поясом клініки: взимку й улітку, наступний запуск', () => {
    // Kyiv is UTC+2 in winter and UTC+3 in summer
    expect(autoSyncSlot(new Date('2026-12-10T10:00:00Z')).at.toISOString()).toBe('2026-12-10T01:00:00.000Z');
    expect(autoSyncSlot(new Date('2026-07-10T10:00:00Z')).at.toISOString()).toBe('2026-07-10T00:00:00.000Z');
    // before 03:00 the next run is today's, after it tomorrow's
    expect(autoSyncSlot(new Date('2026-12-10T00:30:00Z')).nextAt.toISOString()).toBe('2026-12-10T01:00:00.000Z');
    expect(autoSyncSlot(new Date('2026-12-10T01:30:00Z')).nextAt.toISOString()).toBe('2026-12-11T01:00:00.000Z');
    // the clinic day is the local one: 23:30 UTC on 9 December is already 10 December in Kyiv
    expect(autoSyncSlot(new Date('2026-12-09T23:30:00Z')).day).toBe('2026-12-10');
  });

  it('один запуск на день, також при двох серверах; до 03:00 нічого; ручне оновлення після 03:00 зараховується; лише клініки з ключем Cliniccards', async () => {
    const a = await clinic();
    const b = await clinic();
    const tgOnly = await clinic({ cliniccards: false });
    await prisma.integration.create({ data: { clinicId: tgOnly.clinicId, provider: 'TELEGRAM', apiKeyEnc: encrypt('123:tg') } });
    const calls = fakeLoads();

    await auto.tick(kyiv('2026-12-10 02:59:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(0);

    // two servers check at the same moment: each clinic is loaded once
    const other = new AutoSyncService(prisma, sync);
    await Promise.all([auto.tick(kyiv('2026-12-10 03:05:00'), { clinicIds: ids }), other.tick(kyiv('2026-12-10 03:05:00'), { clinicIds: ids })]);
    expect(mine(calls, a.clinicId)).toBe(1);
    expect(mine(calls, b.clinicId)).toBe(1);
    expect(mine(calls, tgOnly.clinicId)).toBe(0);
    expect((await state(a.clinicId)).autoSyncDay).toBe('2026-12-10');

    // later checks of the same day do nothing
    await auto.tick(kyiv('2026-12-10 09:00:00'), { clinicIds: ids });
    await auto.tick(kyiv('2026-12-10 23:55:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(1);

    // the next day: once again
    await auto.tick(kyiv('2026-12-11 03:01:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(2);

    // a manual load after today's 03:00 is the day's load (the claim is made without a second load)
    const c = await clinic();
    await prisma.integration.updateMany({ where: { clinicId: c.clinicId, provider: 'CLINICCARDS' }, data: { lastSyncAt: kyiv('2026-12-12 03:30:00') } });
    await auto.tick(kyiv('2026-12-12 04:00:00'), { clinicIds: ids });
    expect(mine(calls, c.clinicId)).toBe(0);
    expect(await state(c.clinicId)).toMatchObject({ autoSyncDay: '2026-12-12', autoSyncAttempts: 0 });
  });

  it('збій: повтор через 30 хвилин, не більше 3 спроб на день; наступного дня спроби знову', async () => {
    const a = await clinic();
    let failing = true;
    const calls = fakeLoads((id) => (id === a.clinicId && failing ? new Error('Cliniccards /visits: нет связи с сервером (test)') : null));

    await auto.tick(kyiv('2026-12-15 03:00:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(1);
    expect((await state(a.clinicId)).autoSyncRetryAt?.toISOString()).toBe(new Date(kyiv('2026-12-15 03:00:00').getTime() + 30 * MIN).toISOString());
    await auto.tick(kyiv('2026-12-15 03:20:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(1);
    await auto.tick(kyiv('2026-12-15 03:31:00'), { clinicIds: ids });
    await auto.tick(kyiv('2026-12-15 04:05:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(3);
    // the third failure was the last attempt of the day
    expect(await state(a.clinicId)).toMatchObject({ autoSyncAttempts: 3, autoSyncRetryAt: null });
    await auto.tick(kyiv('2026-12-15 06:00:00'), { clinicIds: ids });
    await auto.tick(kyiv('2026-12-15 20:00:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(3);

    failing = false;
    await auto.tick(kyiv('2026-12-16 03:02:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(4);
    expect(await state(a.clinicId)).toMatchObject({ autoSyncDay: '2026-12-16', autoSyncAttempts: 1, autoSyncRetryAt: null });
  });

  it('перезапуск: під час оренди спроби не запускається нічого; оборвана спроба повторюється після оренди; пропущені 03:00 сьогодні наздоганяються один раз', async () => {
    const a = await clinic();
    const calls = fakeLoads();
    // the server died during the 03:00 attempt: the day is claimed, the lease runs until 03:45
    await prisma.integration.updateMany({ where: { clinicId: a.clinicId, provider: 'CLINICCARDS' }, data: { autoSyncDay: '2026-12-20', autoSyncAttempts: 1, autoSyncRetryAt: kyiv('2026-12-20 03:45:00') } });
    await auto.tick(kyiv('2026-12-20 03:20:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(0);
    await auto.tick(kyiv('2026-12-20 03:50:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(1);
    expect(await state(a.clinicId)).toMatchObject({ autoSyncAttempts: 2, autoSyncRetryAt: null });

    // the server was off at 03:00 and starts at 10:00: today's load once, not on every start
    const b = await clinic();
    await auto.tick(kyiv('2026-12-21 10:00:00'), { clinicIds: ids });
    await auto.tick(kyiv('2026-12-21 10:05:00'), { clinicIds: ids });
    expect(mine(calls, b.clinicId)).toBe(1);
    // a day that passed without a load is not made up the next night before 03:00
    const c = await clinic();
    await prisma.integration.updateMany({ where: { clinicId: c.clinicId, provider: 'CLINICCARDS' }, data: { autoSyncDay: '2026-12-21', autoSyncAttempts: 3, autoSyncRetryAt: null } });
    await auto.tick(kyiv('2026-12-22 01:00:00'), { clinicIds: ids });
    expect(mine(calls, c.clinicId)).toBe(0);
  });

  it('ручне й автоматичне не йдуть одночасно: ручне під час завантаження — 409; автоматичне під час ручного відкладається, а не рахується помилкою', async () => {
    const a = await clinic();
    const integration = await prisma.integration.findFirstOrThrow({ where: { clinicId: a.clinicId, provider: 'CLINICCARDS' } });
    // a load is going on (the real lock: the "running" record of this clinic)
    const run = await prisma.syncRun.create({ data: { clinicId: a.clinicId, integrationId: integration.id } });
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(409);
    await expect(sync.run(a.clinicId, null)).rejects.toBeInstanceOf(ConflictException);
    // the status shows that a load is going on
    expect((await http().get('/integrations/cliniccards').set(auth(a.token)).expect(200)).body.lastRun.status).toBe('RUNNING');
    await prisma.syncRun.update({ where: { id: run.id }, data: { status: 'OK', finishedAt: new Date() } });

    // the scheduled load meets a manual one going on: tried again later
    const calls = fakeLoads((id) => (id === a.clinicId ? new ConflictException('sync_running') : null));
    await auto.tick(kyiv('2026-12-25 03:00:00'), { clinicIds: ids });
    expect(mine(calls, a.clinicId)).toBe(1);
    expect((await state(a.clinicId)).autoSyncRetryAt?.getTime()).toBe(kyiv('2026-12-25 03:30:00').getTime());
  });

  it('кілька серверів: запуск одного не обриває живе завантаження іншого; без сигналу понад 2 хвилини або старше 30 хвилин — обірване', async () => {
    const a = await clinic();
    const integrationId = (await prisma.integration.findFirstOrThrow({ where: { clinicId: a.clinicId, provider: 'CLINICCARDS' } })).id;
    const mk = (over: object) => prisma.syncRun.create({ data: { clinicId: a.clinicId, integrationId, ...over } });
    const ago = (ms: number) => new Date(Date.now() - ms);
    // another server's load: started 10 minutes ago, alive 15 seconds ago
    const alive = await mk({ startedAt: ago(10 * 60_000), heartbeatAt: ago(15_000) });
    const b = await clinic();
    const bInt = (await prisma.integration.findFirstOrThrow({ where: { clinicId: b.clinicId, provider: 'CLINICCARDS' } })).id;
    const silent = await prisma.syncRun.create({ data: { clinicId: b.clinicId, integrationId: bInt, startedAt: ago(10 * 60_000), heartbeatAt: ago(3 * 60_000) } });
    const d = await clinic();
    const dInt = (await prisma.integration.findFirstOrThrow({ where: { clinicId: d.clinicId, provider: 'CLINICCARDS' } })).id;
    // records made before the signal existed: a recent one is left, an old one is closed
    const legacyNew = await prisma.syncRun.create({ data: { clinicId: d.clinicId, integrationId: dInt, startedAt: ago(5 * 60_000) } });
    const e = await clinic();
    const eInt = (await prisma.integration.findFirstOrThrow({ where: { clinicId: e.clinicId, provider: 'CLINICCARDS' } })).id;
    const legacyOld = await prisma.syncRun.create({ data: { clinicId: e.clinicId, integrationId: eInt, startedAt: ago(31 * 60_000) } });

    // this server starts
    await sync.onApplicationBootstrap();
    const st = async (id: string) => (await prisma.syncRun.findUniqueOrThrow({ where: { id } })).status;
    expect(await st(alive.id)).toBe('RUNNING');
    expect(await st(silent.id)).toBe('FAILED');
    expect(await st(legacyNew.id)).toBe('RUNNING');
    expect(await st(legacyOld.id)).toBe('FAILED');
    // the live load still blocks a second start for its clinic
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(409);
    await prisma.syncRun.updateMany({ where: { id: { in: [alive.id, legacyNew.id] } }, data: { status: 'FAILED', finishedAt: new Date() } });
  });

  it('стан у налаштуваннях: увімкнено лише якщо сервер це робить і є ключ; остання помилка зрозумілим видом', async () => {
    const a = await clinic();
    const demo = await clinic({ cliniccards: false });
    // tests run with AUTO_SYNC_MINUTES=0: off
    expect((await http().get('/integrations/cliniccards').set(auth(a.token)).expect(200)).body.autoSync).toMatchObject({ enabled: false, nextAt: null });
    const before = process.env.AUTO_SYNC_MINUTES;
    process.env.AUTO_SYNC_MINUTES = '60';
    try {
      const st = (await http().get('/integrations/cliniccards').set(auth(a.token)).expect(200)).body.autoSync;
      expect(st).toMatchObject({ enabled: true, hour: 3, timeZone: 'Europe/Kyiv' });
      expect(new Date(st.nextAt).getTime()).toBeGreaterThan(Date.now());
      expect((await http().get('/integrations/cliniccards').set(auth(demo.token)).expect(200)).body.autoSync.enabled).toBe(false);
      process.env.AUTO_SYNC = 'off';
      expect((await http().get('/integrations/cliniccards').set(auth(a.token)).expect(200)).body.autoSync.enabled).toBe(false);
    } finally {
      process.env.AUTO_SYNC_MINUTES = before;
      delete process.env.AUTO_SYNC;
    }
    const integration = await prisma.integration.findFirstOrThrow({ where: { clinicId: a.clinicId, provider: 'CLINICCARDS' } });
    await prisma.syncRun.create({ data: { clinicId: a.clinicId, integrationId: integration.id, status: 'FAILED', finishedAt: new Date(), error: 'Cliniccards /visits: нет связи с сервером (ECONNRESET)' } });
    expect((await http().get('/integrations/cliniccards').set(auth(a.token)).expect(200)).body.lastRun).toMatchObject({ status: 'FAILED', errorKind: 'network' });
  });
});

describe('нагадування про візит перевіряє запис у Cliniccards перед відправкою', () => {
  // a working day in the sending window (Kyiv), and the visit tomorrow at 10:00
  const NOW = kyiv('2026-12-01 12:00:00');
  const AT = kyiv('2026-12-02 10:00:00');

  async function setup() {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { sendingEnabled: true, plan: 'PRO' } });
    await prisma.integration.create({ data: { clinicId: c.clinicId, provider: 'TELEGRAM', apiKeyEnc: encrypt('123456:tg-token') } });
    return c;
  }
  async function reminder(clinicId: string, opts: { at?: Date } = {}) {
    const at = opts.at ?? AT;
    const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Олена', consent: 'GIVEN' } });
    await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
    const visit = await prisma.visit.create({ data: { clinicId, patientId: p.id, externalId: `v${rnd()}`, status: 'PLANNED', startsAt: at, endsAt: new Date(at.getTime() + 30 * MIN) } });
    const m = await prisma.outboundMessage.create({ data: { clinicId, patientId: p.id, ruleKey: 'visit-reminder', channel: 'TELEGRAM', text: 'Нагадуємо про візит', status: 'APPROVED', scheduledFor: new Date(NOW.getTime() - MIN), expiresAt: at, visitId: visit.id, dedupeKey: reminderKey(visit.id, 24, at) } });
    return { visit, m };
  }
  // what Cliniccards answers now for the visit's day; counts the reads
  function cliniccards(rows: () => ExternalVisit[] | Error) {
    const reads = { n: 0 };
    const connector = { fetchVisits: async () => { reads.n++; const r = rows(); if (r instanceof Error) throw r; return r; } } as unknown as ClinicConnector;
    jest.spyOn(sync, 'connectorForClinic').mockResolvedValue(connector);
    return reads;
  }
  const ext = (externalId: string, startsAt: Date, status = 'PLANNED'): ExternalVisit => ({ externalId, patientExternalId: 'x', startsAt, status } as ExternalVisit);
  const row = (id: string) => prisma.outboundMessage.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } });

  it('запис на місці й о тій самій годині: надсилається; кілька нагадувань одного дня — одне читання Cliniccards', async () => {
    const c = await setup();
    const one = await reminder(c.clinicId);
    const two = await reminder(c.clinicId);
    const reads = cliniccards(() => [ext(one.visit.externalId, AT), ext(two.visit.externalId, AT, 'CONFIRMED')]);
    await outbox.process(NOW, { clinicId: c.clinicId });
    expect((await row(one.m.id)).status).toBe('SENT');
    expect((await row(two.m.id)).status).toBe('SENT');
    expect(reads.n).toBe(1);
    expect(tg.sent).toHaveLength(2);
  });

  it('у Cliniccards запис перенесено, скасовано або видалено: нагадування зі старим часом скасовується; наш запис не змінюється', async () => {
    const c = await setup();
    const moved = await reminder(c.clinicId);
    const cancelled = await reminder(c.clinicId);
    const gone = await reminder(c.clinicId);
    cliniccards(() => [ext(moved.visit.externalId, new Date(AT.getTime() + 2 * 3600_000)), ext(cancelled.visit.externalId, AT, 'CANCELLED')]);
    await outbox.process(NOW, { clinicId: c.clinicId });
    for (const r of [moved, cancelled, gone]) expect(await row(r.m.id)).toEqual({ status: 'CANCELLED', error: 'Запис змінено або скасовано в Cliniccards' });
    expect(tg.sent).toHaveLength(0);
    // no load of the clinic for this: our copy keeps the old data until the daily load
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: moved.visit.id } })).startsAt.getTime()).toBe(AT.getTime());
  });

  it('Cliniccards не відповідає: нагадування не надсилається, причина записана; повтору немає', async () => {
    const c = await setup();
    const r = await reminder(c.clinicId);
    const reads = cliniccards(() => new Error('Cliniccards /visits: нет связи с сервером (test)'));
    await outbox.process(NOW, { clinicId: c.clinicId });
    expect(await row(r.m.id)).toEqual({ status: 'FAILED', error: 'Не вдалося перевірити запис у Cliniccards: нагадування не надіслано' });
    await outbox.process(new Date(NOW.getTime() + 5 * MIN), { clinicId: c.clinicId });
    expect(reads.n).toBe(1);
    expect(tg.sent).toHaveLength(0);
  });

  it('клініка без ключа Cliniccards (демо): лише власна копія, як раніше; інші повідомлення не перевіряються', async () => {
    const c = await setup();
    const r = await reminder(c.clinicId);
    jest.spyOn(sync, 'connectorForClinic').mockResolvedValue(null);
    await outbox.process(NOW, { clinicId: c.clinicId });
    expect((await row(r.m.id)).status).toBe('SENT');

    // a message that is not about a visit's time asks nothing
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Іван', consent: 'GIVEN' } });
    await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: `chat-${rnd()}` } });
    const thanks = await prisma.outboundMessage.create({ data: { clinicId: c.clinicId, patientId: p.id, ruleKey: 'post-visit-thanks', channel: 'TELEGRAM', text: 'Дякуємо', status: 'APPROVED', scheduledFor: new Date(NOW.getTime() - MIN), dedupeKey: `t${rnd()}` } });
    const reads = cliniccards(() => new Error('must not be read'));
    await outbox.process(NOW, { clinicId: c.clinicId });
    expect((await row(thanks.id)).status).toBe('SENT');
    expect(reads.n).toBe(0);
  });
});
