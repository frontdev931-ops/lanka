import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { channelFromUtm } from '../src/automations/leads.service';
import { FacebookApi, MetaApiError } from '../src/automations/meta-graph.api';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const SECRET = 'meta-app-secret-for-tests';
const SITE = 'https://clinic-site.example';
const lead = { field_data: [{ name: 'full_name', values: ['Олена Ковальчук'] }, { name: 'phone_number', values: ['+380507776655'] }], form_id: '555', platform: 'ig' };
const fb = {
  pages: {} as Record<string, { id: string; name: string }>,
  leads: {} as Record<string, typeof lead>,
  failures: 0,
  me: async (t: string) => fb.pages[t],
  profile: async () => ({ name: 'x' }),
  sendMessage: async () => undefined,
  getLead: async (_t: string, id: string) => {
    if (fb.failures > 0) {
      fb.failures--;
      throw new MetaApiError('temporary', 500);
    }
    if (!fb.leads[id]) throw new MetaApiError('not found', 100);
    return fb.leads[id];
  },
};
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_VERIFY_TOKEN = 'v';
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(FacebookApi).useValue(fb).compile()).createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});

async function clinic() {
  const email = `l${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { token: res.body.accessToken as string, clinicId };
}
async function enabled(origins: string[] = [SITE]) {
  const c = await clinic();
  const s = (await http().patch('/automations/leads').set(auth(c.token)).send({ enabled: true, origins }).expect(200)).body;
  return { ...c, key: (s.url as string).split('/leads/')[1], url: s.url as string };
}
const post = (key: string, body: object, origin?: string | null) => {
  const r = http().post(`/leads/${key}`);
  return (origin === null ? r : r.set('Origin', origin ?? SITE)).send(body);
};

describe('заявки з сайту', () => {
  it('налаштування: лише власник і керуючий; адреси перевіряються; ключ видно в адресі', async () => {
    const c = await clinic();
    expect((await http().get('/automations/leads').set(auth(c.token)).expect(200)).body).toMatchObject({ enabled: false, url: null });
    await http().patch('/automations/leads').set(auth(c.token)).send({ origins: ['http://insecure.example'] }).expect(400);
    const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email: `r${rnd()}@example.com`, role: 'ADMIN' }).expect(201);
    const admin = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Адмін', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().patch('/automations/leads').set(auth(admin)).send({ enabled: true }).expect(403);
    const e = await enabled();
    expect(e.url).toMatch(/\/backend\/leads\/[\w-]+$/);
  });

  it('форма з дозволеного сайту стає зверненням з позначками реклами; звичайна форма (form-urlencoded) теж; тієї ж людини двічі поспіль не дублюємо', async () => {
    const e = await enabled();
    const r = await post(e.key, { name: 'Олена', phone: '0507776655', message: 'Хочу на чистку', utm_source: 'instagram', utm_campaign: 'autumn', page: 'https://clinic-site.example/clean' }).expect(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['access-control-allow-origin']).toBe(SITE);
    expect(await prisma.inquiry.findFirstOrThrow({ where: { clinicId: e.clinicId } })).toMatchObject({ channel: 'INSTAGRAM', name: 'Олена', phoneNorm: '380507776655', note: 'Хочу на чистку', utmSource: 'instagram', utmCampaign: 'autumn', landing: 'https://clinic-site.example/clean' });
    await post(e.key, { name: 'Олена', phone: '+380 50 777 66 55', utm_source: 'instagram' }).expect(200); // pressed twice
    expect(await prisma.inquiry.count({ where: { clinicId: e.clinicId } })).toBe(1);
    // a form plugin on a server: a classic form and no Origin
    await http().post(`/leads/${e.key}`).type('form').send({ 'your-name': 'Іван', 'your-phone': '0671112233', 'your-message': 'Ціна імпланта?' }).expect(200);
    expect(await prisma.inquiry.findFirstOrThrow({ where: { clinicId: e.clinicId, phoneNorm: '380671112233' } })).toMatchObject({ channel: 'SITE', name: 'Іван', note: 'Ціна імпланта?' });
    expect((await http().get('/inquiries').set(auth(e.token)).expect(200)).body.rows.length).toBe(2);
  });

  it('звернення зв’язується з карткою за телефоном; воронка бачить джерело', async () => {
    const e = await enabled();
    const p = await prisma.patient.create({ data: { clinicId: e.clinicId, externalId: `p${rnd()}`, fullName: 'Ковальчук Олена', phoneNorm: '380507776655', createdAtExt: new Date(Date.now() + 3_600_000) } });
    await post(e.key, { name: 'Олена', phone: '0507776655', utm_source: 'google' }).expect(200);
    expect(await prisma.inquiry.findFirstOrThrow({ where: { clinicId: e.clinicId } })).toMatchObject({ channel: 'GOOGLE', patientId: p.id });
  });

  it('захист: чужий сайт, невірний ключ, вимкнено, призупинена клініка; порожня заявка; пастка для роботів', async () => {
    const e = await enabled();
    expect((await post(e.key, { phone: '0501112233' }, 'https://evil.example').expect(404)).headers['access-control-allow-origin']).toBeUndefined();
    await post('wrong-key', { phone: '0501112233' }).expect(404);
    await post(e.key, {}).expect(400);
    await post(e.key, { name: 'Бот', phone: '0501112233', website: 'http://spam.example' }).expect(200);
    expect(await prisma.inquiry.count({ where: { clinicId: e.clinicId } })).toBe(0); // the robot trap swallows it silently
    const pre = await http().options(`/leads/${e.key}`).set('Origin', SITE).expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe(SITE);
    expect((await http().options(`/leads/${e.key}`).set('Origin', 'https://evil.example').expect(204)).headers['access-control-allow-origin']).toBeUndefined();
    await prisma.clinic.update({ where: { id: e.clinicId }, data: { suspendedAt: new Date() } });
    await post(e.key, { phone: '0501112233' }).expect(403);
    await prisma.clinic.update({ where: { id: e.clinicId }, data: { suspendedAt: null } });
    await http().patch('/automations/leads').set(auth(e.token)).send({ enabled: false }).expect(200);
    await post(e.key, { phone: '0501112233' }).expect(404);
    const r = await http().post('/automations/leads/rotate-key').set(auth(e.token)).expect(200);
    expect(r.body.url).not.toContain(e.key);
  });

  it('мітки реклами визначають канал', () => {
    expect(channelFromUtm('Instagram')).toBe('INSTAGRAM');
    expect(channelFromUtm('fb')).toBe('INSTAGRAM');
    expect(channelFromUtm('google')).toBe('GOOGLE');
    expect(channelFromUtm('newsletter')).toBe('SITE');
    expect(channelFromUtm(undefined, 'OTHER')).toBe('OTHER');
  });
});

describe('рекламні форми Meta (Lead Ads)', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const hook = (pageId: string, leadgenId: string, signed = true) => {
    const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: '555' } }] }] });
    const r = http().post('/messenger/webhook').set('Content-Type', 'application/json');
    return (signed ? r.set('X-Hub-Signature-256', sign(body)) : r).send(body);
  };
  async function withPage() {
    const c = await clinic();
    const token = `FBPAGE${rnd()}_0123456789abcdef`;
    const pageId = `page${rnd()}`;
    fb.pages[token] = { id: pageId, name: 'Сторінка' };
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'PRO' } });
    await http().post('/automations/messenger').set(auth(c.token)).send({ token }).expect(200);
    return { ...c, pageId };
  }

  it('заявка з рекламної форми потрапляє у звернення з каналом платформи; повторна доставка не дублює; без підпису ігнорується', async () => {
    const c = await withPage();
    const id = `lg${rnd()}`;
    fb.leads[id] = lead;
    await hook(c.pageId, id, false).expect(200);
    expect(await prisma.inquiry.count({ where: { clinicId: c.clinicId } })).toBe(0);
    await hook(c.pageId, id).expect(200);
    await hook(c.pageId, id).expect(200);
    const rows = await prisma.inquiry.findMany({ where: { clinicId: c.clinicId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'INSTAGRAM', name: 'Олена Ковальчук', phoneNorm: '380507776655', utmSource: 'meta_lead_ads', utmCampaign: 'form 555', externalId: `leadgen:${id}` });
  });

  it('збій отримання заявки не губить її: повторюється з паузами; чужа сторінка не потрапляє в іншу клініку', async () => {
    const c = await withPage();
    const other = await withPage();
    const id = `lg${rnd()}`;
    fb.leads[id] = { ...lead, platform: 'fb' };
    fb.failures = 1;
    await hook(c.pageId, id).expect(200);
    expect(await prisma.inquiry.count({ where: { clinicId: c.clinicId } })).toBe(0);
    const ev = await prisma.inboundEvent.findFirstOrThrow({ where: { clinicId: c.clinicId, channel: 'LEADGEN' } });
    expect(ev).toMatchObject({ status: 'PENDING', attempts: 1 });
    await prisma.inboundEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await app.get((await import('../src/automations/inbound.service')).InboundService).retryDue();
    expect(await prisma.inquiry.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ channel: 'OTHER' });
    expect(await prisma.inquiry.count({ where: { clinicId: other.clinicId } })).toBe(0);
  });
});
