import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// The "call me back" form of the landing page: saved for the service owner, mailed to PLATFORM_ADMIN_EMAILS, a bot trap, validation, the limit per
// address, and the list on /platform for the service owner only. Mail goes to the in-memory outbox (no provider in tests).
let app: INestApplication;
let prisma: PrismaService;
let mail: MailService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ADMIN = `owner${rnd()}@example.com`;

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication<NestExpressApplication>();
  // as in main.ts: the address comes from the proxy header, so each test can use its own address
  (app as NestExpressApplication).set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});
afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_EMAILS;
  await app.close();
});

const register = async (email: string) => (await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201)).body.accessToken as string;

describe('заявка «зв’яжіться зі мною» з лендингу', () => {
  it('зберігається, приходить листом власнику сервісу, видна лише йому на /platform і позначається опрацьованою', async () => {
    const phone = `+38 (050) ${Math.floor(1000000 + Math.random() * 8999999)}`;
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.1').send({ phone, name: ' Олена ', lang: 'ru', consent: true }).expect(200, { ok: true });
    const digits = '+' + phone.replace(/\D/g, '');
    const row = await prisma.contactRequest.findFirstOrThrow({ where: { phone: digits } });
    expect(row).toMatchObject({ name: 'Олена', lang: 'ru', handledAt: null });
    const sent = mail.outbox.filter((m) => m.to === ADMIN && m.text.includes(digits));
    expect(sent).toHaveLength(1);

    const owner = await register(ADMIN);
    const list = (await http().get('/platform/contact-requests').set(auth(owner)).expect(200)).body;
    expect(list.some((r: { id: string }) => r.id === row.id)).toBe(true);
    await http().patch(`/platform/contact-requests/${row.id}`).set(auth(owner)).send({ handled: true }).expect(200);
    expect((await prisma.contactRequest.findUniqueOrThrow({ where: { id: row.id } })).handledAt).not.toBeNull();

    // a clinic owner is not the service owner
    const other = await register(`c${rnd()}@example.com`);
    await http().get('/platform/contact-requests').set(auth(other)).expect(403);
    await http().patch(`/platform/contact-requests/${row.id}`).set(auth(other)).send({ handled: false }).expect(403);
    await http().get('/platform/contact-requests').expect(401);
  });

  it('пастка для ботів нічого не зберігає; без згоди чи з неправильним номером — 400', async () => {
    const before = await prisma.contactRequest.count();
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.2').send({ phone: '+380501112233', consent: true, website: 'http://spam.example' }).expect(200, { ok: true });
    expect(await prisma.contactRequest.count()).toBe(before);
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.2').send({ phone: '+380501112233', consent: false }).expect(400);
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.2').send({ phone: '+380501112233' }).expect(400);
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.2').send({ phone: '12-34', consent: true }).expect(400);
    await http().post('/contact-requests').set('X-Forwarded-For', '10.1.0.2').send({ phone: '1'.repeat(16), consent: true }).expect(400);
    expect(await prisma.contactRequest.count()).toBe(before);
  });

  it('обмеження з однієї адреси', async () => {
    const before = process.env.RATE_LIMIT_IP_MULTIPLIER;
    process.env.RATE_LIMIT_IP_MULTIPLIER = '1';
    try {
      const ip = `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 5; i++) await http().post('/contact-requests').set('X-Forwarded-For', ip).send({ phone: `+38050100000${i}`, consent: true }).expect(200);
      await http().post('/contact-requests').set('X-Forwarded-For', ip).send({ phone: '+380501000009', consent: true }).expect(429);
    } finally {
      process.env.RATE_LIMIT_IP_MULTIPLIER = before;
    }
  });
});
