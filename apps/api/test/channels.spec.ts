import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { FacebookApi, MetaApiError } from '../src/automations/meta-graph.api';
import { InstagramApi, InstagramError } from '../src/automations/instagram.api';
import { InstagramService } from '../src/automations/instagram.service';
import { ViberProvider } from '../src/automations/viber.provider';
import { ViberService } from '../src/automations/viber.service';
import { WhatsAppApi } from '../src/automations/whatsapp.api';
import { decrypt } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const SECRET = 'meta-app-secret-for-tests';
const VERIFY = 'meta-verify-token-for-tests';

// Fakes: nothing goes to the internet, every send is recorded
const fb = {
  sent: [] as { to: string; text: string; quick: { title: string; payload: string }[] }[],
  pages: {} as Record<string, { id: string; name: string }>,
  me: async (t: string) => {
    if (!fb.pages[t]) throw new MetaApiError('Invalid token', 190);
    return fb.pages[t];
  },
  profile: async (_t: string, id: string) => ({ name: `Гість ${id}` }),
  sendMessage: async (_t: string, to: string, text: string, quick: { title: string; payload: string }[] = []) => void fb.sent.push({ to, text, quick }),
};
const wa = {
  sent: [] as { phoneNumberId: string; to: string; text: string; buttons: { title: string; payload: string }[] }[],
  numbers: {} as Record<string, string>,
  phoneNumber: async (t: string, id: string) => {
    if (t.startsWith('bad') || !wa.numbers[id]) throw new MetaApiError('bad', 190);
    return { display_phone_number: wa.numbers[id], verified_name: 'Клініка' };
  },
  sendText: async (_t: string, phoneNumberId: string, to: string, text: string, buttons: { title: string; payload: string }[] = []) => void wa.sent.push({ phoneNumberId, to, text, buttons }),
};
const viberSent: { to: string; text: string }[] = [];
const viber = {
  available: true,
  verify: async (c: Record<string, string>) => {
    if (c.token === 'bad') throw new Error('bad');
    return { senderName: 'Клініка Viber' };
  },
  send: async (_c: Record<string, string>, to: string, text: string) => void viberSent.push({ to, text }),
};
const ig = {
  accounts: {} as Record<string, { user_id: string; username: string }>,
  refreshed: 0,
  me: async (t: string) => {
    if (!ig.accounts[t]) throw new InstagramError('Invalid token', 190);
    return ig.accounts[t];
  },
  profile: async () => ({ name: 'Гість' }),
  sendMessage: async () => undefined,
  subscribeApps: async () => ({ success: true }),
  exchangeCode: async (code: string) => {
    if (code === 'bad') throw new InstagramError('bad code', 400);
    ig.accounts[`short-${code}`] = { user_id: `igu-${code}`, username: `clinic_${code}` };
    return { access_token: `short-${code}`, user_id: `igu-${code}` };
  },
  exchangeLongLived: async (short: string) => {
    ig.accounts[`long-${short}`] = ig.accounts[short];
    return { access_token: `long-${short}`, expires_in: 5_184_000 };
  },
  refreshLongLived: async (t: string) => {
    ig.refreshed++;
    ig.accounts[`${t}+`] = ig.accounts[t];
    return { access_token: `${t}+`, expires_in: 5_184_000 };
  },
};
const llm = { configured: true, next: '', complete: async () => ({ text: llm.next, inputTokens: 5, outputTokens: 5 }) };

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
  process.env.META_INSTAGRAM_APP_ID = '123456';
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FacebookApi).useValue(fb)
    .overrideProvider(WhatsAppApi).useValue(wa)
    .overrideProvider(ViberProvider).useValue(viber)
    .overrideProvider(InstagramApi).useValue(ig)
    .overrideProvider(LlmClient).useValue(llm)
    .compile();
  app = mod.createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  delete process.env.META_INSTAGRAM_APP_ID;
  await app.close();
});
beforeEach(() => {
  fb.sent.length = 0;
  wa.sent.length = 0;
  viberSent.length = 0;
});

async function clinic(plan = 'PRO') {
  const email = `c${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan, sendingEnabled: true } });
  return { token: res.body.accessToken as string, clinicId };
}
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const post = (path: string, payload: object) => {
  const body = JSON.stringify(payload);
  return http().post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
};
let mid = 0;

describe('Facebook Messenger', () => {
  async function connected() {
    const c = await clinic();
    const token = `FBPAGE${rnd()}_0123456789abcdef`;
    const pageId = `page${++seq}${rnd()}`;
    fb.pages[token] = { id: pageId, name: 'Сторінка клініки' };
    await http().post('/automations/messenger').set(auth(c.token)).send({ token }).expect(200);
    return { ...c, pageId, pageToken: token };
  }
  const msg = (pageId: string, sender: string, m: Record<string, unknown>) => post('/messenger/webhook', { object: 'page', entry: [{ id: pageId, messaging: [{ sender: { id: sender }, recipient: { id: pageId }, message: m }] }] });

  it('підключення: токен перевіряється, зберігається зашифрованим, лише в «Про», одна сторінка — одна клініка', async () => {
    const c = await connected();
    expect((await http().get('/automations/channels').set(auth(c.token)).expect(200)).body.messenger).toMatchObject({ connected: true, username: 'Сторінка клініки', serverReady: true });
    const row = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'MESSENGER' } });
    expect(row.apiKeyEnc).not.toContain(c.pageToken);
    await http().post('/automations/messenger').set(auth(c.token)).send({ token: 'FBunknown_token_0123456789abc' }).expect(400);
    const other = await clinic();
    fb.pages['FBdup_0123456789abcdefghij'] = { id: c.pageId, name: 'x' };
    await http().post('/automations/messenger').set(auth(other.token)).send({ token: 'FBdup_0123456789abcdefghij' }).expect(400);
    const start = await clinic('START');
    fb.pages['FBstart_0123456789abcdefgh'] = { id: `p${rnd()}`, name: 'x' };
    await http().post('/automations/messenger').set(auth(start.token)).send({ token: 'FBstart_0123456789abcdefgh' }).expect(400);
    const admin = await member(c.token, 'ADMIN');
    await http().post('/automations/messenger').set(auth(admin)).send({ token: c.token }).expect(403);
  });

  it('повідомлення потрапляє у вхідні; без підпису — ні; повтор не дублює; відповідь співробітника йде у Messenger у межах 24 годин', async () => {
    const c = await connected();
    const m = { mid: `m${++mid}${rnd()}`, text: 'Добрий день, чи можна записатися?' };
    await http().post('/messenger/webhook').set('Content-Type', 'application/json').send({ object: 'page', entry: [{ id: c.pageId, messaging: [{ sender: { id: 'u1' }, message: m }] }] }).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(0);
    await msg(c.pageId, 'u1', m).expect(200);
    await msg(c.pageId, 'u1', m).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'IN' } })).toBe(1);
    expect(await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, direction: 'IN' } })).toMatchObject({ channel: 'MESSENGER', contactName: 'Гість u1' });
    await http().post('/conversations/MESSENGER/u1/reply').set(auth(c.token)).send({ text: 'Добрий день!' }).expect(200);
    expect(fb.sent.at(-1)).toMatchObject({ to: 'u1', text: 'Добрий день!' });
    await prisma.chatMessage.updateMany({ where: { clinicId: c.clinicId, chatId: 'u1' }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await http().post('/conversations/MESSENGER/u1/reply').set(auth(c.token)).send({ text: 'Ще раз' }).expect(400);
  });

  it('клініки ізольовані: подія однієї сторінки не потрапляє в іншу', async () => {
    const a = await connected();
    const b = await connected();
    await msg(a.pageId, 'u9', { mid: `m${++mid}${rnd()}`, text: 'Тільки для A' }).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: b.clinicId } })).toBe(0);
    await http().get('/conversations/MESSENGER/u9').set(auth(b.token)).expect(404);
  });
});

describe('WhatsApp', () => {
  async function connected() {
    const c = await clinic();
    const id = `1055${++seq}${Math.floor(Math.random() * 1e6)}`;
    wa.numbers[id] = '+38 050 111 22 33';
    await http().post('/automations/whatsapp').set(auth(c.token)).send({ token: `WAtoken${rnd()}_0123456789abcdef`, phoneNumberId: id }).expect(200);
    return { ...c, id };
  }
  const incoming = (id: string, from: string, m: Record<string, unknown>) => post('/whatsapp/webhook', { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: id }, contacts: [{ wa_id: from, profile: { name: 'Олена' } }], messages: [{ from, id: `wamid.${++mid}${rnd()}`, ...m }] } }] }] });

  it('підключення перевіряє номер у WhatsApp; токен зашифровано; погані дані відхиляються', async () => {
    const c = await connected();
    expect((await http().get('/automations/channels').set(auth(c.token))).body.whatsapp).toMatchObject({ connected: true, username: '+38 050 111 22 33' });
    await http().post('/automations/whatsapp').set(auth(c.token)).send({ token: 'badtoken_0123456789abcdefghij', phoneNumberId: c.id }).expect(400);
    await http().post('/automations/whatsapp').set(auth(c.token)).send({ token: 'WAtoken_0123456789abcdefghij', phoneNumberId: 'abc' }).expect(400);
    const row = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'WHATSAPP' } });
    expect(row.apiKeyEnc).not.toContain('WAtoken');
    expect(decrypt(row.apiKeyEnc!)).toContain('WAtoken');
    const other = await clinic();
    await http().post('/automations/whatsapp').set(auth(other.token)).send({ token: 'WAtoken_0123456789abcdefghij', phoneNumberId: c.id }).expect(400);
  });

  it('номер відправника підтверджує WhatsApp: єдина картка з цим телефоном прив’язується сама; кілька карток — ні', async () => {
    const c = await connected();
    const one = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Мельник Олена', phone: '0507776655', phoneNorm: '380507776655' } });
    await incoming(c.id, '380507776655', { type: 'text', text: { body: 'Добрий день' } }).expect(200);
    expect(await prisma.patientChannel.findFirst({ where: { patientId: one.id } })).toMatchObject({ channel: 'WHATSAPP', externalId: '380507776655' });
    expect(await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: '380507776655', direction: 'IN' } })).toMatchObject({ patientId: one.id, contactName: 'Олена' });
    // two cards with one number: a person decides
    for (const n of ['Двійник Один', 'Двійник Два']) await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: n, phone: '0501230000', phoneNorm: '380501230000' } });
    await incoming(c.id, '380501230000', { type: 'text', text: { body: 'Привіт' } }).expect(200);
    expect(await prisma.patientChannel.count({ where: { clinicId: c.clinicId, externalId: '380501230000' } })).toBe(0);
    expect((await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: '380501230000', direction: 'IN' } })).patientId).toBeNull();
  });

  it('кнопка з часом стає заявкою; співробітник відповідає в межах 24 годин; чужа клініка не бачить; без підпису нічого', async () => {
    const c = await connected();
    await incoming(c.id, '380671112233', { type: 'text', text: { body: 'Хочу на чистку' } }).expect(200);
    await incoming(c.id, '380671112233', { type: 'interactive', interactive: { button_reply: { id: 'slot|2026-11-03|10:00', title: 'Вт 03.11, 10:00' } } }).expect(200);
    expect((await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'WHATSAPP' } })).summary).toContain('03.11 10:00');
    expect(wa.sent.at(-1)!.text).toContain('адміністратору');
    await http().post('/conversations/WHATSAPP/380671112233/reply').set(auth(c.token)).send({ text: 'Підтверджуємо' }).expect(200);
    expect(wa.sent.at(-1)).toMatchObject({ phoneNumberId: c.id, to: '380671112233', text: 'Підтверджуємо' });
    const other = await clinic();
    await http().get('/conversations/WHATSAPP/380671112233').set(auth(other.token)).expect(404);
    const before = await prisma.chatMessage.count({ where: { clinicId: c.clinicId } });
    await http().post('/whatsapp/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=00').send({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: c.id }, messages: [{ from: '3806', id: 'x', type: 'text', text: { body: 'підробка' } }] } }] }] }).expect(200);
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId } })).toBe(before);
  });

  it('адреса вебхука підтверджується лише правильним токеном', async () => {
    await http().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '77' }).expect(200).expect((r) => expect(r.text).toBe('77'));
    await http().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }).expect(400);
    await http().get('/messenger/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }).expect(400);
  });
});

describe('Viber (партнер ще не обрано, на підробці)', () => {
  it('без партнера підключити не можна; з партнером повідомлення проходить повний шлях і відповідь іде через інтерфейс', async () => {
    const c = await clinic();
    viber.available = false;
    await http().post('/automations/viber').set(auth(c.token)).send({ credentials: { token: 'ok' } }).expect(400);
    viber.available = true;
    await http().post('/automations/viber').set(auth(c.token)).send({ credentials: { token: 'bad' } }).expect(400);
    await http().post('/automations/viber').set(auth(c.token)).send({ credentials: { token: 'ok' } }).expect(200);
    await app.get(ViberService).receive(c.clinicId, { from: 'vb1', id: `v${++mid}${rnd()}`, text: 'Привіт', name: 'Ірина' });
    expect(await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'VIBER', direction: 'IN' } })).toMatchObject({ chatId: 'vb1', contactName: 'Ірина' });
    expect(viberSent.at(-1)).toMatchObject({ to: 'vb1' }); // the polite first reply
    await http().post('/conversations/VIBER/vb1/reply').set(auth(c.token)).send({ text: 'Добрий день!' }).expect(200);
    expect(viberSent.at(-1)).toMatchObject({ to: 'vb1', text: 'Добрий день!' });
  });
});

describe('чат на сайті клініки', () => {
  const SITE = 'https://clinic-site.example';
  async function enabled(plan = 'PRO') {
    const c = await clinic(plan);
    const s = await http().patch('/automations/webchat').set(auth(c.token)).send({ enabled: true, origins: [SITE], greeting: 'Вітаємо!' });
    return { ...c, s, key: (s.body.snippet as string | null)?.match(/data-key="([^"]+)"/)?.[1] ?? '' };
  }
  const visit = (key: string, path: string, origin: string | null = SITE) => {
    const r = http().get(`/webchat/${key}/${path}`);
    return origin ? r.set('Origin', origin) : r;
  };
  const session = async (key: string, over: Record<string, unknown> = {}) => {
    const r = await http().post(`/webchat/${key}/session`).set('Origin', SITE).send(over).expect(200);
    return r.body.token as string;
  };
  const say = (key: string, token: string, text: string, payload?: string) => http().post(`/webchat/${key}/messages`).set('Origin', SITE).set('Authorization', `Bearer ${token}`).send({ text, ...(payload ? { payload } : {}) });

  it('налаштування: вмикає лише власник і керуючий, лише в «Про»; адреси перевіряються; ключ видно у вставці', async () => {
    const start = await enabled('START');
    expect(start.s.status).toBe(400);
    const c = await enabled();
    expect(c.s.status).toBe(200);
    expect(c.s.body).toMatchObject({ enabled: true, origins: [SITE] });
    expect(c.s.body.snippet).toContain('/widget.js');
    await http().patch('/automations/webchat').set(auth(c.token)).send({ origins: ['not a url'] }).expect(400);
    await http().patch('/automations/webchat').set(auth(c.token)).send({ origins: ['http://insecure.example'] }).expect(400);
    const admin = await member(c.token, 'ADMIN');
    await http().patch('/automations/webchat').set(auth(admin)).send({ enabled: false }).expect(403);
  });

  it('працює лише з дозволеного сайту; чужий сайт і неправильний ключ однаково отримують 404 без CORS-заголовків', async () => {
    const c = await enabled();
    const ok = await visit(c.key, 'config').expect(200);
    expect(ok.body).toMatchObject({ greeting: 'Вітаємо!' });
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    const evil = await visit(c.key, 'config', 'https://evil.example').expect(404);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    await visit(c.key, 'config', null).expect(404);
    await visit('wrong-key', 'config').expect(404);
    const pre = await http().options(`/webchat/${c.key}/messages`).set('Origin', SITE).set('Access-Control-Request-Method', 'POST').expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe(SITE);
    const preEvil = await http().options(`/webchat/${c.key}/messages`).set('Origin', 'https://evil.example').expect(204);
    expect(preEvil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('відвідувач пише, отримує відповідь, співробітник бачить розмову й відповідає; відвідувач бачить цю відповідь; ім’я з форми, але картка автоматично не прив’язується', async () => {
    const c = await enabled();
    await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Коваль Іван', phone: '0509998877', phoneNorm: '380509998877' } });
    const token = await session(c.key, { name: 'Іван', phone: '0509998877' });
    const r = await say(c.key, token, 'Добрий день, хочу записатися').expect(200);
    expect(r.body.messages[0].text).toContain('повідомлення отримано');
    const chat = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'WEB', direction: 'IN' } });
    expect(chat).toMatchObject({ contactName: 'Іван · 0509998877', patientId: null });
    expect(await prisma.patientChannel.count({ where: { clinicId: c.clinicId, channel: 'WEB' } })).toBe(0);
    await http().post(`/conversations/WEB/${chat.chatId}/reply`).set(auth(c.token)).send({ text: 'Є вікно завтра о 10:00' }).expect(200);
    const hist = await visit(c.key, 'messages').set('Authorization', `Bearer ${token}`).expect(200);
    expect(hist.body.messages.map((m: { text: string }) => m.text)).toContain('Є вікно завтра о 10:00');
    // another visitor's session sees nothing of this chat
    const other = await session(c.key);
    expect((await visit(c.key, 'messages').set('Authorization', `Bearer ${other}`).expect(200)).body.messages).toHaveLength(0);
  });

  it('ШІ відповідає і в чаті сайту: той самий помічник, ті самі межі', async () => {
    const c = await enabled();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true, aiAutoReply: true } });
    const token = await session(c.key);
    llm.next = JSON.stringify({ intent: 'booking', reply: 'Добрий день! Допоможемо із записом.', summary: 'Запис', options: [] });
    const r = await say(c.key, token, 'Хочу записатися на чистку').expect(200);
    expect(r.body.messages[0]).toMatchObject({ text: 'Добрий день! Допоможемо із записом.' });
    expect(await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, channel: 'WEB' } })).toMatchObject({ kind: 'BOOKING' });
    // a dangerous topic never reaches the model: a hand-over text comes back
    const risky = await say(c.key, token, 'У мене болить зуб').expect(200);
    expect(risky.body.messages[0].text).toContain('адміністратор');
  });

  it('захист: без токена сесії 401; токен іншого ключа не підходить; порожнє й задовге повідомлення відхиляються; ліміт повідомлень; вимкнений чат і призупинена клініка недоступні', async () => {
    const a = await enabled();
    const b = await enabled();
    await http().post(`/webchat/${a.key}/messages`).set('Origin', SITE).send({ text: 'x' }).expect(401);
    const tokenA = await session(a.key);
    await http().post(`/webchat/${b.key}/messages`).set('Origin', SITE).set('Authorization', `Bearer ${tokenA}`).send({ text: 'x' }).expect(401);
    await say(a.key, tokenA, '   ').expect(400);
    await say(a.key, tokenA, 'я'.repeat(1001)).expect(400);
    for (let i = 0; i < 20; i++) await say(a.key, tokenA, `повідомлення ${i}`);
    await say(a.key, tokenA, 'ще одне').expect(429);
    await http().patch('/automations/webchat').set(auth(b.token)).send({ enabled: false }).expect(200);
    await visit(b.key, 'config').expect(404);
    await prisma.clinic.update({ where: { id: a.clinicId }, data: { suspendedAt: new Date() } });
    await visit(a.key, 'config').expect(403);
  });

  it('новий ключ скасовує старий код вставки та відкриті сесії', async () => {
    const c = await enabled();
    const token = await session(c.key);
    const r = await http().post('/automations/webchat/rotate-key').set(auth(c.token)).expect(200);
    const newKey = (r.body.snippet as string).match(/data-key="([^"]+)"/)![1];
    expect(newKey).not.toBe(c.key);
    await visit(c.key, 'config').expect(404);
    await http().post(`/webchat/${newKey}/messages`).set('Origin', SITE).set('Authorization', `Bearer ${token}`).send({ text: 'x' }).expect(401);
  });
});

describe('Instagram: вхід через OAuth', () => {
  it('кнопка веде в Instagram з підписаним станом; після повернення акаунт підключається, токен довгий; зіпсований стан відхиляється', async () => {
    const c = await clinic();
    const start = await http().get('/automations/instagram/oauth').set(auth(c.token)).expect(302);
    const url = new URL(start.headers.location);
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456');
    expect(url.searchParams.get('redirect_uri')).toContain('/backend/instagram/oauth/callback');
    const state = url.searchParams.get('state')!;

    const bad = await http().get('/instagram/oauth/callback').query({ code: 'abc', state: `${state}x` }).expect(302);
    expect(bad.headers.location).toContain('ig=fail');
    expect(await prisma.integration.count({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).toBe(0);
    const denied = await http().get('/instagram/oauth/callback').query({ error: 'access_denied', state }).expect(302);
    expect(denied.headers.location).toContain('ig=denied');

    const code = `c${rnd()}`;
    const ok = await http().get('/instagram/oauth/callback').query({ code: `${code}#_`, state }).expect(302);
    expect(ok.headers.location).toContain('ig=ok');
    const row = await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } });
    expect(decrypt(row.apiKeyEnc!)).toBe(`long-short-${code}`);
    expect((row.config as { ownId?: string }).ownId).toBe(`igu-${code}`);
    expect((row.config as { expiresAt?: number }).expiresAt).toBeGreaterThan(Date.now() + 50 * 86_400_000);
    expect((await http().get('/automations').set(auth(c.token))).body.instagram).toMatchObject({ connected: true, oauthReady: true });
  });

  it('вхід доступний лише власнику і керуючому на «Про»; на «Старт» відправляє назад із поясненням; у демо заборонено; без налаштування Meta — теж пояснення', async () => {
    const c = await clinic();
    const doctor = await member(c.token, 'DOCTOR');
    await http().get('/automations/instagram/oauth').set(auth(doctor)).expect(403);
    const start = await clinic('START');
    expect((await http().get('/automations/instagram/oauth').set(auth(start.token)).expect(302)).headers.location).toContain('ig=plan');
    const demo = await clinic();
    await prisma.clinic.update({ where: { id: demo.clinicId }, data: { isDemo: true } });
    expect((await http().get('/automations/instagram/oauth').set(auth(demo.token)).expect(302)).headers.location).toContain('ig=demo');
    const id = process.env.META_INSTAGRAM_APP_ID;
    delete process.env.META_INSTAGRAM_APP_ID;
    try {
      expect((await http().get('/automations/instagram/oauth').set(auth(c.token)).expect(302)).headers.location).toContain('ig=off');
    } finally {
      process.env.META_INSTAGRAM_APP_ID = id;
    }
  });

  it('акаунт, уже підключений до іншої клініки, відхиляється; токен, що спливає, оновлюється автоматично', async () => {
    const a = await clinic();
    const b = await clinic();
    const connect = async (c: { token: string }, code: string) => {
      const state = new URL((await http().get('/automations/instagram/oauth').set(auth(c.token)).expect(302)).headers.location).searchParams.get('state')!;
      return (await http().get('/instagram/oauth/callback').query({ code, state }).expect(302)).headers.location as string;
    };
    const code = `d${rnd()}`;
    expect(await connect(a, code)).toContain('ig=ok');
    expect(await connect(b, code)).toContain('ig=taken');

    const row = await prisma.integration.findFirstOrThrow({ where: { clinicId: a.clinicId, provider: 'INSTAGRAM' } });
    await prisma.integration.update({ where: { id: row.id }, data: { config: { ...(row.config as object), expiresAt: Date.now() + 3 * 86_400_000 } } });
    const before = ig.refreshed;
    await app.get(InstagramService).refreshDue();
    expect(ig.refreshed).toBeGreaterThanOrEqual(before + 1);
    const afterFirst = ig.refreshed;
    const after = await prisma.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(decrypt(after.apiKeyEnc!)).toBe(`long-short-${code}+`);
    // a token far from expiry is left alone
    await app.get(InstagramService).refreshDue();
    expect(ig.refreshed).toBe(afterFirst);
  });
});
