import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { InstagramApi } from '../src/automations/instagram.api';
import { InstagramService } from '../src/automations/instagram.service';
import { FacebookApi, MetaApiError } from '../src/automations/meta-graph.api';
import { MetaLoginApi, PageInfo, TokenInfo } from '../src/automations/meta-login.api';
import { MetaLoginService } from '../src/automations/meta-login.service';
import { decrypt, encrypt as encryptForTest } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const SECRET = 'meta-app-secret-for-tests';
// Fake Facebook: what the login returns, what each token is, which pages it reaches; every subscription is recorded
const codes: Record<string, { accessToken: string; expiresIn: number | null }> = {};
const tokens: Record<string, TokenInfo> = {};
const accountsByToken: Record<string, PageInfo[]> = {};
const flags = { leadSubscribeFails: false, subscribeDenied: false };
const loginFake = {
  subscribed: [] as { pageId: string; fields: string; token: string }[],
  exchangeCode: async (code: string) => {
    if (!codes[code]) throw new MetaApiError('bad code', 100);
    return codes[code];
  },
  debugToken: async (t: string): Promise<TokenInfo> => tokens[t] ?? { isValid: false, type: 'UNKNOWN', expiresAt: null, scopes: [], pageIds: [] },
  accounts: async (t: string) => accountsByToken[t] ?? [],
  pageToken: async (_t: string, pageId: string) => `page-token-${pageId}`,
  subscribe: async (token: string, pageId: string, fields: string) => {
    if (flags.subscribeDenied) throw new MetaApiError('permission denied', 200);
    if (fields.includes('leadgen') && flags.leadSubscribeFails) throw new MetaApiError('no leads permission', 200);
    loginFake.subscribed.push({ pageId, fields, token });
    return { success: true };
  },
};

const fbSent: { token: string; to: string; text: string }[] = [];
const fb = { me: async () => ({ id: 'x', name: 'x' }), profile: async (_t: string, id: string) => ({ name: `Гість ${id}` }), sendMessage: async (token: string, to: string, text: string) => void fbSent.push({ token, to, text }) };
const igSent: { to: string }[] = [];
const ig = { me: async () => ({ user_id: 'u', username: 'u' }), profile: async () => ({ name: 'legacy' }), sendMessage: async (_t: string, to: string) => void igSent.push({ to }), refreshLongLived: jest.fn() };

let app: INestApplication;
let prisma: PrismaService;
let mail: MailService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  Object.assign(process.env, { META_APP_ID: '999000', META_APP_SECRET: SECRET, META_CONFIG_ID: '2189107265371270', META_VERIFY_TOKEN: 'v', WEB_ORIGIN: 'https://lankaclinic.app' });
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MetaLoginApi).useValue(loginFake).overrideProvider(FacebookApi).useValue(fb).overrideProvider(InstagramApi).useValue(ig).compile()).createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_CONFIG_ID', 'META_VERIFY_TOKEN', 'WEB_ORIGIN']) delete process.env[k];
  await app.close();
});
beforeEach(() => {
  loginFake.subscribed.length = 0;
  fbSent.length = 0;
  igSent.length = 0;
});

async function clinic(plan = 'PRO') {
  const email = `f${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  await prisma.clinic.update({ where: { id: user.memberships[0].clinicId }, data: { plan, sendingEnabled: true } });
  return { token: res.body.accessToken as string, clinicId: user.memberships[0].clinicId, email };
}
const stateOf = async (token: string) => new URL((await http().get('/automations/meta/oauth').set(auth(token)).expect(302)).headers.location).searchParams.get('state')!;
// what a person who picked the given pages brings back
function grant(pages: PageInfo[], over: Partial<TokenInfo> = {}) {
  const code = `code${rnd()}`;
  const token = `user-token-${rnd()}`;
  codes[code] = { accessToken: token, expiresIn: null };
  tokens[token] = { isValid: true, type: 'SYSTEM_USER', expiresAt: null, scopes: ['pages_messaging', 'instagram_manage_messages', 'leads_retrieval'], pageIds: pages.map((p) => p.id), ...over };
  accountsByToken[token] = pages;
  return { code, token };
}
// the test database is shared, so only the letters to this clinic's owner are counted
const mailsTo = (email: string) => mail.outbox.filter((m) => m.to === email).length;
const page = (over: Partial<PageInfo> = {}): PageInfo => {
  const p = { id: `pg${rnd()}`, name: 'Клініка «Усмішка»', igId: `ig${rnd()}`, igUsername: `smile_${rnd()}`, ...over };
  // the page token that the login will give is valid and does not expire
  tokens[`page-token-${p.id}`] = { isValid: true, type: 'PAGE', expiresAt: null, scopes: [], pageIds: [] };
  return p;
};
const back = (code: string | undefined, state: string, error?: string) => http().get('/meta/oauth/callback').query({ ...(code ? { code } : {}), state, ...(error ? { error } : {}) }).expect(302);

describe('вхід через Facebook Login for Business', () => {
  it('кнопка веде в діалог Facebook із конфігурацією, а не зі списком дозволів; доступна лише власнику й керуючому на «Про»', async () => {
    const c = await clinic();
    const r = await http().get('/automations/meta/oauth').set(auth(c.token)).expect(302);
    const url = new URL(r.headers.location);
    expect(url.origin + url.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: '999000', config_id: '2189107265371270', response_type: 'code', override_default_response_type: 'true', redirect_uri: 'https://lankaclinic.app/backend/meta/oauth/callback' });
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBeTruthy();
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `d${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
    const doctor = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лікар', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/automations/meta/oauth').set(auth(doctor)).expect(403);
    const start = await clinic('START');
    expect((await http().get('/automations/meta/oauth').set(auth(start.token)).expect(302)).headers.location).toContain('meta=plan');
    const demo = await clinic();
    await prisma.clinic.update({ where: { id: demo.clinicId }, data: { isDemo: true } });
    expect((await http().get('/automations/meta/oauth').set(auth(demo.token)).expect(302)).headers.location).toContain('meta=demo');
    delete process.env.META_CONFIG_ID;
    try {
      expect((await http().get('/automations/meta/oauth').set(auth(c.token)).expect(302)).headers.location).toContain('meta=off');
    } finally {
      process.env.META_CONFIG_ID = '2189107265371270';
    }
  });

  it('повернення: підроблений стан, відмова й невірний код нічого не підключають', async () => {
    const c = await clinic();
    const state = await stateOf(c.token);
    const g = grant([page()]);
    expect((await back(g.code, `${state}x`)).headers.location).toContain('meta=fail');
    expect((await back(undefined, state, 'access_denied')).headers.location).toContain('meta=denied');
    expect((await back('unknown-code', state)).headers.location).toContain('meta=fail');
    // a token that Meta says is not valid
    const bad = grant([page()], { isValid: false });
    expect((await back(bad.code, state)).headers.location).toContain('meta=fail');
    expect(await prisma.integration.count({ where: { clinicId: c.clinicId, provider: { in: ['INSTAGRAM', 'MESSENGER'] } } })).toBe(0);
  });

  it('одна сторінка: підключаються Messenger і Instagram за токеном сторінки, термін не задано (без 60 днів), підписка на вебхуки оформлена, токени зашифровано', async () => {
    const c = await clinic();
    const p = page();
    const g = grant([p]);
    const r = await back(g.code, await stateOf(c.token));
    expect(r.headers.location).toContain('meta=ok');
    const [m, i] = [await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'MESSENGER' } }), await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })];
    expect(decrypt(m.apiKeyEnc!)).toBe(`page-token-${p.id}`);
    expect(decrypt(i.apiKeyEnc!)).toBe(`page-token-${p.id}`);
    expect(m.config).toMatchObject({ ownId: p.id, name: p.name, mode: 'FACEBOOK_LOGIN', tokenType: 'SYSTEM_USER' });
    expect(i.config).toMatchObject({ ownId: p.igId, name: p.igUsername, mode: 'FACEBOOK_LOGIN', pageId: p.id });
    expect(i.apiKeyEnc).not.toContain('page-token');
    // the lifetime: nothing to refresh on a schedule
    expect((i.config as { expiresAt?: number }).expiresAt).toBeUndefined();
    expect((i.config as { tokenExpiresAt?: number }).tokenExpiresAt).toBeUndefined();
    expect(loginFake.subscribed.map((s) => s.fields)).toEqual(['messages,messaging_postbacks', 'messages,messaging_postbacks,leadgen']);
    expect(loginFake.subscribed[0]).toMatchObject({ pageId: p.id, token: `page-token-${p.id}` });
    expect(await prisma.metaConnectSession.count({ where: { clinicId: c.clinicId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'meta.connected' } })).toBe(1);
    const st = (await http().get('/automations').set(auth(c.token))).body.instagram;
    expect(st).toMatchObject({ connected: true, username: p.igUsername, via: 'facebook', tokenProblem: null, facebookLoginReady: true });
    expect(JSON.stringify(st)).not.toContain('page-token');
  });

  it('збій підписки на заявки з реклами не скасовує підключення; відмова в підписці на повідомлення повертає помилку', async () => {
    const c = await clinic();
    flags.leadSubscribeFails = true;
    expect((await back(grant([page()]).code, await stateOf(c.token))).headers.location).toContain('meta=ok');
    flags.leadSubscribeFails = false;
    const d = await clinic();
    flags.subscribeDenied = true;
    expect((await back(grant([page()]).code, await stateOf(d.token))).headers.location).toContain('meta=subscribe');
    flags.subscribeDenied = false;
  });

  it('кілька сторінок: показується вибір без токенів; обмеження людини в діалозі враховується; чужа клініка вибір не бачить; після вибору сеанс видаляється', async () => {
    const c = await clinic();
    const [a, b, d] = [page(), page(), page({ igId: null, igUsername: null })];
    const code = `code${rnd()}`;
    const token = `user-token-${rnd()}`;
    codes[code] = { accessToken: token, expiresIn: null };
    // the person picked only two pages in the dialog, the account can reach three
    tokens[token] = { isValid: true, type: 'SYSTEM_USER', expiresAt: null, scopes: ['pages_messaging', 'instagram_manage_messages'], pageIds: [a.id, d.id] };
    accountsByToken[token] = [a, b, d];
    const r = await back(code, await stateOf(c.token));
    const sessionId = new URL(r.headers.location).searchParams.get('session')!;
    expect(r.headers.location).toContain('meta=select');
    const pending = (await http().get(`/automations/meta/pending/${sessionId}`).set(auth(c.token)).expect(200)).body;
    expect(pending.pages.map((p: { id: string }) => p.id)).toEqual([a.id, d.id]);
    expect(JSON.stringify(pending)).not.toContain('token');
    const other = await clinic();
    await http().get(`/automations/meta/pending/${sessionId}`).set(auth(other.token)).expect(404);
    await http().post('/automations/meta/connect').set(auth(other.token)).send({ sessionId, pageId: a.id }).expect(404);
    await http().post('/automations/meta/connect').set(auth(c.token)).send({ sessionId, pageId: b.id }).expect(400); // a page the person did not pick
    // a page without an Instagram account connects Messenger only
    await http().post('/automations/meta/connect').set(auth(c.token)).send({ sessionId, pageId: d.id }).expect(200);
    expect(await prisma.integration.count({ where: { clinicId: c.clinicId, provider: 'MESSENGER' } })).toBe(1);
    expect(await prisma.integration.count({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).toBe(0);
    await http().get(`/automations/meta/pending/${sessionId}`).set(auth(c.token)).expect(404);
    // a session that ran out
    const e = await clinic();
    const r2 = await back(grant([a, b]).code, await stateOf(e.token));
    const s2 = new URL(r2.headers.location).searchParams.get('session')!;
    await prisma.metaConnectSession.update({ where: { id: s2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().post('/automations/meta/connect').set(auth(e.token)).send({ sessionId: s2, pageId: a.id }).expect(404);
  });

  it('страницю й акаунт Instagram, уже підключені до іншої клініки, підключити не можна', async () => {
    const a = await clinic();
    const b = await clinic();
    const p = page();
    expect((await back(grant([p]).code, await stateOf(a.token))).headers.location).toContain('meta=ok');
    expect((await back(grant([p]).code, await stateOf(b.token))).headers.location).toContain('meta=taken');
    expect(await prisma.integration.count({ where: { clinicId: b.clinicId, provider: { in: ['INSTAGRAM', 'MESSENGER'] } } })).toBe(0);
  });

  it('повідомлення Instagram приходять на вебхук з об’єктом instagram та id акаунта; відповідь іде токеном сторінки через Facebook, а не старою адресою Instagram', async () => {
    const c = await clinic();
    const p = page();
    await back(grant([p]).code, await stateOf(c.token));
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: p.igId, messaging: [{ sender: { id: 'u77' }, recipient: { id: p.igId }, message: { mid: `m${rnd()}`, text: 'Добрий день, хочу записатися' } }] }] });
    await http().post('/instagram/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body).expect(200);
    expect(await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'INSTAGRAM', direction: 'IN' } })).toMatchObject({ chatId: 'u77', contactName: 'Гість u77' });
    await http().post('/conversations/INSTAGRAM/u77/reply').set(auth(c.token)).send({ text: 'Добрий день!' }).expect(200);
    expect(fbSent.at(-1)).toMatchObject({ token: `page-token-${p.id}`, to: 'u77', text: 'Добрий день!' });
    expect(igSent).toHaveLength(0);
  });
});

describe('дозволи конфігурації: канали не залежать один від одного', () => {
  const perms = (scopes: string[]) => ({ scopes });
  const connectAs = async (scopes: string[], p = page()) => {
    const c = await clinic();
    const r = await back(grant([p], perms(scopes)).code, await stateOf(c.token));
    return { c, p, r };
  };
  const has = async (clinicId: string, provider: 'INSTAGRAM' | 'MESSENGER') => prisma.integration.count({ where: { clinicId, provider } });

  it('без pages_messaging підключається Instagram, а Messenger ні; сторінка підписується лише на messages, без заявок реклами', async () => {
    const { c, p, r } = await connectAs(['instagram_basic', 'instagram_manage_messages', 'pages_show_list']);
    expect(r.headers.location).toContain('meta=ok_instagram');
    expect(await has(c.clinicId, 'INSTAGRAM')).toBe(1);
    expect(await has(c.clinicId, 'MESSENGER')).toBe(0);
    expect(loginFake.subscribed.map((s) => s.fields)).toEqual(['messages']);
    expect((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).config).toMatchObject({ ownId: p.igId, pageId: p.id, mode: 'FACEBOOK_LOGIN' });
    const st = (await http().get('/automations').set(auth(c.token))).body.instagram;
    expect(st).toMatchObject({ connected: true, via: 'facebook' });
    expect((await http().get('/automations/channels').set(auth(c.token))).body.messenger.connected).toBe(false);
    // Instagram works without Messenger: a message comes in and the reply goes by the page token
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: p.igId, messaging: [{ sender: { id: 'u5' }, recipient: { id: p.igId }, message: { mid: `m${rnd()}`, text: 'Привіт' } }] }] });
    await http().post('/instagram/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body).expect(200);
    await http().post('/conversations/INSTAGRAM/u5/reply').set(auth(c.token)).send({ text: 'Добрий день' }).expect(200);
    expect(fbSent.at(-1)).toMatchObject({ token: `page-token-${p.id}`, to: 'u5' });
  });

  it('відмова у підписці на повідомлення сторінки без pages_messaging не ламає підключення Instagram, а лише записується', async () => {
    flags.subscribeDenied = true;
    try {
      const { c, r } = await connectAs(['instagram_manage_messages']);
      expect(r.headers.location).toContain('meta=ok_instagram');
      expect((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).config).toMatchObject({ subscribeWarning: expect.stringContaining('permission') });
    } finally {
      flags.subscribeDenied = false;
    }
  });

  it('лише pages_messaging: підключається Messenger, а Instagram ні, навіть якщо до сторінки прив’язаний акаунт', async () => {
    const { c, r } = await connectAs(['pages_messaging']);
    expect(r.headers.location).toContain('meta=ok');
    expect(await has(c.clinicId, 'MESSENGER')).toBe(1);
    expect(await has(c.clinicId, 'INSTAGRAM')).toBe(0);
    expect(loginFake.subscribed.map((s) => s.fields)).toEqual(['messages,messaging_postbacks']);
  });

  it('без жодного з двох дозволів на повідомлення, або коли у сторінки немає Instagram, а Messenger не дозволено, нічого не підключається й пояснюється чому', async () => {
    const none = await connectAs(['pages_show_list', 'instagram_basic']);
    expect(none.r.headers.location).toContain('meta=noperm');
    expect(await has(none.c.clinicId, 'INSTAGRAM') + (await has(none.c.clinicId, 'MESSENGER'))).toBe(0);
    const noIg = await connectAs(['instagram_manage_messages'], page({ igId: null, igUsername: null }));
    expect(noIg.r.headers.location).toContain('meta=noperm');
    expect(await has(noIg.c.clinicId, 'INSTAGRAM') + (await has(noIg.c.clinicId, 'MESSENGER'))).toBe(0);
  });

  it('заявки з рекламних форм працюють і через підключення Instagram, якщо Messenger не дозволено, але є leads_retrieval', async () => {
    const { c, p } = await connectAs(['instagram_manage_messages', 'leads_retrieval']);
    expect(loginFake.subscribed.map((s) => s.fields)).toEqual(['messages', 'messages,leadgen']);
    const body = JSON.stringify({ object: 'page', entry: [{ id: p.id, changes: [{ field: 'leadgen', value: { leadgen_id: `lg${rnd()}`, page_id: p.id } }] }] });
    await http().post('/messenger/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body).expect(200);
    // the lead is looked up through the Instagram connection of this page (the fake knows no such lead id, so it waits for a retry)
    expect(await prisma.inboundEvent.count({ where: { clinicId: c.clinicId, channel: 'LEADGEN' } })).toBe(1);
  });

  it('вибір зі списку: у відповіді видно, що підключено', async () => {
    const c = await clinic();
    const [a, b] = [page(), page()];
    const g = grant([a, b], { scopes: ['instagram_manage_messages'] });
    const r = await back(g.code, await stateOf(c.token));
    const session = new URL(r.headers.location).searchParams.get('session')!;
    const done = (await http().post('/automations/meta/connect').set(auth(c.token)).send({ sessionId: session, pageId: a.id }).expect(200)).body;
    expect(done).toMatchObject({ page: a.name, instagram: a.igUsername, messenger: false, leads: false });
  });
});

describe('життя токена', () => {
  it('токен, що не спливає, не оновлюється за розкладом; перевірка раз на кілька годин мовчить, поки токен чинний', async () => {
    const c = await clinic();
    const p = page();
    await back(grant([p]).code, await stateOf(c.token));
    const mails = mailsTo(c.email);
    await app.get(MetaLoginService).checkTokens();
    await app.get(InstagramService).refreshDue(Date.now() + 365 * 86_400_000);
    // other clinics of the shared test database may have older connections: only this clinic's token matters
    const storedToken = decrypt((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).apiKeyEnc!);
    expect(ig.refreshLongLived.mock.calls.map((x) => x[0])).not.toContain(storedToken);
    expect(mailsTo(c.email)).toBe(mails);
    expect(((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).config as { tokenProblem?: string | null }).tokenProblem ?? null).toBeNull();
  });

  it('відкликаний або такий, що скоро закінчується, токен: підключення помічається, власник отримує один лист, нічого не оновлюється мовчки; після виправлення помітка знімається', async () => {
    const c = await clinic();
    const p = page();
    await back(grant([p]).code, await stateOf(c.token));
    const stored = decrypt((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).apiKeyEnc!);
    const problem = async (provider: 'INSTAGRAM' | 'MESSENGER') => ((await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider } })).config as { tokenProblem?: string | null }).tokenProblem;
    // the page token is revoked: the page and the Instagram account share it, the owner gets one letter
    tokens[stored] = { isValid: false, type: 'PAGE', expiresAt: null, scopes: [], pageIds: [] };
    const before = mailsTo(c.email);
    await app.get(MetaLoginService).checkTokens();
    await app.get(MetaLoginService).checkTokens();
    expect(mailsTo(c.email)).toBe(before + 1);
    expect(mail.outbox.at(-1)).toMatchObject({ to: c.email });
    expect(await problem('INSTAGRAM')).toBe('invalid');
    expect(await problem('MESSENGER')).toBe('invalid');
    expect((await http().get('/automations').set(auth(c.token))).body.instagram.tokenProblem).toBe('invalid');
    // a token that has an end date (a login configured for a short-lived token) is reported before it ends, not renewed
    tokens[stored] = { isValid: true, type: 'USER', expiresAt: Date.now() + 3 * 86_400_000, scopes: [], pageIds: [] };
    await app.get(MetaLoginService).checkTokens();
    expect(await problem('INSTAGRAM')).toBe('expiring');
    expect(mailsTo(c.email)).toBe(before + 2);
    expect(ig.refreshLongLived.mock.calls.map((x) => x[0])).not.toContain(stored);
    // fixed (the clinic connected again or the token is fine): the mark goes away
    tokens[stored] = { isValid: true, type: 'SYSTEM_USER', expiresAt: null, scopes: [], pageIds: [] };
    await app.get(MetaLoginService).checkTokens();
    expect(await problem('INSTAGRAM')).toBeNull();
    expect(mailsTo(c.email)).toBe(before + 2);
  });

  it('підключення інших клінік і старого способу Instagram Login перевіркою не зачіпаються', async () => {
    const c = await clinic();
    await prisma.integration.create({ data: { clinicId: c.clinicId, provider: 'INSTAGRAM', apiKeyEnc: encryptForTest('legacy-token'), config: { ownId: `old${rnd()}`, expiresAt: Date.now() + 300 * 86_400_000 } } });
    const before = mailsTo(c.email);
    await app.get(MetaLoginService).checkTokens();
    expect(mailsTo(c.email)).toBe(before);
    const cfg = (await prisma.integration.findFirstOrThrow({ where: { clinicId: c.clinicId, provider: 'INSTAGRAM' } })).config as { tokenProblem?: unknown };
    expect(cfg.tokenProblem).toBeUndefined();
    await prisma.integration.deleteMany({ where: { clinicId: c.clinicId } });
  });
});
