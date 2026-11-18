import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { BillingService } from '../src/billing/billing.service';
import { monoFixture } from './mono-fixture';
import { I18nExceptionFilter } from '../src/common/i18n';
import { NetworkService } from '../src/network/network.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { pinPlatformFixture } from './platform-fixture';

jest.setTimeout(120_000);

// Networks of clinics (2026-11-16). The model is a fake that returns a scripted report spec; mono is simulated with a test key; mail goes to the
// in-memory outbox. Nothing leaves the machine.
const mono = monoFixture();
let restoreMono: () => void;
const fake = { configured: true, seq: [] as string[], prompts: [] as string[], complete: async (system: string, messages: { content: string }[]) => {
  fake.prompts.push(JSON.stringify({ system, messages }));
  return { text: fake.seq.shift() ?? '{"answer":"ok","title":null,"spec":null}', inputTokens: 1, outputTokens: 1 };
} };
let app: INestApplication;
let prisma: PrismaService;
let restorePlatform: (() => Promise<void>) | undefined;
let mail: MailService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const ADMIN = `svc${rnd()}@example.com`;

beforeAll(async () => {
  restoreMono = mono.install();
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fake).compile()).createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});
afterAll(async () => {
  await restorePlatform?.();
  restoreMono?.();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  await app.close();
});

async function register(email = `n${rnd()}@example.com`, clinicName = `Клініка ${rnd()}`) {
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { token: res.body.accessToken as string, clinicId, email, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
}
const login = async (email: string, clinicId?: string) => {
  // a person with several clinics names the clinic at sign-in
  const r = (await http().post('/auth/login').send({ email, password: PASSWORD, ...(clinicId ? { clinicId } : {}) }).expect((x) => expect([200, 201]).toContain(x.status))).body;
  if (r.accessToken) return r.accessToken as string;
  const first = (r.clinics ?? r.choose ?? [])[0]?.id;
  return (await http().post('/auth/login').send({ email, password: PASSWORD, clinicId: first }).expect((x) => expect([200, 201]).toContain(x.status))).body.accessToken as string;
};
const member = async (owner: string, role: string, email = `r${rnd()}@example.com`) => {
  const inv = await http().post('/team/invitations').set(auth(owner)).send({ email, role }).expect(201);
  const acc = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201)).body.accessToken as string;
  return { token: acc, email, userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id };
};
const pay = (orderId: string, amountMinor: number) => {
  const raw = JSON.stringify(mono.event(orderId, amountMinor));
  return http().post('/billing/mono/webhook').set('Content-Type', 'application/json').set('X-Sign', mono.signature(raw)).send(raw);
};
const order = (body: { url: string }) => {
  const order_id = new URL(body.url).pathname.slice('/mono-'.length);
  return { order_id, amount: mono.invoices.get(order_id)!.amount / 100 };
};

// The service owner, a network owner with two clinics joined into a network
let platformUser: Awaited<ReturnType<typeof register>> | undefined;
async function setup() {
  if (!platformUser) {
    platformUser = await register(ADMIN);
    restorePlatform = await pinPlatformFixture(prisma, ADMIN);
  }
  const admin = platformUser;
  const owner = await register();
  const net = (await http().post('/platform/networks').set(auth(admin.token)).send({ name: `Мережа ${rnd()}`, ownerEmail: owner.email }).expect(201)).body as { id: string };
  // a second clinic of the same owner: created as a new branch of the network
  const b = (await http().post(`/network/${net.id}/branches`).set(auth(owner.token)).send({ name: 'Філіал Б', acceptTerms: true }).expect(201)).body as { id: string };
  await http().post(`/network/${net.id}/branches/attach`).set(auth(owner.token)).send({ clinicId: owner.clinicId }).expect(201);
  return { admin, owner, net: net.id, a: owner.clinicId, b: b.id };
}

describe('мережа: створення, приєднання, доступ', () => {
  it('мережу створює лише власник сервісу; власник клініки — ні; клініки самі не групуються', async () => {
    const someone = await register();
    await http().post('/platform/networks').set(auth(someone.token)).send({ name: 'Моя мережа', ownerEmail: someone.email }).expect(403);
    const s = await setup();
    // the owner's clinics are in it only because the owner joined them explicitly
    expect(await prisma.clinic.count({ where: { networkId: s.net } })).toBe(2);
    expect(await prisma.clinic.count({ where: { id: someone.clinicId, NOT: { networkId: null } } })).toBe(0);
  });

  it('приєднати можна лише власну клініку; клініка з власною оплаченою підпискою — лише з явним підтвердженням; інша мережа — ні', async () => {
    const s = await setup();
    const stranger = await register();
    await http().post(`/network/${s.net}/branches/attach`).set(auth(s.owner.token)).send({ clinicId: stranger.clinicId }).expect(403);
    // a manager of the network owner's clinic cannot attach it
    const mgr = await member(s.owner.token, 'MANAGER');
    await http().post(`/network/${s.net}/branches/attach`).set(auth(mgr.token)).send({ clinicId: s.a }).expect(404);
    // a paid standalone clinic of the owner
    const own = await prisma.clinic.create({ data: { name: 'Своя', billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 10 * 86_400_000), memberships: { create: { userId: s.owner.userId, role: 'OWNER' } } } });
    expect((await http().post(`/network/${s.net}/branches/attach`).set(auth(s.owner.token)).send({ clinicId: own.id }).expect(400)).body.message).toMatch(/власна оплачена підписка/);
    await http().post(`/network/${s.net}/branches/attach`).set(auth(s.owner.token)).send({ clinicId: own.id, confirmEndOwnSubscription: true }).expect(201);
    expect(await prisma.auditLog.findFirst({ where: { clinicId: own.id, action: 'network.branch_attached' } })).toMatchObject({ details: expect.objectContaining({ endedOwnSubscription: true }) });
    const other = (await http().post('/platform/networks').set(auth(s.admin.token)).send({ name: 'Інша', ownerEmail: s.owner.email }).expect(201)).body.id;
    await http().post(`/network/${other}/branches/attach`).set(auth(s.owner.token)).send({ clinicId: own.id }).expect(400);
  });

  it('доступ: лише учасник мережі й лише філіали, де в нього керівна роль; параметр branches не розширює; власник сервісу не бачить даних мережі', async () => {
    const s = await setup();
    // a manager of branch A who is also a member of the network; a doctor of branch B, also a member
    const mgr = await member(s.owner.token, 'MANAGER');
    const ownerB = await login(s.owner.email, s.b);
    const doc = await member(ownerB, 'DOCTOR');
    await prisma.networkMember.createMany({ data: [{ networkId: s.net, userId: mgr.userId, role: 'MEMBER' }, { networkId: s.net, userId: doc.userId, role: 'MEMBER' }] });
    const names = async (token: string, q = '') => ((await http().get(`/network/${s.net}/summary${q}`).set(auth(token)).expect(200)).body.branches as { id: string }[]).map((b) => b.id).sort();
    expect(await names(s.owner.token)).toEqual([s.a, s.b].sort());
    expect(await names(mgr.token)).toEqual([s.a]);
    expect(await names(mgr.token, `?branches=${s.b}`)).toEqual([]);
    expect(await names(doc.token)).toEqual([]);
    const stranger = await register();
    await http().get(`/network/${s.net}/summary`).set(auth(stranger.token)).expect(404);
    await http().get(`/network/${s.net}/summary`).set(auth(s.admin.token)).expect(404);
    // only the network's owner changes it
    await http().patch(`/network/${s.net}/digest`).set(auth(mgr.token)).send({ digest: 'OFF' }).expect(403);
    await http().post(`/network/${s.net}/branches`).set(auth(mgr.token)).send({ name: 'Новий', acceptTerms: true }).expect(403);
  });
});

describe('мережа: правила підрахунку', () => {
  it('лічильники додаються, частки — з доданих лічильників, а не середнє відсотків; пацієнти — записи, люди не поєднуються; гроші — за валютами', async () => {
    const s = await setup();
    await prisma.clinic.update({ where: { id: s.a }, data: { sourceCurrency: 'UAH' } });
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    const mk = async (clinicId: string, name: string, phone: string) => prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: name, phone, phoneNorm: phone.replace(/\D/g, ''), createdAtExt: ago(3) } });
    // the same person in both branches (same name, same phone): two records
    const pa = await mk(s.a, 'Олена Спільна', '+380501112233');
    const pb = await mk(s.b, 'Олена Спільна', '+380501112233');
    const visits = async (clinicId: string, patientId: string, visited: number, noShow: number) => {
      for (let i = 0; i < visited + noShow; i++) await prisma.visit.create({ data: { clinicId, patientId, externalId: `v${rnd()}`, startsAt: ago(2), status: i < visited ? 'VISITED' : 'DID_NOT_COME' } });
    };
    await visits(s.a, pa.id, 9, 1); // 10% no-shows
    await visits(s.b, pb.id, 1, 1); // 50% no-shows
    await prisma.payment.createMany({ data: [
      { clinicId: s.a, patientId: pa.id, externalId: `pay${rnd()}`, paidAt: ago(1), amount: 1000, currency: 'UAH' },
      { clinicId: s.b, patientId: pb.id, externalId: `pay${rnd()}`, paidAt: ago(1), amount: 40, currency: 'USD' },
    ] });
    const sum = (await http().get(`/network/${s.net}/summary?days=30`).set(auth(s.owner.token)).expect(200)).body;
    const a = sum.branches.find((b: { id: string }) => b.id === s.a);
    const b = sum.branches.find((x: { id: string }) => x.id === s.b);
    expect(a).toMatchObject({ visited: 9, noShow: 1, noShowRate: 10 });
    expect(b).toMatchObject({ visited: 1, noShow: 1, noShowRate: 50 });
    // 2 of 12, not (10 + 50) / 2 = 30
    expect(sum.total).toMatchObject({ visited: 10, noShow: 2, noShowRate: 16.7 });
    expect(sum.total.records).toBe(a.records + b.records);
    expect(sum.uniquePeople).toBeNull();
    expect(sum.total.paid).toEqual([{ currency: 'UAH', amount: 1000 }, { currency: 'USD', amount: 40 }]);
  });
});

describe('мережа: звіти, вивантаження, помічник', () => {
  it('готовий звіт по філіалах: колонка «Філіал», рядки кожного філіалу, валюта по рядках, правило про записи; файл пишеться в журнал кожного філіалу', async () => {
    const s = await setup();
    await prisma.clinic.update({ where: { id: s.a }, data: { sourceCurrency: 'UAH' } });
    await prisma.patient.create({ data: { clinicId: s.a, externalId: `d${rnd()}`, fullName: 'Борг А', balanceIssued: 500, balancePaid: 0, balanceCurrency: 'UAH' } });
    await prisma.patient.create({ data: { clinicId: s.b, externalId: `d${rnd()}`, fullName: 'Борг Б', balanceIssued: 300, balancePaid: 0 } });
    const r = (await http().get(`/network/${s.net}/reports/debtors`).set(auth(s.owner.token)).expect(200)).body;
    expect(r.columns[0]).toEqual({ key: 'branch', label: 'Філіал' });
    expect(r.rows.map((x: { fullName: string; branch: string }) => `${x.branch}:${x.fullName}`)).toEqual(expect.arrayContaining(['Філіал Б:Борг Б']));
    expect(r.rows.some((x: { fullName: string }) => x.fullName === 'Борг А')).toBe(true);
    expect(r.currency.state).toBe('mixed');
    expect(r.rule).toContain('записи філіалів');
    const csv = await http().get(`/network/${s.net}/reports/debtors/csv`).set(auth(s.owner.token)).expect(200);
    expect(csv.text.split('\r\n')[0]).toContain('"Філіал"');
    for (const id of [s.a, s.b]) expect(await prisma.auditLog.count({ where: { clinicId: id, action: 'report.exported', details: { path: ['network'], equals: s.net } } })).toBe(1);
    await http().get(`/network/${s.net}/reports/debtors/docx`).set(auth(s.owner.token)).expect(400);
  });

  it('помічник мережі: модель пише лише опис звіту, код рахує його в кожному доступному філіалі; люди не потрапляють у запит; потрібен «Про»-рівень і вхід у філіал мережі', async () => {
    const s = await setup();
    await prisma.patient.create({ data: { clinicId: s.a, externalId: `q${rnd()}`, fullName: 'Секретне Імʼя', source: 'Instagram' } });
    await prisma.patient.create({ data: { clinicId: s.b, externalId: `q${rnd()}`, fullName: 'Інше Секретне', source: 'Instagram' } });
    // the network is paid: both branches have the Pro-level plan, the assistant is switched on in the signed branch
    const co = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    await pay(order(co).order_id, Math.round(order(co).amount * 100)).expect(200);
    await prisma.clinic.update({ where: { id: s.a }, data: { aiEnabled: true, aiAssistantEnabled: true } });
    fake.seq = [JSON.stringify({ answer: 'Порахував пацієнтів за джерелом.', title: 'Джерела', spec: { dataset: 'patients', groupBy: { field: 'source' }, aggregates: [{ fn: 'count' }] } }), 'Instagram у обох філіалах.'];
    fake.prompts = [];
    const res = (await http().post(`/network/${s.net}/assistant`).set(auth(s.owner.token)).send({ question: 'скільки пацієнтів з Instagram у кожному філіалі?' }).expect(200)).body;
    expect(res.report.columns[0].key).toBe('branch');
    const branchesInRows = new Set(res.report.rows.map((r: { branch: string }) => r.branch));
    expect(branchesInRows.size).toBe(2);
    expect(fake.prompts.join(' ')).not.toContain('Секретне');
    // the model's work is counted against the signed-in branch
    expect(await prisma.aiUsage.count({ where: { clinicId: s.a } })).toBeGreaterThan(0);
    expect(await prisma.aiUsage.count({ where: { clinicId: s.b } })).toBe(0);
    // signed in to a clinic that is not a branch: refused
    const outside = await prisma.clinic.create({ data: { name: 'Поза мережею', memberships: { create: { userId: s.owner.userId, role: 'OWNER' } } } });
    const outsideToken = await login(s.owner.email, outside.id);
    await http().post(`/network/${s.net}/assistant`).set(auth(outsideToken)).send({ question: 'скільки пацієнтів?' }).expect(403);
  });
});

describe('мережа: оплата, права, дайджест', () => {
  it('7 990 за два філіали, +2 990 за кожен наступний, підключення 4 990 один раз; оплата дає філіалам рівень «Про» окремо кожному; власна оплата філіалу — ні; повтор — один раз', async () => {
    const s = await setup();
    let o = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body;
    expect(o).toMatchObject({ status: 'AWAITING_PAYMENT', branches: 2, monthlyUah: 7990, setupUah: 4990 });
    await http().post(`/network/${s.net}/branches`).set(auth(s.owner.token)).send({ name: 'Філіал В', acceptTerms: true }).expect(201);
    o = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body;
    expect(o.monthlyUah).toBe(7990 + 2990);
    // a branch is never paid on its own
    expect((await http().post('/billing/checkout').set(auth(s.owner.token)).send({ plan: 'PRO' }).expect(400)).body.message).toMatch(/мережею/);
    const mgr = await member(s.owner.token, 'MANAGER');
    await prisma.networkMember.create({ data: { networkId: s.net, userId: mgr.userId, role: 'MEMBER' } });
    await http().post(`/billing/network/${s.net}/checkout`).set(auth(mgr.token)).expect(403);

    const co = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    expect(order(co).amount).toBe(7990 + 2990 + 4990);
    await pay(order(co).order_id, Math.round(order(co).amount * 100)).expect(200);
    await pay(order(co).order_id, Math.round(order(co).amount * 100)).expect(200);
    const branches = await prisma.clinic.findMany({ where: { networkId: s.net } });
    expect(branches).toHaveLength(3);
    for (const b of branches) expect(b).toMatchObject({ plan: 'NETWORK', billingStatus: 'ACTIVE', aiMonthlyLimit: 3000, aiAgentAuto: false, sendingEnabled: false });
    expect(await prisma.auditLog.count({ where: { action: 'billing.paid', details: { path: ['networkId'], equals: s.net } } })).toBe(1);
    // Pro capabilities per branch: the assistant and the agent are in the plan; nothing is switched on
    expect((await http().get('/ai/agent').set(auth(s.owner.token)).expect(200)).body).toMatchObject({ inPlan: true, active: false });
    // next month: no onboarding again
    expect(order((await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body).amount).toBe(7990 + 2990);
  });

  it('підключення наступного філіалу — лише сума, яку погодив власник сервісу (від 2 990), один раз', async () => {
    const s = await setup();
    await http().post(`/billing/network/${s.net}/branch-setup/${s.b}`).set(auth(s.owner.token)).expect(400);
    await http().patch(`/platform/networks/${s.net}/branches/${s.b}`).set(auth(s.admin.token)).send({ setupQuoteUah: 1000 }).expect(400);
    await http().patch(`/platform/networks/${s.net}/branches/${s.b}`).set(auth(s.owner.token)).send({ setupQuoteUah: 3500 }).expect(403);
    await http().patch(`/platform/networks/${s.net}/branches/${s.b}`).set(auth(s.admin.token)).send({ setupQuoteUah: 3500 }).expect(200);
    expect((await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.branchSetups).toEqual([{ clinicId: s.b, name: 'Філіал Б', quoteUah: 3500 }]);
    const co = (await http().post(`/billing/network/${s.net}/branch-setup/${s.b}`).set(auth(s.owner.token)).expect(200)).body;
    expect(order(co).amount).toBe(3500);
    await pay(order(co).order_id, 350000).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: s.b } })).branchSetupPaidAt).not.toBeNull();
    await http().post(`/billing/network/${s.net}/branch-setup/${s.b}`).set(auth(s.owner.token)).expect(400);
  });

  it('строк мережі: усі філіали разом переходять у прострочку й блокування, власникові — один лист; дайджест мережі — раз на день у понеділок, неоплаченій — ні; від’єднаний філіал — знову окрема клініка', async () => {
    const s = await setup();
    const co = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    await pay(order(co).order_id, Math.round(order(co).amount * 100)).expect(200);
    // the digest: a Monday at 09:00 Kyiv
    const monday = new Date('2026-11-16T07:00:00Z');
    const before = mail.outbox.filter((m) => m.to === s.owner.email && m.subject.includes('дайджест мережі')).length;
    await app.get(NetworkService).digestTick(monday);
    await app.get(NetworkService).digestTick(new Date(monday.getTime() + 3600_000));
    const digests = mail.outbox.filter((m) => m.to === s.owner.email && m.subject.includes('дайджест мережі'));
    expect(digests.length - before).toBe(1);
    expect(digests[digests.length - 1].text).toContain('Мережа разом');
    expect(digests[digests.length - 1].text).toContain('записи філіалів');

    // the paid month ended long ago: past the grace days
    await prisma.network.update({ where: { id: s.net }, data: { paidUntil: new Date(Date.now() - 10 * 86_400_000) } });
    await app.get(BillingService).networkTick();
    await app.get(BillingService).networkTick();
    expect((await prisma.network.findUniqueOrThrow({ where: { id: s.net } })).billingStatus).toBe('LAPSED');
    expect(await prisma.clinic.count({ where: { networkId: s.net, billingStatus: 'LAPSED' } })).toBe(2);
    expect(mail.outbox.filter((m) => m.to === s.owner.email && m.subject.includes('оплата мережі'))).toHaveLength(1);
    await prisma.network.update({ where: { id: s.net }, data: { lastDigestAt: null } });
    await app.get(NetworkService).digestTick(new Date('2026-11-23T07:00:00Z'));
    expect(mail.outbox.filter((m) => m.to === s.owner.email && m.subject.includes('дайджест мережі')).length - before).toBe(1);

    await http().delete(`/network/${s.net}/branches/${s.b}`).set(auth(s.owner.token)).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: s.b } })).toMatchObject({ networkId: null, plan: 'START', billingStatus: 'AWAITING_PAYMENT' });
  });
});

describe('мережа: команда й умови оплати (2026-11-16)', () => {
  it('власник мережі дає керуючому доступ: звичайне запрошення у філіал, потім додати в мережу — лише ті філіали, де є роль; інших не додати; сторонній не може', async () => {
    const s = await setup();
    // the ordinary invitation in branch A's team (the owner is signed in to A)
    const mgr = await member(s.owner.token, 'MANAGER');
    await http().get(`/network/${s.net}/summary`).set(auth(mgr.token)).expect(404); // not a network member yet
    await http().post(`/network/${s.net}/members`).set(auth(s.owner.token)).send({ email: mgr.email }).expect(201);
    const seen = ((await http().get(`/network/${s.net}/summary`).set(auth(mgr.token)).expect(200)).body.branches as { id: string }[]).map((b) => b.id);
    expect(seen).toEqual([s.a]); // branch B is not granted by the network
    const list = (await http().get(`/network/${s.net}/members`).set(auth(s.owner.token)).expect(200)).body as { email: string; branches: { name: string; role: string }[] }[];
    expect(list.find((m) => m.email === mgr.email)?.branches).toEqual([{ name: expect.any(String), role: 'MANAGER' }]);
    // a person outside the network's teams cannot be added; only the network's owner adds or removes; the owner cannot be removed here
    const stranger = await register();
    await http().post(`/network/${s.net}/members`).set(auth(s.owner.token)).send({ email: stranger.email }).expect(400);
    await http().post(`/network/${s.net}/members`).set(auth(mgr.token)).send({ email: stranger.email }).expect(403);
    await http().delete(`/network/${s.net}/members/${s.owner.userId}`).set(auth(s.owner.token)).expect(400);
    await http().delete(`/network/${s.net}/members/${mgr.userId}`).set(auth(s.owner.token)).expect(200);
    await http().get(`/network/${s.net}/summary`).set(auth(mgr.token)).expect(404);
  });

  it('до оплати видно: сума зараз, період, підключення окремо, наступне продовження; приєднана клініка отримує доступ мережі лише після підтвердженої оплати, що її включає', async () => {
    const s = await setup();
    let np = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment;
    expect(np).toMatchObject({ chargeNowUah: 7990 + 4990, monthlyUah: 7990, setupUah: 4990, renewal: { amountUah: 7990 } });
    expect(new Date(np.coversTo).getTime()).toBeGreaterThan(new Date(np.coversFrom).getTime());
    expect(np.branchesGettingAccess).toHaveLength(2);
    const first = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    await pay(order(first).order_id, Math.round(order(first).amount * 100)).expect(200);
    const until = (await prisma.network.findUniqueOrThrow({ where: { id: s.net } })).paidUntil!;

    // a paid clinic of the owner joins mid-period: it keeps its own state until the network payment that includes it
    const own = await prisma.clinic.create({ data: { name: 'Третя', billingStatus: 'ACTIVE', plan: 'START', paidUntil: new Date(Date.now() + 5 * 86_400_000), memberships: { create: { userId: s.owner.userId, role: 'OWNER' } } } });
    await http().post(`/network/${s.net}/branches/attach`).set(auth(s.owner.token)).send({ clinicId: own.id, confirmEndOwnSubscription: true }).expect(201);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ plan: 'START', billingStatus: 'ACTIVE' });
    np = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment;
    // no onboarding again; three branches; it covers the month after the paid period; the third branch is the one getting access
    expect(np).toMatchObject({ chargeNowUah: 7990 + 2990, setupUah: null, renewal: { amountUah: 7990 + 2990 }, branchesGettingAccess: ['Третя'] });
    expect(new Date(np.coversFrom).getTime()).toBe(until.getTime());
    const next = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    expect(order(next).amount).toBe(np.chargeNowUah);
    await pay(order(next).order_id, Math.round(order(next).amount * 100)).expect(200);
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ plan: 'NETWORK', billingStatus: 'ACTIVE' });
    expect((await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment.branchesGettingAccess).toEqual([]);
  });
});

describe('мережа: передоплата наступного періоду (правило власника, 2026-11-16)', () => {
  it('один період купується один раз: друге вікно оплати не відкривається, два оплачені вікна не дають період двічі; після передоплати новий філіал — через підтримку, без нового списання', async () => {
    const s = await setup();
    const first = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    // The same purchase resumes the existing invoice.
    expect((await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body).toEqual(first);
    const stranger = await register();
    await http().get(`/billing/network/${s.net}/payments/${first.id}`).set(auth(stranger.token)).expect(404);
    await http().get(`/billing/network/${s.net}/payments/${first.id}`).set(auth(s.owner.token)).expect(200).expect(({ body }) => expect(body.status).toBe('PENDING'));
    expect((await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment.blocked).toBe('payment_pending');
    await pay(order(first).order_id, Math.round(order(first).amount * 100)).expect(200);
    const until1 = (await prisma.network.findUniqueOrThrow({ where: { id: s.net } })).paidUntil!;

    // a new branch during the paid period: the owner prepays the next period at the new price; access is complimentary until it starts
    await http().post(`/network/${s.net}/branches`).set(auth(s.owner.token)).send({ name: 'Філіал Новий', acceptTerms: true }).expect(201);
    const np = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment;
    expect(np).toMatchObject({ chargeNowUah: 7990 + 2990, blocked: null, branchesGettingAccess: ['Філіал Новий'] });
    expect(np.branchesCovered).toHaveLength(3);
    expect(new Date(np.coversFrom).getTime()).toBe(until1.getTime());
    expect(new Date(np.complimentaryUntil).getTime()).toBe(until1.getTime());

    // two windows for that same next period (the second created directly, as if opened in another tab before the guard), both paid
    const a = (await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(200)).body;
    const dupOrder = `lanka-dup-${Date.now()}`;
    const orderA = await prisma.billingPayment.findUniqueOrThrow({ where: { orderId: order(a).order_id } });
    await prisma.billingPayment.create({ data: { clinicId: orderA.clinicId, networkId: s.net, orderId: dupOrder, kind: 'NETWORK', plan: 'NETWORK', amountMinor: orderA.amountMinor, setupMinor: 0, periodFrom: orderA.periodFrom, monoExpiresAt: orderA.monoExpiresAt, branchIds: orderA.branchIds } });
    await pay(order(a).order_id, orderA.amountMinor).expect(200);
    const until2 = (await prisma.network.findUniqueOrThrow({ where: { id: s.net } })).paidUntil!;
    expect(until2.getTime()).toBeGreaterThan(until1.getTime());
    expect((await prisma.clinic.findFirstOrThrow({ where: { networkId: s.net, name: 'Філіал Новий' } })).billingStatus).toBe('ACTIVE');
    await pay(dupOrder, orderA.amountMinor).expect(200);
    await pay(dupOrder, orderA.amountMinor).expect(200); // and mono repeating that callback changes nothing either
    expect((await prisma.network.findUniqueOrThrow({ where: { id: s.net } })).paidUntil!.getTime()).toBe(until2.getTime());
    expect(await prisma.auditLog.count({ where: { action: 'billing.period_duplicate', details: { path: ['orderId'], equals: dupOrder } } })).toBe(1);

    // the next period is prepaid now: no further purchase; a branch added now is named and sent to support, nothing is charged
    expect((await http().post(`/billing/network/${s.net}/checkout`).set(auth(s.owner.token)).expect(400)).body.message).toMatch(/hello@lankaclinic\.app/);
    await http().post(`/network/${s.net}/branches`).set(auth(s.owner.token)).send({ name: 'Філіал Пізній', acceptTerms: true }).expect(201);
    const after = (await http().get(`/billing/network/${s.net}`).set(auth(s.owner.token)).expect(200)).body.nextPayment;
    expect(after).toMatchObject({ blocked: 'next_period_paid', uncoveredAfterPrepaid: ['Філіал Пізній'], branchesGettingAccess: [] });
  });
});
