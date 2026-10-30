import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { InstagramApi, InstagramError } from '../src/automations/instagram.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const SECRET = 'meta-app-secret-for-tests';
const VERIFY = 'meta-verify-token-for-tests';
const TOKEN = 'IGAAFakeTokenForTestsOnly_abcdefghijklmnop';

// Fake Instagram: nothing goes to the internet, every send is recorded
class FakeInstagram {
  sent: { token: string; to: string; text: string; quick: { title: string; payload: string }[] }[] = [];
  accounts: Record<string, { user_id: string; username: string }> = {};
  me = async (token: string) => {
    const a = this.accounts[token];
    if (!a) throw new InstagramError('Invalid token', 190);
    return a;
  };
  profile = async (_t: string, id: string) => ({ name: `Гість ${id}`, username: `guest${id}` });
  sendMessage = async (token: string, to: string, text: string, quick: { title: string; payload: string }[] = []) => void this.sent.push({ token, to, text, quick });
}

const llm = { configured: true, next: '', complete: async () => ({ text: llm.next, inputTokens: 50, outputTokens: 10 }) };
const ig = new FakeInstagram();
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
let seq = 0;

beforeAll(async () => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_VERIFY_TOKEN = VERIFY;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(InstagramApi).useValue(ig).overrideProvider(LlmClient).useValue(llm).compile();
  app = mod.createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  ig.sent.length = 0;
});

async function connected(sending = true) {
  const email = `i${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // features of the Pro plan are on by default in these tests; the plan rules have their own tests
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO' } });
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: sending } });
  const token = `${TOKEN}${rnd()}`;
  const igUserId = `ig${++seq}${rnd()}`;
  ig.accounts[token] = { user_id: igUserId, username: `clinic_${rnd()}` };
  await http().post('/automations/instagram').set(auth(res.body.accessToken)).send({ token }).expect(201);
  return { owner: res.body.accessToken as string, clinicId, igUserId, token };
}

// A signed webhook as Meta sends it
function hook(igUserId: string, sender: string, message: Record<string, unknown>, opts: { secret?: string; sign?: boolean } = {}) {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: igUserId, messaging: [{ sender: { id: sender }, recipient: { id: igUserId }, timestamp: Date.now(), message }] }] });
  const sig = `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(body).digest('hex')}`;
  const r = http().post('/instagram/webhook').set('Content-Type', 'application/json');
  if (opts.sign !== false) r.set('X-Hub-Signature-256', sig);
  return r.send(body);
}
let mid = 0;
const text = (t: string) => ({ mid: `m${++mid}${rnd()}`, text: t });

describe('підключення Instagram', () => {
  it('токен перевіряється в Instagram і лежить зашифрованим; один акаунт — одна клініка; налаштовує лише власник і керуючий', async () => {
    const c = await connected();
    const st = await http().get('/automations').set(auth(c.owner)).expect(200);
    expect(st.body.instagram).toMatchObject({ connected: true, serverReady: true, linkedPatients: 0 });
    expect(JSON.stringify(st.body)).not.toContain(c.token);
    const row = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } });
    expect(row.apiKeyEnc).not.toContain(c.token);
    expect(JSON.stringify(row.config)).not.toContain(c.token);

    await http().post('/automations/instagram').set(auth(c.owner)).send({ token: 'IGAAunknown_token_0123456789abc' }).expect(400);
    // the same account in another clinic is refused
    const other = await connected();
    ig.accounts['IGAAduplicate_0123456789abcdef'] = { user_id: c.igUserId, username: 'x' };
    await http().post('/automations/instagram').set(auth(other.owner)).send({ token: 'IGAAduplicate_0123456789abcdef' }).expect(400);

    const inv = await http().post('/team/invitations').set(auth(c.owner)).send({ email: `r${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().post('/automations/instagram').set(auth(admin)).send({ token: c.token }).expect(403);
    await http().delete('/automations/instagram').set(auth(c.owner)).expect(200);
    expect((await http().get('/automations').set(auth(c.owner)).expect(200)).body.instagram.connected).toBe(false);
  });
});

describe('вебхук Meta', () => {
  it('адресу підтверджує лише правильний verify token', async () => {
    const ok = await http().get('/instagram/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '12345' }).expect(200);
    expect(ok.text).toBe('12345');
    await http().get('/instagram/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(400);
  });

  it('без підпису, з чужою підписью або для невідомого акаунта нічого не зберігається', async () => {
    const c = await connected();
    await hook(c.igUserId, 'u1', text('Привіт'), { sign: false }).expect(200);
    await hook(c.igUserId, 'u1', text('Привіт'), { secret: 'not-the-secret' }).expect(200);
    await hook('unknown-account', 'u1', text('Привіт')).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
  });

  it('повідомлення потрапляє у вхідні з іменем; повторна доставка тієї ж події не дублює; луна власних повідомлень ігнорується', async () => {
    const c = await connected(false);
    const m = text('Добрий день, чи можна записатися?');
    await hook(c.igUserId, 'u100', m).expect(200);
    await hook(c.igUserId, 'u100', m).expect(200);
    await hook(c.igUserId, c.igUserId, { ...text('echo'), is_echo: true }).expect(200);
    const rows = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'INSTAGRAM', chatId: 'u100', direction: 'IN', contactName: 'Гість u100' });
    // sending is off: nothing is written back
    expect(ig.sent).toHaveLength(0);
    const list = await http().get('/conversations').set(auth(c.owner)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ channel: 'INSTAGRAM', unread: 1 });
  });

  it('клініки ізольовані: подія одного акаунта не потрапляє в іншу клініку', async () => {
    const a = await connected();
    const b = await connected();
    await hook(a.igUserId, 'u1', text('Тільки для A')).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: b.clinicId } })).toBe(0);
    expect((await http().get('/conversations').set(auth(b.owner)).expect(200)).body).toHaveLength(0);
    await http().get('/conversations/INSTAGRAM/u1').set(auth(b.owner)).expect(404);
  });

  it('призупинена клініка повідомлення не обробляє', async () => {
    const c = await connected();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { suspendedAt: new Date() } });
    await hook(c.igUserId, 'u1', text('Привіт')).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
  });
});

describe('відповіді в Instagram', () => {
  it('без ШІ: одна ввічлива відповідь на добу, коли відправка увімкнена', async () => {
    const c = await connected();
    await hook(c.igUserId, 'u1', text('Привіт')).expect(200);
    await hook(c.igUserId, 'u1', text('Є хтось?')).expect(200);
    expect(ig.sent).toHaveLength(1);
    expect(ig.sent[0]).toMatchObject({ to: 'u1', token: c.token });
  });

  it('співробітник відповідає в межах 24 годин; після цього відповідь закрита', async () => {
    const c = await connected();
    await hook(c.igUserId, 'u2', text('Скільки коштує чистка?')).expect(200);
    const thread = await http().get('/conversations/INSTAGRAM/u2').set(auth(c.owner)).expect(200);
    expect(thread.body.replyWindowOpen).toBe(true);
    await http().post('/conversations/INSTAGRAM/u2/reply').set(auth(c.owner)).send({ text: 'Добрий день! Зараз уточню.' }).expect(200);
    expect(ig.sent.at(-1)).toMatchObject({ to: 'u2', text: 'Добрий день! Зараз уточню.' });

    await prisma.chatMessage.updateMany({ where: { clinicId: c.clinicId, chatId: 'u2' }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const n = ig.sent.length;
    expect((await http().get('/conversations/INSTAGRAM/u2').set(auth(c.owner)).expect(200)).body.replyWindowOpen).toBe(false);
    const r = await http().post('/conversations/INSTAGRAM/u2/reply').set(auth(c.owner)).send({ text: 'Ще раз вітаю' }).expect(400);
    expect(JSON.stringify(r.body)).toContain('24 години');
    expect(ig.sent).toHaveLength(n);
  });

  it('ШІ відповідає кнопками з часом; вибір кнопки стає заявкою адміністратору', async () => {
    const c = await connected();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true, aiAutoReply: true } });
    llm.next = JSON.stringify({ intent: 'booking', reply: 'Добрий день! Можна записати вас на гігієну. Оберіть час кнопкою.', summary: 'Хоче гігієну', options: [] });
    await hook(c.igUserId, 'u3', text('Хочу на чистку зубів')).expect(200);
    const out = ig.sent.at(-1)!;
    expect(out.text).toContain('гігієну');
    expect(await prisma.chatMessage.findFirst({ where: { clinicId: c.clinicId, chatId: 'u3', direction: 'OUT' } })).toMatchObject({ byAi: true });
    expect(await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: 'u3' } })).toMatchObject({ kind: 'BOOKING' });

    // the person taps a time button
    await hook(c.igUserId, 'u3', { mid: `m${++mid}${rnd()}`, text: 'Вт 03.11, 10:00', quick_reply: { payload: 'slot|2026-11-03|10:00' } }).expect(200);
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: 'u3' } });
    expect(req.summary).toContain('03.11 10:00');
    expect(ig.sent.at(-1)!.text).toContain('адміністратору');
  });

  it('«Зупинити»: людина прив’язана до картки більше не отримує автоматичних відповідей', async () => {
    const c = await connected();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true, aiAutoReply: true } });
    const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Петренко Ірина' } });
    await hook(c.igUserId, 'u4', text('Привіт')).expect(200);
    await http().post('/conversations/INSTAGRAM/u4/link').set(auth(c.owner)).send({ patientId: p.id }).expect(200);
    expect(await prisma.patientChannel.findUnique({ where: { patientId_channel: { patientId: p.id, channel: 'INSTAGRAM' } } })).toMatchObject({ externalId: 'u4' });
    await hook(c.igUserId, 'u4', text('Зупинити')).expect(200);
    const n = ig.sent.length;
    llm.next = JSON.stringify({ intent: 'info', reply: 'Ще раз вітаю', summary: null, options: [] });
    await hook(c.igUserId, 'u4', text('Хочу записатись')).expect(200);
    expect(ig.sent).toHaveLength(n);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: 'u4', direction: 'IN' } })).toBe(3);
  });

  it('«Зупинити» від незнайомого теж зупиняє автовідповіді', async () => {
    const c = await connected();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true, aiAutoReply: true } });
    await hook(c.igUserId, 'u5', text('stop')).expect(200);
    const n = ig.sent.length;
    llm.next = JSON.stringify({ intent: 'info', reply: 'Вітаю', summary: null, options: [] });
    await hook(c.igUserId, 'u5', text('А тепер хочу запис')).expect(200);
    expect(ig.sent).toHaveLength(n);
  });
});
