import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AgentApprovalService } from '../src/automations/agent-approval.service';
import { SendError } from '../src/automations/channels';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Stage 2: review and approval of the agent's draft by a staff member. The model is scripted, the transport is a fake that can fail, answer "unknown" or be slow,
// Cliniccards is the mock. Nothing here proves the quality of a real model.
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

const fake = { configured: true, script: (() => '') as () => string, complete: async () => ({ text: fake.script(), inputTokens: 1, outputTokens: 1 }) };
type Mode = 'ok' | 'fail' | 'ambiguous' | 'slow';
const transport = { mode: 'ok' as Mode, sent: [] as { chatId: string; text: string; options: { label: string; date: string; time: string }[] }[] };

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(fake).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    if (transport.mode === 'slow') await new Promise((r) => setTimeout(r, 250));
    if (transport.mode === 'fail') throw new SendError('provider refused the message', false);
    if (transport.mode === 'ambiguous') throw new SendError('no answer from the provider', false, 'failed', true);
    transport.sent.push({ chatId, text, options: options.map((o) => ({ label: o.label, date: o.date, time: o.time })) });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
});
beforeEach(() => {
  transport.mode = 'ok';
  transport.sent.length = 0;
  mock.writes.length = 0;
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

const agentClinic = (o: Parameters<typeof createAgentClinic>[1] = {}) => createAgentClinic({ http, prisma }, o);
type C = AgentClinic;
const incoming = (c: C, text: string, chat = c.chat) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: chat, direction: 'IN', text } });
const refOf = async (c: C, title: string) => (await app.get(KbService).factsFor(c.clinicId, new Date(), '', '')).items.find((x) => x.title === title)!.ref;
const decision = (content: Record<string, unknown>, next: Record<string, unknown> = {}) =>
  JSON.stringify({ content: { kind: 'ANSWER', reply: 'Добрий день!', prices: [], after: '', ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });

interface View { id: string; revision: number; status: string; allowed: string[]; kind: string; options: string[]; previews: Record<string, string>; stale: { stale: boolean; reasons: string[] }; unsupported: boolean; handoffReason: string | null }
const make = async (c: C, chat = c.chat): Promise<View> => (await http().post(`/conversations/INSTAGRAM/${chat}/draft`).set(auth(c.token)).expect(200)).body;
const approve = (c: C, v: { id: string; revision: number }, choice: string, extra: object = {}, token = c.token) => http().post(`/agent-drafts/${v.id}/approve`).set(auth(token)).send({ revision: v.revision, choice, ...extra });
const rows = (c: C, model: 'chatMessage' | 'funnelEvent' | 'conversationState' | 'bookingRequest' | 'bookingAttempt' | 'agentDraft') => (prisma[model] as unknown as { count: (a: object) => Promise<number> }).count({ where: { clinicId: c.clinicId } });
async function invite(c: C, role: string) {
  const email = `r${rnd()}@example.com`;
  const inv = await http().post('/team/invitations').set(auth(c.token)).send({ email, role }).expect(201);
  const acc = await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Колега', password: PASSWORD }).expect(201);
  return acc.body.accessToken as string;
}
// a clinic with a ready "price + times" draft
async function priceDraft(opts: Parameters<typeof createAgentClinic>[1] = {}) {
  const c = await agentClinic(opts);
  const s = await refOf(c, 'Тестова консультація');
  await incoming(c, 'Скільки коштує тестова консультація?');
  fake.script = () => decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
  return { c, s, v: await make(c) };
}

describe('перегляд і одобрення чернетки агента співробітником', () => {
  it('чернетка зберігається на сервері для перегляду; генерація нічого не виконує; видно, що отримає пацієнт і які вікна пропонуються; технічних позначок немає', async () => {
    const { c, v } = await priceDraft();
    expect(v).toMatchObject({ status: 'PENDING', kind: 'times', allowed: ['SEND_TIMES'], unsupported: false, stale: { stale: false, reasons: [] } });
    expect(v.options.length).toBeGreaterThan(0);
    expect(v.previews.SEND_TIMES).toContain('100 грн');
    expect(JSON.stringify(v)).not.toMatch(/\bS\d+\b|OFFER_TIME|serviceId|clinicId/); // no internal reference and no technical enum for the screen
    expect(transport.sent).toHaveLength(0);
    expect(await rows(c, 'agentDraft')).toBe(1);
    expect(await rows(c, 'bookingRequest')).toBe(0);
    expect((await http().get('/agent-drafts/latest').query({ channel: 'INSTAGRAM', chatId: c.chat }).set(auth(c.token)).expect(200)).body.draft.id).toBe(v.id);
  });

  it('одобрення «Відправити варіанти часу»: рівно одна відправка зі збереженим текстом і кнопками; пам’ять діалогу оновлена без аналітики; візит не створюється', async () => {
    const { c, v } = await priceDraft(); // the collection of funnel events is OFF
    const res = (await approve(c, v, 'SEND_TIMES').expect(200)).body;
    expect(res).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toBe(v.previews.SEND_TIMES);
    expect(transport.sent[0].options.map((o) => o.label)).toEqual(v.options);
    const msg = await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, direction: 'OUT' } });
    expect(msg).toMatchObject({ authorUserId: c.userId, error: null, text: v.previews.SEND_TIMES });
    expect((msg.buttons as { payload: string }[]).every((b) => b.payload.startsWith('slot|'))).toBe(true);
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'SENT', choice: 'SEND_TIMES', approvedById: c.userId, messageId: msg.id });
    // the memory of the agent works with the analytics switch off
    const state = await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(state).toMatchObject({ salesStage: 'OFFERED', serviceId: c.consult.id, owner: 'BOT', version: 1, lastDecisionMessageId: msg.id });
    expect(await rows(c, 'funnelEvent')).toBe(0);
    // no visit, no booking attempt, nothing written to Cliniccards, no request
    expect(await rows(c, 'bookingAttempt')).toBe(0);
    expect(await rows(c, 'bookingRequest')).toBe(0);
    expect(mock.writes).toHaveLength(0);
  });

  it('аналітика ввімкнена: показ часу записується подією один раз; повторний запит нічого не дублює', async () => {
    const { c, v } = await priceDraft({ events: true });
    await approve(c, v, 'SEND_TIMES').expect(200);
    const again = (await approve(c, v, 'SEND_TIMES').expect(200)).body;
    expect(again).toMatchObject({ ok: true, outcome: 'SENT', already: true });
    expect(transport.sent).toHaveLength(1);
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'TIME_OFFERED' } })).toBe(1);
  });

  it('два одночасні запити на одобрення: одна відправка, інший отримує «вже виконується» або результат першого', async () => {
    transport.mode = 'slow';
    const { c, v } = await priceDraft();
    const [a, b] = await Promise.all([approve(c, v, 'SEND_TIMES'), approve(c, v, 'SEND_TIMES')]);
    expect(transport.sent).toHaveLength(1);
    const outcomes = [a.body, b.body].map((x) => (x.ok ? 'SENT' : x.code));
    expect(outcomes.sort()).toEqual(['SENT', 'in_progress'].sort());
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT' } })).toBe(1);
  });

  it('«Відправити відповідь» для звичайної відповіді; «Передати адміністратору»: заявка створюється ДО повідомлення, текст у минулому часі правдивий, стан HANDED', async () => {
    const c = await agentClinic({ events: true });
    await incoming(c, 'Мені потрібна консультація щодо мого минулого лікування');
    fake.script = () => decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'identity_needed' });
    const v = await make(c);
    expect(v).toMatchObject({ kind: 'handoff', handoffReason: 'identity_needed' });
    expect(v.allowed).toEqual(['HAND_OFF', 'SEND_REPLY']);
    expect(v.previews.SEND_REPLY).toMatch(/Якщо хочете, ми передамо/); // the offer, as a plain reply
    expect(v.previews.HAND_OFF).toBe('Передали ваше запитання адміністратору клініки.'); // true only after the hand-over
    expect(await rows(c, 'bookingRequest')).toBe(0);
    const res = (await approve(c, v, 'HAND_OFF').expect(200)).body;
    expect(res).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(transport.sent[0].text).toBe('Передали ваше запитання адміністратору клініки.');
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    expect(req).toMatchObject({ kind: 'HANDOFF', status: 'NEW', channel: 'INSTAGRAM', chatId: c.chat });
    expect((await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } })).salesStage).toBe('HANDED');
    expect(await prisma.funnelEvent.count({ where: { clinicId: c.clinicId, kind: 'HANDED_OFF', refKey: req.id } })).toBe(1);
    expect(await rows(c, 'bookingAttempt')).toBe(0);
    // an ordinary reply
    const c2 = await agentClinic();
    await incoming(c2, 'Розкажіть про консультацію');
    fake.script = () => decision({ reply: 'Консультація триває близько 30 хвилин.' });
    const v2 = await make(c2);
    expect(v2).toMatchObject({ kind: 'reply', allowed: ['SEND_REPLY'] });
    await approve(c2, v2, 'SEND_REPLY').expect(200);
    expect(transport.sent.at(-1)!.text).toBe('Консультація триває близько 30 хвилин.');
    expect(await rows(c2, 'bookingRequest')).toBe(0);
  });

  it('нове повідомлення пацієнта чи відповідь іншого співробітника роблять чернетку застарілою: нічого не відправляється, після оновлення одобрення працює', async () => {
    const { c, v } = await priceDraft();
    await incoming(c, 'Ще одне питання');
    const refused = (await approve(c, v, 'SEND_TIMES').expect(200)).body;
    expect(refused).toMatchObject({ ok: false, outcome: 'REFUSED', code: 'stale', reasons: ['new_incoming_message'] });
    expect(refused.draft.stale.stale).toBe(true);
    expect(transport.sent).toHaveLength(0);
    // another staff member answered by hand
    const c2 = await priceDraft();
    await prisma.chatMessage.create({ data: { clinicId: c2.c.clinicId, channel: 'INSTAGRAM', chatId: c2.c.chat, direction: 'OUT', text: 'Відповідаю вручну', authorUserId: c2.c.userId } });
    expect((await approve(c2.c, c2.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'stale', reasons: ['staff_replied'] });
    expect(transport.sent).toHaveLength(0);
    // regenerate: the new draft is approvable, the old one is superseded
    fake.script = () => decision({ reply: 'Відповідь на нове питання.' });
    const fresh = await make(c);
    expect((await prisma.agentDraft.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('SUPERSEDED');
    expect((await approve(c, fresh, 'SEND_REPLY').expect(200)).body.outcome).toBe('SENT');
  });

  it('змінилася ціна послуги: чернетка недійсна (нічого не відправлено); змінилися вікна: нові варіанти показуються заново й потребують нового одобрення', async () => {
    const a = await priceDraft();
    await prisma.kbItem.update({ where: { id: a.c.consult.id }, data: { priceUah: 150 } });
    expect((await approve(a.c, a.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'content_changed' });
    expect(transport.sent).toHaveLength(0);
    // the first offered time is taken in Cliniccards meanwhile
    const b = await priceDraft();
    const first = (await prisma.agentDraft.findUniqueOrThrow({ where: { id: b.v.id } })).snapshot as { options: { date: string; time: string }[] };
    const at = first.options[0];
    for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `7${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${at.date} ${at.time}:00`, visit_end: `${at.date} ${at.time}:00`.replace(/:00$/, ':00'), note: 'busy', price_items: null, date_created: `${at.date} 08:00:00`, date_edited: `${at.date} 08:00:00` });
    // the visit occupies the cabinets for 30 minutes
    for (const v of mock.data.visits.slice(-2)) v.visit_end = `${at.date} ${String(Number(at.time.slice(0, 2)) + (at.time.slice(3) === '30' ? 1 : 0)).padStart(2, '0')}:${at.time.slice(3) === '30' ? '00' : '30'}:00`;
    const changed = (await approve(b.c, b.v, 'SEND_TIMES').expect(200)).body;
    expect(changed).toMatchObject({ ok: false, outcome: 'REFUSED', code: 'options_changed' });
    expect(transport.sent).toHaveLength(0); // the changed times were NOT sent
    expect(changed.draft.revision).toBe(b.v.revision + 1);
    expect(changed.draft.options).not.toEqual(b.v.options);
    // the old revision cannot be approved; the new one, once seen, can
    expect((await approve(b.c, b.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'revision_changed' });
    expect(transport.sent).toHaveLength(0);
    const ok = (await approve(b.c, changed.draft, 'SEND_TIMES').expect(200)).body;
    expect(ok.outcome).toBe('SENT');
    expect(transport.sent[0].options.map((o) => o.label)).toEqual(changed.draft.options);
    // no window at all any more: the draft is refused
    const d = await priceDraft();
    const sentBefore = transport.sent.length;
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { workHours: {} } });
    await http().put('/clinic/work-hours').set(auth(d.c.token)).send({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null }).expect(200);
    expect((await approve(d.c, d.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'options_unavailable' });
    expect(transport.sent).toHaveLength(sentBefore);
  });

  it('підміна браузером: текст, дія, вікна, ціна й clinicId у тілі ігноруються; кнопка, якої немає для цієї чернетки, відхиляється; чужа клініка й права', async () => {
    const { c, v } = await priceDraft();
    // a button that does not exist for this draft
    expect((await approve(c, v, 'HAND_OFF').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'not_allowed' });
    expect((await approve(c, v, 'SEND_REPLY').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'not_allowed' });
    await approve(c, v, 'DELETE_EVERYTHING').expect(400); // not a button at all
    // extra fields from the browser change nothing
    const forged = { text: 'ІНШИЙ ТЕКСТ ВІД БРАУЗЕРА', action: 'HAND_OFF', options: [{ label: 'підмінений', date: '2030-01-01', time: '03:00' }], price: 1, clinicId: 'x', slot: '2030-01-01 03:00' };
    expect((await approve(c, v, 'SEND_TIMES', forged).expect(200)).body.outcome).toBe('SENT');
    expect(transport.sent[0].text).toBe(v.previews.SEND_TIMES);
    expect(transport.sent[0].text).not.toContain('БРАУЗЕРА');
    expect(transport.sent[0].options.map((o) => o.label)).toEqual(v.options);
    expect(await rows(c, 'bookingRequest')).toBe(0);
    // another clinic cannot see, approve or reject it
    const other = await agentClinic({ name: 'LANKA Agent Test B' });
    const p2 = await priceDraft();
    await approve(p2.c, p2.v, 'SEND_TIMES', {}, other.token).expect(404);
    await http().post(`/agent-drafts/${p2.v.id}/reject`).set(auth(other.token)).expect(404);
    expect((await http().get('/agent-drafts/latest').query({ channel: 'INSTAGRAM', chatId: p2.c.chat }).set(auth(other.token)).expect(200)).body.draft).toBeNull();
    // insufficient rights: an analyst and a doctor
    for (const role of ['ANALYST', 'DOCTOR']) {
      const t = await invite(p2.c, role);
      await approve(p2.c, p2.v, 'SEND_TIMES', {}, t).expect(403);
      await http().post(`/agent-drafts/${p2.v.id}/reject`).set(auth(t)).expect(403);
    }
    expect(transport.sent).toHaveLength(1); // only the first, legitimate one
    // a manager and an administrator may
    const mgr = await invite(p2.c, 'MANAGER');
    expect((await approve(p2.c, p2.v, 'SEND_TIMES', {}, mgr).expect(200)).body.outcome).toBe('SENT');
  });

  it('відправка вимкнена, режим агента вимкнено, пацієнт відписаний: одобрення відхиляється з причиною, нічого не відправлено; старий інтерфейс без агента не змінюється', async () => {
    const a = await priceDraft();
    await prisma.clinic.update({ where: { id: a.c.clinicId }, data: { sendingEnabled: false } });
    expect((await approve(a.c, a.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'sending_disabled' });
    const b = await priceDraft();
    await prisma.patientChannel.create({ data: { clinicId: b.c.clinicId, patientId: (await prisma.patient.findFirstOrThrow({ where: { clinicId: b.c.clinicId } })).id, channel: 'INSTAGRAM', externalId: b.c.chat, optedOutAt: new Date() } });
    expect((await approve(b.c, b.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'opted_out' });
    const c = await priceDraft();
    await prisma.clinic.update({ where: { id: c.c.clinicId }, data: { aiAgentMode: false } });
    expect((await approve(c.c, c.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'agent_mode_off' });
    // paid, the launch is being prepared: the draft can be made and read, an approval executes nothing even with sending on
    const d = await priceDraft();
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { billingStatus: 'LAUNCH_PENDING' } });
    expect((await approve(d.c, d.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'sending_disabled' });
    expect(transport.sent).toHaveLength(0);
    // without the agent the draft endpoint is the old one (its shape) and nothing is stored
    const plain = await agentClinic({ agent: false });
    await incoming(plain, 'Добрий день');
    fake.script = () => JSON.stringify({ intent: 'info', reply: 'Добрий день!', summary: null, service: '', options: [] });
    const old = (await http().post(`/conversations/INSTAGRAM/${plain.chat}/draft`).set(auth(plain.token)).expect(200)).body;
    expect(old).toMatchObject({ intent: 'info', reply: 'Добрий день!' });
    expect(old).not.toHaveProperty('revision');
    expect(await rows(plain, 'agentDraft')).toBe(0);
  });

  it('помилка відправки (чітка відмова) і невідомий результат: стан не змінюється, подій немає, «невідомо» не повторюється й не видається за успіх', async () => {
    const f = await priceDraft({ events: true });
    transport.mode = 'fail';
    expect((await approve(f.c, f.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ ok: false, outcome: 'FAILED' });
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: f.v.id } })).toMatchObject({ status: 'FAILED' });
    expect(await rows(f.c, 'conversationState')).toBe(0);
    expect(await rows(f.c, 'funnelEvent')).toBe(0);
    expect((await prisma.chatMessage.findFirstOrThrow({ where: { clinicId: f.c.clinicId, direction: 'OUT' } })).error).toBeTruthy(); // visible in the thread as a failed send
    // unknown: the provider gave no clear answer
    const u = await priceDraft({ events: true });
    transport.mode = 'ambiguous';
    const unknown = (await approve(u.c, u.v, 'SEND_TIMES').expect(200)).body;
    expect(unknown).toMatchObject({ ok: false, outcome: 'UNKNOWN' });
    expect(unknown.outcome).not.toBe('SENT');
    transport.mode = 'ok';
    const again = (await approve(u.c, u.v, 'SEND_TIMES').expect(200)).body; // pressing again does NOT send again
    expect(again).toMatchObject({ ok: false, outcome: 'UNKNOWN', already: true });
    expect(transport.sent).toHaveLength(0);
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: u.v.id } })).toMatchObject({ status: 'UNKNOWN', error: 'result_unknown' });
    expect(await rows(u.c, 'conversationState')).toBe(0);
    expect(await rows(u.c, 'funnelEvent')).toBe(0);
    // an approval that stopped half-way (stuck in "approving") is unknown too: it is never resent
    const s = await priceDraft();
    await prisma.agentDraft.update({ where: { id: s.v.id }, data: { status: 'APPROVING', updatedAt: new Date(Date.now() - 5 * 60_000) } });
    // updatedAt is managed by Prisma: force the old value in the database
    await prisma.$executeRawUnsafe(`update "AgentDraft" set "updatedAt" = now() - interval '5 minutes' where id = $1`, s.v.id);
    expect((await approve(s.c, s.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'UNKNOWN' });
    expect(transport.sent).toHaveLength(0);
  });

  it('відхилення чернетки: нічого не відправляється, заявки, стану й подій немає; відхилену не можна одобрити', async () => {
    const { c, v } = await priceDraft({ events: true });
    expect((await http().post(`/agent-drafts/${v.id}/reject`).set(auth(c.token)).expect(200)).body).toMatchObject({ ok: true, status: 'REJECTED' });
    expect(transport.sent).toHaveLength(0);
    expect(await rows(c, 'bookingRequest')).toBe(0);
    expect(await rows(c, 'conversationState')).toBe(0);
    expect(await rows(c, 'funnelEvent')).toBe(0);
    expect(await rows(c, 'chatMessage')).toBe(1); // only the patient's incoming message
    expect((await approve(c, v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'not_active' });
    expect((await http().get('/agent-drafts/latest').query({ channel: 'INSTAGRAM', chatId: c.chat }).set(auth(c.token)).expect(200)).body.draft).toBeNull();
  });

  it('власник діалогу — людина не забороняє одобрення співробітником, і одобрення не повертає діалог боту (власник не змінюється)', async () => {
    const c = await agentClinic();
    await prisma.conversationState.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, owner: 'HUMAN' } });
    await incoming(c, 'Розкажіть про консультацію');
    fake.script = () => decision({ reply: 'Консультація триває близько 30 хвилин.' });
    const v = await make(c);
    expect(v.stale.stale).toBe(false);
    expect((await approve(c, v, 'SEND_REPLY').expect(200)).body.outcome).toBe('SENT');
    expect((await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } })).owner).toBe('HUMAN');
  });

  it('дія, яку ще не можна виконувати з чернетки (підтвердження згоди), показується як недоступна й не виконується; візит не створюється', async () => {
    const c = await agentClinic();
    // a time was already chosen in a request: the model asks to ASK_CONSENT
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'x', service: 'Тестова консультація', slotAt: new Date(Date.now() + 2 * 86_400_000), stage: 'COLLECT' } });
    await incoming(c, 'Так, на цей час підходить');
    fake.script = () => decision({ reply: 'Чудово!' }, { action: 'ASK_CONSENT' });
    const v = await make(c);
    expect(v).toMatchObject({ kind: 'unsupported', unsupported: true, allowed: [] });
    expect((await approve(c, v, 'SEND_REPLY').expect(200)).body).toMatchObject({ outcome: 'REFUSED', code: 'unsupported' });
    expect(transport.sent).toHaveLength(0);
    expect(await rows(c, 'bookingAttempt')).toBe(0);
    expect(mock.writes).toHaveLength(0);
  });

  it('уточнююче питання лишає слід у пам’яті (лічильник); видалення за запитом і строк зберігання прибирають чернетки', async () => {
    const c = await agentClinic();
    await incoming(c, 'Хочу до лікаря');
    fake.script = () => decision({ kind: 'CLARIFY', reply: 'Підкажіть, будь ласка, яка послуга вам потрібна?' });
    const v = await make(c);
    await approve(c, v, 'SEND_REPLY').expect(200);
    expect(await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ clarifyCount: 1, salesStage: 'DISCOVERY' });
    // a simple generation or a rejection never moves the counters (see the rejection test); here: retention
    const old = await priceDraft();
    await prisma.$executeRawUnsafe(`update "AgentDraft" set "createdAt" = now() - interval '40 days' where id = $1`, old.v.id);
    expect((await app.get(AgentApprovalService).purge()).count).toBeGreaterThanOrEqual(1);
    expect(await prisma.agentDraft.findUnique({ where: { id: old.v.id } })).toBeNull();
    expect(await prisma.agentDraft.findUnique({ where: { id: v.id } })).not.toBeNull();
  });

  it('генерація сама нічого не виконує навіть при aiAutoReply: чернетка створена, повідомлень немає', async () => {
    const { c } = await priceDraft({ autoReply: true, events: true });
    expect(transport.sent).toHaveLength(0);
    expect(await rows(c, 'funnelEvent')).toBe(0);
    expect(await rows(c, 'conversationState')).toBe(0);
    expect(app.get(AgentDraftService)).toBeTruthy();
    expect(localToUtc(`${clinicDate(new Date())} 00:00:00`)).toBeTruthy();
  });

  it('UNKNOWN → новий чернетка: те саме дію не можна схвалити, поки людина не перевірила доставку; діалог не блокується назавжди', async () => {
    const u = await priceDraft({ events: true });
    transport.mode = 'ambiguous';
    expect((await approve(u.c, u.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ outcome: 'UNKNOWN' });
    transport.mode = 'ok';
    // a new draft of the same action is made; the screen is told that the delivery has to be checked
    const s = u.s;
    fake.script = () => decision({ reply: 'Дякуємо за запитання.', prices: [s] }, { action: 'OFFER_TIME', service: s });
    const fresh = await make(u.c);
    expect(fresh.id).not.toBe(u.v.id);
    const latest = (await http().get(`/agent-drafts/latest?channel=INSTAGRAM&chatId=${u.c.chat}`).set(auth(u.c.token)).expect(200)).body.draft;
    expect(latest.id).toBe(fresh.id);
    expect(latest.unverified).toMatchObject({ id: u.v.id, choice: 'SEND_TIMES' });
    // approving the same action again is refused, nothing is sent, the new draft stays usable
    const refused = (await approve(u.c, fresh, 'SEND_TIMES').expect(200)).body;
    expect(refused).toMatchObject({ ok: false, outcome: 'REFUSED', code: 'delivery_unverified' });
    expect(transport.sent).toHaveLength(0);
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ status: 'PENDING' });
    // another person's resolve in another clinic changes nothing
    const o = await agentClinic();
    await http().post(`/agent-drafts/${u.v.id}/resolve`).set(auth(o.token)).send({ outcome: 'NOT_DELIVERED' }).expect(404);
    // the person checked the chat: the message did not arrive; now the same action can be approved
    expect((await http().post(`/agent-drafts/${u.v.id}/resolve`).set(auth(u.c.token)).send({ outcome: 'NOT_DELIVERED' }).expect(200)).body).toMatchObject({ ok: true, status: 'CLEARED' });
    const next = (await approve(u.c, fresh, 'SEND_TIMES').expect(200)).body;
    expect(next).toMatchObject({ ok: true, outcome: 'SENT' });
    expect(transport.sent).toHaveLength(1);
    expect(await rows(u.c, 'funnelEvent')).toBe(1); // only the real send is counted, once
    // the dialogue was never blocked as a whole: the manual reply works
    await http().post(`/conversations/INSTAGRAM/${u.c.chat}/reply`).set(auth(u.c.token)).send({ text: 'Перевіряємо, чи дійшло повідомлення' }).expect(200);
    // a second resolve of the same unknown draft does nothing
    expect((await http().post(`/agent-drafts/${u.v.id}/resolve`).set(auth(u.c.token)).send({ outcome: 'DELIVERED' }).expect(200)).body).toMatchObject({ ok: false });
  });

  it('UNKNOWN → «доставлено»: чернетка закривається як надіслана один раз, нова того самого дії не відправляється', async () => {
    const u = await priceDraft({ events: true });
    transport.mode = 'ambiguous';
    await approve(u.c, u.v, 'SEND_TIMES').expect(200);
    transport.mode = 'ok';
    expect((await http().post(`/agent-drafts/${u.v.id}/resolve`).set(auth(u.c.token)).send({ outcome: 'DELIVERED' }).expect(200)).body).toMatchObject({ ok: true, status: 'SENT' });
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: u.v.id } })).toMatchObject({ status: 'SENT' });
    expect(await rows(u.c, 'funnelEvent')).toBe(1);
    expect((await prisma.conversationState.findFirstOrThrow({ where: { clinicId: u.c.clinicId } })).salesStage).toBe('OFFERED');
    // the message with the unknown result is no longer shown as a failure
    expect(await prisma.chatMessage.count({ where: { clinicId: u.c.clinicId, direction: 'OUT', error: { not: null } } })).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('збій між відправкою і збереженням результату: SENT лише за збереженим підтвердженням каналу цієї спроби; повідомлення в нашій таблиці саме по собі нічого не доводить', async () => {
    const stall = async (id: string) => {
      await prisma.agentDraft.update({ where: { id }, data: { status: 'APPROVING', messageId: null, error: null } });
      await prisma.$executeRawUnsafe(`update "AgentDraft" set "updatedAt" = now() - interval '5 minutes' where id = $1`, id);
    };
    const latest = async (c: C) => (await http().get(`/agent-drafts/latest?channel=INSTAGRAM&chatId=${c.chat}`).set(auth(c.token)).expect(200)).body.draft;

    // 1. the channel confirmed (the confirmation is stored by the normal path), the server stopped before the result was saved: completed as sent, once
    const r = await priceDraft({ events: true });
    await approve(r.c, r.v, 'SEND_TIMES').expect(200);
    expect(transport.sent).toHaveLength(1);
    expect((await prisma.agentDraft.findUniqueOrThrow({ where: { id: r.v.id } })).transportConfirmedAt).not.toBeNull();
    await stall(r.v.id);
    await prisma.funnelEvent.deleteMany({ where: { clinicId: r.c.clinicId } });
    await prisma.conversationState.deleteMany({ where: { clinicId: r.c.clinicId } });
    expect((await approve(r.c, r.v, 'SEND_TIMES').expect(200)).body).toMatchObject({ ok: true, outcome: 'SENT', already: true });
    expect(transport.sent).toHaveLength(1);
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: r.v.id } })).toMatchObject({ status: 'SENT', error: 'recovered' });
    expect(await rows(r.c, 'funnelEvent')).toBe(1);

    // 2. confirmed, but the message record of the thread was never written: it is written once, and the draft is sent
    const m = await priceDraft();
    await approve(m.c, m.v, 'SEND_TIMES').expect(200);
    await prisma.chatMessage.deleteMany({ where: { clinicId: m.c.clinicId, direction: 'OUT' } });
    await stall(m.v.id);
    expect(await latest(m.c)).toBeNull();
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: m.v.id } })).toMatchObject({ status: 'SENT' });
    expect(await prisma.chatMessage.count({ where: { clinicId: m.c.clinicId, direction: 'OUT', error: null } })).toBe(1);
    expect(transport.sent).toHaveLength(2); // one real send per case (1 and 2); the recovery itself sent nothing

    // 3. NO confirmation of the channel: a message with the same text and author in our own table is not a proof; the result is unknown, the same action is blocked
    const n = await priceDraft({ events: true });
    const snap = (await prisma.agentDraft.findUniqueOrThrow({ where: { id: n.v.id } })).snapshot as { reply: string };
    await prisma.chatMessage.create({ data: { clinicId: n.c.clinicId, channel: 'INSTAGRAM', chatId: n.c.chat, direction: 'OUT', text: snap.reply, authorUserId: n.c.userId } });
    await prisma.agentDraft.update({ where: { id: n.v.id }, data: { status: 'APPROVING', choice: 'SEND_TIMES', approvedById: n.c.userId, approvedAt: new Date(Date.now() - 10 * 60_000), transportConfirmedAt: null } });
    await prisma.$executeRawUnsafe(`update "AgentDraft" set "updatedAt" = now() - interval '5 minutes' where id = $1`, n.v.id);
    expect(await latest(n.c)).toMatchObject({ id: n.v.id, status: 'UNKNOWN' });
    expect(await prisma.agentDraft.findUniqueOrThrow({ where: { id: n.v.id } })).toMatchObject({ status: 'UNKNOWN', error: 'interrupted', messageId: null });
    expect(await rows(n.c, 'funnelEvent')).toBe(0);
    expect(await rows(n.c, 'conversationState')).toBe(0);
    const again = (await approve(n.c, n.v, 'SEND_TIMES').expect(200)).body;
    expect(again).toMatchObject({ ok: false, outcome: 'UNKNOWN', already: true });
    expect(transport.sent).toHaveLength(2); // nothing was sent again

    // 4. an ambiguous transport answer stores NO confirmation
    const u = await priceDraft();
    transport.mode = 'ambiguous';
    await approve(u.c, u.v, 'SEND_TIMES').expect(200);
    expect((await prisma.agentDraft.findUniqueOrThrow({ where: { id: u.v.id } })).transportConfirmedAt).toBeNull();
  });

  it('Viber: схвалення чернеток агента вимкнене, поки помилки не розрізняються; інші канали працюють', async () => {
    const { c, v } = await priceDraft();
    await prisma.agentDraft.update({ where: { id: v.id }, data: { channel: 'VIBER' } });
    const res = (await approve(c, v, 'SEND_TIMES').expect(200)).body;
    expect(res).toMatchObject({ ok: false, outcome: 'REFUSED', code: 'channel_not_supported' });
    expect(res.draft.channelSupported).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
});
