import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { LlmClient } from '../src/ai/llm.client';
import { incomingHandoff, replyViolates } from '../src/ai/guardrails';
import { decodeEntities } from '../src/integrations/cliniccards.connector';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(90_000);

const llm = { configured: true, calls: 0, systems: [] as string[], next: '', complete: async (system?: string) => { llm.calls++; llm.systems.push(system ?? ''); return { text: llm.next, inputTokens: 5, outputTokens: 5 }; } };
const say = (reply: string, intent = 'info') => (llm.next = JSON.stringify({ intent, reply, summary: null, options: [] }));
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  mock = await startMock({ patients: 20, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(llm).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
});

async function clinic() {
  const email = `k${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', aiEnabled: true, aiAutoReply: true, sendingEnabled: true } });
  return { token: res.body.accessToken as string, clinicId };
}
const member = async (ownerToken: string, role: string) => {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email: `r${rnd()}@example.com`, role }).expect(201);
  return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Роль', password: PASSWORD }).expect(201)).body.accessToken as string;
};
async function service(c: { token: string }, title: string, over: Record<string, unknown> = {}, approve = true) {
  const id = (await http().post('/knowledge').set(auth(c.token)).send({ kind: 'SERVICE', title, durationMin: 60, priceUah: 1200, ...over }).expect(201)).body.id as string;
  if (approve) await http().post(`/knowledge/${id}/approve`).set(auth(c.token)).expect(200);
  return id;
}
async function ask(clinicId: string, text: string) {
  const chatId = `kc-${rnd()}`;
  await prisma.chatMessage.create({ data: { clinicId, channel: 'TELEGRAM', chatId, direction: 'IN', text } });
  return app.get(ChatAssistantService).draft(clinicId, 'TELEGRAM', chatId);
}

describe('база знань клініки', () => {
  it('редагують і затверджують лише власник і керуючий; адміністратор читає; лікар ні; чужа клініка нічого не бачить', async () => {
    const c = await clinic();
    const other = await clinic();
    const id = await service(c, 'Професійна гігієна');
    const manager = await member(c.token, 'MANAGER');
    const admin = await member(c.token, 'ADMIN');
    const doctor = await member(c.token, 'DOCTOR');
    await http().post('/knowledge').set(auth(admin)).send({ kind: 'FAQ', title: 'Питання' }).expect(403);
    await http().post(`/knowledge/${id}/approve`).set(auth(admin)).expect(403);
    await http().get('/knowledge').set(auth(doctor)).expect(403);
    expect((await http().get('/knowledge').set(auth(admin)).expect(200)).body.items).toHaveLength(1);
    await http().patch(`/knowledge/${id}`).set(auth(manager)).send({ text: 'Не їсти за дві години' }).expect(200);
    expect((await http().get('/knowledge').set(auth(other.token)).expect(200)).body.items).toHaveLength(0);
    await http().patch(`/knowledge/${id}`).set(auth(other.token)).send({ title: 'Чуже' }).expect(404);
    await http().post(`/knowledge/${id}/approve`).set(auth(other.token)).expect(404);
    await http().delete(`/knowledge/${id}`).set(auth(other.token)).expect(404);
    await http().post('/knowledge').set(auth(c.token)).send({ kind: 'SERVICE', title: 'x', priceUah: -5 }).expect(400);
    await http().post('/knowledge').set(auth(c.token)).send({ kind: 'NOPE', title: 'x' }).expect(400);
  });

  it('зміна змісту знімає затвердження; перемикач «активно» його не знімає; «ще актуально» продовжує 90 днів', async () => {
    const c = await clinic();
    const id = await service(c, 'Консультація');
    const get = async () => (await http().get('/knowledge').set(auth(c.token))).body.items.find((i: { id: string }) => i.id === id);
    expect((await get()).approved).toBe(true);
    await http().patch(`/knowledge/${id}`).set(auth(c.token)).send({ active: false }).expect(200);
    expect((await get()).approved).toBe(true);
    await http().patch(`/knowledge/${id}`).set(auth(c.token)).send({ priceUah: 1500 }).expect(200);
    expect((await get()).approved).toBe(false);
    await http().post(`/knowledge/${id}/confirm`).set(auth(c.token)).expect(404); // not approved: nothing to confirm
    await http().post(`/knowledge/${id}/approve`).set(auth(c.token)).expect(200);
    await prisma.kbItem.update({ where: { id }, data: { reviewedAt: new Date(Date.now() - 100 * 86_400_000) } });
    expect((await get()).stale).toBe(true);
    await http().post(`/knowledge/${id}/confirm`).set(auth(c.token)).expect(200);
    expect((await get()).stale).toBe(false);
    expect((await http().get('/knowledge').set(auth(c.token))).body.summary).toMatchObject({ total: 1, drafts: 0, stale: 0 });
  });

  it('у промпт потрапляє тільки затверджене й активне; чернетки, вимкнене й чужі клініки — ні', async () => {
    const c = await clinic();
    const other = await clinic();
    await service(c, 'Професійна гігієна', { text: 'Не їсти за 2 години' });
    await service(c, 'Чернетка послуги', {}, false);
    const off = await service(c, 'Вимкнена послуга');
    await http().patch(`/knowledge/${off}`).set(auth(c.token)).send({ active: false }).expect(200);
    await service(other, 'Чужа послуга');
    const doc = (await http().post('/knowledge').set(auth(c.token)).send({ kind: 'DOCTOR', title: 'Іваненко Олег', text: 'Терапевт' }).expect(201)).body.id;
    await http().post(`/knowledge/${doc}/approve`).set(auth(c.token)).expect(200);
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Добрий день, розкажіть про гігієну');
    const sys = llm.systems.at(-1)!;
    expect(sys).toContain('Професійна гігієна; тривалість 60 хв; ціна 1200 грн; Не їсти за 2 години');
    expect(sys).toContain('Іваненко Олег: Терапевт');
    expect(sys).not.toContain('Чернетка послуги');
    expect(sys).not.toContain('Вимкнена послуга');
    expect(sys).not.toContain('Чужа послуга');
  });
});

describe('ціни у відповідях ШІ', () => {
  it('питання про ціну йде до моделі лише коли є затверджена свіжа ціна; відповідь з цією сумою проходить', async () => {
    const c = await clinic();
    llm.calls = 0;
    // no knowledge: a price question goes to a person before the model
    expect((await ask(c.clinicId, 'Скільки коштує чистка?')).handoff).toBe(true);
    expect(llm.calls).toBe(0);
    await service(c, 'Професійна гігієна');
    say('Професійна гігієна коштує 1200 грн, триває близько години.');
    const d = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(d.handoff).toBe(false);
    expect(d.reply).toContain('1200 грн');
    expect(llm.calls).toBe(1);
  });

  it('вигадана, інша чи сума з чернетки не проходить: заміна на передачу людині', async () => {
    const c = await clinic();
    await service(c, 'Професійна гігієна');
    await service(c, 'Чернетка', { priceUah: 777 }, false);
    for (const wrong of ['Це коштує 1500 грн.', 'Чистка 1200 грн плюс огляд 300 грн', 'Чернетка коштує 777 грн', 'Це приблизно 40 $']) {
      say(wrong);
      const d = await ask(c.clinicId, 'Скільки коштує чистка?');
      expect(d.handoff).toBe(true);
      expect(d.reason).toBe('reply_check');
    }
  });

  it('прострочена (понад 90 днів) ціна не називається: питання іде людині ще до моделі, а в промпті ціни немає', async () => {
    const c = await clinic();
    const id = await service(c, 'Професійна гігієна');
    await prisma.kbItem.update({ where: { id }, data: { reviewedAt: new Date(Date.now() - 100 * 86_400_000) } });
    llm.calls = 0;
    const d = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(d.handoff).toBe(true);
    expect(llm.calls).toBe(0);
    say('Добрий день!');
    await ask(c.clinicId, 'Розкажіть про гігієну');
    expect(llm.systems.at(-1)).toContain('ціна: не називати');
    expect(llm.systems.at(-1)).not.toContain('1200 грн');
  });

  it('знижки, розстрочка і медичні питання не доходять до моделі навіть при затверджених цінах', async () => {
    const c = await clinic();
    await service(c, 'Професійна гігієна');
    llm.calls = 0;
    for (const t of ['А знижка буде?', 'Є розстрочка на лікування?', 'У мене болить зуб, скільки коштує лікування?', 'Буду скаржитися']) expect((await ask(c.clinicId, t)).handoff).toBe(true);
    expect(llm.calls).toBe(0);
  });

  it('правила захисту: сума допустима лише з переліку; ліки й дозування заборонені завжди', () => {
    expect(replyViolates('Коштує 1 200 грн', [1200])).toBe(false);
    expect(replyViolates('Коштує 1200,00 грн', [1200])).toBe(false);
    expect(replyViolates('Коштує 1200 грн', [])).toBe(true);
    expect(replyViolates('Коштує 1300 грн', [1200])).toBe(true);
    expect(replyViolates('Це 30 usd', [30])).toBe(true);
    expect(replyViolates('Прийміть 500 мг', [500])).toBe(true);
    expect(incomingHandoff('Скільки коштує чистка?')).toBe('price');
    expect(incomingHandoff('Скільки коштує чистка?', true)).toBeNull();
    expect(incomingHandoff('Є знижка на чистку?', true)).toBe('price');
  });
});

describe('чернетки з Cliniccards', () => {
  it('імпорт створює лише чернетки; ціну з прайсу треба підтвердити вручну; повторний імпорт нічого не дублює', async () => {
    const c = await clinic();
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(400); // no Cliniccards key yet
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    const r = await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    expect(r.body.added).toBe(3);
    expect((await http().post('/knowledge/import/services').set(auth(c.token)).expect(200)).body.added).toBe(0);
    const items = (await http().get('/knowledge').set(auth(c.token))).body.items as { id: string; title: string; approved: boolean; priceUah: number | null; source: string }[];
    expect(items.every((i) => !i.approved && i.source === 'CLINICCARDS')).toBe(true);
    expect((items as unknown as { title: string; category: string | null }[]).find((i) => i.title === 'Лікування карієсу')!.category).toBe('Терапія');
    const noPrice = items.find((i) => i.title === 'Консультація')!;
    expect(noPrice.priceUah).toBeNull(); // "0" in the price list means "not set"
    const air = (items as unknown as { title: string; text: string; priceUah: number }[]).find((i) => i.title.startsWith('Професійна гігєна'))!;
    expect(air.title).toBe('Професійна гігєна "Air flow" 1 ступеня'); // HTML entities decoded
    expect(air.text).toBe('— AirFlow\n— Полірування');
    expect(air.priceUah).toBe(1200);
    await http().post(`/knowledge/${noPrice.id}/approve`).set(auth(c.token)).expect(400);
    // the model sees nothing until a person approves
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Розкажіть про гігієну');
    expect(llm.systems.at(-1)).not.toContain('Професійна гігієна');
  });
});

describe('затвердити групу', () => {
  it('затверджує чернетки однієї групи; позиції без ціни пропускає; чужа клініка й адміністратор не можуть', async () => {
    const c = await clinic();
    const other = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const admin = await member(c.token, 'ADMIN');
    await http().post('/knowledge/approve-group').set(auth(admin)).send({ kind: 'SERVICE', category: 'Терапія' }).expect(403);
    // a group with one priced item
    expect((await http().post('/knowledge/approve-group').set(auth(c.token)).send({ kind: 'SERVICE', category: 'Терапія' }).expect(200)).body).toEqual({ approved: 1, skipped: 0 });
    // the group whose only item has no price: nothing is approved
    expect((await http().post('/knowledge/approve-group').set(auth(c.token)).send({ kind: 'SERVICE', category: 'Консультації' }).expect(200)).body).toEqual({ approved: 0, skipped: 1 });
    const items = (await http().get('/knowledge').set(auth(c.token))).body.items as { title: string; approved: boolean }[];
    expect(items.find((i) => i.title === 'Лікування карієсу')!.approved).toBe(true);
    expect(items.find((i) => i.title === 'Консультація')!.approved).toBe(false);
    expect(items.find((i) => i.title.startsWith('Професійна гігєна'))!.approved).toBe(false);
    expect((await http().post('/knowledge/approve-group').set(auth(other.token)).send({ kind: 'SERVICE', category: 'Профілактика' }).expect(200)).body).toEqual({ approved: 0, skipped: 0 });
  });
});

describe('довгий прайс (як у 112 dental: 234 позиції)', () => {
  it('у промпт потрапляють лише послуги за темою питання плюс перелік напрямків; суми з інших послуг у відповіді не дозволені', async () => {
    const c = await clinic();
    const now = new Date();
    const groups = ['Терапія', 'Імплантація', 'Ортодонтія', 'Хірургія'];
    await prisma.kbItem.createMany({ data: Array.from({ length: 120 }, (_, i) => ({ clinicId: c.clinicId, kind: 'SERVICE', title: `Послуга ${i} ${['пломба', 'імплант', 'брекети', 'видалення'][i % 4]}`, category: groups[i % 4], priceUah: 1000 + i, approvedAt: now, reviewedAt: now })) });
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Скільки коштує імплант?');
    const sys = llm.systems.at(-1)!;
    expect(sys).toContain('НАПРЯМКИ ПОСЛУГ КЛІНІКИ');
    expect(sys).toContain('Імплантація');
    expect(sys).toContain('Послуга 1 імплант');
    expect(sys).not.toContain('Послуга 0 пломба');
    expect((sys.match(/\n- Послуга /g) ?? []).length).toBeLessThanOrEqual(25);
    // a price of a service that is not in the prompt cannot be quoted
    say('Імплант коштує 1001 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує імплант?')).handoff).toBe(false);
    say('Пломба коштує 1000 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує імплант?')).handoff).toBe(true);
    // a question that matches nothing: no services, no prices, so a price question goes to a person with the directions known
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Розкажіть, що ви робите');
    expect(llm.systems.at(-1)).not.toContain('\n- Послуга ');
  });

  it('декодування HTML-символів із Cliniccards', () => {
    expect(decodeEntities('Air flow &#34;1&#34; &quot;2&quot; &amp; &#x41; &laquo;')).toBe('Air flow "1" "2" & A &laquo;');
  });
});

