import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { expandForSearch, fold, stemsOf } from '../src/ai/dental';
import { AppModule } from '../src/app.module';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

// One Instagram dialogue that went wrong on a live test (prices of cleaning, the content, a filling, a tooth removal, the same in Russian, a
// booking, the address). The model here is a FAITHFUL fake: it answers only from the services that are in the prompt it was given and asks
// for a hand-over when the prompt has nothing about the question, as the real one did. So the test fails when the search, the context or the
// validation of the code lose the right services. The real model runs the same dialogue in ai-eval.spec.ts.
const LOG: string[] = [];
const faithful = {
  configured: true,
  complete: async (system: string, messages: { role: string; content: string }[]) => {
    const lines = system.split('\n').filter((l) => l.startsWith('- ') && l.includes('(група:'));
    const users = messages.filter((m) => m.role === 'user').map((m) => m.content).reverse();
    const STOP = ['скил', 'сколь', 'кошту', 'стоит', 'зубив', 'зубов', 'хочу', 'добри', 'поста', 'вида'];
    let hits: string[] = [];
    for (const u of users) {
      // the patient's own words weigh double, the words the glossary adds (чистка -> гігієна) once; a line is kept when it is close to the best
      const own = stemsOf(u).filter((x) => !STOP.includes(x));
      const extra = stemsOf(expandForSearch(u)).filter((x) => !own.includes(x) && !STOP.includes(x));
      const scored = lines.map((l) => {
        const t = fold(l.split(';')[0]);
        return { l, n: 2 * own.filter((x) => t.includes(x)).length + extra.filter((x) => t.includes(x)).length };
      });
      const top = Math.max(0, ...scored.map((x) => x.n));
      hits = top ? scored.filter((x) => x.n >= (top * 2) / 3).map((x) => x.l) : [];
      if (hits.length) break;
    }
    const last = users[0];
    const out = (o: object) => ({ text: JSON.stringify({ summary: '', options: [], service: '', ...o }), inputTokens: 100, outputTokens: 20 });
    LOG.push(`${last} -> ${hits.length} lines`);
    if (!hits.length) return out({ intent: 'handoff', reply: 'Передаю запитання.' });
    const title = (l: string) => l.slice(2).split(' (група:')[0];
    const price = (l: string) => /ціна (\d+) грн/.exec(l)?.[1];
    const ru = /сколько|стоит|зубов|хочу записаться/i.test(last) && !/[іїє]/i.test(last);
    if (/що входить|что входит/i.test(last)) return out({ intent: 'info', reply: hits.map((l) => `${title(l)}: ${/склад і опис саме цієї послуги: (.*)$/.exec(l)?.[1] ?? 'склад уточнить адміністратор'}`).join('\n') });
    if (/записат|запис/i.test(last)) {
      const exact = lines.find((l) => fold(last).includes(fold(title(l))));
      return out({ intent: 'booking', reply: 'Підберемо час.', service: exact ? title(exact) : hits.length === 1 ? title(hits[0]) : '' });
    }
    if (/^[^?]*$/.test(last) && lines.some((l) => fold(last).includes(fold(title(l))))) {
      const exact = lines.find((l) => fold(last).includes(fold(title(l))))!;
      return out({ intent: 'booking', reply: 'Підберемо час.', service: title(exact) });
    }
    const body = hits.map((l) => `${title(l)}: ${price(l)} грн`).join('\n');
    return out({ intent: 'info', reply: `${ru ? 'По актуальному прайсу:' : 'За актуальним прайсом:'}\n${body}` });
  },
};
const sent: { chatId: string; text: string }[] = [];

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let mid = 0;

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(faithful).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string) => {
    sent.push({ chatId, text });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
});

// A price list shaped like the real one (234 positions; the real list has the typo "гігєна" and long groups of near-identical rows)
const REAL: [string, string, number, string][] = [
  ['Професійна гігєна "Air flow" 1 ступеня', 'Профілактика', 1200, '— AirFlow\n— Полірування'],
  ['Ультразвукова чистка зубів', 'Профілактика', 900, '— Видалення каменю ультразвуком\n— Полірування'],
  ['Чистка зубів комплексна (ультразвук + Air flow)', 'Профілактика', 1900, '— Ультразвук\n— AirFlow\n— Фторування'],
  ['Пломба світлова 1 поверхня', 'Терапія', 1100, 'Світлополімерний матеріал'],
  ['Пломба світлова 2 поверхні', 'Терапія', 1500, 'Світлополімерний матеріал, дві поверхні'],
  ['Пломбування кореневого каналу', 'Ендодонтія', 1400, ''],
  ['Лікування карієсу', 'Терапія', 1800, 'Препарування й пломба'],
  ['Видалення зуба простого', 'Хірургія', 900, ''],
  ['Видалення зуба складного', 'Хірургія', 2200, ''],
  ['Консультація лікаря', 'Консультації', 0, ''],
];
async function clinic() {
  const email = `d${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', sendingEnabled: true, scheduleMode: 'CABINETS', priceListSyncedAt: new Date() } });
  await http().patch('/ai').set(auth(token)).send({ enabled: true, autoReply: true }).expect(200);
  const now = new Date();
  const row = (title: string, category: string, priceUah: number | null, text: string, i: number) => ({ clinicId, kind: 'SERVICE', title, category, priceUah, text, source: 'CLINICCARDS', externalId: `d${i}`, externalPrice: priceUah, approvedAt: now, reviewedAt: now });
  await prisma.kbItem.createMany({ data: [...REAL.map(([t, c, p, x], i) => row(t, c, p === 0 ? null : p, x, i)), ...Array.from({ length: 150 }, (_, i) => row(`Допоміжна позиція ${i} матеріал`, 'Матеріали', 50 + i, '', 100 + i)),
      // many rows that share the generic word of the real hygiene title ("Професійна") and of a removal: they must not push the right services out
      ...Array.from({ length: 60 }, (_, i) => row(`Професійна консультація спеціаліста ${i}`, 'Консультації', 300 + i, '', 400 + i))] });
  return { token, clinicId, chat: `ig${rnd()}` };
}
const write = (c: { clinicId: string; chat: string }, text: string, payload?: string) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const last = () => sent[sent.length - 1].text;
const amounts = (t: string) => [...t.matchAll(/(\d[\d ]*)\s*грн/g)].map((m) => Number(m[1].replace(/ /g, ''))).sort((a, b) => a - b);
const requests = (c: { clinicId: string }, kind?: string) => prisma.bookingRequest.findMany({ where: { clinicId: c.clinicId, ...(kind ? { kind } : {}) } });

describe('діалог з живого тесту Instagram: ціни, склад, пломба, видалення, російська, запис, адреса', () => {
  it('усі сім повідомлень в одній розмові', async () => {
    const c = await clinic();

    // 1. the price of a cleaning (Ukrainian): the three cleaning services with their own prices
    await write(c, 'Добрий день! Скільки коштує чистка зубів?');
    expect(amounts(last())).toEqual([900, 1200, 1900]);
    expect(last()).toContain('Вартість попередня');
    const ukPrices = amounts(last());

    // 2. what is included: taken from the descriptions of THESE services, never carried from one to another
    await write(c, 'А що входить у цю вартість?');
    const content = last();
    expect(content).toMatch(/гігєна[^\n]*AirFlow/);
    expect(content).toMatch(/Ультразвукова чистка зубів: — Видалення каменю/);
    expect(content).toMatch(/комплексна[^\n]*Ультразвук — AirFlow — Фторування/);
    expect(content.match(/Фторування/g)).toHaveLength(1); // the fluoride of the complex service is not added to the others

    // 3. a filling: found (it was a hand-over before), the variants are shown with their own prices
    await write(c, 'А скільки коштує поставити пломбу?');
    expect(last()).not.toContain('Передали ваше запитання');
    expect(amounts(last())).toEqual(expect.arrayContaining([1100, 1500]));
    expect(last()).toContain('Вартість попередня');

    // 4. a tooth removal: both variants
    await write(c, 'Скільки коштує видалити зуб?');
    expect(amounts(last())).toEqual([900, 2200]);

    // 5. the same question about the cleaning in Russian: the same positions and prices as in Ukrainian, with the notice in Russian
    await write(c, 'Сколько стоит чистка зубов?');
    expect(amounts(last())).toEqual(ukPrices);
    expect(last()).toContain('Стоимость предварительная — точную сумму и что входит в услугу уточнит администратор.');
    expect(await requests(c)).toHaveLength(0); // questions answered from the price list create no request: nothing was handed over

    // 6. "I want to book a cleaning": three different cleaning services fit, so the patient is asked which one (no hand-over, no request)
    await write(c, 'Хочу записатися на чистку');
    expect(last()).toContain('Уточніть, будь ласка, яка саме послуга вам потрібна');
    for (const t of ['Ультразвукова чистка зубів', 'Професійна гігєна', 'Чистка зубів комплексна']) expect(last()).toContain(t);
    expect(last()).not.toContain('Передали');
    expect(await requests(c)).toHaveLength(0);

    // 6b. the patient names one; the service is not allowed for online booking yet: a request WITH the exact reason is created and the text says so
    await write(c, 'Ультразвукова чистка зубів');
    // the patient gets a plain answer (no technical word) and the offer to pass it on; a different service is not put in its place
    expect(last()).toContain('Цю послугу записує адміністратор');
    expect(last()).not.toMatch(/кабінет|тривалість|Cliniccards|налаштуван/i);
    const booking = await requests(c, 'BOOKING');
    expect(booking).toHaveLength(1);
    expect(booking[0].summary).toContain('послугу не дозволено для онлайн-запису');
    expect(booking[0].blockCode).toBe('service_not_allowed');
    expect(booking[0].service).toBe('Ультразвукова чистка зубів'); // exactly the chosen one is kept

    // 7. the address after the booking started: the clinic has not entered it, so it is said to be clarified (no invented ban), nothing new is promised
    await write(c, 'А де ви знаходитесь?');
    expect(last()).toContain('потрібно уточнити в адміністратора клініки');
    expect(last()).not.toMatch(/не можемо|в цьому чаті/);
    expect(await requests(c)).toHaveLength(1); // still the one request: no duplicate
    // the address is entered: it is named
    await http().put('/clinic/contacts').set(auth(c.token)).send({ address: 'м. Київ, вул. Тестова, 12', phone: '+380441234567' }).expect(200);
    await write(c, 'А де ви знаходитесь?');
    expect(last()).toContain('Наша адреса: м. Київ, вул. Тестова, 12');
    expect(await requests(c)).toHaveLength(1);

    // a repeated booking message does not create a second request
    await write(c, 'Ультразвукова чистка зубів');
    expect(await requests(c, 'BOOKING')).toHaveLength(1);
  });

  it('причина відсутності часу при записі називається точно: не дозволено / немає тривалості / немає спільного облікового запису', async () => {
    const c = await clinic();
    const svc = await prisma.kbItem.findFirstOrThrow({ where: { clinicId: c.clinicId, title: 'Ультразвукова чистка зубів' } });
    const reasonOf = async () => {
      await prisma.bookingRequest.deleteMany({ where: { clinicId: c.clinicId } });
      await write(c, 'Ультразвукова чистка зубів');
      return (await requests(c, 'BOOKING'))[0].summary;
    };
    const code = async () => (await requests(c, 'BOOKING'))[0].blockCode;
    expect(await reasonOf()).toContain('послугу не дозволено для онлайн-запису'); // not allowed
    expect(await code()).toBe('service_not_allowed');
    await prisma.kbItem.update({ where: { id: svc.id }, data: { onlineBooking: true } });
    expect(await reasonOf()).toContain('у послуги не вказана тривалість'); // allowed but no length
    expect(await code()).toBe('no_length');
    await prisma.kbItem.update({ where: { id: svc.id }, data: { durationMin: 45 } });
    expect(await reasonOf()).toContain('не вибрано спільний обліковий запис Cliniccards'); // the service is fine, the shared account is missing
    expect(await code()).toBe('no_shared_account');
  });

  it('ізоляція: розмова однієї клініки не бачить послуг і цін іншої', async () => {
    const a = await clinic();
    const b = await clinic();
    await prisma.kbItem.updateMany({ where: { clinicId: b.clinicId, title: 'Ультразвукова чистка зубів' }, data: { priceUah: 777, externalPrice: 777 } });
    await write(a, 'Скільки коштує чистка зубів?');
    expect(amounts(last())).not.toContain(777);
    await write(b, 'Скільки коштує чистка зубів?');
    expect(amounts(last())).toContain(777);
  });
});

describe('українські й російські формулювання знаходять одні й ті самі позиції (відмінки, синоніми, помилка прайсу «гігєна»)', () => {
  const pairs: [string, string][] = [
    ['Скільки коштує чистка зубів?', 'Сколько стоит чистка зубов?'],
    ['Скільки коштує гігієна?', 'Сколько стоит гигиена полости рта?'],
    ['Скільки коштує поставити пломбу?', 'Сколько стоит поставить пломбу?'],
    ['пломби', 'пломба'],
    ['лікування карієсу', 'лечение кариеса'],
    ['Скільки коштує видалити зуб?', 'Сколько стоит удалить зуб?'],
    ['видалення зуба', 'удаление зуба'],
    ['хочу вирвати зуб', 'хочу удалить зуб'],
  ];
  it.each(pairs)('«%s» і «%s» дають однаковий набір послуг із прайсу', async (uk, ru) => {
    const c = await clinic();
    const kb = app.get((await import('../src/kb/kb.service')).KbService);
    const titles = async (q: string) => {
      const f = await kb.factsFor(c.clinicId, new Date(), `${q} ${expandForSearch(q)}`, `${q} ${expandForSearch(q)}`);
      const rows = await prisma.kbItem.findMany({ where: { id: { in: f.shownIds } }, select: { title: true } });
      return rows.map((r) => r.title).filter((t) => REAL.some(([x]) => x === t)).sort();
    };
    const a = await titles(uk);
    expect(a.length).toBeGreaterThan(0);
    expect(await titles(ru)).toEqual(a);
  });

  it('помилка прайсу «гігєна» знаходиться за правильним написанням і навпаки', async () => {
    const c = await clinic();
    const kb = app.get((await import('../src/kb/kb.service')).KbService);
    for (const q of ['гігієна', 'гигиена', 'гігєна', 'професійна гігієна']) {
      const f = await kb.factsFor(c.clinicId, new Date(), q, q);
      expect(f.text).toContain('Професійна гігєна');
    }
  });
});

