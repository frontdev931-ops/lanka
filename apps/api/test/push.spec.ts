import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RequestsService } from '../src/automations/requests.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { InsightsService } from '../src/insights/insights.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PushSender } from '../src/push/push.service';

// Push per device (2026-11-25): devices, owners, clinics, signals, the test. Nothing reaches a real push service.
jest.setTimeout(120_000);

const fake = {
  configured: true,
  sent: [] as { endpoint: string; payload: { title: string; body: string; url: string; tag?: string }; ttl: number }[],
  gone: new Set<string>(),
  broken: new Set<string>(),
  send: async (sub: { endpoint: string }, payload: { title: string; body: string; url: string; tag?: string }, opts: { ttl: number }) => {
    if (fake.gone.has(sub.endpoint)) throw Object.assign(new Error(`gone ${sub.endpoint}`), { statusCode: 410 });
    if (fake.broken.has(sub.endpoint)) throw Object.assign(new Error(`server error for ${sub.endpoint}`), { statusCode: 500 });
    fake.sent.push({ endpoint: sub.endpoint, payload, ttl: opts.ttl });
  },
};

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const device = (n: string) => ({ endpoint: `https://push.example/${n}-${rnd()}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PushSender).useValue(fake).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  fake.sent.length = 0;
  fake.gone.clear();
  fake.broken.clear();
  fake.configured = true;
});

async function clinic(plan = 'PRO') {
  const email = `pu${rnd()}@example.com`;
  const name = `Клініка ${rnd()}`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: name, name: 'Олена Власниця', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan, billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * 86_400_000) } });
  return { token: res.body.accessToken as string, clinicId, userId: user.id, name, email };
}
async function member(ownerToken: string, role: string, email = `pm${rnd()}@example.com`) {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const res = await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: `Роль ${role}`, password: PASSWORD });
  const token = (res.body.accessToken as string) ?? '';
  return { token, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, email };
}
const on = (token: string, d: ReturnType<typeof device>, lang = 'uk') => http().post('/push/subscribe').set(auth(token)).send({ ...d, lang }).expect(200);
const state = async (token: string, endpoint: string) => (await http().post('/push/device').set(auth(token)).send({ endpoint }).expect(200)).body.device as string;
const request_ = (clinicId: string) => app.get(RequestsService).upsert(clinicId, { channel: 'TELEGRAM', chatId: `c${rnd()}`, patientId: null, contactName: 'Тарас Секретний', kind: 'BOOKING', summary: 'Біль у зубі, телефон 0501234567' });
const to = () => fake.sent.map((x) => x.endpoint).sort();

describe('Push на пристроях', () => {
  it('два пристрої незалежні; повторне ввімкнення без дублікатів; вимкнення одного не чіпає іншого; ліміт тексту без даних пацієнтів', async () => {
    const c = await clinic();
    const phone = device('phone');
    const laptop = device('laptop');
    await on(c.token, phone);
    await on(c.token, laptop, 'en');
    const first = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: phone.endpoint } });
    await on(c.token, phone); // the same device again
    expect(await prisma.pushSubscription.count({ where: { userId: c.userId } })).toBe(2);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: phone.endpoint } })).enabledAt).toEqual(first.enabledAt);
    await request_(c.clinicId);
    expect(to()).toEqual([laptop.endpoint, phone.endpoint].sort());
    const uk = fake.sent.find((x) => x.endpoint === phone.endpoint)!;
    const en = fake.sent.find((x) => x.endpoint === laptop.endpoint)!;
    expect(uk.payload.title).toBe(`${c.name} · Нова заявка`);
    expect(en.payload.title).toBe(`${c.name} · New request`);
    expect(uk.ttl).toBe(7200);
    expect(JSON.stringify(fake.sent)).not.toMatch(/Тарас|0501234567|Біль/);
    // switching the phone off: confirmed by the server, the laptop still receives
    const off = (await http().post('/push/unsubscribe').set(auth(c.token)).send({ endpoint: phone.endpoint }).expect(200)).body;
    expect(off).toMatchObject({ removed: 1, device: 'none' });
    fake.sent.length = 0;
    await request_(c.clinicId);
    expect(to()).toEqual([laptop.endpoint]);
  });

  it('вихід і вхід іншої людини на тому ж пристрої: попередня підписка не успадковується; чужу підписку видалити не можна', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    const shared = device('shared');
    await on(c.token, shared);
    // the manager signs in on the owner's phone: the device is "someone else's"
    expect(await state(m.token, shared.endpoint)).toBe('other');
    await http().post('/push/unsubscribe').set(auth(m.token)).send({ endpoint: shared.endpoint }).expect(200);
    expect(await prisma.pushSubscription.count({ where: { endpoint: shared.endpoint } })).toBe(1);
    // the browser unsubscribed: the push service answers 410 and the row goes at the next send; the manager gets nothing of the owner
    fake.gone.add(shared.endpoint);
    await request_(c.clinicId);
    expect(await prisma.pushSubscription.count({ where: { endpoint: shared.endpoint } })).toBe(0);
    // or the manager switches it on explicitly on that device: it becomes theirs, from now on
    fake.gone.clear();
    const again = device('shared2');
    await on(c.token, again);
    const before = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: again.endpoint } });
    await on(m.token, again);
    const after = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: again.endpoint } });
    expect(after.userId).toBe(m.userId);
    expect(after.enabledAt.getTime()).toBeGreaterThanOrEqual(before.enabledAt.getTime());
    expect(await state(c.token, again.endpoint)).toBe('other');
    // sign-out of the owner on their own device: the server stops at once
    const own = device('own');
    await on(c.token, own);
    await http().post('/push/unsubscribe').set(auth(c.token)).send({ endpoint: own.endpoint }).expect(200);
    fake.sent.length = 0;
    await request_(c.clinicId);
    expect(to()).toEqual([again.endpoint]); // only the manager's (requests go to the manager too)
  });

  it('ролі й клініки: втрата ролі чи членства — нічого; пристрій не прив’язаний до вибраної клініки; заблокована клініка — нічого', async () => {
    const a = await clinic();
    const b = await clinic();
    // one person in both clinics: a manager in A, a doctor in B
    const email = `both${rnd()}@example.com`;
    const inA = await member(a.token, 'MANAGER', email);
    const invB = await http().post('/team/invitations').set(auth(b.token)).send({ email, role: 'DOCTOR' }).expect(201);
    await http().post(`/invites/${(invB.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'x', password: PASSWORD });
    const d = device('multi');
    await on(inA.token, d);
    await request_(a.clinicId);
    await request_(b.clinicId);
    expect(fake.sent.filter((x) => x.endpoint === d.endpoint).map((x) => x.payload.url)).toEqual([expect.stringContaining(`c=${a.clinicId}`)]); // a doctor in B gets nothing
    // the person becomes a manager in B: B's requests reach the same device, A's link still names A (no rebinding)
    await prisma.membership.update({ where: { userId_clinicId: { userId: inA.userId, clinicId: b.clinicId } }, data: { role: 'MANAGER' } });
    fake.sent.length = 0;
    await request_(b.clinicId);
    expect(fake.sent.filter((x) => x.endpoint === d.endpoint).map((x) => x.payload.url)).toEqual([expect.stringContaining(`c=${b.clinicId}`)]);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: d.endpoint } })).clinicId).toBe(a.clinicId);
    // a lost role in A: nothing from A any more; a removed membership: nothing either
    await prisma.membership.update({ where: { userId_clinicId: { userId: inA.userId, clinicId: a.clinicId } }, data: { role: 'DOCTOR' } });
    await prisma.membership.delete({ where: { userId_clinicId: { userId: inA.userId, clinicId: b.clinicId } } });
    fake.sent.length = 0;
    await request_(a.clinicId);
    await request_(b.clinicId);
    expect(fake.sent.filter((x) => x.endpoint === d.endpoint)).toHaveLength(0);
    // a suspended clinic sends nothing
    const own = device('susp');
    await on(a.token, own);
    await prisma.clinic.update({ where: { id: a.clinicId }, data: { suspendedAt: new Date() } });
    fake.sent.length = 0;
    await request_(a.clinicId);
    expect(fake.sent).toHaveLength(0);
  });

  it('сигнали: лише власник і керуючий, лише «Про», лише пристрої, ввімкнені до події; одна подія — одне сповіщення; без чисел', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    const owner = device('o');
    const mgr = device('m');
    const adm = device('a');
    await on(c.token, owner);
    await on(m.token, mgr);
    await on(admin.token, adm);
    for (let i = 0; i < 4; i++) await prisma.task.create({ data: { clinicId: c.clinicId, title: 'T', dueDate: new Date(Date.now() - 3 * 86_400_000), status: 'OPEN' } });
    await http().patch('/alerts/OVERDUE_TASKS').set(auth(c.token)).send({ threshold: 2, push: true }).expect(200);
    const ins = app.get(InsightsService);
    // the first check after switching on records the baseline: nothing accumulated
    expect(await ins.evaluate(c.clinicId)).toEqual([]);
    expect(fake.sent).toHaveLength(0);
    // normal → deviation: one event
    await prisma.alertRule.updateMany({ where: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' }, data: { evalState: 'OK', evalValue: 0, evalAt: new Date(Date.now() - 3_600_000) } });
    // a device switched on after the event must not get it: the event is created, then the late device appears before the delivery
    const late = device('late');
    const realDeliver = ins.deliverPending.bind(ins);
    const spy = jest.spyOn(ins, 'deliverPending').mockImplementationOnce(async (clinicId, now) => {
      await new Promise((r) => setTimeout(r, 5));
      await on(c.token, late);
      return realDeliver(clinicId, now);
    });
    const runs = await Promise.all([ins.evaluate(c.clinicId), ins.evaluate(c.clinicId)]);
    spy.mockRestore();
    expect(runs.flat()).toEqual(['OVERDUE_TASKS']);
    expect(to()).toEqual([mgr.endpoint, owner.endpoint].sort()); // not the administrator, not the late device, once each
    const p = fake.sent[0].payload;
    expect(p.title).toBe(`${c.name} · Сигнал`);
    expect(p.body).toBe('Прострочені завдання. Відкрийте, щоб переглянути подробиці.');
    expect(p.body).not.toMatch(/\d/);
    expect(p.url).toMatch(new RegExp(`^/open\\?c=${c.clinicId}&to=%2Fsignals%2FOVERDUE_TASKS%3Fc%3D`));
    expect(fake.sent[0].ttl).toBe(6 * 3600);
    // repeated checks: nothing more
    await ins.evaluate(c.clinicId);
    expect(fake.sent).toHaveLength(2);
    // Start: the plan has no signals, Push of a signal is not sent
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'START' } });
    await prisma.alertRule.updateMany({ where: { clinicId: c.clinicId, kind: 'OVERDUE_TASKS' }, data: { evalState: 'OK', evalAt: new Date(Date.now() - 3_600_000), lastFiredAt: new Date(Date.now() - 25 * 3_600_000) } });
    fake.sent.length = 0;
    await ins.deliverPending(c.clinicId);
    await ins.evaluateAll();
    expect(fake.sent).toHaveLength(0);
  });

  it('тест — лише на цей пристрій цієї людини, раз на хвилину; оновлення підписки; збій одного пристрою не заважає іншим; у журналі немає адрес', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    const mine = device('mine');
    const second = device('second');
    const his = device('his');
    await on(c.token, mine);
    await on(c.token, second);
    await on(m.token, his);
    expect((await http().post('/push/test').set(auth(c.token)).send({ endpoint: mine.endpoint }).expect(200)).body.sent).toBe(1);
    expect(fake.sent).toEqual([{ endpoint: mine.endpoint, payload: { title: 'LANKA · Сповіщення працюють', body: 'Тестове сповіщення лише на цей пристрій.', url: '/settings#push', tag: 'test', u: expect.any(String) }, ttl: 300 }]);
    await http().post('/push/test').set(auth(c.token)).send({ endpoint: second.endpoint }).expect(400); // a minute has not passed
    await http().post('/push/test').set(auth(m.token)).send({ endpoint: mine.endpoint }).expect(404); // not the manager's device
    // renewed by the browser: the row moves, no duplicate
    const renewed = device('renewed');
    await http().post('/push/renew').set(auth(c.token)).send({ oldEndpoint: second.endpoint, endpoint: renewed.endpoint, keys: renewed.keys }).expect(200);
    await http().post('/push/renew').set(auth(m.token)).send({ oldEndpoint: mine.endpoint, endpoint: device('x').endpoint, keys: renewed.keys }).expect(404);
    expect(await prisma.pushSubscription.count({ where: { userId: c.userId } })).toBe(2);
    expect(await prisma.pushSubscription.count({ where: { endpoint: second.endpoint } })).toBe(0);
    // one broken device: the others still get it; the log has the status only
    const warn = jest.spyOn(Logger.prototype, 'warn');
    fake.broken.add(mine.endpoint);
    fake.sent.length = 0;
    await request_(c.clinicId);
    expect(to()).toEqual([his.endpoint, renewed.endpoint].sort());
    const logged = warn.mock.calls.map((x) => String(x[0])).join('\n');
    warn.mockRestore();
    expect(logged).toContain('Push not delivered (status 500)');
    expect(logged).not.toContain('push.example');
    expect(await prisma.pushSubscription.count({ where: { endpoint: mine.endpoint } })).toBe(1); // a server error is not "gone"
    // a non-https endpoint is refused
    await http().post('/push/subscribe').set(auth(c.token)).send({ endpoint: 'http://push.example/x', keys: renewed.keys }).expect(400);
  });

  it('вихід без мережі: у кожному сповіщенні ключ одержувача (пристрій показує лише своєму власнику); відкладене зняття підписки без сесії', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    const d = device('offline');
    const md = device('mgr');
    const key = (await http().post('/push/device').set(auth(c.token)).send({ endpoint: d.endpoint }).expect(200)).body.userKey as string;
    const mkey = (await http().post('/push/device').set(auth(m.token)).send({}).expect(200)).body.userKey as string;
    expect(key).not.toBe(mkey);
    await on(c.token, d);
    await on(m.token, md);
    await request_(c.clinicId);
    expect(Object.fromEntries(fake.sent.map((x) => [x.endpoint, (x.payload as { u?: string }).u]))).toEqual({ [d.endpoint]: key, [md.endpoint]: mkey });
    // the sign-out could not reach the server; later the device sends the removal with no session at all, naming whose it was
    await http().post('/push/release').send({ endpoint: d.endpoint, u: mkey }).expect(200); // a wrong owner: nothing removed
    expect(await prisma.pushSubscription.count({ where: { endpoint: d.endpoint } })).toBe(1);
    await http().post('/push/release').send({ endpoint: d.endpoint, u: key }).expect(200);
    expect(await prisma.pushSubscription.count({ where: { endpoint: d.endpoint } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { endpoint: md.endpoint } })).toBe(1); // nothing else touched
    await http().post('/push/release').send({ endpoint: d.endpoint, u: key }).expect(200); // repeated: harmless
    await http().post('/push/release').send({ endpoint: 'http://push.example/x', u: key }).expect(200);
    await http().post('/push/release').send({ endpoint: d.endpoint }).expect(400);
    fake.sent.length = 0;
    await request_(c.clinicId);
    expect(to()).toEqual([md.endpoint]);
  });

  it('пряме звернення до чужої заявки чи звернення: сервер відмовляє незалежно від /open', async () => {
    const a = await clinic();
    const b = await clinic();
    await request_(a.clinicId);
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: a.clinicId } });
    const inq = await prisma.inquiry.create({ data: { clinicId: a.clinicId, channel: 'PHONE', name: 'Секретний' } as never });
    await http().patch(`/requests/${req.id}`).set(auth(b.token)).send({ status: 'DONE' }).expect(404);
    await http().get(`/requests/${req.id}/match`).set(auth(b.token)).expect(404);
    await http().patch(`/inquiries/${inq.id}`).set(auth(b.token)).send({ status: 'LOST' }).expect(404);
    await http().delete(`/inquiries/${inq.id}`).set(auth(b.token)).expect(404);
    const lists = JSON.stringify([(await http().get('/requests').set(auth(b.token)).expect(200)).body, (await http().get('/inquiries').set(auth(b.token)).expect(200)).body]);
    expect(lists).not.toContain(req.id);
    expect(lists).not.toContain(inq.id);
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('NEW');
  });

  it('відкладене зняття старої підписки не чіпає нову: той самий пристрій тим часом увімкнула інша людина', async () => {
    const c = await clinic();
    const m = await member(c.token, 'MANAGER');
    const d = device('handover');
    await on(c.token, d);
    const oldKey = (await http().post('/push/device').set(auth(c.token)).send({}).expect(200)).body.userKey as string;
    // the owner signed out offline (the removal is queued with the owner's key); the manager switches Push on on the same device and endpoint
    await on(m.token, d);
    const other = (await http().post('/push/device').set(auth(c.token)).send({ endpoint: d.endpoint }).expect(200)).body;
    expect(other).toMatchObject({ device: 'other' });
    expect((await http().post('/push/device').set(auth(m.token)).send({ endpoint: d.endpoint }).expect(200)).body).toMatchObject({ device: 'mine' });
    expect((await http().post('/push/device').set(auth(m.token)).send({ endpoint: d.endpoint }).expect(200)).body.holderKey).toBeUndefined();
    // the queue is sent now: the manager's subscription stays and keeps receiving
    await http().post('/push/release').send({ endpoint: d.endpoint, u: oldKey }).expect(200);
    expect(await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: d.endpoint } })).toMatchObject({ userId: m.userId });
    fake.sent.length = 0;
    await request_(c.clinicId);
    expect(fake.sent.filter((x) => x.endpoint === d.endpoint).map((x) => (x.payload as { u?: string }).u)).toEqual([(await http().post('/push/device').set(auth(m.token)).send({}).expect(200)).body.userKey]);
  });
});
