import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PushSender } from '../src/push/push.service';
import { RequestsService } from '../src/automations/requests.service';
import { hotp, stepOf } from '../src/auth/totp';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// A fake push sender: nothing goes to a real push service
const pushFake = {
  configured: true,
  sent: [] as { endpoint: string; payload: { title: string; body: string; url: string } }[],
  gone: new Set<string>(),
  send: async (sub: { endpoint: string }, payload: { title: string; body: string; url: string }) => {
    if (pushFake.gone.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushFake.sent.push({ endpoint: sub.endpoint, payload });
  },
};

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const ADMIN_EMAIL = `platform-${rnd()}@example.com`;

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = `${ADMIN_EMAIL}, someone-else@example.com`;
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PushSender).useValue(pushFake).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_EMAILS;
  await app.close();
});

async function clinic(email = `o${rnd()}@example.com`) {
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Власниця', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { email, token: res.body.accessToken as string, clinicId };
}
async function invite(ownerToken: string, role: string) {
  const email = `r${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  const acc = await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201);
  return { email, token: acc.body.accessToken as string, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
async function enable2fa(token: string) {
  const { secret } = (await http().post('/auth/2fa/setup').set(auth(token)).expect(200)).body;
  await http().post('/auth/2fa/enable').set(auth(token)).send({ code: hotp(secret, stepOf()) }).expect(200);
  return secret as string;
}

describe('тарифы, лимиты и использование', () => {
  it('клиника видит тариф, лимиты и расход; сотрудников по тарифу не больше лимита (учитывая приглашения)', async () => {
    const o = await clinic();
    const u = (await http().get('/service/usage').set(auth(o.token)).expect(200)).body;
    expect(u).toMatchObject({ plan: 'START', limits: { users: 10, messagesPerMonth: 2000, aiRepliesPerMonth: 500 }, usage: { users: 1, pendingInvitations: 0, messagesThisMonth: 0 }, require2fa: false, suspended: false });
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { limitOverrides: { users: 5 } } }); // a small limit makes the check short
    await http().post('/team/invitations').set(auth(o.token)).send({ email: `a${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    await http().post('/team/invitations').set(auth(o.token)).send({ email: `b${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
    for (let i = 0; i < 2; i++) await http().post('/team/invitations').set(auth(o.token)).send({ email: `x${i}${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
    await http().post('/team/invitations').set(auth(o.token)).send({ email: `c${rnd()}@example.com`, role: 'DOCTOR' }).expect(400); // 1 + 4 открытых = лимит 5
    const admin = await invite(o.token, 'ANALYST').catch(() => null);
    expect(admin).toBeNull(); // тоже упирается в лимит
    // права: страницу использования видят только владелец и управляющий
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { plan: 'PRO', limitOverrides: {} } });
    const adm = await invite(o.token, 'ADMIN');
    await http().get('/service/usage').set(auth(adm.token)).expect(403);
  });
});

describe('обзор владельца сервиса', () => {
  it('доступ только по списку PLATFORM_ADMIN_EMAILS; тариф и лимиты меняются; приостановка закрывает клинику, но не стирает данные', async () => {
    const owner = await clinic();
    const platform = await clinic(ADMIN_EMAIL);
    await http().get('/platform/clinics').set(auth(owner.token)).expect(403);
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(owner.token)).send({ plan: 'PRO' }).expect(403);
    expect((await http().get('/auth/me').set(auth(owner.token))).body.platformAdmin).toBe(false);
    expect((await http().get('/auth/me').set(auth(platform.token))).body.platformAdmin).toBe(true);

    const list = (await http().get('/platform/clinics').set(auth(platform.token)).expect(200)).body as { id: string; plan: string; users: number }[];
    expect(list.find((c) => c.id === owner.clinicId)).toMatchObject({ plan: 'START', users: 1, suspended: false });
    expect((await http().get('/platform/plans').set(auth(platform.token))).body.map((p: { key: string }) => p.key)).toEqual(['START', 'PRO', 'CUSTOM']);

    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(platform.token)).send({ plan: 'NOPE' }).expect(400);
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(platform.token)).send({ plan: 'START' }).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).aiMonthlyLimit).toBe(500);
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(platform.token)).send({ plan: 'CUSTOM', limits: { users: 20, messagesPerMonth: 5, bogus: 1 } }).expect(200);
    expect((await http().get('/service/usage').set(auth(owner.token))).body.limits).toEqual({ users: 20, messagesPerMonth: 5, aiRepliesPerMonth: 3000 });
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: 'platform.clinic_changed' } })).toBe(2);
    await http().patch('/platform/clinics/does-not-exist').set(auth(platform.token)).send({ plan: 'PRO' }).expect(404);

    // приостановка
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(platform.token)).send({ suspended: true }).expect(200);
    await http().get('/patients').set(auth(owner.token)).expect(403);
    await http().get('/service/usage').set(auth(owner.token)).expect(403);
    expect((await http().get('/auth/me').set(auth(owner.token)).expect(200)).body.suspended).toBe(true);
    await prisma.patient.create({ data: { clinicId: owner.clinicId, externalId: `p${rnd()}`, fullName: 'Зберігається' } });
    await http().patch(`/platform/clinics/${owner.clinicId}`).set(auth(platform.token)).send({ suspended: false }).expect(200);
    expect((await http().get('/patients').set(auth(owner.token)).expect(200)).body.total).toBe(1);
  });
});

describe('обязательная двухфакторная аутентификация клиники', () => {
  it('владелец сначала включает её себе; после требования сотрудник без 2FA может только настроить её', async () => {
    const o = await clinic();
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { plan: 'PRO' } });
    const staff = await invite(o.token, 'ADMIN');
    await http().patch('/service/security').set(auth(o.token)).send({ require2fa: true }).expect(400); // у владельца ещё нет 2FA
    await http().patch('/service/security').set(auth(staff.token)).send({ require2fa: true }).expect(403);
    await enable2fa(o.token);
    expect((await http().patch('/service/security').set(auth(o.token)).send({ require2fa: true }).expect(200)).body.require2fa).toBe(true);

    await http().get('/patients').set(auth(staff.token)).expect(403);
    const me = (await http().get('/auth/me').set(auth(staff.token)).expect(200)).body;
    expect(me.twoFactorRequired).toBe(true);
    await http().get('/patients').set(auth(o.token)).expect(200); // у владельца 2FA есть
    await enable2fa(staff.token);
    await http().get('/patients').set(auth(staff.token)).expect(200);
    expect((await http().get('/auth/me').set(auth(staff.token))).body.twoFactorRequired).toBe(false);
  });
});

describe('управление сотрудниками', () => {
  it('смена роли, удаление и сброс 2FA делает только владелец; владельца и себя трогать нельзя; чужая клиника недоступна', async () => {
    const o = await clinic();
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { plan: 'PRO' } });
    const ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: o.email } })).id;
    const adminUser = await invite(o.token, 'ADMIN');
    const doctor = await invite(o.token, 'DOCTOR');
    await http().patch(`/team/members/${doctor.userId}`).set(auth(adminUser.token)).send({ role: 'ANALYST' }).expect(403);
    await http().patch(`/team/members/${doctor.userId}`).set(auth(o.token)).send({ role: 'OWNER' }).expect(400); // роль владельца не выдаётся
    await http().patch(`/team/members/${ownerId}`).set(auth(o.token)).send({ role: 'ADMIN' }).expect(400);
    await http().delete(`/team/members/${ownerId}`).set(auth(o.token)).expect(400);
    await http().patch(`/team/members/${doctor.userId}`).set(auth(o.token)).send({ role: 'ANALYST' }).expect(200);
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: doctor.userId, clinicId: o.clinicId } })).role).toBe('ANALYST');

    const other = await clinic();
    await http().patch(`/team/members/${doctor.userId}`).set(auth(other.token)).send({ role: 'ADMIN' }).expect(404);
    await http().delete(`/team/members/${doctor.userId}`).set(auth(other.token)).expect(404);

    // сброс 2FA: старые сессии закрываются, человек входит без кода и настраивает заново
    const secret = await enable2fa(doctor.token);
    expect(secret).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1100)); // токены считаются с точностью до секунды
    await http().post(`/team/members/${doctor.userId}/reset-2fa`).set(auth(o.token)).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: doctor.userId } })).totpEnabledAt).toBeNull();
    await http().get('/auth/me').set(auth(doctor.token)).expect(401);
    expect((await http().post('/auth/login').send({ email: doctor.email, password: PASSWORD }).expect(201)).body.accessToken).toBeTruthy();

    // удаление: доступ пропадает сразу, открытые задачи освобождаются
    const task = await prisma.task.create({ data: { clinicId: o.clinicId, title: 'T', dueDate: new Date(), assigneeId: doctor.userId, createdById: ownerId, status: 'OPEN' } });
    await http().delete(`/team/members/${doctor.userId}`).set(auth(o.token)).expect(200);
    await http().get('/patients').set(auth(doctor.token)).expect(401);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: o.clinicId, action: { in: ['team.role_changed', 'team.removed', 'team.2fa_reset'] } } })).toBe(3);
  });
});

describe('переключение между клиниками', () => {
  it('пользователь нескольких клиник видит их список и переключается без нового входа; в чужую клинику нельзя', async () => {
    const a = await clinic();
    const b = await clinic();
    const userA = await prisma.user.findUniqueOrThrow({ where: { email: a.email } });
    await prisma.membership.create({ data: { userId: userA.id, clinicId: b.clinicId, role: 'MANAGER' } });
    const list = (await http().get('/auth/clinics').set(auth(a.token)).expect(200)).body as { id: string; role: string }[];
    expect(list.map((c) => c.id).sort()).toEqual([a.clinicId, b.clinicId].sort());
    const sw = await http().post('/auth/switch').set(auth(a.token)).send({ clinicId: b.clinicId }).expect(200);
    expect(sw.body.accessToken).toBeTruthy();
    expect((await http().get('/auth/me').set(auth(sw.body.accessToken)).expect(200)).body).toMatchObject({ role: 'MANAGER' });
    const third = await clinic();
    await http().post('/auth/switch').set(auth(a.token)).send({ clinicId: third.clinicId }).expect(401);
    expect(await prisma.auditLog.count({ where: { clinicId: b.clinicId, action: 'auth.switch_clinic' } })).toBe(1);
  });
});

describe('воронка: деньги когорты и работа команды', () => {
  const DAYMS = 86_400_000;
  it('деньги когорты видят только руководство; срез по сотрудникам считается по нашим данным и изолирован по клиникам', async () => {
    const o = await clinic();
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { plan: 'PRO' } });
    const ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: o.email } })).id;
    const admin = await invite(o.token, 'ADMIN');
    const mk = (name: string, over: Record<string, unknown>) => prisma.patient.create({ data: { clinicId: o.clinicId, externalId: `p${rnd()}`, fullName: name, createdAtExt: new Date(Date.now() - 20 * DAYMS), ...over } });
    const started = await mk('Почав Лікування', { balancePaid: 8000, lastVisitAt: new Date(Date.now() - 5 * DAYMS) });
    const stuck = await mk('Не Почав', { balancePaid: 500, lastVisitAt: new Date(Date.now() - 8 * DAYMS) });
    const item = (patientId: string, status: string, price: number, group = 'Терапія') => prisma.planItem.create({ data: { clinicId: o.clinicId, patientId, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Послуга', status, price, groupName: group, createdAtExt: new Date(Date.now() - 18 * DAYMS), markedDoneAt: status === 'DONE' ? new Date(Date.now() - 10 * DAYMS) : null } });
    await item(started.id, 'DONE', 3000);
    await item(started.id, 'NEW', 5000);
    await item(stuck.id, 'NEW', 12000, 'Консультація');
    await prisma.visit.create({ data: { clinicId: o.clinicId, patientId: started.id, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - 10 * DAYMS), status: 'VISITED' } });
    await prisma.visit.create({ data: { clinicId: o.clinicId, patientId: stuck.id, externalId: `v${rnd()}`, startsAt: new Date(Date.now() - 12 * DAYMS), status: 'VISITED' } });

    const f = (await http().get('/funnel?months=3').set(auth(o.token)).expect(200)).body;
    expect(f.money).toMatchObject({ paid: 8500, payers: 2 });
    expect(f.money.openPlanStarted).toBe(5000);
    expect(f.money.openPlanNotStarted).toBeGreaterThanOrEqual(0);
    expect((await http().get('/funnel?months=3').set(auth(admin.token)).expect(200)).body.money).toBeNull(); // администратору денег не показываем

    // команда: обращения, заявки, контакты
    const inq = await prisma.inquiry.create({ data: { clinicId: o.clinicId, channel: 'PHONE', createdById: admin.userId, patientId: started.id, occurredAt: new Date(Date.now() - 15 * DAYMS) } });
    await prisma.inquiry.create({ data: { clinicId: o.clinicId, channel: 'INSTAGRAM', createdById: admin.userId, occurredAt: new Date(Date.now() - 3 * DAYMS) } });
    await prisma.bookingRequest.create({ data: { clinicId: o.clinicId, channel: 'TELEGRAM', chatId: 'x', kind: 'BOOKING', summary: 's', status: 'DONE', handledById: admin.userId, handledAt: new Date() } });
    await prisma.contactLog.create({ data: { clinicId: o.clinicId, patientId: started.id, userId: admin.userId, outcome: 'BOOKED' } });
    await prisma.contactLog.create({ data: { clinicId: o.clinicId, patientId: stuck.id, userId: admin.userId, outcome: 'NO_ANSWER' } });
    expect(inq.id).toBeTruthy();
    const staff = (await http().get('/funnel/staff?months=3').set(auth(o.token)).expect(200)).body as { userId: string; inquiries: number; inquiriesCame: number; requestsHandled: number; contacts: number; contactOutcomes: Record<string, number> }[];
    const a = staff.find((x) => x.userId === admin.userId)!;
    expect(a).toMatchObject({ inquiries: 2, inquiriesCame: 1, requestsHandled: 1, contacts: 2, contactOutcomes: { BOOKED: 1, NO_ANSWER: 1 } });
    expect(staff.find((x) => x.userId === ownerId)).toMatchObject({ inquiries: 0, contacts: 0 });
    const other = await clinic();
    expect((await http().get('/funnel/staff?months=3').set(auth(other.token))).body.every((x: { inquiries: number }) => x.inquiries === 0)).toBe(true);
    const doctor = await invite(o.token, 'DOCTOR');
    await http().get('/funnel/staff').set(auth(doctor.token)).expect(403);
  });
});

describe('push-уведомления сотрудникам', () => {
  const sub = (n: string) => ({ endpoint: `https://push.example/${n}-${rnd()}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });

  it('подписка и отписка у каждого свои; новая заявка уходит владельцу, управляющему и администратору без имён; недействительная подписка удаляется', async () => {
    const o = await clinic();
    await prisma.clinic.update({ where: { id: o.clinicId }, data: { plan: 'PRO', limitOverrides: {} } });
    const admin = await invite(o.token, 'ADMIN');
    const doctor = await invite(o.token, 'DOCTOR');
    const so = sub('owner'), sa = sub('admin'), sd = sub('doctor');
    expect((await http().get('/push').set(auth(o.token)).expect(200)).body).toMatchObject({ available: true, devices: 0 });
    for (const [token, s] of [[o.token, so], [admin.token, sa], [doctor.token, sd]] as const) await http().post('/push/subscribe').set(auth(token)).send(s).expect(200);
    await http().post('/push/subscribe').set(auth(o.token)).send({ endpoint: 'x' }).expect(400);
    expect((await http().get('/push').set(auth(o.token))).body.devices).toBe(1);
    await http().post('/push/unsubscribe').set(auth(doctor.token)).send({ endpoint: so.endpoint }).expect(200); // чужой адрес не удаляется
    expect(await prisma.pushSubscription.count({ where: { endpoint: so.endpoint } })).toBe(1);

    const requests = app.get(RequestsService);
    pushFake.sent.length = 0;
    await requests.upsert(o.clinicId, { channel: 'TELEGRAM', chatId: 'c1', patientId: null, contactName: 'Секретне Ім’я', kind: 'BOOKING', summary: 'Секретне резюме' });
    const to = pushFake.sent.map((x) => x.endpoint).sort();
    expect(to).toEqual([so.endpoint, sa.endpoint].sort()); // лікарю не йде
    expect(JSON.stringify(pushFake.sent)).not.toContain('Секретне');
    expect(pushFake.sent[0].payload).toMatchObject({ title: 'Нова заявка', url: '/inbox' });

    // браузер сообщил, что подписка недействительна (410): она удаляется
    pushFake.gone.add(sa.endpoint);
    pushFake.sent.length = 0;
    await requests.upsert(o.clinicId, { channel: 'TELEGRAM', chatId: 'c2', patientId: null, kind: 'CANCEL', summary: 'x' });
    expect(await prisma.pushSubscription.count({ where: { endpoint: sa.endpoint } })).toBe(0);
    expect(pushFake.sent.map((x) => x.endpoint)).toEqual([so.endpoint]);

    // тест своему устройству; без ключей сервис молчит
    expect((await http().post('/push/test').set(auth(o.token)).expect(200)).body.sent).toBe(1);
    pushFake.configured = false;
    expect((await http().post('/push/test').set(auth(o.token)).expect(200)).body.sent).toBe(0);
    expect((await http().get('/push').set(auth(o.token))).body.available).toBe(false);
    pushFake.configured = true;
    await http().post('/push/unsubscribe').set(auth(o.token)).send({ endpoint: so.endpoint }).expect(200);
    expect((await http().get('/push').set(auth(o.token))).body.devices).toBe(0);
  });
});

describe('журнал просмотров карточек пациентов', () => {
  it('просмотр карточки пишется в журнал не чаще раза в 10 минут на человека и пациента; чужую карточку открыть нельзя', async () => {
    const o = await clinic();
    const other = await clinic();
    const mk = (clinicId: string) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Журнал Перегляду' } });
    const a = await mk(o.clinicId), b = await mk(o.clinicId), foreign = await mk(other.clinicId);
    await http().get(`/patients/${a.id}`).set(auth(o.token)).expect(200);
    await http().get(`/patients/${a.id}`).set(auth(o.token)).expect(200);
    await http().get(`/patients/${b.id}`).set(auth(o.token)).expect(200);
    expect(await prisma.auditLog.count({ where: { clinicId: o.clinicId, action: 'patient.viewed' } })).toBe(2);
    await http().get(`/patients/${foreign.id}`).set(auth(o.token)).expect(404);
    expect(await prisma.auditLog.count({ where: { clinicId: o.clinicId, action: 'patient.viewed' } })).toBe(3); // попытка тоже видна
    expect(await prisma.auditLog.count({ where: { clinicId: other.clinicId, action: 'patient.viewed' } })).toBe(0);
  });
});
