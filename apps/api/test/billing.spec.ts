import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AiService } from '../src/ai/ai.service';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { BillingService } from '../src/billing/billing.service';
import { sign } from '../src/billing/liqpay';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const PRIVATE = 'liqpay-private-key-for-tests';
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
  process.env.LIQPAY_PUBLIC_KEY = 'i0000000000';
  process.env.LIQPAY_PRIVATE_KEY = PRIVATE;
  process.env.USD_UAH_RATE = '40';
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(llm).compile()).createNestApplication();
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
});

async function clinic() {
  const email = `b${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  // test clinics start unpaid, like real ones
  return { token: res.body.accessToken as string, clinicId, email };
}

// What LiqPay sends to the server address after a payment
const pay = (orderId: string, amountMinor: number, status = 'success', over: Record<string, unknown> = {}, key = PRIVATE) => {
  const data = Buffer.from(JSON.stringify({ order_id: orderId, status, amount: amountMinor / 100, currency: 'UAH', payment_id: 7777, ...over })).toString('base64');
  return http().post('/billing/liqpay/callback').send({ data, signature: sign(data, key) });
};
const checkoutOrder = async (token: string, plan = 'START') => {
  const r = await http().post('/billing/checkout').set(auth(token)).send({ plan }).expect(200);
  const p = JSON.parse(Buffer.from(r.body.data, 'base64').toString('utf8'));
  return { form: r.body, params: p, orderId: p.order_id as string, amountMinor: Math.round(p.amount * 100) };
};
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};

describe('підписка та оплата', () => {
  it('нова клініка чекає оплати; перша оплата = підключення (4 990 грн) + місяць тарифу; після неї клініка активна', async () => {
    const c = await clinic();
    const o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ configured: true, status: 'AWAITING_PAYMENT', setupPaid: false, setupUah: 4990, pack: { replies: 500, priceUah: 390 } });
    expect(o.plans.map((p: { key: string; priceUah: number }) => [p.key, p.priceUah])).toEqual([['START', 1990], ['PRO', 3990]]);

    const { form, params, orderId, amountMinor } = await checkoutOrder(c.token);
    expect(form.signature).toBe(sign(form.data, PRIVATE));
    expect(params).toMatchObject({ public_key: 'i0000000000', currency: 'UAH', action: 'pay', amount: 1990 + 4990 });
    expect(params.server_url).toContain('/backend/billing/liqpay/callback');

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
    await pay(orderId, amountMinor, 'success', {}, 'wrong-key').expect(400);
    await http().post('/billing/liqpay/callback').send({}).expect(400);
    await pay(orderId, amountMinor - 100).expect(200); // wrong amount: ignored
    await pay(orderId, amountMinor, 'success', { currency: 'USD' }).expect(200);
    await pay('unknown-order', amountMinor).expect(200);
    await pay(orderId, amountMinor, 'wait_accept').expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('AWAITING_PAYMENT');
    await pay(orderId, amountMinor, 'failure').expect(200);
    expect((await prisma.billingPayment.findUniqueOrThrow({ where: { orderId } })).status).toBe('FAILED');
    // a failed order can still be paid later (the person retries on the LiqPay page)
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

  it('без ключів LiqPay оплата недоступна', async () => {
    const c = await clinic();
    const key = process.env.LIQPAY_PRIVATE_KEY;
    delete process.env.LIQPAY_PRIVATE_KEY;
    try {
      await http().post('/billing/checkout').set(auth(c.token)).send({ plan: 'START' }).expect(400);
      expect((await http().get('/billing').set(auth(c.token))).body.configured).toBe(false);
    } finally {
      process.env.LIQPAY_PRIVATE_KEY = key;
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
    const order = JSON.parse(Buffer.from(r.body.data, 'base64').toString('utf8'));
    expect(order.amount).toBe(390);
    await pay(order.order_id, 39000).expect(200);
    await pay(order.order_id, 39000).expect(200);
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
    expect(first.params).toMatchObject({ currency: 'UAH', amount: 3990 + 4990 });
    await pay(first.orderId, first.amountMinor).expect(200);
    const next = await checkoutOrder(c.token, 'PRO');
    expect(next.params.amount).toBe(3990);
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
    delete process.env.LIQPAY_SANDBOX;
  });
  const toServiceOwner = (part: string) => mail.outbox.filter((m) => m.to === ADMIN_MAIL && m.text.includes(part));

  it('реєстрація → оплата «Про» → підпис LiqPay → права «Про»; повернення з браузера нічого не змінює; агент і розсилки самі не вмикаються; кроки підключення', async () => {
    const c = await clinic();
    const order = await checkoutOrder(c.token, 'PRO');
    expect(order.params.amount).toBe(3990 + 4990);
    // the person comes back from the payment page before LiqPay confirms: the page says the payment is being checked, nothing is paid
    let o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'AWAITING_PAYMENT', checking: true, setupPaid: false });
    // an unsigned or wrongly signed callback changes nothing
    await pay(order.orderId, order.amountMinor, 'success', {}, 'wrong-key').expect(400);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('AWAITING_PAYMENT');

    await pay(order.orderId, order.amountMinor).expect(200);
    await pay(order.orderId, order.amountMinor).expect(200); // LiqPay repeats callbacks: applied once
    const cl = await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } });
    expect(cl).toMatchObject({ plan: 'PRO', billingStatus: 'ACTIVE', aiMonthlyLimit: 3000, aiAgentAuto: false, aiAgentMode: false, sendingEnabled: false, agentAutoScope: 'DIALOGS' });
    expect(cl.setupPaidAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.paid' } })).toBe(1);
    o = (await http().get('/billing').set(auth(c.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'ACTIVE', checking: false, setupPaid: true, setupUah: null, limits: { users: 30, messagesPerMonth: 10000, aiRepliesPerMonth: 3000 } });

    // the next month: plan price only
    expect((await checkoutOrder(c.token, 'PRO')).params.amount).toBe(3990);
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

  it('два вікна оплати до першого підтвердження й обидва оплачені: підключення позначено один раз, друга плата записана й надіслана власнику сервісу на повернення', async () => {
    const c = await clinic();
    const a = await checkoutOrder(c.token, 'START');
    const b = await checkoutOrder(c.token, 'START');
    expect(a.params.amount).toBe(1990 + 4990);
    expect(b.params.amount).toBe(1990 + 4990);
    await pay(a.orderId, a.amountMinor).expect(200);
    const setupAt = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).setupPaidAt;
    await pay(b.orderId, b.amountMinor).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).setupPaidAt).toEqual(setupAt);
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'billing.setup_duplicate' } })).toBe(1);
    expect(toServiceOwner(b.orderId)).toHaveLength(1);
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

  it('тестовий режим LiqPay: лише поза production; статус sandbox у production не відкриває доступ', async () => {
    const c = await clinic();
    process.env.LIQPAY_SANDBOX = '1';
    const s = await checkoutOrder(c.token, 'START');
    expect(s.params.sandbox).toBe(1);
    expect((await http().get('/billing').set(auth(c.token)).expect(200)).body.sandbox).toBe(true);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const p = await checkoutOrder(c.token, 'START');
      expect(p.params.sandbox).toBeUndefined();
      await pay(p.orderId, p.amountMinor, 'sandbox').expect(200);
      expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('AWAITING_PAYMENT');
    } finally {
      process.env.NODE_ENV = env;
      delete process.env.LIQPAY_SANDBOX;
    }
    await pay(s.orderId, s.amountMinor, 'sandbox').expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).billingStatus).toBe('ACTIVE');
  });
});
