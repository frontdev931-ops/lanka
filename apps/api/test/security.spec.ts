import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TERMS_VERSION } from '../src/common/terms';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { RateLimitService } from '../src/auth/rate-limit.service';
import { configProblems } from '../src/common/config';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
let mail: MailService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});

afterAll(async () => {
  await app.close();
});

async function register(password = PASSWORD) {
  const email = `s${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Безпека ${rnd()}`, name: 'Анна', email, password }).expect(201);
  return { token: res.body.accessToken as string, email };
}

// The token from the last email with such a link
const tokenFromMail = (to: string, path: string) => {
  const m = [...mail.outbox].reverse().find((x) => x.to === to && x.text.includes(`/${path}/`));
  return m ? m.text.split(`/${path}/`)[1].split(/\s/)[0] : undefined;
};

describe('пароли и сброс', () => {
  it('слишком короткий пароль и пароль, равный почте, не принимаются', async () => {
    const email = `s${rnd()}@example.com`;
    await http().post('/auth/register').send({ acceptTerms: true, clinicName: 'Клініка', name: 'Анна', email, password: 'short123' }).expect(400);
    await http().post('/auth/register').send({ acceptTerms: true, clinicName: 'Клініка', name: 'Анна', email, password: email }).expect(400);
  });

  it('сброс: для неизвестной почты говорим, что пользователя нет, и письмо не уходит; известной письмо уходит; лимиты действуют и для неизвестных адресов', async () => {
    const u = await register();
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    const unknown = `none${rnd()}@example.com`;
    const res = await http().post('/auth/forgot-password').send({ email: unknown }).expect(404);
    expect(JSON.stringify(res.body)).toContain('не знайдено');
    expect(tokenFromMail(u.email, 'reset')).toBeTruthy();
    expect(mail.outbox.filter((m) => m.to.startsWith('none'))).toHaveLength(0);
    // a wrong address cannot be tried without limit
    for (let i = 0; i < 2; i++) await http().post('/auth/forgot-password').send({ email: unknown }).expect(404);
    await http().post('/auth/forgot-password').send({ email: unknown }).expect(429);
  });

  it('ссылка одноразовая; после сброса старый пароль и старые сессии не работают, в базе только хэш', async () => {
    const u = await register();
    await http().get('/auth/me').set(auth(u.token)).expect(200);
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    const token = tokenFromMail(u.email, 'reset')!;
    const stored = await prisma.authToken.findMany({ where: { user: { email: u.email }, type: 'RESET' } });
    expect(stored.some((s) => s.tokenHash === token)).toBe(false); // the token is not stored in the database

    await new Promise((r) => setTimeout(r, 1100)); // iat in tokens is in seconds
    await http().post('/auth/reset-password').send({ token, password: 'a-brand-new-password' }).expect(200);
    await http().post('/auth/reset-password').send({ token, password: 'another-new-password' }).expect(400); // not allowed a second time

    await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(401);
    await http().post('/auth/login').send({ email: u.email, password: 'a-brand-new-password' }).expect(201);
    await http().get('/auth/me').set(auth(u.token)).expect(401); // a session issued before the reset is closed
  });

  it('новая ссылка отзывает старую; слабый пароль и неверный токен отклоняются', async () => {
    const u = await register();
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    const first = tokenFromMail(u.email, 'reset')!;
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    const second = tokenFromMail(u.email, 'reset')!;
    expect(second).not.toBe(first);
    await http().post('/auth/reset-password').send({ token: first, password: 'a-brand-new-password' }).expect(400);
    await http().post('/auth/reset-password').send({ token: second, password: 'short' }).expect(400);
    await http().post('/auth/reset-password').send({ token: 'garbage', password: 'a-brand-new-password' }).expect(400);
    await http().post('/auth/reset-password').send({ token: second, password: 'a-brand-new-password' }).expect(200);
  });

  it('просроченная ссылка не работает', async () => {
    const u = await register();
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    const token = tokenFromMail(u.email, 'reset')!;
    await prisma.authToken.updateMany({ where: { user: { email: u.email }, type: 'RESET' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().post('/auth/reset-password').send({ token, password: 'a-brand-new-password' }).expect(400);
  });

  it('запросы сброса по одной почте ограничены (3 в час)', async () => {
    const u = await register();
    for (let i = 0; i < 3; i++) await http().post('/auth/forgot-password').send({ email: u.email }).expect(200);
    await http().post('/auth/forgot-password').send({ email: u.email }).expect(429);
  });
});

describe('подтверждение почты', () => {
  const withVerification = async (fn: () => Promise<void>) => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    try {
      await fn();
    } finally {
      process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
    }
  };

  it('без подтверждения нельзя подключить данные клиники, после ссылки можно', async () => {
    const u = await register();
    expect(tokenFromMail(u.email, 'verify')).toBeTruthy(); // the email was sent at registration
    expect((await http().get('/auth/me').set(auth(u.token)).expect(200)).body.emailVerified).toBe(false);

    await withVerification(async () => {
      await http().put('/integrations/cliniccards/key').set(auth(u.token)).send({ apiKey: 'some-key-12345' }).expect(403);
      await http().post('/auth/verify-email').send({ token: tokenFromMail(u.email, 'verify') }).expect(200);
      expect((await http().get('/auth/me').set(auth(u.token)).expect(200)).body.emailVerified).toBe(true);
      // now the request reaches the key check (Cliniccards will not accept it), instead of being rejected as "email not confirmed"
      const r = await http().put('/integrations/cliniccards/key').set(auth(u.token)).send({ apiKey: 'some-key-12345' });
      expect(r.status).not.toBe(403);
    });
    // opening the link again is not an error
    await http().post('/auth/verify-email').send({ token: tokenFromMail(u.email, 'verify') }).expect(200);
  });

  it('неверная ссылка подтверждения отклоняется; повторная отправка ограничена', async () => {
    const u = await register();
    await http().post('/auth/verify-email').send({ token: 'garbage' }).expect(400);
    await http().post('/auth/resend-verification').set(auth(u.token)).expect(200);
    await http().post('/auth/resend-verification').set(auth(u.token)).expect(200);
    await http().post('/auth/resend-verification').set(auth(u.token)).expect(200);
    await http().post('/auth/resend-verification').set(auth(u.token)).expect(429);
  });
});

describe('доступ сотрудников проверяется на каждый запрос', () => {
  it('удалённый из клиники сотрудник теряет доступ сразу, не дожидаясь конца токена', async () => {
    const owner = await register();
    const memberEmail = `m${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner.token)).send({ email: memberEmail, role: 'ADMIN' }).expect(201);
    const accepted = await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201);
    const member = accepted.body.accessToken as string;
    await http().get('/patients').set(auth(member)).expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail }, include: { memberships: true } });
    await prisma.membership.deleteMany({ where: { userId: user.id } });
    await http().get('/patients').set(auth(member)).expect(401);
  });

  it('смена роли действует сразу', async () => {
    const owner = await register();
    const memberEmail = `m${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner.token)).send({ email: memberEmail, role: 'MANAGER' }).expect(201);
    const member = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Керівник', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/clinic/audit').set(auth(member)).expect(200); // the history is available to the manager
    await prisma.membership.updateMany({ where: { user: { email: memberEmail } }, data: { role: 'DOCTOR' } });
    await http().get('/clinic/audit').set(auth(member)).expect(403); // the token is the same, the role is already different
  });
});

describe('защита от перебора', () => {
  it('счётчик живёт в базе: 10 неверных паролей блокируют почту, верный пароль после этого тоже не пускает', async () => {
    const u = await register();
    for (let i = 0; i < 10; i++) await http().post('/auth/login').send({ email: u.email, password: 'wrong-password-1' }).expect(401);
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(429);
    // the lock is in a table, not in the process memory
    expect(await prisma.rateLimit.count({ where: { key: `login:email:${u.email}` } })).toBe(1);
  });

  it('лимит по адресу: регистрации с одного адреса ограничены', async () => {
    const limits = app.get(RateLimitService);
    const key = `register:ip:test-${rnd()}`;
    process.env.RATE_LIMIT_IP_MULTIPLIER = '1';
    try {
      for (let i = 0; i < 5; i++) await limits.consume(key, 5, 3600_000);
      await expect(limits.consume(key, 5, 3600_000)).rejects.toThrow();
    } finally {
      process.env.RATE_LIMIT_IP_MULTIPLIER = '10000';
    }
  });

  it('окно лимита сбрасывается по истечении времени', async () => {
    const limits = app.get(RateLimitService);
    const key = `forgot:email:win-${rnd()}`;
    expect(await limits.hit(key, 1000)).toBe(1);
    expect(await limits.hit(key, 1000)).toBe(2);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await limits.hit(key, 1000)).toBe(1);
  });
});

describe('настройки и служебное', () => {
  it('в продакшене слабые секреты, http-адрес и отсутствие почты отмечаются', () => {
    const good = {
      JWT_SECRET: 'f3c9a1d7b2e84a6c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6',
      ENCRYPTION_KEY: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
      DATABASE_URL: 'postgresql://x',
      WEB_ORIGIN: 'https://app.example.com',
      SMTP_URL: 'smtps://u:p@smtp.example.com',
      MONO_ACQUIRING_TOKEN: 'fixture-mono-token',
    } as NodeJS.ProcessEnv;
    expect(configProblems(good)).toEqual([]);
    // The development password, test switches and incomplete Meta settings are rejected. Missing acquiring only disables checkout.
    expect(configProblems({ ...good, DATABASE_URL: 'postgresql://stomat:stomat@db.internal:5432/stomat' }).join()).toContain('пароль разработки');
    expect(configProblems({ ...good, REQUIRE_EMAIL_VERIFICATION: 'false' }).join()).toContain('REQUIRE_EMAIL_VERIFICATION');
    expect(configProblems({ ...good, RATE_LIMIT_IP_MULTIPLIER: '10000' }).join()).toContain('RATE_LIMIT_IP_MULTIPLIER');
    expect(configProblems({ ...good, MONO_ACQUIRING_TOKEN: undefined })).toEqual([]);
    expect(configProblems({ ...good, META_APP_SECRET: 's'.repeat(32) }).join()).toContain('META_VERIFY_TOKEN');
    expect(configProblems({ ...good, META_CONFIG_ID: '1' }).join()).toContain('META_CONFIG_ID');
    expect(configProblems({ ...good, META_APP_ID: '1', META_APP_SECRET: 's'.repeat(32), META_CONFIG_ID: '1', META_VERIFY_TOKEN: 'v' })).toEqual([]);
    expect(configProblems({ ...good, JWT_SECRET: 'change-me' }).join()).toContain('JWT_SECRET');
    expect(configProblems({ ...good, ENCRYPTION_KEY: 'short' }).join()).toContain('ENCRYPTION_KEY');
    expect(configProblems({ ...good, ENCRYPTION_KEY: good.JWT_SECRET }).join()).toContain('разными');
    expect(configProblems({ ...good, WEB_ORIGIN: 'http://app.example.com' }).join()).toContain('https');
    expect(configProblems({ ...good, SMTP_URL: undefined }).join()).toContain('SMTP_URL');
  });

  it('проверка здоровья отвечает без входа и ничего не раскрывает', async () => {
    const r = await http().get('/health').expect(200);
    expect(r.body).toEqual({ ok: true });
  });
});

describe('врач не видит деньги', () => {
  const setup = async () => {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    const patient = await prisma.patient.create({
      data: { clinicId, externalId: `x${rnd()}`, fullName: 'Тестенко Іван', phone: '380501112233', balanceIssued: 5000, balancePaid: 2000 },
    });
    await prisma.visit.create({ data: { clinicId, patientId: patient.id, externalId: `v${rnd()}`, startsAt: new Date(), status: 'VISITED', amount: 1500 } });
    const doctorEmail = `d${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner.token)).send({ email: doctorEmail, role: 'DOCTOR' }).expect(201);
    const doctor = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лікар', password: PASSWORD }).expect(201)).body.accessToken as string;
    return { owner, doctor, patient };
  };

  it('в списке и карточке пациента врач не получает ни выставленное, ни оплаченное, ни долг, ни суммы визитов', async () => {
    const { owner, doctor, patient } = await setup();

    const ownerList = (await http().get('/patients').set(auth(owner.token)).expect(200)).body.rows[0];
    expect(ownerList.debt).toBe(3000);
    const ownerCard = (await http().get(`/patients/${patient.id}`).set(auth(owner.token)).expect(200)).body;
    expect(Number(ownerCard.balanceIssued)).toBe(5000);
    expect(ownerCard.visits[0].amount).toBeTruthy();

    const docList = (await http().get('/patients').set(auth(doctor)).expect(200)).body.rows[0];
    expect(docList).not.toHaveProperty('debt');
    expect(docList).not.toHaveProperty('balanceIssued');
    const docCard = (await http().get(`/patients/${patient.id}`).set(auth(doctor)).expect(200)).body;
    expect(docCard).not.toHaveProperty('balanceIssued');
    expect(docCard).not.toHaveProperty('balancePaid');
    expect(docCard.visits[0]).not.toHaveProperty('amount');
    expect(docCard.fullName).toBe('Тестенко Іван'); // the rest is available to the doctor
  });

  it('отчёты с деньгами (долги, источники, выручка) для врача закрыты, в каталоге их нет, CSV тоже', async () => {
    const { doctor } = await setup();
    for (const id of ['debtors', 'sources', 'revenue']) {
      await http().get(`/reports/${id}`).set(auth(doctor)).expect(403);
      await http().get(`/reports/${id}/csv`).set(auth(doctor)).expect(403);
    }
    const catalog = (await http().get('/reports').set(auth(doctor)).expect(200)).body.map((c: { id: string }) => c.id);
    for (const id of ['debtors', 'sources', 'revenue']) expect(catalog).not.toContain(id);
    expect(catalog).toContain('no-next-visit');
    await http().post('/tasks/from-report').set(auth(doctor)).send({ reportId: 'debtors' }).expect(403);
  });
});

describe('выгрузка отчёта', () => {
  it('скачивание CSV попадает в историю действий; формулы из внешних данных обезврежены', async () => {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    await prisma.patient.createMany({
      data: [
        { clinicId, externalId: `a${rnd()}`, fullName: '=HYPERLINK("http://evil.example","клік")', phone: '+380501112233', balanceIssued: 900, balancePaid: 0 },
        { clinicId, externalId: `b${rnd()}`, fullName: '@SUM(1+1)', phone: '-5', balanceIssued: 100, balancePaid: 0 },
        { clinicId, externalId: `c${rnd()}`, fullName: '+cmd|calc', phone: '380509998877', balanceIssued: 100, balancePaid: 0 },
      ],
    });
    const res = await http().get('/reports/debtors/csv').set(auth(owner.token)).expect(200);
    const csv = res.text;
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).toContain(`"'@SUM(1+1)"`);
    expect(csv).toContain(`"'+cmd|calc"`);
    expect(csv).toContain('"+380501112233"'); // an ordinary phone is not damaged
    const log = await prisma.auditLog.findFirst({ where: { clinicId, action: 'report.exported' } });
    expect(log).toBeTruthy();
    expect(log!.details).toMatchObject({ report: 'debtors', rows: 3 });
  });
});

describe('соглашение об обработке данных', () => {
  const clinicOf = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;

  it('без принятия соглашения регистрация невозможна; принятие записывается с версией и адресом', async () => {
    const email = `s${rnd()}@example.com`;
    const base = { clinicName: 'Клініка', name: 'Анна', email, password: PASSWORD };
    await http().post('/auth/register').send(base).expect(400);
    await http().post('/auth/register').send({ ...base, acceptTerms: false }).expect(400);
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const res = await http().post('/auth/register').send({ ...base, acceptTerms: true }).expect(201);
    const clinicId = await clinicOf(email);
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
    expect(clinic.termsVersion).toBeTruthy();
    expect(clinic.termsAcceptedAt).toBeTruthy();
    expect(clinic.termsAcceptedById).toBeTruthy();
    const log = await prisma.auditLog.findFirst({ where: { clinicId, action: 'terms.accepted' } });
    expect(log!.details).toMatchObject({ version: clinic.termsVersion });
    expect((await http().get('/auth/me').set(auth(res.body.accessToken)).expect(200)).body.termsAccepted).toBe(true);
  });

  it('клиника без принятого соглашения (создана раньше) не может подключить данные, пока владелец не примет', async () => {
    const owner = await register();
    const clinicId = await clinicOf(owner.email);
    await prisma.clinic.update({ where: { id: clinicId }, data: { termsVersion: null, termsAcceptedAt: null, termsAcceptedById: null } });
    expect((await http().get('/auth/me').set(auth(owner.token)).expect(200)).body.termsAccepted).toBe(false);
    await http().put('/integrations/cliniccards/key').set(auth(owner.token)).send({ apiKey: 'some-key-12345' }).expect(403);

    // a non-owner cannot accept; an outdated version is rejected
    const adminEmail = `a${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner.token)).send({ email: adminEmail, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().put('/clinic/terms').set(auth(admin)).send({ version: TERMS_VERSION }).expect(403);
    await http().put('/clinic/terms').set(auth(owner.token)).send({ version: 'old' }).expect(400);

    const ok = await http().put('/clinic/terms').set(auth(owner.token)).send({ version: TERMS_VERSION }).expect(200);
    expect(ok.body.ok).toBe(true);
    expect((await http().get('/auth/me').set(auth(owner.token)).expect(200)).body.termsAccepted).toBe(true);
    const r = await http().put('/integrations/cliniccards/key').set(auth(owner.token)).send({ apiKey: 'some-key-12345' });
    expect(r.status).not.toBe(403); // it reached the key check
    expect(await prisma.auditLog.count({ where: { clinicId, action: 'terms.accepted' } })).toBeGreaterThanOrEqual(2); // at registration and later
  });
});

describe('«давно не бували»: порядок и граница периода', () => {
  it('сначала незавершённое лечение, потом оплаты за всё время; слишком давних нет, если не расширить период', async () => {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const mk = (name: string, days: number, paid: number) =>
      prisma.patient.create({ data: { clinicId, externalId: `l${rnd()}`, fullName: name, lastVisitAt: ago(days), balancePaid: paid, balanceIssued: paid } });
    const withPlan = await mk('А З лікуванням', 300, 1000);
    const rich = await mk('Б Багато оплат', 300, 100_000);
    const poor = await mk('В Мало оплат', 200, 500);
    const tooOld = await mk('Г Давній', 900, 999_999);
    const recent = await mk('Д Нещодавній', 30, 1);

    // "A" has unfinished treatment: by the plan total 7000 is left (the item prices say otherwise, the plan total wins)
    await prisma.planItem.create({ data: { clinicId, externalId: `p${rnd()}`, patientId: withPlan.id, planId: 'PL1', name: 'Імплант', price: 5000, status: 'NEW', createdAtExt: ago(100) } });
    await prisma.treatmentPlan.create({ data: { clinicId, externalId: 'PL1', total: 7000, totalDone: 0, createdAtExt: ago(100) } });

    const body = (await http().get('/reports/lapsed-patients').set(auth(owner.token)).expect(200)).body;
    const names = (body.rows as { fullName: string }[]).map((r) => r.fullName);
    expect(names).toEqual([withPlan.fullName, rich.fullName, poor.fullName]); // treatment first, then payments in descending order; no old and no recent ones
    expect(body.rows[0].openSum).toBe(7000);
    expect(body.rows[1]).toMatchObject({ openSum: 0, lifetimePaid: 100_000 });
    expect(body.maxDays).toBe(730);
    expect(body.columns.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['openSum', 'lifetimePaid']));
    expect(body.rule).toContain('730');

    const wide = (await http().get('/reports/lapsed-patients?maxDays=1000').set(auth(owner.token)).expect(200)).body.rows as { fullName: string }[];
    expect(wide.map((r) => r.fullName)).toContain(tooOld.fullName);
    expect(wide.map((r) => r.fullName)).not.toContain(recent.fullName);

    // the upper bound cannot be smaller than the lower
    const narrow = (await http().get('/reports/lapsed-patients?days=250&maxDays=100').set(auth(owner.token)).expect(200)).body;
    expect(narrow.maxDays).toBeGreaterThan(250);

    // tasks from the report take the same period
    const t = await http().post('/tasks/from-report').set(auth(owner.token)).send({ reportId: 'lapsed-patients', maxDays: 1000 }).expect(201);
    expect(t.body.created).toBe(4);
  });
});

describe('«записи без итога»', () => {
  it('показывает только прошедшие записи без итога; результат, будущее, свежие и удалённые пациенты не попадают', async () => {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const patient = await prisma.patient.create({ data: { clinicId, externalId: `u${rnd()}`, fullName: 'Іваненко Іван', phone: '380501112233' } });
    const gone = await prisma.patient.create({ data: { clinicId, externalId: `u${rnd()}`, fullName: 'Видалений', removedAt: new Date() } });
    const visit = (patientId: string, status: string, startsAt: Date, endsAt?: Date) =>
      prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt, endsAt: endsAt ?? new Date(startsAt.getTime() + 30 * 60_000), status } });
    await visit(patient.id, 'PLANNED', hoursAgo(48)); // not closed: it is included
    await visit(patient.id, 'CONFIRMED', hoursAgo(24 * 10)); // not closed: it is included
    await visit(patient.id, 'VISITED', hoursAgo(24 * 3)); // there is a total
    await visit(patient.id, 'CANCELLED', hoursAgo(24 * 4)); // there is a total
    await visit(patient.id, 'PLANNED', hoursAgo(-48)); // future
    await visit(patient.id, 'CONFIRMED', hoursAgo(1)); // just ended: too early
    await visit(patient.id, 'PLANNED', hoursAgo(24 * 200)); // outside the period (90 days)
    await visit(gone.id, 'PLANNED', hoursAgo(72)); // the patient is no longer in Cliniccards

    const body = (await http().get('/reports/unclosed-visits').set(auth(owner.token)).expect(200)).body;
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((r: { visitStatus: string }) => r.visitStatus)).toEqual(['PLANNED', 'CONFIRMED']); // fresh on top
    expect(body.rows[0]).toMatchObject({ fullName: 'Іваненко Іван', daysSince: 2 });
    expect(body.rows[0].visitTime).toMatch(/^\d\d:\d\d$/);
    expect(body.columns.map((c: { key: string }) => c.key)).toContain('visitStatus');

    // the period widens: an appointment 200 days ago
    const wide = (await http().get('/reports/unclosed-visits?days=300').set(auth(owner.token)).expect(200)).body;
    expect(wide.rows).toHaveLength(3);

    const csv = (await http().get('/reports/unclosed-visits/csv').set(auth(owner.token)).expect(200)).text;
    expect(csv).toContain('Запланований'); // the status is labelled for people, not as a code
    expect(csv).not.toContain('PLANNED');

    // a task for the administrator: one per patient (they have two unclosed appointments), a repeated run makes no duplicates
    const t1 = await http().post('/tasks/from-report').set(auth(owner.token)).send({ reportId: 'unclosed-visits' }).expect(201);
    expect(t1.body.created).toBe(1);
    const t2 = await http().post('/tasks/from-report').set(auth(owner.token)).send({ reportId: 'unclosed-visits' }).expect(201);
    expect(t2.body.created).toBe(0);

    // another clinic does not see these appointments; the doctor sees the report (there is no money in it)
    const other = await register();
    expect((await http().get('/reports/unclosed-visits').set(auth(other.token)).expect(200)).body.rows).toHaveLength(0);
  });
});

describe('воронка пациента', () => {
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000);

  async function seed() {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    const mk = (name: string, over: Record<string, unknown> = {}) =>
      prisma.patient.create({ data: { clinicId, externalId: `f${rnd()}`, fullName: name, phone: '3805011', createdAtExt: ago(60), ...over } });
    const visit = (patientId: string, status: string, startsAt: Date, bookedAt?: Date) =>
      prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), status, bookedAt } });
    const item = (patientId: string, status: string, group: string, markedDoneAt?: Date, price = 1000) =>
      prisma.planItem.create({ data: { clinicId, patientId, externalId: `i${rnd()}`, planId: `pl${rnd()}`, name: 'Послуга', price, status, groupName: group, createdAtExt: ago(60), markedDoneAt } });

    const A = await mk('A Повний шлях', { source: 'Instagram', balancePaid: 5000 });
    await visit(A.id, 'VISITED', ago(50), ago(55));
    await visit(A.id, 'VISITED', ago(20));
    await item(A.id, 'DONE', 'Терапія', ago(50));
    const B = await mk('B Скасував', { source: 'Instagram' });
    await visit(B.id, 'CANCELLED', ago(40));
    const C = await mk('C Без запису');
    const D = await mk('D Запис без итога', { source: 'Google реклама' });
    await visit(D.id, 'PLANNED', ago(20));
    const E = await mk('E Давно був', { createdAt: undefined, createdAtExt: ago(300), source: 'Instagram' });
    await visit(E.id, 'VISITED', ago(290));
    const F = await mk('F Лікується, запис не закрито', { source: 'Google реклама', balancePaid: 800 });
    await visit(F.id, 'PLANNED', ago(20));
    await item(F.id, 'DONE', 'Ортопедія', ago(20));
    const G = await mk('G Лише гігієна', { source: 'Instagram' });
    await visit(G.id, 'VISITED', ago(10));
    await item(G.id, 'DONE', 'Профілактика', ago(10));
    const J = await mk('J Запис попереду');
    await visit(J.id, 'PLANNED', ago(-5));
    await mk('H Видалений', { removedAt: new Date() });
    await mk('I Давня картка', { createdAtExt: ago(365 * 5) });
    return { owner, clinicId, ids: { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id, F: F.id, G: G.id, J: J.id } };
  }

  it('считает этапы по когорте: вложенные этапы, «пришёл» подтверждается услугой или оплатой, лишних людей нет', async () => {
    const { owner } = await seed();
    const b = (await http().get('/funnel?months=12').set(auth(owner.token)).expect(200)).body;
    expect(b.counts).toEqual({ card: 8, booked: 7, came: 4, started: 2, paid: 2, repeat: 1, active: 3 });
    // the funnel does not grow towards the end: each next stage is no larger than the previous
    expect(b.counts.booked).toBeLessThanOrEqual(b.counts.card);
    expect(b.counts.started).toBeLessThanOrEqual(b.counts.came);
    expect(b.counts.paid).toBeLessThanOrEqual(b.counts.started);
    expect(b.lostAfterDays).toBe(180);
    expect(b.cohorts.reduce((s: number, c: { card: number }) => s + c.card, 0)).toBe(8);
    expect(b.sources).toEqual(expect.arrayContaining(['Instagram', 'Google реклама', '(не вказано)']));
    expect(b.directions).toEqual(['Ортопедія', 'Терапія']); // hygiene does not count as a direction
    expect(b.medians.cardToBooked).toBeDefined();
  });

  it('причины остановки и списки людей совпадают со счётчиками', async () => {
    const { owner, ids } = await seed();
    const b = (await http().get('/funnel').set(auth(owner.token)).expect(200)).body;
    expect(b.leaks).toMatchObject({ 'no-booking': 1, upcoming: 1, unclosed: 1, cancelled: 1, 'no-show': 0, moved: 0, 'not-started': 2, 'not-paid': 0, 'no-return': 3, lost: 1 });
    const who = async (reason: string) => (await http().get(`/funnel/people?reason=${reason}`).set(auth(owner.token)).expect(200)).body;
    const unclosed = await who('unclosed');
    expect(unclosed.total).toBe(1);
    expect(unclosed.rows[0]).toMatchObject({ patientId: ids.D, fullName: 'D Запис без итога', source: 'Google реклама' });
    expect((await who('lost')).rows.map((r: { patientId: string }) => r.patientId)).toEqual([ids.E]);
    expect((await who('no-booking')).rows[0].patientId).toBe(ids.C);
    const total = (await who('not-started')).total;
    expect(total).toBe(b.leaks['not-started']);
    await http().get('/funnel/people?reason=whatever').set(auth(owner.token)).expect(400);
  });

  it('срезы по источнику и направлению; период обрезает когорту', async () => {
    const { owner } = await seed();
    const ig = (await http().get(`/funnel?source=${encodeURIComponent('Instagram')}`).set(auth(owner.token)).expect(200)).body;
    expect(ig.counts.card).toBe(4); // A, B, E, G
    const terapia = (await http().get(`/funnel?direction=${encodeURIComponent('Терапія')}`).set(auth(owner.token)).expect(200)).body;
    expect(terapia.counts).toMatchObject({ card: 1, started: 1, paid: 1 });
    const short = (await http().get('/funnel?months=1').set(auth(owner.token)).expect(200)).body;
    expect(short.counts.card).toBe(0); // the cards were created 60 days ago: they do not fall into the last month
    const bySource = (await http().get('/funnel').set(auth(owner.token)).expect(200)).body.bySource as { name: string; card: number; paidSum: number }[];
    expect(bySource.find((r) => r.name === 'Instagram')).toMatchObject({ card: 4, paidSum: [{ currency: null, amount: 5000 }] });
  });

  it('чужая клиника данных не видит; врач воронку не открывает', async () => {
    const { owner } = await seed();
    const other = await register();
    expect((await http().get('/funnel').set(auth(other.token)).expect(200)).body.counts.card).toBe(0);
    const doctorEmail = `d${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(owner.token)).send({ email: doctorEmail, role: 'DOCTOR' }).expect(201);
    const doctor = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лікар', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/funnel').set(auth(doctor)).expect(403);
    await http().get('/funnel/people?reason=lost').set(auth(doctor)).expect(403);
    await http().get('/funnel').expect(401);
  });
});

describe('журнал обращений (верх воронки)', () => {
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
  const inviteRole = async (ownerToken: string, role: string) => {
    const email = `r${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
    return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
  };

  it('проверяет ввод: канал, пустое обращение, дата из будущего', async () => {
    const owner = await register();
    await http().post('/inquiries').set(auth(owner.token)).send({ channel: 'FAX', phone: '0501112233' }).expect(400);
    await http().post('/inquiries').set(auth(owner.token)).send({ channel: 'PHONE' }).expect(400);
    await http().post('/inquiries').set(auth(owner.token)).send({ channel: 'PHONE', phone: '0501112233', occurredAt: new Date(Date.now() + 86_400_000 * 3).toISOString() }).expect(400);
    const ok = await http().post('/inquiries').set(auth(owner.token)).send({ channel: 'INSTAGRAM', name: 'Марія' }).expect(201);
    expect(ok.body.phoneNorm).toBeNull();
  });

  it('связывает обращение с картой по телефону: новая карточка = стало пациентом, старая = вернувшийся; этапы доходят до прихода', async () => {
    const owner = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email }, include: { memberships: true } })).memberships[0].clinicId;
    const make = (channel: string, phone: string, occurredAt: Date) => http().post('/inquiries').set(auth(owner.token)).send({ channel, phone, occurredAt: occurredAt.toISOString() }).expect(201);

    const a = (await make('PHONE', '050 111 22 33', ago(10))).body; // will come later and be treated
    const b = (await make('INSTAGRAM', '+38 (050) 222-33-44', ago(10))).body; // will come and not appear
    const c = (await make('GOOGLE', '0503334455', ago(10))).body; // booked, did not come
    const d = (await make('PHONE', '0504445566', ago(10))).body; // a long-standing patient
    const e = (await make('SITE', '0505556677', ago(9))).body; // no card
    await prisma.inquiry.update({ where: { id: (await make('WALK_IN', '0506667788', ago(1))).body.id }, data: { status: 'LOST' } }); // declined

    const mk = (phone: string, createdAtExt: Date) => prisma.patient.create({ data: { clinicId, externalId: `q${rnd()}`, fullName: `P ${phone}`, phone, phoneNorm: phone, createdAtExt } });
    const pa = await mk('380501112233', ago(9));
    await prisma.visit.create({ data: { clinicId, patientId: pa.id, externalId: `v${rnd()}`, startsAt: ago(8), endsAt: ago(8), status: 'VISITED' } });
    const pc = await mk('380503334455', ago(9));
    await prisma.visit.create({ data: { clinicId, patientId: pc.id, externalId: `v${rnd()}`, startsAt: ago(-3), endsAt: ago(-3), status: 'PLANNED' } });
    await mk('380504445566', ago(500)); // an old card
    const pb = await mk('380502223344', ago(9)); // a card without an appointment

    // any new inquiry starts the linking (after a sync it starts by itself)
    await make('PHONE', '0509998877', ago(0));
    const list = (await http().get('/inquiries').set(auth(owner.token)).expect(200)).body.rows as { id: string; stage: string; patient: { id: string } | null }[];
    const stage = (id: string) => list.find((r) => r.id === id)!.stage;
    expect(stage(a.id)).toBe('CAME');
    expect(stage(b.id)).toBe('CARD');
    expect(stage(c.id)).toBe('BOOKED');
    expect(stage(d.id)).toBe('RETURNING');
    expect(stage(e.id)).toBe('NEW');
    expect(list.find((r) => r.id === a.id)!.patient!.id).toBe(pa.id);
    expect(pb.id).toBeTruthy();

    // top of the funnel: an inquiry of a "long-standing patient" is not counted as new
    const f = (await http().get('/funnel/inquiries?months=3').set(auth(owner.token)).expect(200)).body;
    expect(f.returning).toBe(1);
    expect(f.counts).toEqual({ total: 6, card: 3, booked: 2, came: 1, started: 0, lost: 1 });
    const phone = f.byChannel.find((x: { name: string }) => x.name === 'PHONE');
    expect(phone).toMatchObject({ total: 2, came: 1 }); // the "long-standing" one is not part of the channel
    const ig = (await http().get('/funnel/inquiries?channel=INSTAGRAM').set(auth(owner.token)).expect(200)).body;
    expect(ig.counts).toMatchObject({ total: 1, card: 1, came: 0 });
  });

  it('отметка «потерян», возврат и удаление; чужая клиника не видит и не меняет; роли', async () => {
    const owner = await register();
    const other = await register();
    const row = (await http().post('/inquiries').set(auth(owner.token)).send({ channel: 'PHONE', phone: '0507778899' }).expect(201)).body;
    expect((await http().patch(`/inquiries/${row.id}`).set(auth(owner.token)).send({ status: 'LOST' }).expect(200)).body.status).toBe('LOST');
    await http().patch(`/inquiries/${row.id}`).set(auth(owner.token)).send({ status: 'BAD' }).expect(400);
    expect((await http().get('/inquiries?filter=lost').set(auth(owner.token)).expect(200)).body.total).toBe(1);
    expect((await http().get('/inquiries?filter=new').set(auth(owner.token)).expect(200)).body.total).toBe(0);

    await http().patch(`/inquiries/${row.id}`).set(auth(other.token)).send({ status: 'OPEN' }).expect(404);
    await http().delete(`/inquiries/${row.id}`).set(auth(other.token)).expect(404);
    expect((await http().get('/inquiries').set(auth(other.token)).expect(200)).body.total).toBe(0);

    const doctor = await inviteRole(owner.token, 'DOCTOR');
    const analyst = await inviteRole(owner.token, 'ANALYST');
    const admin = await inviteRole(owner.token, 'ADMIN');
    await http().get('/inquiries').set(auth(doctor)).expect(403);
    await http().post('/inquiries').set(auth(doctor)).send({ channel: 'PHONE', phone: '0501112233' }).expect(403);
    await http().get('/inquiries').set(auth(analyst)).expect(200);
    await http().post('/inquiries').set(auth(analyst)).send({ channel: 'PHONE', phone: '0501112233' }).expect(403);
    await http().post('/inquiries').set(auth(admin)).send({ channel: 'PHONE', phone: '0501112233' }).expect(201);

    await http().delete(`/inquiries/${row.id}`).set(auth(owner.token)).expect(200);
    expect((await http().get('/inquiries').set(auth(owner.token)).expect(200)).body.total).toBe(1);
  });
});
