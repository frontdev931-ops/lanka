import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DUMMY_HASH } from '../src/auth/auth.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const ADMIN = `platform-${rnd()}@example.com`;

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_EMAILS;
  delete process.env.PLATFORM_REQUIRE_2FA;
  await app.close();
});

async function register(email = `h${rnd()}@example.com`) {
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  return { token: res.body.accessToken as string, email };
}
const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.accessToken as string;

describe('вихід з системи закриває сесію', () => {
  it('токен після виходу не приймається, хоча ще не закінчився; інша сесія тієї ж людини працює', async () => {
    const u = await register();
    const first = await login(u.email);
    const second = await login(u.email);
    await http().get('/auth/me').set(auth(first)).expect(200);
    await http().post('/auth/logout').set(auth(first)).expect(200);
    await http().get('/auth/me').set(auth(first)).expect(401);
    await http().get('/auth/me').set(auth(second)).expect(200);
    // the same through the session cookie
    const loginRes = await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201);
    const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    await http().get('/auth/me').set('Cookie', cookie).expect(200);
    await http().post('/auth/logout').set('Cookie', cookie).expect(200);
    await http().get('/auth/me').set('Cookie', cookie).expect(401);
    // signing out twice or with garbage changes nothing
    await http().post('/auth/logout').set(auth(first)).expect(200);
    await http().post('/auth/logout').set(auth('not-a-token')).expect(200);
  });

  it('забуті записи видаляються: прострочений токен у списку закритих не зберігається', async () => {
    await prisma.revokedToken.create({ data: { jti: `old-${rnd()}`, expiresAt: new Date(Date.now() - 1000) } });
    const u = await register();
    const t = await login(u.email);
    await http().post('/auth/logout').set(auth(t)).expect(200);
    expect(await prisma.revokedToken.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0);
  });
});

describe('вхід не виказує, які адреси є в системі', () => {
  it('невідома адреса витрачає стільки ж часу на перевірку пароля, скільки й відома (порівняння з фіксованим хешем)', async () => {
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(12);
    // bcrypt at cost 12 takes a noticeable time: an unknown email must not answer at once
    const t = Date.now();
    await http().post('/auth/login').send({ email: `nobody-${rnd()}@example.com`, password: 'whatever-password' }).expect(401);
    expect(Date.now() - t).toBeGreaterThanOrEqual(80);
  });
});

describe('склад команди', () => {
  it('імена й пошту колег бачать власник, керуючий і адміністратор; лікар і аналітик ні', async () => {
    const o = await register();
    const make = async (role: string) => {
      const email = `m${rnd()}@example.com`;
      const inv = await http().post('/team/invitations').set(auth(o.token)).send({ email, role }).expect(201);
      return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201)).body.accessToken as string;
    };
    await http().get('/team').set(auth(o.token)).expect(200);
    const [admin, doctor, analyst] = [await make('ADMIN'), await make('DOCTOR'), await make('ANALYST')];
    await http().get('/team').set(auth(admin)).expect(200);
    await http().get('/team').set(auth(doctor)).expect(403);
    await http().get('/team').set(auth(analyst)).expect(403);
  });
});

describe('власник сервісу бачить усі клініки: потрібен другий фактор', () => {
  it('у продакшені (або з PLATFORM_REQUIRE_2FA=true) без двофакторного входу огляд закритий, з ним відкритий', async () => {
    const a = await register(ADMIN);
    await http().get('/platform/clinics').set(auth(a.token)).expect(200); // not required in development
    process.env.PLATFORM_REQUIRE_2FA = 'true';
    try {
      const r = await http().get('/platform/clinics').set(auth(a.token)).expect(403);
      expect(JSON.stringify(r.body)).toContain('двофакторний');
      await http().patch('/platform/clinics/x').set(auth(a.token)).send({ suspended: true }).expect(403);
      await prisma.user.update({ where: { email: ADMIN }, data: { totpEnabledAt: new Date() } });
      await http().get('/platform/clinics').set(auth(a.token)).expect(200);
      // an ordinary clinic owner never gets in
      const other = await register();
      await http().get('/platform/clinics').set(auth(other.token)).expect(403);
    } finally {
      delete process.env.PLATFORM_REQUIRE_2FA;
      await prisma.user.update({ where: { email: ADMIN }, data: { totpEnabledAt: null } });
    }
  });
});

describe('вебхук Telegram', () => {
  it('клініку знаходить секрет в адресі, заголовок має збігатися; невідомий або чужий секрет мовчки ігнорується', async () => {
    const o = await register();
    const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email: o.email }, include: { memberships: true } })).memberships[0].clinicId;
    const { encrypt } = await import('../src/common/crypto');
    const secret = `s${rnd()}${rnd()}${rnd()}`;
    await prisma.integration.create({ data: { clinicId, provider: 'TELEGRAM', apiKeyEnc: encrypt('1:fake'), config: { secret, username: 'b', offset: 0 } } });
    const update = { update_id: 1, message: { chat: { id: 5 }, from: { id: 5 }, text: 'привіт' } };
    await http().post(`/telegram/webhook/${secret}`).set('x-telegram-bot-api-secret-token', 'wrong').send(update).expect(200);
    await http().post('/telegram/webhook/unknown-secret').set('x-telegram-bot-api-secret-token', 'unknown-secret').send(update).expect(200);
    await http().post(`/telegram/webhook/${secret}`).send(update).expect(200);
    expect(await prisma.inboundEvent.count({ where: { clinicId, channel: 'TELEGRAM' } })).toBe(0);
    await http().post(`/telegram/webhook/${secret}`).set('x-telegram-bot-api-secret-token', secret).send(update).expect(200);
    expect(await prisma.inboundEvent.count({ where: { clinicId, channel: 'TELEGRAM' } })).toBe(1);
  });
});
