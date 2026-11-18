import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AiService } from '../src/ai/ai.service';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { BillingService } from '../src/billing/billing.service';
import { DIAGNOSTIC_AUDIT_PREFIX, DIAGNOSTIC_WEBHOOK, MONO_DIAGNOSTIC } from '../src/billing/mono-diagnostic';
import type { MonoStatus } from '../src/billing/mono';
import { monoFixture } from './mono-fixture';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { pinPlatformFixture } from './platform-fixture';

jest.setTimeout(60_000);

const mono = monoFixture();
let restoreMono: () => void;
const llm = { configured: true, complete: async () => ({ text: 'ok', inputTokens: 5, outputTokens: 5 }) };
let app: INestApplication;
let prisma: PrismaService;
let billing: BillingService;
let ai: AiService;
let mail: MailService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  restoreMono = mono.install();
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(llm).compile()).createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  billing = app.get(BillingService);
  ai = app.get(AiService);
  mail = app.get(MailService);
});

afterAll(async () => {
  delete process.env.BILLING_ENFORCED;
  await app.close();
  restoreMono?.();
});

async function clinic() {
  const email = `b${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // test clinics start unpaid, like real ones
  return { token: res.body.accessToken as string, clinicId, email };
}

const webhook = (event: MonoStatus, valid = true) => {
  // Whitespace is part of the signed data.
  const raw = JSON.stringify(event, null, 2);
  return http().post('/billing/mono/webhook').set('Content-Type', 'application/json').set('X-Sign', mono.signature(raw, valid)).send(raw);
};
const pay = (orderId: string, amountMinor: number, status: MonoStatus['status'] = 'success', over: Partial<MonoStatus> = {}, valid = true) =>
  webhook(mono.event(orderId, amountMinor, status, over), valid);
const checkoutOrder = async (token: string, plan = 'START') => {
  const r = await http().post('/billing/checkout').set(auth(token)).send({ plan }).expect(200);
  const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id: r.body.id } });
  return { form: r.body, params: mono.invoices.get(order.orderId)!, orderId: order.orderId, amountMinor: order.amountMinor, id: order.id };
};
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};

describe('mono diagnostic', () => {
  const path = '/platform/mono-diagnostic';
  const flag = process.env.MONO_DIAGNOSTIC_ENABLED;
  let owner: Awaited<ReturnType<typeof clinic>>;
  let restoreOwner: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    process.env.MONO_DIAGNOSTIC_ENABLED = 'true';
    owner = await clinic();
    restoreOwner = await pinPlatformFixture(prisma, owner.email);
  });

  afterEach(async () => {
    await restoreOwner?.();
    restoreOwner = undefined;
    if (flag === undefined) delete process.env.MONO_DIAGNOSTIC_ENABLED;
    else process.env.MONO_DIAGNOSTIC_ENABLED = flag;
  });

  it('allows only the pinned platform owner and defaults to disabled for checkout', async () => {
    const other = await clinic(); // Even an allowlisted clinic owner is not the pinned owner.
    process.env.PLATFORM_ADMIN_EMAILS += ',' + other.email;
    for (const [method, route] of [['get', path], ['post', path + '/checkout'], ['get', path + '/unavailable-id']] as const) {
      await http()[method](route).expect(401);
      await http()[method](route).set(auth(other.token)).expect(403);
    }
    delete process.env.MONO_DIAGNOSTIC_ENABLED;
    await http().get(path).set(auth(owner.token)).expect(200, { enabled: false, configured: true, paymentId: null });
    await http().post(path + '/checkout').set(auth(owner.token)).expect(404);
    expect(await prisma.billingPayment.count({ where: { clinicId: owner.clinicId } })).toBe(0);
  });

  it('opens and reuses the exact bank checkout URL — mono diagnostic navigation', async () => {
    const pageUrl = 'https://pay.monobank.ua/checkout/opaque-link?source=acquiring%2Ftest';
    const invoiceCount = mono.invoices.size;
    mono.pageUrlNext(pageUrl);
    const checkout = () => http().post(path + '/checkout').set(auth(owner.token)).expect(200);
    const { body: first } = await checkout();
    expect(first.url).toBe(pageUrl);
    const invoice = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(invoice.monoPageUrl).toBe(pageUrl);
    expect(invoice.monoInvoiceId).not.toContain('opaque-link');
    await checkout().expect(200, first);
    await http().get(path + '/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PENDING', url: pageUrl }));
    expect(mono.invoices.size).toBe(invoiceCount + 1);

    await prisma.billingPayment.update({ where: { id: first.id }, data: { monoExpiresAt: new Date(Date.now() - 1000) } });
    await http().get(path + '/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ url: null }));
  });

  it.each([
    'https://pay.monobank.ua.example.test/checkout',
    'http://pay.monobank.ua/checkout',
    'https://user@pay.monobank.ua/checkout',
  ])('keeps the invoice for reconciliation without offering an unsafe URL %s — mono diagnostic navigation', async (pageUrl) => {
    mono.pageUrlNext(pageUrl);
    const invoiceCount = mono.invoices.size;
    const checkout = () => http().post(path + '/checkout').set(auth(owner.token)).expect(200);
    const { body: first } = await checkout();
    expect(first.url).toBeNull();
    const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(order).toMatchObject({ monoInvoiceId: expect.any(String), monoPageUrl: null });
    await checkout().expect(200, first);
    await http().get(path + '/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PENDING', url: null, diagnostic: { checkoutLinkUnavailable: true } }));
    expect(mono.invoices.size).toBe(invoiceCount + 1);
  });

  it('prices on the server, reuses concurrent checkout requests, and records a signed payment exactly once without entitlements', async () => {
    const before = await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } });
    const messages = mail.outbox.length;
    const originalInvoiceCount = mono.invoices.size;
    const checkout = () => http().post(path + '/checkout').set(auth(owner.token)).send({ amountMinor: 499000, ccy: 840, plan: 'PRO', clinicId: 'another-clinic' }).expect(200);
    const [first, repeated] = await Promise.all([checkout(), checkout()]);
    expect(first.body.id).toBe(repeated.body.id);
    expect(mono.invoices.size).toBe(originalInvoiceCount + 1);
    const id = first.body.id;
    const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id } });
    expect(order).toMatchObject({
      kind: MONO_DIAGNOSTIC, clinicId: owner.clinicId, networkId: null, plan: null, amountMinor: 100, currency: 980,
      periodFrom: null, periodTo: null, setupMinor: 0, packReplies: 0,
    });
    const invoice = mono.invoices.get(order.orderId);
    expect(invoice).toMatchObject({
      amount: 100, ccy: 980, paymentType: 'debit',
      merchantPaymInfo: { destination: 'LANKA — перевірка оплати', basketOrder: [{ sum: 100, total: 100 }] },
    });
    expect(new URL(invoice!.redirectUrl).pathname).toBe('/platform');
    expect(new URL(invoice!.redirectUrl).searchParams.get('diagnosticPayment')).toBe(id);
    expect(invoice!.webHookUrl).toContain('/backend/billing/mono/webhook');
    await http().get('/billing/payments/' + id).set(auth(owner.token)).expect(404);
    await http().get('/billing').set(auth(owner.token)).expect(200).expect(({ body }) => expect(body).toMatchObject({ payments: [], pendingPaymentId: null }));
    await http().get(path + '/' + id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PENDING', diagnostic: { invoiceId: order.monoInvoiceId, webhookReceivedAt: null } }));

    const event = mono.event(order.orderId, 100);
    await webhook(event, false).expect(400);
    await webhook({ ...event, ccy: 840 }).expect(200);
    await webhook({ ...event, amount: 101 }).expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: DIAGNOSTIC_WEBHOOK } })).toBe(0);

    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PAID', paidAt: new Date(event.modifiedDate) });
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: DIAGNOSTIC_AUDIT_PREFIX + 'paid' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: DIAGNOSTIC_WEBHOOK } })).toBe(1);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).toEqual(before);
    expect(mail.outbox).toHaveLength(messages);
    await http().get('/clinic/audit').set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body.rows.every((row: { action: string }) => !row.action.startsWith(DIAGNOSTIC_AUDIT_PREFIX))).toBe(true));

    process.env.MONO_DIAGNOSTIC_ENABLED = 'false';
    await http().post(path + '/checkout').set(auth(owner.token)).expect(404);
    await http().get(path).set(auth(owner.token)).expect(200).expect(({ body }) => expect(body.paymentId).toBe(id));
    await http().get(path + '/' + id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PAID', url: null, diagnostic: { invoiceId: order.monoInvoiceId, webhookReceivedAt: expect.any(String) } }));
  });

  it('distinguishes status reconciliation from late signed webhook delivery after a create timeout', async () => {
    mono.failNext('unknown');
    const { body: first } = await http().post(path + '/checkout').set(auth(owner.token)).expect(200);
    expect(first.url).toBeNull();
    await http().post(path + '/checkout').set(auth(owner.token)).expect(200, first);
    const order = await prisma.billingPayment.update({
      where: { id: first.id }, data: { createdAt: new Date(Date.now() - 120_000) },
    });
    const lateWebhook = mono.event(order.orderId, 100);
    mono.report(mono.event(order.orderId, 100), true);
    const status = path + '/' + first.id;
    await http().get(status).set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body).toMatchObject({ status: 'PAID', diagnostic: { webhookReceivedAt: null } }));

    process.env.MONO_DIAGNOSTIC_ENABLED = 'false';
    await webhook(lateWebhook).expect(200);
    await http().get(status).set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body).toMatchObject({ status: 'PAID', diagnostic: { webhookReceivedAt: expect.any(String) } }));
  });
});

describe('підписка та оплата', () => {
  it('нова клініка чекає оплати; перша оплата = підключення (4 990 грн) + місяць тарифу; після неї клініка активна', async () => {
    const c = await clinic();
    const o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ configured: true, status: 'AWAITING_PAYMENT', setupPaid: false, setupUah: 4990, pack: { replies: 500, priceUah: 390 } });
    expect(o.plans.map((p: { key: string; priceUah: number }) => [p.key, p.priceUah])).toEqual([['START', 1990], ['PRO', 3990]]);

    const { form, params, orderId, amountMinor } = await checkoutOrder(c.token);
    expect(form.url).toBe('https://pay.mbnk.biz/mono-' + orderId);
    expect(params).toMatchObject({ ccy: 980, paymentType: 'debit', amount: 698000, validity: 900 });
    expect(params.merchantPaymInfo.basketOrder.map((item) => item.sum)).toEqual([199000, 499000]);
    expect(params.webHookUrl).toContain('/backend/billing/mono/webhook');
    expect(params.redirectUrl).toContain('/settings?tab=billing&payment=');
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { orderId } })).toMatchObject({
      monoInvoiceId: 'mono-' + orderId, currency: 980, setupMinor: 499000, periodFrom: expect.any(Date), periodTo: expect.any(Date),
    });

    await pay(orderId, amountMinor).expect(200);
    const cl = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(cl).toMatchObject({ billingStatus: 'ACTIVE', plan: 'START', aiMonthlyLimit: 500 });
    expect(cl.setupPaidAt).not.toBeNull();
    expect(cl.paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect(mail.outbox.at(-1)).toMatchObject({ to: c.email });

    // a repeated callback changes nothing
    const until = cl.paidUntil!.getTime();
    await pay(orderId, amountMinor).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil!.getTime()).toBe(until);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);

    // the next order has no setup fee and renewing early extends the paid month
    const next = await checkoutOrder(c.token, 'PRO');
    expect(next.amountMinor).toBe(399000);
    await pay(next.orderId, next.amountMinor).expect(200);
    const after = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(after.plan).toBe('PRO');
    expect(after.aiMonthlyLimit).toBe(3000);
    expect(after.paidUntil!.getTime()).toBeGreaterThan(until + 27 * 86_400_000);
    expect((await http().get('/billing').set(auth(c.token))).body.payments).toHaveLength(2);
  });

  it('підпис, сума і валюта перевіряються; невдалий платіж нічого не відкриває', async () => {
    const c = await clinic();
    const { orderId, amountMinor } = await checkoutOrder(c.token);
    await pay(orderId, amountMinor, 'success', {}, false).expect(400);
    await http().post('/billing/mono/webhook').send({}).expect(400);
    await pay(orderId, amountMinor - 100).expect(200); // wrong amount: ignored
    await pay(orderId, amountMinor, 'success', { ccy: 840 }).expect(200);
    await pay('unknown-order', amountMinor).expect(200);
    await pay(orderId, amountMinor, 'processing').expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('AWAITING_PAYMENT');
    await pay(orderId, amountMinor, 'failure').expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId } })).status).toBe('FAILED');
    // a failed order can still be paid later (the person retries on the hosted page)
    await pay(orderId, amountMinor).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('ACTIVE');
  });

  it('платить може лише власник; історію бачить керуючий; чужа клініка історії не бачить', async () => {
    const c = await clinic();
    const other = await clinic();
    const manager = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    await http().post('/billing/checkout').set(auth(manager)).send({ plan: 'START' }).expect(403);
    await http().get('/billing').set(auth(manager)).expect(200);
    await http().get('/billing').set(auth(admin)).expect(403);
    await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'CUSTOM' }).expect(400);
    const { orderId, amountMinor } = await checkoutOrder(c.token);
    await pay(orderId, amountMinor).expect(200);
    expect((await http().get('/billing').set(auth(other.token))).body.payments).toHaveLength(0);
  });

  it('без токена mono оплата недоступна', async () => {
    const c = await clinic();
    const key = process.env.MONO_ACQUIRING_TOKEN;
    delete process.env.MONO_ACQUIRING_TOKEN;
    try {
      await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'START' }).expect(503);
      expect((await http().get('/billing').set(auth(c.token))).body.configured).toBe(false);
    } finally {
      process.env.MONO_ACQUIRING_TOKEN = key;
    }
  });
});

describe('доступ до даних залежить від оплати', () => {
  beforeAll(() => {
    process.env.BILLING_ENFORCED = 'true';
  });
  afterAll(() => {
    delete process.env.BILLING_ENFORCED;
  });

  it('до оплати відкриті лише вхід, оплата і тариф; після оплати все працює; після пільгових днів доступ закривається, дані лишаються', async () => {
    const c = await clinic();
    await http().get('/patients').set(auth(c.token)).expect(403);
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(403);
    await http().get('/billing').set(auth(c.token)).expect(200);
    await http().get('/service/usage').set(auth(c.token)).expect(200);
    const me = (await http().get('/auth/me').set(auth(c.token)).expect(200)).body;
    expect(me.billing).toMatchObject({ status: 'AWAITING_PAYMENT', blocked: true });

    const { orderId, amountMinor } = await checkoutOrder(c.token);
    await pay(orderId, amountMinor).expect(200);
    await http().get('/patients').set(auth(c.token)).expect(200);
    expect((await http().get('/auth/me').set(auth(c.token))).body.billing).toMatchObject({ status: 'ACTIVE', blocked: false });

    // the paid month ended: grace days keep access, a reminder goes out once
    const ended = new Date(Date.now() - 86_400_000);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { paidUntil: ended } });
    const mails = mail.outbox.length;
    await billing.tick();
    await billing.tick();
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('PAST_DUE');
    expect(mail.outbox.length).toBe(mails + 1);
    await http().get('/patients').set(auth(c.token)).expect(200);

    // grace is over
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { paidUntil: new Date(Date.now() - 6 * 86_400_000) } });
    await billing.tick();
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('LAPSED');
    await http().get('/patients').set(auth(c.token)).expect(403);
    expect(await prisma.patient.count({ where: { clinicId: c.clinicId } })).toBeGreaterThanOrEqual(0);

    // paying again restores access at once
    const again = await checkoutOrder(c.token);
    await pay(again.orderId, again.amountMinor).expect(200);
    await http().get('/patients').set(auth(c.token)).expect(200);
  });

  it('демо-клініка не блокується', async () => {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { isDemo: true } });
    await http().get('/patients').set(auth(c.token)).expect(200);
  });
});

describe('відповіді ШІ: включені, куплені, ліміт', () => {
  async function paid(plan = 'START') {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan, billingStatus: 'ACTIVE', aiEnabled: true, aiMonthlyLimit: 2, periodStartsAt: new Date(Date.now() - 1000) } });
    return c;
  }
  const call = (clinicId: string, billable = true) => ai.complete(clinicId, 'chat_draft', 's', [{ role: 'user', content: 'x' }], 50, 'chat', billable);

  it('спочатку тратяться включені, потім куплені; з нуля ШІ відмовляє без боргу; повтор запиту не рахується', async () => {
    const c = await paid();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiPurchased: 2 } });
    await call(c.clinicId);
    await call(c.clinicId, false); // a retry of the same request is free
    await call(c.clinicId);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiPurchased: 2 });
    await call(c.clinicId); // included are used up: a bought reply is spent
    await call(c.clinicId);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).aiPurchased).toBe(0);
    await expect(call(c.clinicId)).rejects.toMatchObject({ message: 'ai_limit' });
    const o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o.ai).toMatchObject({ included: 2, used: 4, purchased: 0, remaining: 0 });
  });

  it('новий оплачений місяць оновлює включені відповіді, куплені переносяться', async () => {
    const c = await paid();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiPurchased: 7 } });
    await call(c.clinicId);
    await call(c.clinicId);
    await expect(call(c.clinicId)).resolves.toBeDefined(); // a bought one
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).aiPurchased).toBe(6);
    const { orderId, amountMinor } = await checkoutOrder(c.token);
    await pay(orderId, amountMinor).expect(200);
    const o = (await http().get('/billing').set(auth(c.token))).body;
    expect(o.ai).toMatchObject({ included: 500, used: 0, purchased: 6 });
  });

  it('пакет 500 відповідей: купити можна лише в активній клініці, зараховується один раз, є місячна межа', async () => {
    const c = await clinic();
    await http().post('/billing/ai-pack').set(auth(c.token)).expect(400); // not paid yet
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { billingStatus: 'ACTIVE', aiPackCapPerMonth: 1, periodStartsAt: new Date(Date.now() - 1000) } });
    const r = await http().post('/billing/ai-pack').set(auth(c.token)).expect(200);
    const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(mono.invoices.get(order.orderId)?.amount).toBe(39000);
    const event = mono.event(order.orderId, 39000);
    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).aiPurchased).toBe(500);
    await http().post('/billing/ai-pack').set(auth(c.token)).expect(400); // the monthly cap
  });

  it('ШІ не робить нічого, коли ліміт вичерпано: діалог іде людині заявкою', async () => {
    const c = await paid('PRO');
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiMonthlyLimit: 0, aiAutoReply: true, sendingEnabled: true } });
    const auto = (await import('../src/automations/auto-reply.service')).AutoReplyService;
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'TELEGRAM', chatId: 'c1', direction: 'IN', text: 'Хочу записатись' } });
    expect(await app.get(auto).onInbound(c.clinicId, 'TELEGRAM', 'c1')).toBe(false);
    expect(await prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: 'c1' } })).toMatchObject({ kind: 'HANDOFF' });
  });
});

describe('функції за тарифом', () => {
  it('самостійні відповіді ШІ, другий канал і щоденна сводка — тільки в «Про»', async () => {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true } });
    await http().patch('/ai').set(auth(c.token)).send({ autoReply: true }).expect(400);
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'DAILY' }).expect(400);
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'WEEKLY' }).expect(200);
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'PRO' } });
    await http().patch('/ai').set(auth(c.token)).send({ autoReply: true }).expect(200);
    await http().patch('/digest').set(auth(c.token)).send({ frequency: 'DAILY' }).expect(200);
    const usage = (await http().get('/service/usage').set(auth(c.token))).body;
    expect(usage.features).toContain('ai_autoreply');
  });

  it('помічник керівника й автономний агент — лише «Про», також при прямому зверненні до API; чернетки для пацієнтів лишаються на «Старті»', async () => {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiEnabled: true } });
    const st = (await http().get('/ai').set(auth(c.token)).expect(200)).body;
    expect(st).toMatchObject({ assistantInPlan: false });
    expect((await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(400)).body.message).toMatch(/тариф/i);
    // even with the switch left on in the database (a clinic that moved from Pro to Start) the model is not called for the assistant
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { aiAssistantEnabled: true } });
    expect((await http().post('/assistant/ask').set(auth(c.token)).send({ question: 'скільки пацієнтів прийшло цього місяця?', history: [] }).expect(400)).body.message).toMatch(/тариф/i);
    await expect(ai.complete(c.clinicId, 'assistant', 's', [{ role: 'user', content: 'x' }], 50, 'assistant')).rejects.toMatchObject({ message: 'plan_feature' });
    // a patient draft is the same on Start
    await expect(ai.complete(c.clinicId, 'chat_draft', 's', [{ role: 'user', content: 'x' }], 50, 'chat')).resolves.toMatchObject({ text: 'ok' });
    const usage = (await http().get('/service/usage').set(auth(c.token))).body;
    expect(usage.features).not.toContain('ai_assistant');
    expect(usage.features).not.toContain('patient_agent');
    expect((await http().get('/ai/agent').set(auth(c.token)).expect(200)).body).toMatchObject({ inPlan: false, active: false });
    expect((await http().post('/ai/agent/activate').set(auth(c.token)).expect(400)).body.message).toMatch(/тариф/i);

    await prisma.clinic.update({ where: { id: c.clinicId }, data: { plan: 'PRO' } });
    // Pro alone switches nothing on
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ aiAgentAuto: false, aiAgentMode: false, sendingEnabled: false, agentAutoScope: 'DIALOGS' });
    await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(200);
    await expect(ai.complete(c.clinicId, 'assistant', 's', [{ role: 'user', content: 'x' }], 50, 'assistant')).resolves.toMatchObject({ text: 'ok' });
  });

  it('перша оплата «Про»: 3 990 + 4 990 грн підключення; далі лише тариф', async () => {
    const c = await clinic();
    const first = await checkoutOrder(c.token, 'PRO');
    expect(first.params).toMatchObject({ ccy: 980, amount: 898000 });
    await pay(first.orderId, first.amountMinor).expect(200);
    const next = await checkoutOrder(c.token, 'PRO');
    expect(next.params.amount).toBe(399000);
  });
});

// The standard purchase and setup path (2026-11-16): registration → payment → the signed server callback → entitlements → setup steps → the owner's
// own agent activation. Only the signed callback changes anything; the browser's return address does nothing.
describe('покупка й підключення', () => {
  const ADMIN_MAIL = `svc${rnd()}@example.com`;
  beforeAll(() => {
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_MAIL;
  });
  afterAll(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });
  const toServiceOwner = (part: string) => mail.outbox.filter((m) => m.to === ADMIN_MAIL && m.text.includes(part));

  it('реєстрація → оплата «Про» → підпис mono → права «Про»; повернення з браузера нічого не змінює; агент і розсилки самі не вмикаються; кроки підключення', async () => {
    const c = await clinic();
    const order = await checkoutOrder(c.token, 'PRO');
    expect(order.params.amount).toBe(898000);
    // the person comes back from the payment page before mono confirms: the page says the payment is being checked, nothing is paid
    let o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'AWAITING_PAYMENT', pendingPaymentId: order.id, setupPaid: false });
    await http().get('/billing/payments/' + order.id).set(auth(c.token)).expect(200).expect(({ body }) => expect(body.status).toBe('PENDING'));
    // an unsigned or wrongly signed callback changes nothing
    await pay(order.orderId, order.amountMinor, 'success', {}, false).expect(400);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('AWAITING_PAYMENT');

    await pay(order.orderId, order.amountMinor).expect(200);
    await pay(order.orderId, order.amountMinor).expect(200); // mono repeats callbacks: applied once
    const cl = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(cl).toMatchObject({ plan: 'PRO', billingStatus: 'ACTIVE', aiMonthlyLimit: 3000, aiAgentAuto: false, aiAgentMode: false, sendingEnabled: false, agentAutoScope: 'DIALOGS' });
    expect(cl.setupPaidAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);
    o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'ACTIVE', pendingPaymentId: null, setupPaid: true, setupUah: null, limits: { users: 30, messagesPerMonth: 10000, aiRepliesPerMonth: 3000 } });

    // the next month: plan price only
    expect((await checkoutOrder(c.token, 'PRO')).params.amount).toBe(399000);
    // entitlements on the server: the assistant is allowed; the agent is in the plan but off and not ready
    await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(200);
    expect((await http().get('/ai/agent').set(auth(c.token)).expect(200)).body).toMatchObject({ inPlan: true, active: false, ready: false });
    const steps = (await http().get('/onboarding').set(auth(c.token)).expect(200)).body;
    const by = Object.fromEntries(steps.steps.map((s: { key: string; done: boolean }) => [s.key, s.done]));
    expect(by).toMatchObject({ payment: true, cliniccards: false, currency: false, services: false, telegram: false, meta: false, agent: false });
    expect(steps.complete).toBe(false);
    // a manager sees the steps; an administrator does not
    const manager = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    await http().get('/onboarding').set(auth(manager)).expect(200);
    await http().get('/onboarding').set(auth(admin)).expect(403);
  });

  it('«Старт» не продається клініці, у якій більше співробітників, ніж він дозволяє', async () => {
    const c = await clinic();
    const first = await checkoutOrder(c.token, 'PRO');
    await pay(first.orderId, first.amountMinor).expect(200);
    for (let i = 0; i < 5; i++) await member(c.token, 'DOCTOR');
    expect((await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'START' }).expect(400)).body.message).toMatch(/співробітник/);
    await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'PRO' }).expect(200);
  });

  it('concurrent plan clicks reuse one invoice and cannot open a second setup fee', async () => {
    const c = await clinic();
    const first = await Promise.all([checkoutOrder(c.token), checkoutOrder(c.token)]);
    expect(first[0].orderId).toBe(first[1].orderId);
    expect(await prisma.billingPayment.count({ where: { clinicId: c.clinicId } })).toBe(1);
    await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'PRO' }).expect(409);
    const event = mono.event(first[0].orderId, first[0].amountMinor);
    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);
    expect((await checkoutOrder(c.token)).amountMinor).toBe(199000);
  });

  it('повернення оплаченого й чужа сума: записано, власнику сервісу лист, оплачений період сам не змінюється', async () => {
    const c = await clinic();
    const o = await checkoutOrder(c.token, 'START');
    await pay(o.orderId, o.amountMinor).expect(200);
    const until = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil;
    await pay(o.orderId, o.amountMinor, 'reversed').expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: o.orderId } })).status).toBe('REVERSED');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.reversed' } })).toBe(1);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil).toEqual(until);
    expect(toServiceOwner(o.orderId)).toHaveLength(1);

    const n = await checkoutOrder(c.token, 'START');
    await pay(n.orderId, 100).expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: n.orderId } })).status).toBe('PENDING');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.mismatch' } })).toBe(1);
    expect(toServiceOwner(n.orderId)).toHaveLength(1);
  });

  it('reconciles a missed callback after return and ignores an out-of-order failure', async () => {
    const c = await clinic();
    const other = await clinic();
    const manager = await member(c.token, 'MANAGER');
    const o = await checkoutOrder(c.token);
    await http().get('/billing/payments/' + o.id).set(auth(other.token)).expect(404);
    await http().get('/billing/payments/' + o.id).expect(401);
    const pending = await http().get('/billing/payments/' + o.id).set(auth(manager)).expect(200);
    expect(pending.body).toMatchObject({ status: 'PENDING', url: null });
    const earlier = mono.event(o.orderId, o.amountMinor, 'failure');
    const success = mono.event(o.orderId, o.amountMinor);
    mono.report(success);
    await prisma.billingPayment.update({ where: { id: o.id }, data: { monoCheckedAt: null } });
    const report = await http().get('/billing/payments/' + o.id).set(auth(c.token)).expect(200);
    expect(report.body.status).toBe('PAID');
    await webhook(earlier).expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PAID');
  });

  it('does not create a second invoice after timeout and recovers it by statement reference', async () => {
    const c = await clinic();
    mono.failNext('unknown');
    const o = await checkoutOrder(c.token);
    expect(o.form.url).toBeNull();
    const same = await checkoutOrder(c.token);
    expect(same.id).toBe(o.id);
    expect(await prisma.billingPayment.count({ where: { clinicId: c.clinicId } })).toBe(1);
    await prisma.billingPayment.update({ where: { id: o.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    mono.report(mono.event(o.orderId, o.amountMinor), true);
    await http().get('/billing/payments/' + o.id).set(auth(c.token)).expect(200).expect(({ body }) => expect(body.status).toBe('PAID'));
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { id: o.id } })).monoInvoiceId).toBe('mono-' + o.orderId);
  });

  it('verifies the exact body and invoice identity, reconciles expiry and allows a new invoice', async () => {
    const c = await clinic();
    const o = await checkoutOrder(c.token);
    const success = mono.event(o.orderId, o.amountMinor);
    const raw = JSON.stringify(success);
    await http().post('/billing/mono/webhook').set('Content-Type', 'application/json')
      .set('X-Sign', mono.signature(raw)).send(raw + ' ').expect(400);
    await webhook({ ...success, invoiceId: 'wrong-invoice' }).expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PENDING');
    mono.report(mono.event(o.orderId, o.amountMinor, 'expired'));
    await http().get('/billing/payments/' + o.id).set(auth(c.token)).expect(200).expect(({ body }) => expect(body.status).toBe('EXPIRED'));
    expect((await checkoutOrder(c.token)).id).not.toBe(o.id);
  });

  it('records a partial refund separately and preserves the paid access', async () => {
    const c = await clinic();
    const o = await checkoutOrder(c.token);
    await pay(o.orderId, o.amountMinor).expect(200);
    const until = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil;
    const refund = mono.event(o.orderId, o.amountMinor, 'success', { finalAmount: o.amountMinor - 10000 });
    await webhook(refund).expect(200);
    await webhook(refund).expect(200);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'PAID', refundedMinor: 10000 });
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.refunded' } })).toBe(1);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil).toEqual(until);
  });
});
describe('one-time Pro checkout', () => {
  const keys = ['BILLING_ONE_TIME_PRO_ENABLED', 'BILLING_ONE_TIME_PRO_CLINIC_ID'] as const;
  const prior = keys.map((key) => process.env[key]);
  let buyer: Awaited<ReturnType<typeof clinic>>;
  let restoreOwner: () => Promise<void>;

  beforeEach(async () => {
    buyer = await clinic();
    restoreOwner = await pinPlatformFixture(prisma, buyer.email);
    process.env.BILLING_ONE_TIME_PRO_ENABLED = 'true';
    process.env.BILLING_ONE_TIME_PRO_CLINIC_ID = buyer.clinicId;
  });

  afterEach(async () => {
    await restoreOwner?.();
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
  });

  const offer = async (token: string) => {
    const { body } = await http().get('/billing').set(auth(token)).expect(200);
    return body.plans.find((p: { key: string }) => p.key === 'PRO');
  };
  const checkout = (token: string, plan = 'PRO') => http().post('/billing/checkout').set(auth(token)).send({
    plan, amountMinor: 100, oneTimePro: true, clinicId: 'ignored',
  });
  const buyerId = async () => (await prisma.membership.findFirstOrThrow({
    where: { clinicId: buyer.clinicId, role: 'OWNER', user: { email: 'hello@lankaclinic.app' } }, select: { userId: true },
  })).userId;
  const switchClinic = async (token: string, clinicId: string) => {
    const { body } = await http().post('/auth/switch').set(auth(token)).send({ clinicId }).expect(200);
    return body.accessToken as string;
  };

  it('requires the enabled flag, exact clinic ID, verified platform identity and clinic OWNER role', async () => {
    const id = await buyerId();
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 1, oneTimePro: { includesSetup: true } });
    delete process.env.BILLING_ONE_TIME_PRO_ENABLED;
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 8980 });
    process.env.BILLING_ONE_TIME_PRO_ENABLED = 'true';

    await prisma.user.update({ where: { id }, data: { emailVerifiedAt: null } });
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 8980 });
    mono.failNext('rejected');
    expect((await checkout(buyer.token).expect(200)).body.amountMinor).toBe(898000);
    await prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });

    const membership = { userId_clinicId: { userId: id, clinicId: buyer.clinicId } };
    await prisma.membership.update({ where: membership, data: { role: 'MANAGER' } });
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 8980 });
    await checkout(buyer.token).expect(403);
    await prisma.membership.update({ where: membership, data: { role: 'OWNER' } });

    const target = await prisma.clinic.findUniqueOrThrow({ where: { id: buyer.clinicId } });
    const lookalike = await prisma.clinic.create({ data: { name: target.name, memberships: { create: { userId: id, role: 'OWNER' } } } });
    const otherClinicToken = await switchClinic(buyer.token, lookalike.id);
    expect((await checkout(otherClinicToken).expect(200)).body.amountMinor).toBe(898000);

    // An otherwise eligible buyer pays the usual Start price.
    mono.failNext('rejected');
    expect((await checkout(buyer.token, 'START').expect(200)).body.amountMinor).toBe(698000);

    const other = await clinic();
    const otherId = (await prisma.user.findUniqueOrThrow({ where: { email: other.email } })).id;
    process.env.PLATFORM_ADMIN_EMAILS += ',' + other.email;
    await prisma.membership.create({ data: { userId: otherId, clinicId: buyer.clinicId, role: 'OWNER' } });
    const otherOwnerToken = await switchClinic(other.token, buyer.clinicId);
    expect(await offer(otherOwnerToken)).toMatchObject({ totalUah: 8980 });
    expect((await checkout(otherOwnerToken).expect(200)).body.amountMinor).toBe(898000);
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 8980 }); // No misleading quote while a regular invoice is open.
  });

  it.each([false, true])('fulfills the 100-kopeck Pro order once, with setup already paid = %s', async (setupPaid) => {
    const buyerUserId = await buyerId();
    const previousSetup = setupPaid ? new Date(Date.now() - 10 * 86_400_000) : null;
    const previousEnd = setupPaid ? new Date(Date.now() + 10 * 86_400_000) : null;
    await prisma.clinic.update({ where: { id: buyer.clinicId }, data: {
      setupPaidAt: previousSetup, paidUntil: previousEnd, billingStatus: setupPaid ? 'ACTIVE' : 'AWAITING_PAYMENT', aiPurchased: 23,
    } });
    expect(await offer(buyer.token)).toMatchObject({ priceUah: 3990, totalUah: 1, oneTimePro: { includesSetup: !setupPaid } });

    const count = mono.invoices.size;
    const [first, duplicate] = await Promise.all([checkout(buyer.token).expect(200), checkout(buyer.token).expect(200)]);
    expect(first.body).toMatchObject({ id: duplicate.body.id, amountMinor: 100 });
    expect(mono.invoices.size).toBe(count + 1);
    const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(order).toMatchObject({
      kind: 'SUBSCRIPTION', plan: 'PRO', amountMinor: 100, currency: 980, setupMinor: 0, networkId: null,
      oneTimeProBuyerId: buyerUserId, oneTimeProIncludesSetup: !setupPaid, periodFrom: expect.any(Date), periodTo: expect.any(Date),
    });
    expect(mono.invoices.get(order.orderId)).toMatchObject({
      amount: 100, ccy: 980, merchantPaymInfo: { destination: expect.stringContaining('Pro'), basketOrder: [{ sum: 100, total: 100 }] },
    });

    const other = await clinic();
    const otherId = (await prisma.user.findUniqueOrThrow({ where: { email: other.email } })).id;
    await prisma.membership.create({ data: { userId: otherId, clinicId: buyer.clinicId, role: 'OWNER' } });
    const otherClinicOwner = await switchClinic(other.token, buyer.clinicId);
    await checkout(otherClinicOwner).expect(409);
    await http().get('/billing/payments/' + order.id).set(auth(otherClinicOwner)).expect(200)
      .expect(({ body }) => expect(body.url).toBeNull());

    delete process.env.BILLING_ONE_TIME_PRO_ENABLED;
    expect((await checkout(buyer.token).expect(200)).body).toMatchObject({ id: order.id, amountMinor: 100, url: expect.any(String) });
    const event = mono.event(order.orderId, 100);
    await webhook({ ...event, amount: 399000 }).expect(200);
    await webhook(event, false).expect(400);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: buyer.clinicId } })).toMatchObject({ plan: 'START', paidUntil: previousEnd });
    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);

    const paidAt = new Date(event.modifiedDate);
    const from = previousEnd ?? paidAt;
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'PAID', paidAt, periodFrom: from, periodTo: to, amountMinor: 100,
    });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: buyer.clinicId } })).toMatchObject({
      plan: 'PRO', billingStatus: 'ACTIVE', paidUntil: to, periodStartsAt: paidAt, setupPaidAt: previousSetup ?? paidAt,
      aiMonthlyLimit: 3000, aiPurchased: 23, sendingEnabled: false, aiAgentAuto: false, aiAgentMode: false,
    });
    expect(await prisma.auditLog.count({ where: { clinicId: buyer.clinicId, action: 'billing.paid' } })).toBe(1);
    process.env.BILLING_ONE_TIME_PRO_ENABLED = 'true';
    expect(await offer(buyer.token)).toMatchObject({ totalUah: 3990 });
    await webhook(mono.event(order.orderId, 100, 'reversed')).expect(200);
    const renewal = await checkout(buyer.token).expect(200);
    expect(renewal.body.amountMinor).toBe(399000);
  });

  it('reserves an unknown or failed invoice until mono confirms it is expired and unpaid', async () => {
    mono.failNext('unknown');
    const invoices = mono.invoices.size;
    const first = (await checkout(buyer.token).expect(200)).body;
    expect(first).toMatchObject({ url: null, amountMinor: 100 });
    const reserved = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(reserved).toMatchObject({ status: 'PENDING', monoInvoiceId: null });
    await prisma.billingPayment.update({ where: { id: first.id }, data: {
      createdAt: new Date(Date.now() - 120_000), monoExpiresAt: new Date(Date.now() - 1000),
    } });
    await checkout(buyer.token).expect(200, first); // Even after the local deadline, the result is unknown.
    expect(mono.invoices.size).toBe(invoices + 1);

    const failure = mono.event(reserved.orderId, 100, 'failure');
    mono.report(failure);
    await webhook(failure).expect(200);
    await prisma.billingPayment.update({ where: { id: first.id }, data: { monoCheckedAt: null } });
    await checkout(buyer.token).expect(200, first);
    expect(mono.invoices.size).toBe(invoices + 1);
    mono.report(mono.event(reserved.orderId, 100, 'expired'));
    await prisma.billingPayment.update({ where: { id: first.id }, data: { monoCheckedAt: null } });

    const retry = (await checkout(buyer.token).expect(200)).body;
    expect(retry).toMatchObject({ amountMinor: 100, url: expect.any(String) });
    expect(retry.id).not.toBe(first.id);
    expect(mono.invoices.size).toBe(invoices + 2);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: buyer.clinicId } })).toMatchObject({
      plan: 'START', billingStatus: 'AWAITING_PAYMENT', paidUntil: null, setupPaidAt: null,
    });
    expect(await prisma.auditLog.count({ where: { clinicId: buyer.clinicId, action: 'billing.paid' } })).toBe(0);
  });
});
