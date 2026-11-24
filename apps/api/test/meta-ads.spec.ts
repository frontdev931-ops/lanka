import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AdAccountInfo, InsightRow, MetaAdsApi, MetaAdsError } from '../src/ads/meta-ads.api';
import { dayStartUtc, MetaAdsService, todayIn } from '../src/ads/meta-ads.service';
import { MetaLoginApi } from '../src/automations/meta-login.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

// Meta is faked: no live ad account, no live token, nothing leaves the machine
const TOKEN = 'fake-ads-token-never-real';
const login = {
  scopes: ['ads_read'] as string[],
  exchangeCode: async () => ({ accessToken: TOKEN, expiresIn: null }),
  debugToken: async () => ({ isValid: true, type: 'USER', expiresAt: null, scopes: login.scopes, pageIds: [] }),
};
const ads = {
  accounts: [
    { accountId: '111', name: 'Кабінет А', currency: 'USD', timezoneName: 'America/Los_Angeles', status: 1 },
    { accountId: '222', name: 'Кабінет Б', currency: 'UAH', timezoneName: 'Europe/Kyiv', status: 1 },
  ] as AdAccountInfo[],
  daily: [] as InsightRow[],
  accReach: 0,
  campReach: [] as InsightRow[],
  fail: null as MetaAdsError | null,
  calls: [] as Record<string, string>[],
  adAccounts: async () => ads.accounts,
  account: async (_t: string, id: string) => {
    if (ads.fail) throw ads.fail;
    return ads.accounts.find((a) => a.accountId === id)!;
  },
  insights: async (_t: string, _id: string, p: Record<string, string>) => {
    if (ads.fail) throw ads.fail;
    ads.calls.push(p);
    if (p.level === 'account') return [{ reach: String(ads.accReach) }];
    if (!p.time_increment) return ads.campReach;
    const r = JSON.parse(p.time_range) as { since: string; until: string };
    return ads.daily.filter((d) => d.date_start! >= r.since && d.date_start! <= r.until);
  },
};

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MetaAdsApi).useValue(ads).overrideProvider(MetaLoginApi).useValue(login).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  process.env.META_APP_ID = 'app-id-test';
  process.env.META_APP_SECRET = 'app-secret-test';
  process.env.META_ADS_CONFIG_ID = 'ads-config-test';
  process.env.META_CONFIG_ID = 'instagram-config-test';
  login.scopes = ['ads_read'];
  ads.fail = null;
  ads.calls = [];
});

async function clinic() {
  const email = `ad${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Реклама ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  return { token: res.body.accessToken as string, clinicId: user.memberships[0].clinicId };
}
async function member(ownerToken: string, role: string) {
  const email = `adm${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: role, password: PASSWORD }).expect(201)).body.accessToken as string;
}
// the whole login: the owner's dialog address, Facebook's return with the signed state, the choice of an account
async function connect(owner: string, accountId = '111') {
  const url = (await http().get('/meta-ads/connect-url').set(auth(owner)).expect(200)).body.url as string;
  const state = new URL(url).searchParams.get('state')!;
  const back = await http().get(`/meta-ads/oauth/callback?code=abc&state=${encodeURIComponent(state)}`).expect(302);
  const s = new URL(back.headers.location).searchParams.get('s')!;
  await http().post('/meta-ads/select').set(auth(owner)).send({ sessionId: s, accountId }).expect(200);
}
const lastAttemptBack = (clinicId: string) => prisma.adAccountLink.update({ where: { clinicId }, data: { lastAttemptAt: new Date(Date.now() - 10 * 60_000) } });

describe('аналітика реклами Meta, етап 1', () => {
  it('без налаштування платформи — зрозумілий стан, без кнопки входу; окрема конфігурація входу, не Instagram', async () => {
    const c = await clinic();
    delete process.env.META_ADS_CONFIG_ID;
    expect((await http().get('/meta-ads').set(auth(c.token)).expect(200)).body).toMatchObject({ platformReady: false, account: null });
    await http().get('/meta-ads/connect-url').set(auth(c.token)).expect(400);
    process.env.META_ADS_CONFIG_ID = 'ads-config-test';
    const url = new URL((await http().get('/meta-ads/connect-url').set(auth(c.token)).expect(200)).body.url);
    expect(url.searchParams.get('config_id')).toBe('ads-config-test');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/backend\/meta-ads\/oauth\/callback$/);
    // a state of the Instagram/Messenger login is not accepted here
    const back = await http().get('/meta-ads/oauth/callback?code=abc&state=forged.state').expect(302);
    expect(back.headers.location).toMatch(/\/ads\?meta=fail$/);
  });

  it('підключення: лише власник; потрібен ads_read; вибір кабінету; токен не віддається; відключення', async () => {
    const c = await clinic();
    const manager = await member(c.token, 'MANAGER');
    await http().get('/meta-ads/connect-url').set(auth(manager)).expect(403);
    // no ads_read in the token: refused
    login.scopes = ['pages_messaging'];
    const url = (await http().get('/meta-ads/connect-url').set(auth(c.token))).body.url as string;
    const noperm = await http().get(`/meta-ads/oauth/callback?code=abc&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`).expect(302);
    expect(noperm.headers.location).toMatch(/meta=noperm/);
    login.scopes = ['ads_read'];
    await connect(c.token, '111');
    const st = (await http().get('/meta-ads').set(auth(manager)).expect(200)).body;
    expect(st.account).toMatchObject({ accountId: '111', currency: 'USD', timezoneName: 'America/Los_Angeles', state: 'ACTIVE' });
    expect(st.canManage).toBe(false);
    expect(JSON.stringify(st)).not.toContain(TOKEN);
    expect((await prisma.adAccountLink.findUniqueOrThrow({ where: { clinicId: c.clinicId } })).tokenEnc).not.toContain(TOKEN);
    await http().delete('/meta-ads').set(auth(manager)).expect(403);
    await http().delete('/meta-ads').set(auth(c.token)).expect(200);
    expect((await http().get('/meta-ads').set(auth(c.token))).body.account).toBeNull();
  });

  it('статистика: охоплення за період від Meta (не сума), результати окремо, вартість = витрати / кількість, «не повідомлено» ≠ нуль; валюта й часовий пояс кабінету', async () => {
    const c = await clinic();
    await connect(c.token, '111');
    const today = todayIn('America/Los_Angeles');
    const d1 = new Date(Date.parse(today) - 3 * 86_400_000).toISOString().slice(0, 10);
    const d2 = new Date(Date.parse(today) - 2 * 86_400_000).toISOString().slice(0, 10);
    ads.daily = [
      { campaign_id: 'A', campaign_name: 'Гігієна', date_start: d1, spend: '10.00', impressions: '1000', inline_link_clicks: '20', actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '2' }, { action_type: 'lead', value: '5' }] },
      { campaign_id: 'A', campaign_name: 'Гігієна', date_start: d2, spend: '20.00', impressions: '1500', inline_link_clicks: '30', actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '1' }] },
      { campaign_id: 'B', campaign_name: 'Імплантація', date_start: d2, spend: '15.00', impressions: '800', actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '0' }] },
    ];
    ads.accReach = 1000;
    ads.campReach = [{ campaign_id: 'A', reach: '700' }, { campaign_id: 'B', reach: '600' }];
    const before = (await http().get(`/meta-ads/report?since=${d1}&until=${d2}`).set(auth(c.token)).expect(200)).body;
    expect(before.state).toBe('not_loaded');
    const r = (await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: d1, until: d2 }).expect(200)).body;
    expect(r.state).toBe('loaded');
    expect(r.account).toMatchObject({ currency: 'USD', timezoneName: 'America/Los_Angeles' });
    // reach of the period as Meta gave it, never 700 + 600
    expect(r.totals.reach).toBe(1000);
    expect(r.totals).toMatchObject({ spend: 45, impressions: 3300, linkClicks: 50 });
    // lead forms: 3 (the overlapping plain "lead" of 5 is not read); cost = 45 / 3; messaging and website not reported: null, not 0
    expect(r.totals.results.leadForm).toEqual({ count: 3, cost: 15 });
    expect(r.totals.results.messaging).toEqual({ count: null, cost: null });
    expect(r.totals.results.website).toEqual({ count: null, cost: null });
    const a = r.campaigns.find((x: { campaignId: string }) => x.campaignId === 'A');
    const b = r.campaigns.find((x: { campaignId: string }) => x.campaignId === 'B');
    expect(a).toMatchObject({ name: 'Гігієна', spend: 30, reach: 700, results: { leadForm: { count: 3, cost: 10 } } });
    // zero results: the cost is not shown
    expect(b).toMatchObject({ spend: 15, reach: 600, linkClicks: null, results: { leadForm: { count: 0, cost: null } } });
    // the attribution windows were asked explicitly and the recent days were read again
    const daily = ads.calls.filter((p) => p.time_increment === '1');
    expect(daily.every((p) => p.action_attribution_windows === JSON.stringify(['7d_click', '1d_view']))).toBe(true);
    const ranges = daily.map((p) => JSON.parse(p.time_range) as { since: string; until: string });
    expect(ranges.some((x) => x.until >= today && x.since <= new Date(Date.parse(today) - 27 * 86_400_000).toISOString().slice(0, 10))).toBe(true);
  });

  it('повторне оновлення: перерахунок Meta замінює дні без дублів; занадто часто — відмова; помилка зберігає останні дані з позначкою', async () => {
    const c = await clinic();
    await connect(c.token, '222');
    const today = todayIn('Europe/Kyiv');
    ads.daily = [{ campaign_id: 'C', campaign_name: 'Огляд', date_start: today, spend: '100', impressions: '10', actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '1' }] }];
    ads.accReach = 9;
    ads.campReach = [{ campaign_id: 'C', reach: '9' }];
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(200);
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(429);
    // Meta recounted the day
    ads.daily = [{ campaign_id: 'C', campaign_name: 'Огляд', date_start: today, spend: '120', impressions: '12', actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '2' }] }];
    await lastAttemptBack(c.clinicId);
    const r = (await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(200)).body;
    expect(await prisma.adInsightDay.count({ where: { clinicId: c.clinicId } })).toBe(1);
    expect(r.totals).toMatchObject({ spend: 120, results: { website: { count: 2, cost: 60 } } });
    // a rate limit: the stored figures stay, the error is recorded, the account stays active
    await lastAttemptBack(c.clinicId);
    ads.fail = new MetaAdsError('limit', 'rate_limited', 17);
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(400);
    const kept = (await http().get(`/meta-ads/report?since=${today}&until=${today}`).set(auth(c.token))).body;
    expect(kept).toMatchObject({ state: 'loaded', lastError: 'rate_limited', totals: { spend: 120 } });
    expect((await http().get('/meta-ads').set(auth(c.token))).body.account.state).toBe('ACTIVE');
    // an expired token and a lost permission are told apart
    await lastAttemptBack(c.clinicId);
    ads.fail = new MetaAdsError('expired', 'expired', 190);
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(400);
    expect((await http().get('/meta-ads').set(auth(c.token))).body.account.state).toBe('EXPIRED');
    await lastAttemptBack(c.clinicId);
    ads.fail = new MetaAdsError('perm', 'no_permission', 200);
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: today, until: today }).expect(400);
    expect((await http().get('/meta-ads').set(auth(c.token))).body.account.state).toBe('NO_PERMISSION');
    expect((await http().get(`/meta-ads/report?since=${today}&until=${today}`).set(auth(c.token))).body.totals.spend).toBe(120);
  });

  it('«Отримано в LANKA»: лише з підключеними лід-формами; межі днів у часовому поясі кабінету; без підключення — не нуль', async () => {
    const c = await clinic();
    await connect(c.token, '111');
    const day = '2026-11-10';
    ads.daily = [];
    ads.accReach = 0;
    ads.campReach = [];
    await http().post('/meta-ads/refresh').set(auth(c.token)).send({ since: day, until: day }).expect(200);
    const start = dayStartUtc(day, 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    const lead = (at: Date, campaignId: string) => prisma.inquiry.create({ data: { clinicId: c.clinicId, channel: 'OTHER', via: 'META_LEAD_ADS', externalId: `leadgen:${rnd()}`, createdAt: at, sourceDetails: { source: 'META_LEAD_ADS', campaignId } } });
    await lead(new Date(start.getTime() + 30 * 60_000), 'A'); // 00:30 there: inside
    await lead(new Date(start.getTime() - 30 * 60_000), 'A'); // 23:30 the day before: outside
    await lead(new Date(start.getTime() + 23 * 3_600_000), 'B');
    let r = (await http().get(`/meta-ads/report?since=${day}&until=${day}`).set(auth(c.token))).body;
    expect(r.received).toBeNull();
    await prisma.integration.create({ data: { clinicId: c.clinicId, provider: 'MESSENGER', config: { pageId: 'p', leadsSubscribed: true } } });
    r = (await http().get(`/meta-ads/report?since=${day}&until=${day}`).set(auth(c.token))).body;
    expect(r.received).toEqual({ total: 2, byCampaign: { A: 1, B: 1 } });
  });

  it('ролі й ізоляція: аналітик і керуючий бачать і оновлюють; адміністратор і лікар — ні; інша клініка нічого не бачить і не підставить чужу сесію', async () => {
    const a = await clinic();
    const b = await clinic();
    await connect(a.token, '111');
    const analyst = await member(a.token, 'ANALYST');
    const admin = await member(a.token, 'ADMIN');
    const doctor = await member(a.token, 'DOCTOR');
    const day = todayIn('America/Los_Angeles');
    await http().get(`/meta-ads/report?since=${day}&until=${day}`).set(auth(analyst)).expect(200);
    for (const t of [admin, doctor]) {
      await http().get('/meta-ads').set(auth(t)).expect(403);
      await http().get(`/meta-ads/report?since=${day}&until=${day}`).set(auth(t)).expect(403);
      await http().post('/meta-ads/refresh').set(auth(t)).send({ since: day, until: day }).expect(403);
    }
    expect((await http().get(`/meta-ads/report?since=${day}&until=${day}`).set(auth(b.token))).body).toEqual({ state: 'not_connected' });
    // a session of clinic A cannot be used by clinic B
    const url = (await http().get('/meta-ads/connect-url').set(auth(a.token))).body.url as string;
    const back = await http().get(`/meta-ads/oauth/callback?code=abc&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`).expect(302);
    const s = new URL(back.headers.location).searchParams.get('s')!;
    await http().post('/meta-ads/select').set(auth(b.token)).send({ sessionId: s, accountId: '222' }).expect(404);
    // a period too long or reversed
    await http().get('/meta-ads/report?since=2026-01-01&until=2026-12-31').set(auth(a.token)).expect(400);
    await http().get('/meta-ads/report?since=2026-02-01&until=2026-01-01').set(auth(a.token)).expect(400);
    void app.get(MetaAdsService);
  });
});
