import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ChatAssistantService } from '../src/ai/chat-assistant.service';
import { KbService } from '../src/kb/kb.service';
import { LlmClient } from '../src/ai/llm.client';
import { incomingHandoff, replyViolates } from '../src/ai/guardrails';
import { decodeEntities } from '../src/integrations/cliniccards.connector';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(90_000);

const llm = { configured: true, calls: 0, systems: [] as string[], next: '', complete: async (system?: string) => { llm.calls++; llm.systems.push(system ?? ''); return { text: llm.next, inputTokens: 5, outputTokens: 5 }; } };
// the model names services by id (`prices`); the text carries no sum, the code writes the lines
const say = (reply: string, intent = 'info', prices: string[] = [], after = '') => (llm.next = JSON.stringify({ intent, reply, prices, after, summary: null, options: [] }));
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
// the reference ("S12") by which the model names a service of the clinic, by its title
const refOf = async (clinicId: string, id: string) => (await app.get(KbService).serviceRefs(clinicId)).get(id)!;
const idOf = async (clinicId: string, title: string) => refOf(clinicId, (await prisma.kbItem.findFirstOrThrow({ where: { clinicId, title } })).id);
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
    expect(sys).toMatch(/- \[\w+\] Професійна гігієна; тривалість 60 хв; ціна відома \(рядок із сумою напише система за id\); склад і опис саме цієї послуги: Не їсти за 2 години/);
    expect(sys).not.toContain('1200'); // the model never sees a sum
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
    const hyg = await service(c, 'Професійна гігієна');
    say('Гігієна триває близько години.', 'info', [await refOf(c.clinicId, hyg)]);
    const d = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(d.handoff).toBe(false);
    expect(d.reply).toContain('- Професійна гігієна: 1200 грн'); // the line is written by the code from the database
    expect(d.reply).toContain('Вартість попередня');
    expect(llm.calls).toBe(1);
  });

  it('вигадана, інша чи сума з чернетки не проходить: заміна на передачу людині', async () => {
    const c = await clinic();
    const hyg = await service(c, 'Професійна гігієна');
    await service(c, 'Чернетка без ціни', { priceUah: null }, false);
    // a sum in the free text is never accepted, in any form: digits, a sign, words
    for (const wrong of ['Це коштує 1500 грн.', 'Чистка 1200 грн плюс огляд 300 грн', 'Чернетка коштує 777 грн', 'Це приблизно 40 $', 'Чистка від 1200 грн', 'Коштує тисячу двісті гривень', 'Це 1200 ₴']) {
      say(wrong, 'info', [await refOf(c.clinicId, hyg)]);
      const d = await ask(c.clinicId, 'Скільки коштує чистка?');
      expect(d.handoff).toBe(true);
      expect(d.reason).toBe('reply_check');
    }
    // an id that is not a service of this clinic is never accepted: an invented one, a malformed list, an id of another clinic
    const hygRef = await refOf(c.clinicId, hyg);
    for (const ids of [['вигадана-позначка'], [hygRef, 'S999'], ['S999'], [42] as unknown as string[]]) {
      say('Ось ціна.', 'info', ids);
      const d = await ask(c.clinicId, 'Скільки коштує чистка?');
      expect(d).toMatchObject({ handoff: true, reason: 'reply_check' });
    }
  });

  it('прострочена (понад 90 днів) ціна не називається: модель відповідає «уточнить адміністратор», стару суму не підставляє', async () => {
    const c = await clinic();
    const id = await service(c, 'Професійна гігієна');
    await prisma.kbItem.update({ where: { id }, data: { reviewedAt: new Date(Date.now() - 100 * 86_400_000) } });
    llm.calls = 0;
    say('Вартість цієї послуги потрібно уточнити в адміністратора клініки.', 'info', [], 'Підібрати зручний час для запису?');
    const d = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(d.handoff).toBe(false);
    expect(llm.calls).toBe(1);
    expect(llm.systems.at(-1)).toContain('ціна: не називати');
    expect(llm.systems.at(-1)).not.toContain('1200');
    expect(d.reply).not.toMatch(/попередн/); // no sum named, no price notice
    // the model names the service whose price is out of date: the line says it is to be clarified, never the old sum and never a zero
    say('Ось що є в прайсі.', 'info', [await refOf(c.clinicId, id)]);
    const unclear = await ask(c.clinicId, 'Скільки коштує чистка?');
    expect(unclear.reply).toContain('- Професійна гігієна: вартість потрібно уточнити в адміністратора');
    expect(unclear.reply).not.toMatch(/1200|0 грн|попередн/);
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

  it('правила захисту: у вільному тексті моделі немає жодної суми (цифрами, знаком чи словами); ліки й дозування заборонені завжди', () => {
    for (const bad of ['Коштує 1 200 грн', 'Коштує 1200,00 грн', 'Це 30 usd', 'Чистка від 1200 грн', 'Тисяча гривень', 'Це 1200 ₴', 'Прийміть 500 мг']) expect(replyViolates(bad)).toBe(true);
    for (const ok of ['Підкажіть, будь ласка, який день вам зручний?', 'Візит триває 45 хвилин', 'Вартість уточнить адміністратор']) expect(replyViolates(ok)).toBe(false);
    expect(incomingHandoff('Скільки коштує чистка?')).toBe('price');
    expect(incomingHandoff('Скільки коштує чистка?', true)).toBeNull();
    expect(incomingHandoff('Є знижка на чистку?', true)).toBe('price');
    expect(incomingHandoff('Подскажите, пожалуйста, сколько стоит', true)).toBeNull(); // «пожалуйста» is not a complaint
    expect(incomingHandoff('Я пожалуюсь на вас')).toBe('complaint');
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
    expect(llm.systems.at(-1)).toMatch(/\[\w+\] Професійна гігєна "Air flow" 1 ступеня \(група: Профілактика\); ціна відома/);
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
    // the price of a service that is in the prompt is written by the code; of a service that is NOT in the prompt it cannot be given at all
    say('Ось ціна.', 'info', [await idOf(c.clinicId, 'Послуга 1 імплант')]);
    const given = await ask(c.clinicId, 'Скільки коштує імплант?');
    expect(given.handoff).toBe(false);
    expect(given.reply).toContain('- Послуга 1 імплант: 1001 грн');
    say('Ось ціна.', 'info', [await idOf(c.clinicId, 'Послуга 0 пломба')]);
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
    say('Ось ціна лікування карієсу.', 'info', [await refOf(c.clinicId, caries.id)], 'Якщо хочете записатися, напишіть день і час.');
    const uk = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
    expect(uk.handoff).toBe(false);
    expect(llm.systems.at(-1)).toContain(`[${await refOf(c.clinicId, caries.id)}] Лікування карієсу (група: Терапія); ціна відома`);
    expect(uk.reply).toBe('Ось ціна лікування карієсу.\n\n- Лікування карієсу: 1800 грн\n\nВартість попередня — точну суму та що входить у послугу уточнить адміністратор.\n\nЯкщо хочете записатися, напишіть день і час.');
    // the same in Russian, in the language of the person: the notice is the code's, in Russian; the title is the title of the database
    say('Вот цена лечения кариеса.', 'info', [await refOf(c.clinicId, caries.id)]);
    const ru = await ask(c.clinicId, 'Сколько стоит лечение кариеса? Подскажите, пожалуйста');
    expect(ru.reply).toContain('Стоимость предварительная — точную сумму и что входит в услугу уточнит администратор.');
    expect(ru.reply).toContain('- Лікування карієсу: 1800 грн');
    // a notice that the model wrote itself is removed: the code's notice stands once, in the language of the dialogue
    say('Вот цена. Вартість попередня — точну суму та що входить у послугу уточнить адміністратор.', 'info', [await refOf(c.clinicId, caries.id)]);
    const once = await ask(c.clinicId, 'Сколько стоит лечение кариеса?');
    expect(once.reply.match(/редварительн|опередн/g)).toHaveLength(1);
    expect(once.reply).toContain('Стоимость предварительная');
    // the dialogue goes on: an answer about the price is not a hand-over
    expect(once).toMatchObject({ handoff: false, intent: 'info' });
  });

  it('невідома ціна, позиція, що зникла з прайсу, і суперечливі дані: сума не називається й не підставляється, «від» заборонено', async () => {
    const c = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const kb = KbService;
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
    // named by id, the unknown, the vanished and the contradicting prices are lines that say "to be clarified": never a sum, never a zero
    say('Ось що є в прайсі.', 'info', [await refOf(c.clinicId, consult.id), await refOf(c.clinicId, gone.id), await refOf(c.clinicId, air.id)]);
    const lines = await ask(c.clinicId, 'Скільки коштує консультація, карієс і гігієна?');
    expect(lines.handoff).toBe(false);
    expect((lines.reply.match(/вартість потрібно уточнити в адміністратора/g) ?? []).length).toBe(3);
    expect(lines.reply).not.toMatch(/грн|\b0\b|1800|1000|1500/);
    expect(lines.reply).not.toMatch(/попередн/); // no sum is named, so no "preliminary" notice
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
    // the model names all three; the title is the same, so the code tells them apart by the group and writes each sum
    const ids = f.items.filter((x) => x.title === 'Видалення зуба').map((x) => x.ref);
    say('Є кілька варіантів.', 'info', ids);
    const d = await ask(c.clinicId, 'Скільки коштує видалення зуба?');
    expect(d.handoff).toBe(false);
    expect(d.reply).toContain('- Видалення зуба (Хірургія): 500 грн');
    expect(d.reply).toContain('- Видалення зуба (Терапія): 1000 грн');
    expect(d.reply).toContain('- Видалення зуба (Ортодонтія): 1500 грн');
    expect(llm.systems.at(-1)).toContain('Ніколи не обирай довільно найдешевшу');
  });

  it('ціна оновлюється після синхронізації; ціна, що розійшлася з рішенням адміністратора, не називається; прайси клінік ізольовані', async () => {
    const c = await clinic();
    const other = await clinic();
    await http().get('/integrations/cliniccards').set(auth(c.token)).expect(200);
    await http().put('/integrations/cliniccards/key').set(auth(c.token)).send({ apiKey: MOCK_KEY }).expect(200);
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    expect((await app.get(KbService).factsFor(c.clinicId)).allowedAmounts).toContain(1800);
    // the price list changes: a draft follows it at the next read
    mock.data.prices.find((r) => r.item_id === '1002')!.item_price = '2100';
    await http().post('/knowledge/import/services').set(auth(c.token)).expect(200);
    const after = await app.get(KbService).factsFor(c.clinicId);
    expect(after.allowedAmounts).toContain(2100);
    expect(after.allowedAmounts).not.toContain(1800);
    const cariesId = await refOf(c.clinicId, (await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, externalId: '1002' } })).id);
    say('Ось ціна.', 'info', [cariesId]);
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reply).toContain('- Лікування карієсу: 2100 грн'); // the new price, written by the code
    say('Лікування карієсу коштує 1800 грн.', 'info', [cariesId]);
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check'); // the old sum in the text is not accepted
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
    say('Ось ціна.', 'info', ['S999']); // a reference beyond the list of this clinic is not accepted
    expect((await ask(other.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
    say('Ось ціна.', 'info', [await idOf(other.clinicId, 'Лікування карієсу')]);
    expect((await ask(other.clinicId, 'Скільки коштує лікування карієсу?')).reply).toContain('- Лікування карієсу: 999 грн');
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
      expect({ q, found: f.text?.includes(`] ${title}`) }).toEqual({ q, found: true });
    }
    // «удалить зуб» is ambiguous (simple or complex): both variants are shown, the cheaper one is not picked
    const del = await kb.factsFor(c.clinicId, new Date(), 'удалить зуб видалення хірургія');
    expect(del.text).toContain('Видалення зуба простого');
    expect(del.text).toContain('Видалення зуба складного');
    // nothing in the price list resembles the words: no price, and the model is told not to say "no such service"
    const none = await kb.factsFor(c.clinicId, new Date(), 'скільки коштує квантовий масаж пяток');
    expect(none.allowedAmounts).toEqual([]);
    expect(none.items).toEqual([]);
    expect(none.text).toContain('не стверджуй, що такої послуги немає');
    expect(none.text).toContain('НАПРЯМКИ ПОСЛУГ КЛІНІКИ');
    say('Не знайшла такої послуги серед наших. Уточніть, будь ласка, назву: вартість уточнить адміністратор.');
    const d = await ask(c.clinicId, 'скільки коштує квантовий масаж пяток');
    expect(d.handoff).toBe(false);
    expect(d.reply).not.toMatch(/\d+\s*грн/);
  });

  it('ціна належить саме названій послузі за побудовою: модель вибирає id, код пише назву й суму з бази; ціна іншої послуги в тексті не проходить', async () => {
    const c = await bigClinic();
    const caries = await idOf(c.clinicId, 'Лікування карієсу');
    const filling = await idOf(c.clinicId, 'Пломба світлова');
    // the right service: the line is the exact title and the exact sum of the database
    say('Ось ціна.', 'info', [caries]);
    const ok = await ask(c.clinicId, 'Скільки коштує лікування карієсу?');
    expect(ok.handoff).toBe(false);
    expect(ok.reply).toContain('- Лікування карієсу: 1800 грн');
    expect(ok.reply).not.toContain('1100');
    // the model cannot attach the price of another service to a name: it writes no sum, and the id decides
    say('Лікування карієсу коштує 1100 грн.', 'info', [caries]);
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
    // two services in one answer: each line has its own sum, in the order the model named them
    say('Дві позиції.', 'info', [filling, caries]);
    const both = await ask(c.clinicId, 'Скільки коштує пломба і лікування карієсу?');
    expect(both.reply.indexOf('- Пломба світлова: 1100 грн')).toBeGreaterThan(-1);
    expect(both.reply.indexOf('- Лікування карієсу: 1800 грн')).toBeGreaterThan(both.reply.indexOf('- Пломба світлова: 1100 грн'));
    // a sum with no id at all cannot be said
    say('Це коштує 1800 грн.');
    expect((await ask(c.clinicId, 'Скільки коштує лікування карієсу?')).reason).toBe('reply_check');
  });
});
