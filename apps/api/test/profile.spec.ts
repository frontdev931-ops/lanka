import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'another-long-passphrase';
const sent: { to: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MailService), 'send').mockImplementation(async (m: { to: string; subject: string; text: string }) => {
    sent.push(m);
    return { ok: true } as never;
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
});

async function register() {
  const email = `p${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  return { token: res.body.accessToken as string, email };
}
const tokenFrom = (to: string) => {
  const mail = [...sent].reverse().find((m) => m.to === to);
  return mail?.text.match(/\/verify\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
};

describe('профіль: ім\'я', () => {
  it('людина змінює своє ім\'я, воно видно в /auth/me', async () => {
    const u = await register();
    await http().patch('/auth/profile').set(auth(u.token)).send({ name: '  Олена Коваль ' }).expect(200);
    expect((await http().get('/auth/me').set(auth(u.token)).expect(200)).body.name).toBe('Олена Коваль');
    await http().patch('/auth/profile').set(auth(u.token)).send({ name: 'a' }).expect(400);
    await http().patch('/auth/profile').send({ name: 'Хтось' }).expect(401);
  });
});

describe('профіль: пароль', () => {
  it('потрібен поточний пароль; старий пароль перестає працювати; інша сесія закривається, поточна лишається', async () => {
    const u = await register();
    const other = (await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201)).body.accessToken as string;
    // wrong current password, the same password, a weak one
    await http().post('/auth/change-password').set(auth(u.token)).send({ currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD }).expect(400);
    await http().post('/auth/change-password').set(auth(u.token)).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
    await http().post('/auth/change-password').set(auth(u.token)).send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);

    const res = await http().post('/auth/change-password').set(auth(u.token)).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
    // the browser gets a fresh session cookie, so it stays signed in
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    await http().get('/auth/me').set('Cookie', cookie).expect(200);
    // the other session and the token before the change are closed
    await http().get('/auth/me').set(auth(other)).expect(401);
    await http().get('/auth/me').set(auth(u.token)).expect(401);
    // the old password no longer signs in, the new one does
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(401);
    await http().post('/auth/login').send({ email: u.email, password: NEW_PASSWORD }).expect(201);
  });
});

describe('профіль: пошта для входу', () => {
  it('пошта змінюється лише після переходу за посиланням з листа на нову адресу', async () => {
    const u = await register();
    const next = `new${rnd()}@example.com`;
    await http().post('/auth/change-email').set(auth(u.token)).send({ email: next, password: 'wrong-wrong-wrong' }).expect(400);
    await http().post('/auth/change-email').set(auth(u.token)).send({ email: u.email, password: PASSWORD }).expect(400);
    await http().post('/auth/change-email').set(auth(u.token)).send({ email: next, password: PASSWORD }).expect(200);

    // until the link is opened the old address still signs in and the new one does not
    expect((await http().get('/auth/me').set(auth(u.token)).expect(200)).body).toMatchObject({ email: u.email, pendingEmail: next });
    await http().post('/auth/login').send({ email: next, password: PASSWORD }).expect(401);

    const token = tokenFrom(next);
    expect(token).toBeTruthy();
    await http().post('/auth/verify-email').send({ token }).expect(200);
    expect((await http().get('/auth/me').set(auth(u.token)).expect(200)).body).toMatchObject({ email: next, pendingEmail: null, emailVerified: true });
    await http().post('/auth/login').send({ email: next, password: PASSWORD }).expect(201);
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(401);
    // the link works once
    await http().post('/auth/verify-email').send({ token }).expect(400);
  });

  it('чужу пошту взяти не можна; скасований запит не змінює пошту; новий запит скасовує попереднє посилання', async () => {
    const a = await register();
    const b = await register();
    await http().post('/auth/change-email').set(auth(a.token)).send({ email: b.email, password: PASSWORD }).expect(409);

    const next = `x${rnd()}@example.com`;
    await http().post('/auth/change-email').set(auth(a.token)).send({ email: next, password: PASSWORD }).expect(200);
    const first = tokenFrom(next);
    await http().post('/auth/change-email/cancel').set(auth(a.token)).expect(200);
    await http().post('/auth/verify-email').send({ token: first }).expect(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).pendingEmail).toBeNull();

    const second = `y${rnd()}@example.com`;
    await http().post('/auth/change-email').set(auth(a.token)).send({ email: second, password: PASSWORD }).expect(200);
    const t2 = tokenFrom(second);
    const third = `z${rnd()}@example.com`;
    await http().post('/auth/change-email').set(auth(a.token)).send({ email: third, password: PASSWORD }).expect(200);
    await http().post('/auth/verify-email').send({ token: t2 }).expect(400);
    await http().post('/auth/verify-email').send({ token: tokenFrom(third) }).expect(200);
    expect((await http().get('/auth/me').set(auth(a.token)).expect(200)).body.email).toBe(third);
  });

  it('демо-сесія не може змінювати профіль', async () => {
    const res = await http().post('/demo/start').expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    await http().patch('/auth/profile').set('Cookie', cookie).send({ name: 'Гість' }).expect(403);
    await http().post('/auth/change-password').set('Cookie', cookie).send({ currentPassword: 'x', newPassword: NEW_PASSWORD }).expect(403);
    await http().post('/auth/change-email').set('Cookie', cookie).send({ email: `d${rnd()}@example.com`, password: 'x' }).expect(403);
  });
});
