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

  it('у промпт потрапляють затверджені локальні послуги; ручні чернетки, вимкнене, чужі клініки й незатверджені лікарі — ні', async () => {
    const c = await clinic();
    const other = await clinic();
    await service(c, 'Професійна гігієна', { text: 'Не їсти за 2 години' });
    await service(c, 'Чернетка послуги', {}, false);
    const draftDoc = (await http().post('/knowledge').set(auth(c.token)).send({ kind: 'DOCTOR', title: 'Незатверджений Лікар', text: 'x' }).expect(201)).body.id;
    expect(draftDoc).toBeTruthy();
    const off = await service(c, 'Вимкнена послуга');
    await http().patch(`/knowledge/${off}`).set(auth(c.token)).send({ active: false }).expect(200);
    await service(other, 'Чужа послуга');
    const doc = (await http().post('/knowledge').set(auth(c.token)).send({ kind: 'DOCTOR', title: 'Іваненко Олег', text: 'Терапевт' }).expect(201)).body.id;
    await http().post(`/knowledge/${doc}/approve`).set(auth(c.token)).expect(200);
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Добрий день, розкажіть про гігієну');
    const sys = llm.systems.at(-1)!;
    expect(sys).toContain('Професійна гігієна; тривалість 60 хв; ціна 1200 грн (фіксована); склад і опис саме цієї послуги: Не їсти за 2 години');
    expect(sys).toContain('Іваненко Олег: Терапевт');
    expect(sys).not.toContain('Чернетка послуги'); // a hand-made draft is not published
    expect(sys).not.toContain('Незатверджений Лікар');
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
    await service(c, 'Чернетка без ціни', { priceUah: null }, false);
    for (const wrong of ['Це коштує 1500 грн.', 'Чистка 1200 грн плюс огляд 300 грн', 'Чернетка коштує 777 грн', 'Це приблизно 40 $', 'Чистка від 1200 грн']) {
      say(wrong);
      const d = await ask(c.clinicId, 'Скільки коштує чистка?');
      expect(d.handoff).toBe(true);
      expect(d.reason).toBe('reply_check');
    }
  });

  it('прострочена (понад 90 днів) ціна не називається: модель відповідає «уточнить адміністратор», стару суму не підставляє', async () => {
    const c = await clinic();
    const id = await service(c, 'Професійна гігієна');
    await prisma.kbItem.update({ where: { id }, data: { reviewedAt: new Date(Date.now() - 100 * 86_400_000) } });
    llm.calls = 0;
    say('Вартість цієї послуги потрібно уточнити в адміністратора клініки. Підібрати зручний час для запису?');
    const d = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(d.handoff).toBe(false);
    expect(llm.calls).toBe(1);
    expect(llm.systems.at(-1)).toContain('ціна: не називати');
    expect(llm.systems.at(-1)).not.toContain('1200 грн');
    expect(d.reply).not.toMatch(/попередн/); // no sum named, no price notice
    say('Це коштує 1200 грн.');
    const old = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(old.handoff).toBe(true);
    expect(old.reason).toBe('reply_check');
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
    expect(incomingHandoff('Подскажите, пожалуйста, сколько стоит', true)).toBeNull(); // «пожалуйста» is not a complaint
    expect(incomingHandoff('Я пожалуюсь на вас')).toBe('complaint');
    expect(replyViolates('Чистка від 1200 грн', [1200])).toBe(true);
    expect(replyViolates('Чистка коштує 1200 грн', [1200])).toBe(false);
  });
});

describe('чернетки з Cliniccards', () => {
  it('імпорт створює послуги, що слідують за Cliniccards без затвердження кожної; невідома ціна лишається невідомою; повторний імпорт нічого не дублює', async () => {
    const c = await clinic();
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(400); // no Cliniccards key yet
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    const r = await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    expect(r.body.added).toBe(3);
    expect((await http().post('/knowledge/import/services').set(auth(c.token)).expect(200)).body.added).toBe(0);
    const items = (await http().get('/knowledge').set(auth(c.token))).body.items as { id: string; title: string; approved: boolean; priceUah: number | null; source: string }[];
    expect(items.every((i) => i.approved && i.source === 'CLINICCARDS')).toBe(true);
    expect((items as unknown as { title: string; category: string | null }[]).find((i) => i.title === 'Лікування карієсу')!.category).toBe('Терапія');
    const noPrice = items.find((i) => i.title === 'Консультація')!;
    expect(noPrice.priceUah).toBeNull(); // "0" in the price list means "not set"
    const air = (items as unknown as { title: string; text: string; priceUah: number }[]).find((i) => i.title.startsWith('Професійна гігєна'))!;
    expect(air.title).toBe('Професійна гігєна "Air flow" 1 ступеня'); // HTML entities decoded
    expect(air.text).toBe('— AirFlow\n— Полірування');
    expect(air.priceUah).toBe(1200);
    // the model sees every imported position at once, with no approval; an unknown price is never named
    say('Добрий день!');
    llm.systems.length = 0;
    await ask(c.clinicId, 'Розкажіть про консультацію та гігієну');
    expect(llm.systems.at(-1)).toMatch(/Консультація[^\n]*ціна: не називати/);
    expect(llm.systems.at(-1)).toContain('Професійна гігєна "Air flow" 1 ступеня (група: Профілактика); ціна 1200 грн (фіксована)');
  });
});

describe('затвердити групу', () => {
  it('затверджує ручні чернетки однієї групи; чужа клініка й адміністратор не можуть', async () => {
    const c = await clinic();
    const other = await clinic();
    const admin = await member(c.token, 'ADMIN');
    await prisma.kbItem.createMany({ data: [{ clinicId: c.clinicId, kind: 'SERVICE', title: 'Ручна терапія', category: 'Терапія', priceUah: 500 }, { clinicId: c.clinicId, kind: 'SERVICE', title: 'Ручна консультація', category: 'Консультації' }] });
    await http().post('/knowledge/approve-group').set(auth(admin)).send({ kind: 'SERVICE', category: 'Терапія' }).expect(403);
    expect((await http().post('/knowledge/approve-group').set(auth(c.token)).send({ kind: 'SERVICE', category: 'Терапія' }).expect(200)).body).toEqual({ approved: 1, skipped: 0 });
    // the group whose only item has an unknown price: approved too (no price is ever named for it)
    expect((await http().post('/knowledge/approve-group').set(auth(c.token)).send({ kind: 'SERVICE', category: 'Консультації' }).expect(200)).body).toEqual({ approved: 1, skipped: 0 });
    const items = (await http().get('/knowledge').set(auth(c.token))).body.items as { title: string; approved: boolean }[];
    expect(items.every((i) => i.approved)).toBe(true);
    expect((await http().post('/knowledge/approve-group').set(auth(other.token)).send({ kind: 'SERVICE', category: 'Терапія' }).expect(200)).body).toEqual({ approved: 0, skipped: 0 });
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
    expect((sys.match(/\n- Послуга /g) ?? []).length).toBeLessThanOrEqual(30);
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


describe('прайс у переписці ШІ', () => {
  it('імпортована послуга без дозволу на онлайн-запис і без тривалості: ціна називається, з поясненням про попередню вартість (мовою розмови)', async () => {
    const c = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const caries = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1002' } });
    expect(caries).toMatchObject({ approvedAt: expect.any(Date), onlineBooking: false, durationMin: null, priceUah: 1800 });
    llm.systems.length = 0;
    say('Лікування карієсу коштує 1800 грн.');
    const uk = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
    expect(uk.handoff).toBe(false);
    expect(llm.systems.at(-1)).toContain('Лікування карієсу (група: Терапія); ціна 1800 грн (фіксована)');
    expect(uk.reply).toContain('1800 грн');
    expect(uk.reply).toContain('Вартість попередня — точну суму та що входить у послугу уточнить адміністратор.');
    // the same in Russian, in the language of the person
    say('Лечение кариеса стоит 1800 грн.');
    const ru = await ask(c.clinicId, 'Сколько стоит лечение кариеса? Подскажите, пожалуйста');
    expect(ru.reply).toContain('Стоимость предварительная — точную сумму и что входит в услугу уточнит администратор.');
    // a reply that already says it is preliminary is not given the sentence twice
    say('За прайсом лікування карієсу коштує 1800 грн. Вартість попередня — точну суму та що входить у послугу уточнить адміністратор.');
    const once = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
    expect(once.reply.match(/попередня/g)).toHaveLength(1);
    // the dialogue goes on: an answer about the price is not a hand-over
    expect(once).toMatchObject({ handoff: false, intent: 'info' });
  });

  it('невідома ціна, позиція, що зникла з прайсу, і суперечливі дані: сума не називається й не підставляється, «від» заборонено', async () => {
    const c = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const kb = (await import('../src/kb/kb.service')).KbService;
    const consult = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1003' } }); // "0" in the price list
    const gone = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1002' } });
    const air = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1001' } });
    await prisma.kbItem.update({ where: { id: gone.id }, data: { missingInSourceAt: new Date() } });
    // the clinic's own price, set on purpose, that the source now contradicts and nobody has decided about yet
    await prisma.kbItem.update({ where: { id: air.id }, data: { priceUah: 1000, localFields: ['priceUah'], externalPrice: 1500 } });
    const f = await app.get(kb).factsFor(c.clinicId, new Date(), 'консультація карієс гігієна');
    expect(f.text).toMatch(/Консультація[^\n]*ціна: не називати, вона невідома/);
    expect(f.text).toMatch(/Лікування карієсу[^\n]*вже немає в актуальному прайсі/);
    expect(f.text).toMatch(/гігєна[^\n]*дані про ціну суперечливі/);
    expect(f.allowedAmounts).toEqual([]);
    expect(consult.priceUah).toBeNull();
    // the model may not fill the gap with the old price, a zero or a "from" price
    for (const wrong of ['Консультація коштує 0 грн.', 'Лікування карієсу коштує 1800 грн.', 'Гігієна коштує 1000 грн.', 'Гігієна від 1000 грн.']) {
      say(wrong);
      const d = await ask(c.clinicId, 'Скільки коштує консультація?');
      expect(d).toMatchObject({ handoff: true, reason: 'reply_check' });
    }
    // and it does not claim a hand-over that did not happen: the prompt says so
    expect(llm.systems.at(-1)).toContain('Не пиши, що передав запит');
  });

  it('кілька підходящих послуг: у промпті всі з групами (не лише найдешевша); сума з іншої послуги не проходить', async () => {
    const c = await clinic();
    const groups = ['Хірургія', 'Терапія', 'Ортодонтія'];
    for (let i = 0; i < 3; i++) await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Видалення зуба', category: groups[i], priceUah: 500 + i * 500, source: 'CLINICCARDS', externalId: `v${i}`, externalPrice: 500 + i * 500, reviewedAt: new Date() } });
    for (let i = 0; i < 45; i++) await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: `Інша послуга ${i}`, priceUah: 100, source: 'CLINICCARDS', externalId: `o${i}`, externalPrice: 100 } });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { priceListSyncedAt: new Date() } });
    const f = await (await import('../src/kb/kb.service')).KbService.prototype.factsFor.call(app.get((await import('../src/kb/kb.service')).KbService), c.clinicId, new Date(), 'видалення зуба');
    for (const g of groups) expect(f.text).toContain(`Видалення зуба (група: ${g})`);
    expect(f.text).not.toContain('Інша послуга 1;');
    expect(f.allowedAmounts.sort((a, b) => a - b)).toEqual([500, 1000, 1500]);
    // the prompt tells the model to ask which one, not to pick the cheapest
    say('Уточніть, будь ласка: видалення зуба у хірургії, терапії чи ортодонтії?');
    const d = await ask(c.clinicId, 'Скільки коштує видалення зуба?');
    expect(d.handoff).toBe(false);
    expect(llm.systems.at(-1)).toContain('Ніколи не обирай довільно найдешевшу');
  });

  it('ціна оновлюється після синхронізації; ціна, що розійшлася з рішенням адміністратора, не називається; прайси клінік ізольовані', async () => {
    const c = await clinic();
    const other = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const KbService = (await import('../src/kb/kb.service')).KbService;
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(1800);
    // the price list changes: a draft follows it at the next read
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2100';
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const after = await app.get(KbService).factsFor(c.clinicId);
    expect(after.allowedAmounts).toContain(2100);
    expect(after.allowedAmounts).not.toContain(1800);
    say('Лікування карієсу коштує 2100 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reply).toContain('2100 грн');
    say('Лікування карієсу коштує 1800 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
    // an approved price that the source now contradicts is not named until the administrator decides
    const caries = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1002' } });
    await http().post(`/knowledge/${caries.id}/approve`).set(auth(c.token)).expect(200);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2500';
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    expect((await app.get(KbService).factsFor(c.clinicId, new Date(), 'карієс')).allowedAmounts).not.toContain(2100);
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '1800';
    // another clinic never sees this price list, and its own price for the same name is its own
    await service(other, 'Лікування карієсу', { priceUah: 999 });
    const o = await app.get(KbService).factsFor(other.clinicId, new Date(), 'карієс');
    expect(o.allowedAmounts).toEqual([999]);
    expect(o.text).not.toContain('2100');
    say('Лікування карієсу коштує 2100 грн.');
    expect((await ask(other.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
    say('Лікування карієсу коштує 999 грн.');
    expect((await ask(other.clinicId, 'Скільки коштує лікування карієсу?')).reply).toContain('999 грн');
  });
});

describe('пошук по всьому прайсу і прив’язка ціни до послуги', () => {
  async function bigClinic() {
    const c = await clinic();
    const now = new Date();
    const real: [string, string, number][] = [
      ['Професійна гігієна порожнини рота', 'Профілактика', 1500],
      ['Пломба світлова', 'Терапія', 1100],
      ['Лікування карієсу', 'Терапія', 1800],
      ['Видалення зуба простого', 'Хірургія', 900],
      ['Видалення зуба складного', 'Хірургія', 2200],
      ['Консультація ортодонта', 'Ортодонтія', 400],
    ];
    await prisma.kbItem.createMany({ data: real.map(([title, category, priceUah], i) => ({ clinicId: c.clinicId, kind: 'SERVICE', title, category, priceUah, source: 'CLINICCARDS', externalId: `r${i}`, externalPrice: priceUah, approvedAt: now, reviewedAt: now })) });
    await prisma.kbItem.createMany({ data: Array.from({ length: 228 }, (_, i) => ({ clinicId: c.clinicId, kind: 'SERVICE', title: `Допоміжна позиція ${i} матеріал`, category: 'Матеріали', priceUah: 50 + i, source: 'CLINICCARDS', externalId: `f${i}`, externalPrice: 50 + i, approvedAt: now, reviewedAt: now })) });
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { priceListSyncedAt: now } });
    return c;
  }
  const KbService = () => import('../src/kb/kb.service').then((m) => m.KbService);

  it('українські й російські формулювання знаходять послугу в прайсі з 234 позицій; без збігу — жодної ціни й жодного «такої послуги немає»', async () => {
    const c = await bigClinic();
    const kb = app.get(await KbService());
    const expectations: [string, string][] = [
      ['скільки коштує чистка', 'Професійна гігієна порожнини рота'],
      ['чистка зубів', 'Професійна гігієна порожнини рота'],
      ['почистить зубы', 'Професійна гігієна порожнини рота'],
      ['гігієна', 'Професійна гігієна порожнини рота'],
      ['гигиена полости рта', 'Професійна гігієна порожнини рота'],
      ['пломба', 'Пломба світлова'],
      ['поставить пломбу', 'Пломба світлова'],
      ['лікування карієсу', 'Лікування карієсу'],
      ['лечение кариеса', 'Лікування карієсу'],
      ['удалить зуб', 'Видалення зуба простого'],
      ['хочу видалити зуб', 'Видалення зуба складного'],
    ];
    for (const [q, title] of expectations) {
      const f = await kb.factsFor(c.clinicId, new Date(), `${q} ${(await import('../src/ai/dental')).expandForSearch(q)}`);
      expect({ q, found: f.text?.includes(`- ${title}`) }).toEqual({ q, found: true });
    }
    // «удалить зуб» is ambiguous (simple or complex): both variants are shown, the cheaper one is not picked
    const del = await kb.factsFor(c.clinicId, new Date(), 'удалить зуб видалення хірургія');
    expect(del.text).toContain('Видалення зуба простого');
    expect(del.text).toContain('Видалення зуба складного');
    // nothing in the price list resembles the words: no price, and the model is told not to say "no such service"
    const none = await kb.factsFor(c.clinicId, new Date(), 'скільки коштує квантовий масаж пяток');
    expect(none.allowedAmounts).toEqual([]);
    expect(none.priced).toEqual([]);
    expect(none.text).toContain('не стверджуй, що такої послуги немає');
    expect(none.text).toContain('НАПРЯМКИ ПОСЛУГ КЛІНІКИ');
    say('Не знайшла такої послуги серед наших. Уточніть, будь ласка, назву: вартість уточнить адміністратор.');
    const d = await ask(c.clinicId, 'скільки коштує квантовий масаж пяток');
    expect(d.handoff).toBe(false);
    expect(d.reply).not.toMatch(/\d+\s*грн/);
  });

  it('сума має належати саме названій послузі: ціна іншої послуги з того самого прайсу не проходить', async () => {
    const c = await bigClinic();
    // right service, right sum
    say('Лікування карієсу коштує 1800 грн.');
    const ok = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
    expect(ok.handoff).toBe(false);
    expect(ok.reply).toContain('1800 грн');
    // 1100 is the price of the filling, 1500 of the hygiene: both exist in the list, but not for the caries
    for (const wrong of ['Лікування карієсу коштує 1100 грн.', 'Лікування карієсу коштує 1500 грн.']) {
      say(wrong);
      const d = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
      expect(d).toMatchObject({ handoff: true, reason: 'reply_check' });
    }
    // two services in one answer, each with its own sum; swapped sums fail
    say('Пломба світлова — 1100 грн, лікування карієсу — 1800 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує пломба і лікування карієсу?')).handoff).toBe(false);
    say('Пломба світлова — 1800 грн, лікування карієсу — 1100 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує пломба і лікування карієсу?')).reason).toBe('reply_check');
    // a sum with no service named at all cannot be tied to anything
    say('Це коштує 1800 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
  });
});
