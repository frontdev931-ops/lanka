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
// The service owner starts the prepaid first month of a new clinic (POST /platform/clinics/:id/launch); here directly through the service
const activate = (clinicId: string) => billing.activateLaunch(clinicId, 'platform-test');
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};

describe('підписка та оплата', () => {
  it('нова клініка: Старт 1 990 + запуск 4 990 = 6 980 грн; оплата → «готуємо запуск» без старту місяця; власник сервісу запускає місяць', async () => {
    const c = await clinic();
    const o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ configured: true, status: 'AWAITING_PAYMENT', setupPaid: false, monthStartsAtLaunch: true, nextPeriod: null, launch: { state: 'NONE' }, renewal: null, pack: { replies: 500, priceUah: 390 } });
    expect(o.plans.map((p: { key: string; priceUah: number; launchUah: number; totalUah: number }) => [p.key, p.priceUah, p.launchUah, p.totalUah]))
      .toEqual([['START', 1990, 4990, 6980], ['PRO', 4990, 4990, 9980]]);

    const { form, params, orderId, amountMinor } = await checkoutOrder(c.token);
    expect(form.url).toBe('https://pay.mbnk.biz/mono-' + orderId);
    expect(params).toMatchObject({ ccy: 980, paymentType: 'debit', amount: 698000, validity: 900 });
    expect(params.merchantPaymInfo.basketOrder.map((item) => item.sum)).toEqual([199000, 499000]);
    expect(params.webHookUrl).toContain('/backend/billing/mono/webhook');
    expect(params.redirectUrl).toContain('/settings?tab=billing&payment=');
    // the launch order has no period yet: it starts on the launch day
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { orderId } })).toMatchObject({
      monoInvoiceId: 'mono-' + orderId, currency: 980, setupMinor: 499000, periodFrom: null, periodTo: null,
    });

    await pay(orderId, amountMinor).expect(200);
    let cl = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(cl).toMatchObject({ billingStatus: 'LAUNCH_PENDING', plan: 'START', aiMonthlyLimit: 500, paidUntil: null, periodStartsAt: null, renewalPlan: 'START', renewalPriceUah: 1990, sendingEnabled: false });
    expect(cl.setupPaidAt).not.toBeNull();
    expect(mail.outbox.filter((m) => m.to === c.email).at(-1)?.text).toMatch(/Готуємо запуск/);
    expect((await http().get('/billing').set(auth(c.token))).body).toMatchObject({ status: 'LAUNCH_PENDING', launch: { state: 'PENDING', plan: 'START' }, nextPeriod: null });
    // a repeated callback changes nothing and starts no month
    await pay(orderId, amountMinor).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil).toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);
    // the same launch cannot be bought again while it is being prepared
    expect((await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'START' }).expect(409)).body.message).toMatch(/запуск/i);
    await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'PRO' }).expect(409);

    // the service owner starts the month: one billing month from now, once
    const started = await activate(c.clinicId);
    expect(started).toMatchObject({ already: false, plan: 'START' });
    cl = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(cl).toMatchObject({ billingStatus: 'ACTIVE', paidUntil: started.to, periodStartsAt: started.from });
    expect(cl.paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ periodFrom: started.from, periodTo: started.to, launchActivatedBy: 'platform-test', launchActivatedAt: started.from });
    expect(await activate(c.clinicId)).toMatchObject({ already: true, from: started.from, to: started.to });
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.launch_activated' } })).toBe(1);
    const until = cl.paidUntil!.getTime();
    // a callback after the start changes nothing either
    await pay(orderId, amountMinor).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil!.getTime()).toBe(until);
    expect((await http().get('/billing').set(auth(c.token))).body).toMatchObject({ launch: { state: 'DONE' }, renewal: { plan: 'START', priceUah: 1990 }, plans: [{ key: 'START', launchUah: null, totalUah: 1990 }, { key: 'PRO', launchUah: null, totalUah: 4990 }] });

    // an upgrade after the launch: no launch fee again, the Pro list price; renewing early extends the paid month
    const next = await checkoutOrder(c.token, 'PRO');
    expect(next.amountMinor).toBe(499000);
    await pay(next.orderId, next.amountMinor).expect(200);
    const after = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(after.plan).toBe('PRO');
    expect(after.aiMonthlyLimit).toBe(3000);
    expect(after.paidUntil!.getTime()).toBeGreaterThan(until + 27 * 86_400_000);
    expect(after).toMatchObject({ renewalPlan: 'PRO', renewalPriceUah: 4990 });
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
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('LAUNCH_PENDING');
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
    // paid, the launch is being prepared: the clinic can set itself up (Cliniccards, settings), nothing goes to patients
    await http().get('/patients').set(auth(c.token)).expect(200);
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    expect((await http().get('/auth/me').set(auth(c.token))).body.billing).toMatchObject({ status: 'LAUNCH_PENDING', blocked: false });
    await activate(c.clinicId);
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

  it('перша оплата «Про»: 4 990 + 4 990 грн запуску = 9 980; після запуску лише тариф', async () => {
    const c = await clinic();
    const first = await checkoutOrder(c.token, 'PRO');
    expect(first.params).toMatchObject({ ccy: 980, amount: 998000 });
    expect(first.params.merchantPaymInfo.basketOrder.map((item) => item.sum)).toEqual([499000, 499000]);
    await pay(first.orderId, first.amountMinor).expect(200);
    await activate(c.clinicId);
    const next = await checkoutOrder(c.token, 'PRO');
    expect(next.params.amount).toBe(499000);
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
    expect(order.params.amount).toBe(998000);
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
    expect(cl).toMatchObject({ plan: 'PRO', billingStatus: 'LAUNCH_PENDING', aiMonthlyLimit: 3000, aiAgentAuto: false, aiAgentMode: false, sendingEnabled: false, agentAutoScope: 'DIALOGS', paidUntil: null });
    expect(cl.setupPaidAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);
    expect(toServiceOwner('/platform').filter((m) => m.text.includes(order.orderId))).toHaveLength(1);
    o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'LAUNCH_PENDING', pendingPaymentId: null, setupPaid: true, launch: { state: 'PENDING', plan: 'PRO' }, limits: { users: 30, messagesPerMonth: 10000, aiRepliesPerMonth: 3000 } });

    // during the preparation: setup is allowed, nothing goes out (the sending switch stays closed, the agent's billing prerequisite is not met)
    expect((await http().patch('/automations/settings').set(auth(c.token)).send({ sendingEnabled: true }).expect(400)).body.message).toMatch(/запуск/i);
    await http().patch('/ai').set(auth(c.token)).send({ assistant: true }).expect(200);
    expect((await http().get('/ai/agent').set(auth(c.token)).expect(200)).body).toMatchObject({ inPlan: true, active: false, ready: false, prerequisites: expect.arrayContaining([{ key: 'billing', met: false }]) });
    const steps = (await http().get('/onboarding').set(auth(c.token)).expect(200)).body;
    expect(steps.launch).toBe('PENDING');
    const by = Object.fromEntries(steps.steps.map((s: { key: string; done: boolean }) => [s.key, s.done]));
    expect(by).toMatchObject({ payment: true, cliniccards: false, currency: false, services: false, telegram: false, meta: false, agent: false });
    expect(steps.complete).toBe(false);

    // after the start: the next month is the plan price only, the sending switch opens
    await activate(c.clinicId);
    expect((await checkoutOrder(c.token, 'PRO')).params.amount).toBe(499000);
    await http().patch('/automations/settings').set(auth(c.token)).send({ sendingEnabled: false }).expect(200);
    expect((await http().get('/onboarding').set(auth(c.token)).expect(200)).body.launch).toBeNull();
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
    await activate(c.clinicId);
    for (let i = 0; i < 5; i++) await member(c.token, 'DOCTOR');
    expect((await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'START' }).expect(400)).body.message).toMatch(/співробітник/);
    await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'PRO' }).expect(200);
  });

  it('opens and reuses the exact bank checkout URL', async () => {
    const owner = await clinic();
    const pageUrl = 'https://pay.monobank.ua/checkout/opaque-link?source=acquiring%2Ftest';
    const invoiceCount = mono.invoices.size;
    mono.pageUrlNext(pageUrl);
    const checkout = () => http().post('/billing/checkout').set(auth(owner.token)).send({ plan: 'PRO' }).expect(200);
    const { body: first } = await checkout();
    expect(first.url).toBe(pageUrl);
    const invoice = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(invoice.monoPageUrl).toBe(pageUrl);
    expect(invoice.monoInvoiceId).not.toContain('opaque-link');
    await checkout().expect(200, first);
    await http().get('/billing/payments/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PENDING', url: pageUrl }));
    expect(mono.invoices.size).toBe(invoiceCount + 1);

    await prisma.billingPayment.update({ where: { id: first.id }, data: { monoExpiresAt: new Date(Date.now() - 1000) } });
    await http().get('/billing/payments/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ url: null }));
  });

  it.each([
    'https://pay.monobank.ua.example.test/checkout',
    'http://pay.monobank.ua/checkout',
    'https://user@pay.monobank.ua/checkout',
  ])('keeps the invoice for reconciliation without offering an unsafe URL %s', async (pageUrl) => {
    const owner = await clinic();
    mono.pageUrlNext(pageUrl);
    const invoiceCount = mono.invoices.size;
    const checkout = () => http().post('/billing/checkout').set(auth(owner.token)).send({ plan: 'PRO' }).expect(200);
    const { body: first } = await checkout();
    expect(first.url).toBeNull();
    const order = await prisma.billingPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(order).toMatchObject({ monoInvoiceId: expect.any(String), monoPageUrl: null });
    await checkout().expect(200, first);
    await http().get('/billing/payments/' + first.id).set(auth(owner.token)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PENDING', url: null }));
    expect(mono.invoices.size).toBe(invoiceCount + 1);
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
    // two concurrent starts give one month
    const [a, b] = await Promise.all([activate(c.clinicId), activate(c.clinicId)]);
    expect([a.already, b.already].sort()).toEqual([false, true]);
    expect(a.to).toEqual(b.to);
    expect((await checkoutOrder(c.token)).amountMinor).toBe(199000);
  });

  it('повернення оплаченого й чужа сума: записано, власнику сервісу лист, оплачений період сам не змінюється', async () => {
    const c = await clinic();
    const o = await checkoutOrder(c.token, 'START');
    await pay(o.orderId, o.amountMinor).expect(200);
    await activate(c.clinicId);
    const until = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil;
    await pay(o.orderId, o.amountMinor, 'reversed').expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: o.orderId } })).status).toBe('REVERSED');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.reversed' } })).toBe(1);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil).toEqual(until);
    // after the start a refund keeps the old rule (no automatic change); the earlier mail is the "launch paid" notice
    expect(toServiceOwner(o.orderId).filter((m) => m.subject.includes('повернення'))).toHaveLength(1);
    expect(toServiceOwner(o.orderId).at(-1)?.text).toMatch(/Доступ та ліміти не змінено/);

    const n = await checkoutOrder(c.token, 'START');
    await pay(n.orderId, 100).expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: n.orderId } })).status).toBe('PENDING');
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.mismatch' } })).toBe(1);
    expect(toServiceOwner(n.orderId)).toHaveLength(1);
  });

  it('повернення до старту місяця: повне — підготовку скасовано; часткове — запуск і нова оплата зупинені до рішення підтримки', async () => {
    const full = await clinic();
    const o = await checkoutOrder(full.token, 'PRO');
    await pay(o.orderId, o.amountMinor).expect(200);
    await pay(o.orderId, o.amountMinor, 'reversed').expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: full.clinicId } })).toMatchObject({ billingStatus: 'AWAITING_PAYMENT', setupPaidAt: null, paidUntil: null, renewalPlan: null });
    await expect(activate(full.clinicId)).rejects.toMatchObject({ message: 'launch_not_pending' });
    expect(await prisma.auditLog.count({ where: { clinicId: full.clinicId, action: 'billing.launch_cancelled' } })).toBe(1);
    expect(toServiceOwner('Підготовку запуску скасовано').filter((m) => m.text.includes(o.orderId))).toHaveLength(1);
    // the history is kept; a new purchase is the full first payment again
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ status: 'REVERSED', periodFrom: null });
    expect((await checkoutOrder(full.token, 'PRO')).amountMinor).toBe(998000);

    // a partial refund keeps money with us: the clinic is not sent back to pay the full amount again; the launch waits for support
    const partial = await clinic();
    const p = await checkoutOrder(partial.token);
    await pay(p.orderId, p.amountMinor).expect(200);
    await webhook(mono.event(p.orderId, p.amountMinor, 'success', { finalAmount: p.amountMinor - 10000 })).expect(200);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: p.orderId } })).toMatchObject({ status: 'PAID', refundedMinor: 10000, launchActivatedAt: null });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: partial.clinicId } })).toMatchObject({ billingStatus: 'LAUNCH_PENDING', paidUntil: null });
    expect(await prisma.auditLog.count({ where: { clinicId: partial.clinicId, action: 'billing.launch_review' } })).toBe(1);
    expect(toServiceOwner('решта лишилась').filter((m) => m.text.includes(p.orderId))).toHaveLength(1);
    expect((await http().get('/billing').set(auth(partial.token))).body).toMatchObject({ status: 'LAUNCH_PENDING', launch: { state: 'REVIEW' } });
    const before = await prisma.billingPayment.count({ where: { clinicId: partial.clinicId } });
    await http().post('/billing/checkout').set(auth(partial.token)).send({ plan: 'START' }).expect(409);
    expect(await prisma.billingPayment.count({ where: { clinicId: partial.clinicId } })).toBe(before);
    await expect(activate(partial.clinicId)).rejects.toMatchObject({ message: 'launch_payment_missing' });
  });

  it('start of the first month: only the service owner, dates shown first, a clinic that is not pending is refused, no clinic data crosses', async () => {
    const c = await clinic();
    const other = await clinic();
    const svc = await clinic();
    const restore = await pinPlatformFixture(prisma, svc.email);
    try {
      const svcToken = svc.token;
      await http().get(`/platform/clinics/${c.clinicId}/launch`).set(auth(c.token)).expect(403);
      await http().post(`/platform/clinics/${c.clinicId}/launch`).set(auth(c.token)).expect(403);
      // not paid: nothing to start
      expect((await http().get(`/platform/clinics/${c.clinicId}/launch`).set(auth(svcToken)).expect(200)).body).toMatchObject({ eligible: false, status: 'AWAITING_PAYMENT' });
      await http().post(`/platform/clinics/${c.clinicId}/launch`).set(auth(svcToken)).expect(400);
      const o = await checkoutOrder(c.token, 'PRO');
      await pay(o.orderId, o.amountMinor).expect(200);
      const preview = (await http().get(`/platform/clinics/${c.clinicId}/launch`).set(auth(svcToken)).expect(200)).body;
      expect(preview).toMatchObject({ eligible: true, status: 'LAUNCH_PENDING', plan: 'PRO', amountMinor: 998000 });
      expect(Date.parse(preview.to) - Date.parse(preview.from)).toBeGreaterThan(27 * 86_400_000);
      const r = (await http().post(`/platform/clinics/${c.clinicId}/launch`).set(auth(svcToken)).expect(200)).body;
      expect(r).toMatchObject({ already: false, plan: 'PRO' });
      expect((await http().post(`/platform/clinics/${c.clinicId}/launch`).set(auth(svcToken)).expect(200)).body).toMatchObject({ already: true, to: r.to });
      const pay1 = await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: o.orderId } });
      expect(pay1.launchActivatedBy).toBe(process.env.PLATFORM_OWNER_USER_ID);
      expect(await prisma.auditLog.findFirst({ where: { clinicId: c.clinicId, action: 'billing.launch_activated' } })).toMatchObject({ userId: process.env.PLATFORM_OWNER_USER_ID });
      // the other clinic is untouched
      expect(await prisma.clinic.findUniqueOrThrow({ where: { id: other.clinicId } })).toMatchObject({ billingStatus: 'AWAITING_PAYMENT', paidUntil: null });
      await http().get('/platform/clinics/nope/launch').set(auth(svcToken)).expect(404);
    } finally {
      await restore();
    }
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
    await activate(c.clinicId);
    const until = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil;
    const refund = mono.event(o.orderId, o.amountMinor, 'success', { finalAmount: o.amountMinor - 10000 });
    await webhook(refund).expect(200);
    await webhook(refund).expect(200);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'PAID', refundedMinor: 10000 });
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.refunded' } })).toBe(1);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).paidUntil).toEqual(until);
  });
});
describe('historical mono payments', () => {
  async function proOwner() {
    const owner = await clinic();
    const { userId } = await prisma.membership.findFirstOrThrow({ where: { clinicId: owner.clinicId, role: 'OWNER' }, select: { userId: true } });
    const started = new Date(Date.now() - 86_400_000);
    const paidUntil = new Date(started);
    paidUntil.setUTCMonth(paidUntil.getUTCMonth() + 1);
    const current = await prisma.clinic.update({
      where: { id: owner.clinicId },
      // renewalPlan/renewalPriceUah: what the migration of 2026-11-19 sets for a clinic activated before the new price list
      data: { plan: 'PRO', billingStatus: 'ACTIVE', periodStartsAt: started, paidUntil, setupPaidAt: started, aiMonthlyLimit: 3000, aiPurchased: 17, renewalPlan: 'PRO', renewalPriceUah: 3990 },
    });
    return { ...owner, userId, current, started, paidUntil };
  }

  it('keeps paid Pro access and shows the actual 1 UAH payment at the ordinary renewal price', async () => {
    const owner = await proOwner();
    const orderId = rnd();
    const row = await prisma.billingPayment.create({
      data: {
        clinicId: owner.clinicId, orderId, kind: 'SUBSCRIPTION', plan: 'PRO', amountMinor: 100,
        oneTimeProBuyerId: owner.userId, oneTimeProIncludesSetup: true,
        status: 'PAID', paidAt: owner.started, periodFrom: owner.started, periodTo: owner.paidUntil,
        monoInvoiceId: mono.event(orderId, 100).invoiceId, monoExpiresAt: owner.started, monoModifiedAt: owner.started,
      },
    });

    process.env.BILLING_ENFORCED = 'true';
    try {
      await http().get('/patients').set(auth(owner.token)).expect(200);
      await http().get('/auth/me').set(auth(owner.token)).expect(200).expect(({ body }) =>
        expect(body.billing).toMatchObject({ status: 'ACTIVE', blocked: false, paidUntil: owner.paidUntil.toISOString() }));
    } finally {
      delete process.env.BILLING_ENFORCED;
    }

    await http().get('/billing').set(auth(owner.token)).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ plan: 'PRO', paidUntil: owner.paidUntil.toISOString(), setupPaid: true, pendingPaymentId: null, launch: { state: 'DONE' },
        renewal: { plan: 'PRO', priceUah: 3990, date: owner.paidUntil.toISOString() }, nextPeriod: { from: owner.paidUntil.toISOString() } });
      expect(body.plans.find((plan: { key: string }) => plan.key === 'PRO')).toMatchObject({ priceUah: 3990, listPriceUah: 4990, launchUah: null, totalUah: 3990 });
      // the stored price is for Pro only; another plan is at the list price, and never with a launch fee
      expect(body.plans.find((plan: { key: string }) => plan.key === 'START')).toMatchObject({ priceUah: 1990, launchUah: null, totalUah: 1990 });
      expect(body.payments).toEqual([expect.objectContaining({ id: row.id, kind: 'SUBSCRIPTION', plan: 'PRO', amountMinor: 100, status: 'PAID' })]);
      expect(body.payments[0]).not.toHaveProperty('oneTimePro');
      expect(body.payments[0]).not.toHaveProperty('oneTimeProBuyerId');
    });

    const duplicate = mono.event(orderId, 100, 'success', { modifiedDate: owner.started.toISOString() });
    await Promise.all([webhook(duplicate).expect(200), webhook(duplicate).expect(200)]);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).toEqual(owner.current);

    const next = await checkoutOrder(owner.token, 'PRO');
    expect(next.params).toMatchObject({ ccy: 980, amount: 399000 });
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ oneTimeProBuyerId: null, oneTimeProIncludesSetup: false, setupMinor: 0, periodFrom: owner.paidUntil });
    // the renewal keeps the normal period rule (the month after the paid one) and the stored price
    await pay(next.orderId, next.amountMinor).expect(200);
    const renewed = await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } });
    expect(renewed).toMatchObject({ billingStatus: 'ACTIVE', renewalPlan: 'PRO', renewalPriceUah: 3990 });
    expect(renewed.paidUntil!.getTime()).toBeGreaterThan(owner.paidUntil.getTime() + 27 * 86_400_000);
    // an invoice is a snapshot: a later price list change does not touch it
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ amountMinor: 399000, status: 'PAID' });
  });

  it('keeps a historical Pro invoice reserved and records late payment without granting a second period', async () => {
    const owner = await proOwner();
    const snapshot = {
      clinicId: owner.clinicId, kind: 'SUBSCRIPTION', plan: 'PRO', amountMinor: 100,
      oneTimeProBuyerId: owner.userId, oneTimeProIncludesSetup: true,
    };
    await prisma.billingPayment.create({ data: { ...snapshot, orderId: rnd(), status: 'PAID', paidAt: owner.started } });
    const event = mono.event(rnd(), 100);
    const late = await prisma.billingPayment.create({
      data: {
        ...snapshot, orderId: event.reference, monoInvoiceId: event.invoiceId,
        monoExpiresAt: new Date(Date.now() + 60_000), monoPageUrl: 'https://pay.mbnk.biz/historical',
      },
    });
    const invoices = mono.invoices.size;
    await http().get('/billing/payments/' + late.id).set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body).toMatchObject({ status: 'PENDING', url: null }));
    await http().post('/billing/checkout').set(auth(owner.token)).send({ plan: 'PRO' }).expect(409);
    expect(mono.invoices.size).toBe(invoices);

    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
      status: 'PAID', paidAt: new Date(event.modifiedDate), amountMinor: 100, monoInvoiceId: event.invoiceId, periodTo: null,
    });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).toEqual(owner.current);
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: 'billing.one_time_pro_duplicate' } })).toBe(1);
  });

  it('keeps delayed signed diagnostic evidence internal without granting any entitlements', async () => {
    const owner = await proOwner();
    const event = mono.event(rnd(), 100);
    const paidAt = new Date(Date.parse(event.modifiedDate) + 1000);
    const row = await prisma.billingPayment.create({
      data: {
        clinicId: owner.clinicId, orderId: event.reference, kind: MONO_DIAGNOSTIC, amountMinor: 100,
        status: 'PAID', paidAt, monoModifiedAt: paidAt, monoInvoiceId: event.invoiceId, monoExpiresAt: owner.paidUntil,
      },
    });
    await webhook(event, false).expect(400);
    await webhook({ ...event, amount: 101 }).expect(200);
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: DIAGNOSTIC_WEBHOOK } })).toBe(0);
    await Promise.all([webhook(event).expect(200), webhook(event).expect(200)]);
    const evidence = await prisma.auditLog.findMany({ where: { clinicId: owner.clinicId, action: DIAGNOSTIC_WEBHOOK } });
    expect(evidence).toEqual([expect.objectContaining({ details: { orderId: event.reference, invoiceId: event.invoiceId } })]);
    expect(await prisma.billingPayment.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } })).toEqual(owner.current);
    await http().get('/billing').set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body).toMatchObject({ payments: [], pendingPaymentId: null }));
    await http().get('/billing/payments/' + row.id).set(auth(owner.token)).expect(404);
    await http().get('/clinic/audit').set(auth(owner.token)).expect(200).expect(({ body }) =>
      expect(body.rows.every((entry: { action: string }) => !entry.action.startsWith(DIAGNOSTIC_AUDIT_PREFIX))).toBe(true));
  });
});
