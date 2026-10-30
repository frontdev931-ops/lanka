import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { TelegramApi } from '../src/automations/telegram.api';
import { MailService } from '../src/auth/mail.service';
import { DemoService } from '../src/demo/demo.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const sent: string[] = [];
const tg = { sendMessage: async (_t: string, chat: string) => void sent.push(String(chat)), getMe: async () => ({ id: 1, username: 'x' }), answerCallbackQuery: async () => true, getUpdates: async () => [], setWebhook: async () => true, deleteWebhook: async () => true };
const llm = { configured: true, complete: async () => ({ text: JSON.stringify({ intent: 'booking', reply: 'Добрий день! Допоможу з записом.', summary: 'Хоче чистку', options: [] }), inputTokens: 5, outputTokens: 5 }) };
let app: INestApplication;
let prisma: PrismaService;
let demo: DemoService;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(LlmClient).useValue(llm).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  demo = app.get(DemoService);
});

afterAll(async () => {
  delete process.env.DEMO_AI_DAILY_CAP;
  await app.close();
});

// Starts a demo the way the site does and returns a client that carries the session cookie
async function start() {
  const res = await http().post('/demo/start').expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const get = (p: string) => http().get(p).set('Cookie', cookie);
  const post = (p: string) => http().post(p).set('Cookie', cookie);
  const put = (p: string) => http().put(p).set('Cookie', cookie);
  const me = (await get('/auth/me').expect(200)).body;
  const clinic = await prisma.clinic.findFirstOrThrow({ where: { isDemo: true, name: me.clinicName }, orderBy: { createdAt: 'desc' } });
  return { get, post, put, cookie, clinicId: clinic.id, me };
}

describe('демо-клініка', () => {
  it('кожен відвідувач отримує свою копію з вигаданими даними; копії не бачать одна одну', async () => {
    const a = await start();
    const b = await start();
    expect(a.clinicId).not.toBe(b.clinicId);
    expect(a.me).toMatchObject({ role: 'OWNER', billing: { demo: true, blocked: false } });
    expect((await a.get('/patients?limit=100').expect(200)).body.total ?? (await prisma.patient.count({ where: { clinicId: a.clinicId } }))).toBeGreaterThanOrEqual(80);
    expect((await a.get('/conversations').expect(200)).body).toHaveLength(3);
    expect((await a.get('/requests').expect(200)).body.rows).toHaveLength(3);
    expect(await prisma.review.count({ where: { clinicId: a.clinicId } })).toBeGreaterThan(10);
    expect(await prisma.inquiry.count({ where: { clinicId: a.clinicId } })).toBe(24);
    // another copy's chat is not reachable
    await b.get('/conversations/TELEGRAM/demo-chat-1').expect(200);
    await prisma.chatMessage.deleteMany({ where: { clinicId: a.clinicId } });
    expect((await b.get('/conversations').expect(200)).body).toHaveLength(3);
    // reports work on the made-up data
    await a.get('/reports/no-next-visit').expect(200);
  });

  it('у демо не можна підключати реальні системи, змінювати команду, оплату; відповіді тільки імітуються', async () => {
    const d = await start();
    await d.put('/integrations/cliniccards/key').expect(403);
    await d.post('/integrations/cliniccards/sync').expect(403);
    await d.post('/team/invitations').expect(403);
    await d.post('/billing/checkout').expect(403);
    await d.post('/automations/telegram').expect(403);
    const before = sent.length;
    await d.post('/conversations/TELEGRAM/demo-chat-1/reply').send({ text: 'Добрий день! Є вікно завтра о 10:00.' }).expect(200);
    expect(sent.length).toBe(before); // nothing was sent to Telegram
    expect(await prisma.chatMessage.count({ where: { clinicId: d.clinicId, direction: 'OUT' } })).toBe(1);
    // the AI helps with a draft, with the small allowance of the copy
    expect((await d.post('/conversations/TELEGRAM/demo-chat-2/draft').expect(200)).body.reply).toContain('Допоможу');
  });

  it('загальний денний бюджет ШІ на демо обмежує витрати', async () => {
    const d = await start();
    process.env.DEMO_AI_DAILY_CAP = '0';
    try {
      await d.post('/conversations/TELEGRAM/demo-chat-1/draft').expect(400);
    } finally {
      delete process.env.DEMO_AI_DAILY_CAP;
    }
  });

  it('копія закінчується: доступ закривається, а прибирання видаляє її й вигаданого користувача; справжні клініки не чіпає', async () => {
    const d = await start();
    const real = await http().post('/auth/register').send({ acceptTerms: true, clinicName: 'Справжня', name: 'Анна', email: `real${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'correct-horse-battery' }).expect(201);
    await prisma.clinic.update({ where: { id: d.clinicId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });
    await d.get('/auth/me').expect(401);
    expect(await demo.purge()).toBeGreaterThanOrEqual(1);
    expect(await prisma.clinic.findUnique({ where: { id: d.clinicId } })).toBeNull();
    expect(await prisma.user.count({ where: { email: { endsWith: '@demo.lankaclinic.app' }, memberships: { none: {} } } })).toBe(0);
    await http().get('/auth/me').set({ Authorization: `Bearer ${real.body.accessToken}` }).expect(200);
  });

  it('листи демо-користувачам не відправляються', async () => {
    const via = await app.get(MailService).deliver({ to: 'demo-abc@demo.lankaclinic.app', subject: 's', text: 't' });
    expect(via).toBe('log');
  });
});
