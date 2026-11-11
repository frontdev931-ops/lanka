import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AGENT_FALLBACK_TEXT, LANGUAGE_ACK, ASK_PREFERENCE, CLOSE_TEXT, COMPARE_HELP, FINAL_AMOUNT, HELP_OFFER, WHICH_SERVICE_PRICE, SOFT_OFFER, closingOnly, dropPriceAnnouncements } from '../src/ai/agent-draft.service';
import { priceStatusDenied } from '../src/ai/agent-checks';
import { AGENT_PRICE_NOTICE, PRICE_NOTICE, composePriceReply, finalAmountQuestion, languageOnlyRequest, priceOnlyStanding } from '../src/ai/guardrails';
import { contactsOnly } from '../src/ai/contacts';
import { AgentDraftService } from '../src/ai/agent-draft.service';
import { DoctorChoiceService } from '../src/booking/doctor-choice.service';
import { detectLanguage, detectLanguageAgent, languageOf, languageOfAgent, languageRequest } from '../src/ai/guardrails';
import { closesDialogue, concernExplained, incomingHandoff, dropTypePrefix, mayClarify, softenExact, takeLeadIn } from '../src/ai/guardrails';
import { resolveDecision } from '../src/ai/decision-contract';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { SendError } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { KbService } from '../src/kb/kb.service';
import { RequestsService } from '../src/automations/requests.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, startMock } from '../mock/cliniccards-mock';
import { AgentClinic, createAgentClinic } from './agent-fixtures';

jest.setTimeout(120_000);

// Stage 1 of the universal booking funnel: the CONVERSATION RULES of the agent (answer first, one appropriate offer, a short path for those who are ready, no pressure after a doubt
// or a decline, continuity during and after a booking). The model is scripted (it answers by the words of the patient, the way a real one is expected to), the transport is a fake,
// Cliniccards is the mock, the data are synthetic. Assertions are about meaning, state and actions, not long strings. No paid model call, no real message.
let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const fake = { configured: true, script: (() => '') as () => string, complete: (async () => ({ text: '', inputTokens: 1, outputTokens: 1 })) as unknown };
const transport = { fail: false, sent: [] as { chatId: string; text: string; options: { label: string; date: string; time: string; doctorId?: string; payload?: string }[] }[] };

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
    if (transport.fail) throw new SendError('provider refused the message', false);
    transport.sent.push({ chatId, text, options: options.map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.doctorId ? { doctorId: o.doctorId } : {}), ...(o.payload ? { payload: o.payload } : {}) })) });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await mock.close();
  delete process.env.CLINICCARDS_BASE_URL;
  delete process.env.CLINICCARDS_WRITE_ENABLED;
  delete process.env.AGENT_AUTO_DIALOGS;
});
beforeEach(() => {
  transport.fail = false;
  transport.sent.length = 0;
  mock.writes.length = 0;
  delete process.env.AGENT_AUTO_DIALOGS;
  const horizon = clinicDate(new Date(Date.now() + 9 * 86_400_000));
  mock.data.visits = mock.data.visits.filter((v) => String(v.visit_start).slice(0, 10) > horizon);
  mock.data.spaces = mock.data.spaces.filter((b) => String(b.space_start).slice(0, 10) > horizon);
});

type C = AgentClinic;
const intake = () => app.get(IntakeService);
let mid = 0;
const say = (c: C, text: string, payload?: string) => intake().handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `f${++mid}${rnd()}`, text, payload });
const tap = (c: C, o: { date: string; time: string }) => say(c, `Обрав час: ${o.date.slice(8)}.${o.date.slice(5, 7)} ${o.time}`, `slot|${o.date}|${o.time}`);
const sendsTo = (c: C) => transport.sent.filter((m) => m.chatId === c.chat);
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const stateOf = (c: C) => prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: c.chat } });
const bookingReq = (c: C) => prisma.bookingRequest.findFirst({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'BOOKING' }, orderBy: { createdAt: 'desc' } });
const bookings = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'BOOKING' } });
const visitWrites = () => mock.writes.filter((w) => /visit/i.test(JSON.stringify(w)) && !/patient/i.test(String((w as { path?: string }).path ?? '')));
const refOf = async (c: C, title: string) => (await app.get(KbService).factsFor(c.clinicId, new Date(), '', '')).items.find((x) => x.title === title)!.ref;
const decision = (content: Record<string, unknown>, next: Record<string, unknown> = {}) =>
  JSON.stringify({ content: { kind: 'ANSWER', reply: 'Добрий день!', prices: [], after: '', ...content }, next: { action: 'NONE', service: null, reason: null, ...next } });

// the fake model answers by the last words of the patient and keeps every system prompt and call (the real model decides in a live run)
const model = { calls: 0, systems: [] as string[] };
const decideBy = (map: (last: string, system: string) => string) => {
  fake.complete = (async (system: string, messages: { role: string; content: string }[]) => {
    model.calls++;
    model.systems.push(system);
    return { text: map(messages[messages.length - 1].content, system), inputTokens: 1, outputTokens: 1 };
  }) as unknown;
};
beforeEach(() => {
  model.calls = 0;
  model.systems = [];
  decideBy(() => decision({ reply: 'Добре.' }));
});

// FUNNEL_PRINT=1 prints the transcript of every dialogue of a test (for the examples in the documentation); silent otherwise
const created: C[] = [];
afterEach(async () => {
  if (process.env.FUNNEL_PRINT) {
    for (const c of created) {
      const rows = await prisma.chatMessage.findMany({ where: { clinicId: c.clinicId, chatId: c.chat }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      // eslint-disable-next-line no-console
      console.log(`--- ${expect.getState().currentTestName?.slice(0, 60)}\n${rows.map((m) => `${m.direction === 'IN' ? 'ПАЦІЄНТ' : 'АГЕНТ  '}: ${m.text.replace(/\n+/g, ' / ')}${Array.isArray(m.buttons) && m.buttons.length ? `  [кнопки: ${(m.buttons as { label: string }[]).map((b) => b.label).join(' | ')}]` : ''}`).join('\n')}`);
    }
  }
  created.length = 0;
});
const allow = (c: C) => {
  process.env.AGENT_AUTO_DIALOGS = [process.env.AGENT_AUTO_DIALOGS, `${c.clinicId}|INSTAGRAM|${c.chat}`].filter(Boolean).join(',');
};
// an autonomous clinic with the one test service (the consultation), writing on, in the language of the dialogue
async function autoClinic(lang: 'uk' | 'ru' = 'uk') {
  const c = await createAgentClinic({ http, prisma }, { lang });
  await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAgentAuto: true, agentAutoServiceId: c.consult.id } });
  allow(c);
  created.push(c);
  const s = await refOf(c, lang === 'ru' ? 'Тестовая консультация' : 'Тестова консультація');
  return { c, s };
}
const ask = (c: C, text: string) => say(c, text);
const offerCount = (c: C) => sendsTo(c).filter((m) => m.text.includes(SOFT_OFFER.uk) || m.text.includes(SOFT_OFFER.ru)).length;

describe('правила розмови: правила в чистому вигляді', () => {
  it('контракт: відповідь на сумнів не є штовхачем — час у тому ж повідомленні не пропонується; решта дій без змін', () => {
    const ctx = { serviceRefs: ['S1'], advantageRefs: [], objectionRefs: [], hasService: false, hasChosenTime: false, priceQuestion: false, clarifyCount: 0, maxClarify: 2 };
    const raw = (kind: string, action: string) => ({ content: { kind, reply: 'Розуміємо.', after: '', prices: [] }, next: { action, service: 'S1', reason: null } });
    const doubt = resolveDecision(raw('HANDLE_DOUBT', 'OFFER_TIME'), ctx);
    expect(doubt.ok && doubt.decision.next.action).toBe('NONE');
    expect(doubt.ok && doubt.notes).toContain('offer_after_doubt');
    const plain = resolveDecision(raw('ANSWER', 'OFFER_TIME'), ctx);
    expect(plain.ok && plain.decision.next.action).toBe('OFFER_TIME');
  });

  it('«лише контакти» — структурне правило: друге питання чи сполучник не віддаються коду; закриття без питань і розмов про запис', () => {
    for (const t of ['Де ви знаходитесь?', 'Підкажіть адресу, будь ласка', 'Где вы находитесь?', 'До котрої ви працюєте?']) expect(contactsOnly(t)).toBe(true);
    for (const t of ['Де ви знаходитесь і скільки триває консультація?', 'Где вы находитесь, и сколько длится консультация?', 'Де ви? Скільки триває консультація?', 'Яка адреса, а ще чи є парковка']) expect(contactsOnly(t)).toBe(false);
    expect(closingOnly('Звісно! Підібрати зручний час? Якщо захочете записатися — пишіть.')).toBe('Звісно!');
    expect(closingOnly('Підібрати зручний час?')).toBe('');
    expect(closingOnly('Дякуємо, що звернулися. Пишіть нам, якщо з’являться запитання.')).toBe('Дякуємо, що звернулися. Пишіть нам, якщо з’являться запитання.');
  });
});

describe('діалоги воронки (автономний шлях, скриптована модель)', () => {
  it('1. ціна → одна пропозиція → згода → вільні часи (uk і ru); згода підібрати час — не згода на візит', async () => {
    for (const [lang, q, yes, offer] of [['uk', 'Скільки коштує консультація?', 'Так, підберіть', SOFT_OFFER.uk], ['ru', 'Сколько стоит консультация?', 'Да, подберите пожалуйста', SOFT_OFFER.ru]] as const) {
      const { c, s } = await autoClinic(lang);
      decideBy((last) => (/підберіть|подберите/i.test(last) ? decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: lang === 'ru' ? 'Консультация длится около 30 минут.' : 'Консультація триває близько 30 хвилин.', prices: [s] })));
      await ask(c, q);
      expect(sendsTo(c)[0].text).toContain('100');
      expect(sendsTo(c)[0].text.trim().endsWith(offer)).toBe(true);
      expect(sendsTo(c)[0].options).toEqual([]);
      expect((await stateOf(c)).salesStage).toBe('DISCOVERY');
      await ask(c, yes);
      expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
      expect((await stateOf(c)).salesStage).toBe('OFFERED');
      expect(await bookings(c)).toBe(0); // the agreement to look for a time created no booking and no visit
      expect(mock.writes).toHaveLength(0);
    }
  });

  it('2. ціна → адреса → тривалість: корисні відповіді, пропозиція запису одна на весь діалог, адреса — кодом без «пишіть нам»', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/триває/i.test(last) ? decision({ reply: 'Консультація триває приблизно 30 хвилин.' }) : decision({ reply: 'Ось ціна.', prices: [s] })));
    await ask(c, 'Скільки коштує консультація?');
    expect(model.calls).toBe(1);
    await ask(c, 'Де ви знаходитесь?');
    expect(model.calls).toBe(1); // the address is answered by the code from what the clinic entered
    expect(sendsTo(c)[1].text).toContain('Вигадана');
    expect(sendsTo(c)[1].text).not.toMatch(/запиш|напишіть нам/i);
    await ask(c, 'Скільки триває консультація?');
    expect(model.calls).toBe(2);
    expect(sendsTo(c)[2].text).toMatch(/30 хвилин/);
    expect(offerCount(c)).toBe(1);
    expect(sendsTo(c).every((m) => m.options.length === 0)).toBe(true);
  });

  it('3. готовий записатися: найкоротший шлях — одразу вільні часи, без реклами й без питань (uk і ru)', async () => {
    for (const [lang, text] of [['uk', 'Хочу записатися на консультацію'], ['ru', 'Запишите меня на консультацию, пожалуйста']] as const) {
      const { c, s } = await autoClinic(lang);
      model.calls = 0;
      decideBy(() => decision({ reply: lang === 'ru' ? 'Хорошо.' : 'Добре.' }, { action: 'OFFER_TIME', service: s }));
      await ask(c, text);
      expect(model.calls).toBe(1);
      expect(sendsTo(c)).toHaveLength(1);
      expect(sendsTo(c)[0].options.length).toBeGreaterThan(0);
      expect(sendsTo(c)[0].text).not.toMatch(/\?|знижк|акці|скидк|гарант/i); // no question, no promotion
      expect(offerCount(c)).toBe(0);
      expect(model.systems[0]).toMatch(/КОРОТКИЙ шлях/);
    }
  });

  it('4. кілька питань в одному повідомленні: ціна й адреса, адреса й тривалість — нічого не губиться, ім’я й телефон не просяться (uk і ru)', async () => {
    const { c, s } = await autoClinic();
    decideBy((last, system) => {
      const address = /адреса: ([^;\n]+)/.exec(system)?.[1] ?? '';
      return decision({ reply: `Наша адреса: ${address}. Консультація триває близько 30 хвилин.`, prices: /коштує/i.test(last) ? [s] : [] });
    });
    await ask(c, 'Скільки коштує консультація і де ви знаходитесь?');
    expect(sendsTo(c)[0].text).toMatch(/100/);
    expect(sendsTo(c)[0].text).toContain('Вигадана');
    await ask(c, 'Де ви знаходитесь і скільки триває консультація?');
    expect(model.calls).toBe(2); // not answered by the contacts code alone: the second question goes to the model
    expect(sendsTo(c)[1].text).toContain('Вигадана');
    expect(sendsTo(c)[1].text).toMatch(/30 хвилин/);
    expect(sendsTo(c).map((m) => m.text).join(' ')).not.toMatch(/прізвище|телефон|номер/i);
    const r = await autoClinic('ru');
    decideBy((_l, system) => decision({ reply: `Наш адрес: ${/адреса: ([^;\n]+)/.exec(system)?.[1] ?? ''}. Консультация длится около 30 минут.` }));
    await ask(r.c, 'Где вы находитесь и сколько длится консультация?');
    expect(sendsTo(r.c)[0].text).toContain('Выдуманная');
    expect(sendsTo(r.c)[0].text).toMatch(/30 минут/);
  });

  it('5. послуга неоднозначна: одне уточнення від коду зі списку затверджених послуг, без обіцянки «підберемо»; потім коротко до часів', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/консультац/i.test(last) ? decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Звісно, підберемо час.' }, { action: 'OFFER_TIME', service: null })));
    await ask(c, 'Хочу записатися');
    const q = sendsTo(c)[0];
    expect(q.options).toEqual([]);
    expect((q.text.match(/\?/g) ?? []).length).toBe(1);
    expect(q.text).toContain('Тестова консультація'); // the approved list
    expect(q.text).not.toMatch(/підберемо|запишемо/i);
    expect((await stateOf(c)).clarifyCount).toBe(1);
    expect(await bookings(c)).toBe(0);
    await ask(c, 'На консультацію');
    expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    expect(sendsTo(c)).toHaveLength(2);
  });

  it('6. «дорого» і «страшно»: визнання сумніву без повтору запрошення, знижок і гарантій; час не пропонується навіть якщо модель просить (uk і ru)', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/дорог/i.test(last) ? decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо ваш сумнів. До консультації входять огляд і план лікування.', prices: [s] }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Ось ціна.', prices: [s] })));
    await ask(c, 'Скільки коштує консультація?'); // the one soft offer
    expect(offerCount(c)).toBe(1);
    await ask(c, 'Це занадто дорога ціна для мене');
    const dear = sendsTo(c)[1];
    expect(dear.options).toEqual([]);
    expect(dear.text).not.toContain(SOFT_OFFER.uk);
    expect(dear.text).not.toMatch(/знижк|акці|розстрочк|гарант|безболісн/i);
    expect((await stateOf(c)).salesStage).not.toBe('OFFERED');
    // first message is a doubt that also contains a price word: no soft offer is attached to a doubt
    const d = await autoClinic();
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо. Точну суму та склад уточнить адміністратор.', prices: [d.s] }));
    await ask(d.c, 'Це якась дуже висока ціна');
    expect(sendsTo(d.c)[0].text).not.toContain(SOFT_OFFER.uk);
    expect(sendsTo(d.c)[0].options).toEqual([]);
    // fear, in Russian: the approved answer, no promise, no push
    const f = await autoClinic('ru');
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Понимаем вас. Врач объясняет каждый шаг и останавливается по вашему сигналу.' }, { action: 'OFFER_TIME', service: f.s }));
    await ask(f.c, 'Мне страшно идти к врачу');
    expect(sendsTo(f.c)[0].options).toEqual([]);
    expect(sendsTo(f.c)[0].text).not.toMatch(/безболезн|не больно|гарант/i);
    expect(model.systems[model.systems.length - 1]).toContain('HANDLE_DOUBT');
  });

  it('7. «подумаю» / відмова: ввічливе закриття без питання й без пропозиції часу, навіть якщо модель їх додала; без автоматичних нагадувань (uk і ru)', async () => {
    const { c } = await autoClinic();
    decideBy(() => decision({ reply: 'Звісно! Підібрати зручний час? Якщо захочете записатися — пишіть.' }, { action: 'CLOSE' }));
    await ask(c, 'Я подумаю');
    expect(sendsTo(c)).toHaveLength(1);
    expect(sendsTo(c)[0].text).toBe('Звісно!');
    expect(sendsTo(c)[0].options).toEqual([]);
    expect((await stateOf(c)).salesStage).toBe('DECLINED');
    const polite = await autoClinic();
    decideBy(() => decision({ reply: 'Дякуємо, що звернулися. Пишіть нам, якщо з’являться запитання.' }, { action: 'CLOSE' }));
    await ask(polite.c, 'Поки не готовий, дякую');
    expect(sendsTo(polite.c)[0].text).toBe('Дякуємо, що звернулися. Пишіть нам, якщо з’являться запитання.');
    // the model's closing is only an offer to book: the fixed thanks of the code is used (Russian)
    const r = await autoClinic('ru');
    decideBy(() => decision({ reply: 'Подобрать удобное время? Можем записать вас на завтра.' }, { action: 'CLOSE' }));
    await ask(r.c, 'Не хочу записываться');
    expect(sendsTo(r.c)[0].text).toBe(CLOSE_TEXT.ru);
    expect(sendsTo(r.c)).toHaveLength(1); // nothing follows by itself
  });

  it('8. після відмови пацієнт прямо просить запис: стає доступним одразу, модель знає про відмову з коду', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/запис/i.test(last) ? decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Добре, дякуємо.' }, { action: 'CLOSE' })));
    await ask(c, 'Ні, дякую, не потрібно');
    expect((await stateOf(c)).salesStage).toBe('DECLINED');
    await ask(c, 'Все-таки хочу записатися на консультацію');
    expect(model.systems[model.systems.length - 1]).toMatch(/раніше відмовився/);
    expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    expect((await stateOf(c)).salesStage).toBe('OFFERED');
    // and a polite question after a decline is answered without any new offer
    const d = await autoClinic();
    decideBy((last) => (/коштує/i.test(last) ? decision({ reply: 'Ось ціна.', prices: [d.s] }) : decision({ reply: 'Добре.' }, { action: 'CLOSE' })));
    await ask(d.c, 'Не треба, дякую');
    await ask(d.c, 'А скільки коштує консультація, просто цікаво?');
    expect(offerCount(d.c)).toBe(0);
  });

  it('9. питання під час збору контактів: відповідь і повернення до того самого кроку; послуга й час збережені, згоди немає', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/триває/i.test(last) ? decision({ reply: 'Консультація триває близько 30 хвилин.' }) : decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    const before = (await bookingReq(c))!;
    const n = sendsTo(c).length;
    await ask(c, 'Скільки триває консультація?');
    const added = sendsTo(c).slice(n);
    expect(added).toHaveLength(2);
    expect(added[0].text).toMatch(/30 хвилин/);
    expect(added[1].text).toMatch(/прізвище/i);
    expect(added.map((m) => m.text).join(' ')).not.toContain(SOFT_OFFER.uk);
    const after = (await bookingReq(c))!;
    expect(after.slotAt!.getTime()).toBe(before.slotAt!.getTime());
    expect(after.service).toBe(before.service);
    expect(after.consentAt).toBeNull();
    expect(visitWrites()).toHaveLength(0);
  });

  it('10. після підтвердженого запису: подяка й нове довідкове питання — без другого візиту, без збору даних і без пропозиції запису', async () => {
    const { c, s } = await autoClinic();
    decideBy((last, system) => (/триває/i.test(last) ? decision({ reply: 'Консультація триває близько 30 хвилин.' }) : decision({ reply: 'Добре.', prices: [s] }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    const done = sendsTo(c).length;
    await ask(c, 'Дякую!');
    await ask(c, 'А де ви знаходитесь?');
    await ask(c, 'Скільки триває консультація?');
    expect(model.systems[model.systems.length - 1]).toMatch(/запис УЖЕ створено/);
    const texts = sendsTo(c).slice(done).map((m) => m.text);
    expect(texts).toHaveLength(3);
    expect(texts.join(' ')).not.toMatch(/прізвище|телефон|Підібрати|Підтверджуєте/i);
    expect(sendsTo(c).slice(done).every((m) => m.options.length === 0)).toBe(true);
    expect(visitWrites()).toHaveLength(1);
    expect(await bookings(c)).toBe(1);
  });

  it('11. передача людині: після неї агент мовчить і нічого не продає; медична тема йде до людини без моделі', async () => {
    const { c } = await autoClinic();
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(c, 'Можна поговорити з адміністратором?');
    expect((await stateOf(c)).owner).toBe('HUMAN');
    const calls = model.calls;
    const sent = sendsTo(c).length;
    decideBy(() => decision({ reply: 'Ось ціна.' }));
    await ask(c, 'Скільки коштує консультація?');
    await ask(c, 'Хочу записатися');
    expect(sendsTo(c)).toHaveLength(sent); // the agent does not go on selling to a dialogue that belongs to a person
    expect(model.calls).toBe(calls);
    const m = await autoClinic();
    await ask(m.c, 'У мене нестерпно болить зуб');
    expect(model.calls).toBe(calls);
    expect((await stateOf(m.c)).owner).toBe('HUMAN');
    expect(sendsTo(m.c).map((x) => x.text).join(' ')).not.toContain(SOFT_OFFER.uk);
  });
});

describe('одне питання в повідомленні', () => {
  it('два питання до пацієнта в одній відповіді моделі — відхилення й один повтор; власне питання моделі не доповнюється пропозицією запису', async () => {
    const { c, s } = await autoClinic();
    let n = 0;
    decideBy(() => (++n === 1 ? decision({ kind: 'CLARIFY', reply: 'Яка саме послуга вас цікавить? І на який день?' }) : decision({ kind: 'CLARIFY', reply: 'Яка саме послуга вас цікавить?' })));
    await ask(c, 'Підкажіть, будь ласка, щодо лікування');
    expect(model.calls).toBe(2);
    expect((sendsTo(c)[0].text.match(/\?/g) ?? []).length).toBe(1);
    // a price answer that already ends with the model's own question gets no second question from the code
    decideBy(() => decision({ reply: 'Ось ціна. Вам зручніше вранці чи ввечері?', prices: [s] }));
    await ask(c, 'Скільки коштує консультація?');
    expect(sendsTo(c)[1].text).not.toContain(SOFT_OFFER.uk);
    expect((sendsTo(c)[1].text.match(/\?/g) ?? []).length).toBe(1);
  });
});

describe('12. чернетка, відхилена чи не надіслана, не змінює стан', () => {
  it('пропозиція рахується надісланою лише після справжньої відправки: чернетка, відхилення й помилка каналу її не «витрачають»', async () => {
    const c = await createAgentClinic({ http, prisma }, {});
    const s = await refOf(c, 'Тестова консультація');
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: 'Скільки коштує консультація?' } });
    decideBy(() => decision({ reply: 'Ось ціна.', prices: [s] }));
    const make = async () => (await http().post(`/conversations/INSTAGRAM/${c.chat}/draft`).set(auth(c.token)).expect(200)).body as { id: string; revision: number; previews: Record<string, string> };
    const approve = (v: { id: string; revision: number }, choice: string) => http().post(`/agent-drafts/${v.id}/approve`).set(auth(c.token)).send({ revision: v.revision, choice });
    const rowsOf = () => Promise.all([prisma.conversationState.count({ where: { clinicId: c.clinicId } }), prisma.chatMessage.count({ where: { clinicId: c.clinicId, direction: 'OUT' } })]);
    // a draft: nothing is written
    const v1 = await make();
    expect(v1.previews.SEND_REPLY).toContain(SOFT_OFFER.uk);
    expect(await rowsOf()).toEqual([0, 0]);
    // rejected: still nothing, and the next draft offers again
    await http().post(`/agent-drafts/${v1.id}/reject`).set(auth(c.token)).expect(200);
    expect(await rowsOf()).toEqual([0, 0]);
    const v2 = await make();
    expect(v2.previews.SEND_REPLY).toContain(SOFT_OFFER.uk);
    // the channel refuses: nothing is delivered, the stage does not move, the offer is not counted as sent
    transport.fail = true;
    const failed = (await approve(v2, 'SEND_REPLY')).body;
    expect(failed.outcome).toBe('FAILED');
    expect((await prisma.conversationState.findMany({ where: { clinicId: c.clinicId } })).filter((x) => x.salesStage !== 'NEW')).toHaveLength(0);
    transport.fail = false;
    const v3 = await make();
    expect(v3.previews.SEND_REPLY).toContain(SOFT_OFFER.uk);
    // really sent: the stage moves and the offer is not repeated
    expect((await approve(v3, 'SEND_REPLY')).body.outcome).toBe('SENT');
    expect((await prisma.conversationState.findFirstOrThrow({ where: { clinicId: c.clinicId } })).salesStage).toBe('DISCOVERY');
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: 'А скільки коштує консультація точно?' } });
    const v4 = await make();
    expect(v4.previews.SEND_REPLY).not.toContain(SOFT_OFFER.uk);
  });
});

// ---- hardening of stage 1: deterministic objections, eligible services, many patient questions, no invented contacts ----
import { objectionOf, priceAsked } from '../src/ai/guardrails';
import { inventedContact } from '../src/ai/contacts';

describe('жорсткі правила: заперечення, придатні послуги, багато питань пацієнта, вигадані контакти', () => {
  it('код сам читає заперечення (uk і ru); нейтральне питання про ціну, «недорого», «дорогу», страхову й прохання записатися — ні', () => {
    const kinds: Record<string, string[]> = {
      price: ['Це занадто дорого', 'Чому так дорого?', 'Дорого!', 'Слишком дорого для меня', 'Это дороговато', 'Це не по кишені', 'Занадто висока ціна', 'Это слишком высокая цена'],
      fear: ['Боюся стоматологів', 'Мені страшно', 'Мне страшно идти', 'Нервую заздалегідь', 'Я очень боюсь'],
      hesitation: ['Я подумаю', 'Еще подумаю', 'Не впевнена, що мені це потрібно', 'Поки не готовий'],
      refusal: ['Не хочу записуватися', 'Не хочу записываться', 'Не треба', 'Ні, дякую, не потрібно', 'Не надо', 'Передумав'],
    };
    for (const [kind, texts] of Object.entries(kinds)) for (const t of texts) expect([t, objectionOf(t)]).toEqual([t, kind]);
    for (const t of ['Скільки коштує консультація?', 'Яка ціна гігієни?', 'Сколько стоит лечение?', 'Недорого?', 'Як знайти дорогу до клініки?', 'Є страхова?', 'Де ви знаходитесь?', 'Хочу записатися', 'Дорого, але все одно хочу записатися', 'Страшно, але запишіть мене', 'Не треба знижок, скільки коштує?', 'Скільки триває консультація?']) expect([t, objectionOf(t)]).toEqual([t, null]);
    // an explicit price request is told from the bare noun of a complaint
    expect(priceAsked('Це дорого, а скільки точно коштує?')).toBe(true);
    expect(priceAsked('Яка точна ціна?')).toBe(true);
    expect(priceAsked('Занадто висока ціна')).toBe(false);
  });

  it('вигаданий контакт: адреса чи телефон, яких клініка не вводила, — ні; відомі чи відсутні дані — як є', () => {
    expect(inventedContact('Ми на вул. Шевченка, 5.', { address: false, phone: true })).toBe('address');
    expect(inventedContact('Телефон +380 97 000 01 23', { address: true, phone: false })).toBe('phone');
    expect(inventedContact('Ми на вул. Шевченка, 5. Телефон 0970000123', { address: true, phone: true })).toBeNull();
    expect(inventedContact('Адреси в нас немає, це уточнить адміністратор.', { address: false, phone: false })).toBeNull();
  });

  it('заперечення, яке модель позначила звичайною відповіддю: без списку цін, без пропозиції запису й без часів (uk і ru, ціна, страх, вагання, відмова)', async () => {
    for (const [lang, text, kind] of [['uk', 'Це занадто дорого', 'price'], ['ru', 'Слишком дорого для меня', 'price'], ['ru', 'Мне страшно', 'fear'], ['uk', 'Я ще подумаю', 'hesitation'], ['ru', 'Не хочу записываться', 'refusal']] as const) {
      const { c, s } = await autoClinic(lang);
      // the model labels it a plain ANSWER, lists the price, and for price/fear also asks for the times
      decideBy(() => decision({ kind: 'ANSWER', reply: lang === 'ru' ? 'Понимаем вас.' : 'Розуміємо вас.', prices: [s] }, { action: kind === 'price' || kind === 'fear' ? 'OFFER_TIME' : 'NONE', service: s }));
      await ask(c, text);
      const sent = sendsTo(c);
      expect(sent.length).toBeGreaterThan(0);
      const t = sent.map((m) => m.text).join(' ');
      expect([text, /100/.test(t)]).toEqual([text, false]); // no price list nobody asked for
      expect([text, t.includes(SOFT_OFFER.uk) || t.includes(SOFT_OFFER.ru)]).toEqual([text, false]);
      expect(sent.every((m) => m.options.length === 0)).toBe(true);
      expect(await bookings(c)).toBe(0);
    }
    // a question to the patient in the answer to an objection is refused and repeated once
    const q = await autoClinic();
    model.calls = 0;
    let n = 0;
    decideBy(() => (++n === 1 ? decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо. Може, підібрати зручний час?' }) : decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо вас.' })));
    await ask(q.c, 'Це занадто дорого');
    expect(model.calls).toBe(2);
    expect(sendsTo(q.c)[0].text).not.toContain('?');
  });

  it('нейтральне питання про ціну — не заперечення: ціна й одна м’яка пропозиція, як і раніше', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Ось ціна.', prices: [s] }));
    await ask(c, 'Скільки коштує консультація?');
    expect(sendsTo(c)[0].text).toContain('100 грн');
    expect(sendsTo(c)[0].text.trim().endsWith(SOFT_OFFER.uk)).toBe(true);
  });

  it('заперечення разом з явним питанням: ціна — відповідь із ціною без пропозиції; адреса — відповідь, а не лише співчуття; питання не повертаються', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо ваш сумнів. Точну суму уточнить адміністратор.', prices: [s] }));
    await ask(c, 'Це дорого, а скільки точно коштує консультація?');
    expect(sendsTo(c)[0].text).toContain('100 грн');
    expect(sendsTo(c)[0].text).not.toContain(SOFT_OFFER.uk);
    expect(sendsTo(c)[0].text).not.toContain('?');
    const r = await autoClinic('ru');
    model.calls = 0;
    decideBy((_l, system) => decision({ kind: 'HANDLE_DOUBT', reply: `Понимаем вас. Наш адрес: ${/адреса: ([^;\n]+)/.exec(system)?.[1] ?? ''}` }));
    await ask(r.c, 'Мне страшно, а где вы находитесь?');
    expect(model.calls).toBe(1); // not taken by the contacts code alone: the concern is answered too
    expect(sendsTo(r.c)[0].text).toContain('Выдуманная');
    expect(sendsTo(r.c)[0].text).not.toContain('?');
    expect(sendsTo(r.c)[0].text).not.toContain(SOFT_OFFER.ru);
  });

  it('пряме прохання записатися працює після відмови й разом із сумнівом (uk і ru)', async () => {
    const { c, s } = await autoClinic('ru');
    decideBy((last) => (/запиш/i.test(last) ? decision({ reply: 'Хорошо.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Хорошо, спасибо.' })));
    await ask(c, 'Не хочу записываться');
    expect(sendsTo(c)[0].options).toEqual([]);
    await ask(c, 'Хорошо, запишите меня на консультацию');
    expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    expect((await stateOf(c)).salesStage).toBe('OFFERED');
    const d = await autoClinic();
    decideBy(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: d.s }));
    await ask(d.c, 'Дорого, але все одно хочу записатися');
    expect(sendsTo(d.c)[0].options.length).toBeGreaterThan(0);
  });

  describe('список послуг у питанні «на яку послугу»', () => {
    const view = async (c: C, text: string, answer: string) => {
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text } });
      decideBy(() => answer);
      return (await http().post(`/conversations/INSTAGRAM/${c.chat}/draft`).set(auth(c.token)).expect(200)).body as { kind: string; allowed: string[]; handoffReason: string | null; options: string[]; previews: Record<string, string> };
    };
    const services = (c: C, rows: { id: string; on: boolean }[]) => http().put('/booking-settings/services').set(auth(c.token)).send({ services: rows.map((r) => ({ id: r.id, onlineBooking: r.on, cabinetIds: [] })) }).expect(200);
    const noRef = decision({ reply: 'Звісно, підберемо час.' }, { action: 'OFFER_TIME', service: null });

    it('придатні й непридатні разом: у списку лише ті, що можна записати онлайн (до чотирьох); без придатних — шлях до адміністратора без «передали»', async () => {
      const c = await createAgentClinic({ http, prisma }, {});
      await services(c, [{ id: c.consult.id, on: true }, { id: c.filling.id, on: true }, { id: c.hygiene.id, on: false }]);
      const v = await view(c, 'Хочу записатися', noRef);
      const text = v.previews.SEND_REPLY;
      expect(text).toContain('Тестова консультація');
      expect(text).toContain('Тестове лікування');
      expect(text).not.toContain('Тестова гігієна');
      expect(text).not.toContain('Тестова безкоштовна');
      expect((text.match(/\?/g) ?? []).length).toBe(1);
      expect(v.options).toEqual([]);
      // nothing can be booked online
      const n = await createAgentClinic({ http, prisma }, {});
      await services(n, [{ id: n.consult.id, on: false }]);
      const none = await view(n, 'Хочу записатися', noRef);
      expect(none.kind).toBe('handoff');
      expect(none.handoffReason).toBe('online_booking_unavailable');
      expect(none.previews.SEND_REPLY).toMatch(/недоступн/i);
      expect(none.previews.SEND_REPLY).not.toMatch(/передали|передано|передан/i); // an offer, not a done hand-over
      expect(await prisma.bookingRequest.count({ where: { clinicId: n.clinicId, kind: 'HANDOFF' } })).toBe(0);
    });

    it('придатна послуга далеко за межами перших 20 (і за межами того, що влізло в запит): список усе одно її містить, «немає доступних» не кажуть', async () => {
      const c = await createAgentClinic({ http, prisma }, {});
      const now = new Date();
      // 45 approved services that cannot be booked online, all sorted BEFORE the one that can
      await prisma.kbItem.createMany({ data: Array.from({ length: 45 }, (_, i) => ({ clinicId: c.clinicId, kind: 'SERVICE', title: `Послуга ${String(i).padStart(2, '0')}`, text: '', priceUah: 50, durationMin: 30, active: true, approvedAt: now, reviewedAt: now })) });
      const last = await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'SERVICE', title: 'Ярка консультація', text: '', priceUah: 100, durationMin: 30, active: true, approvedAt: now, reviewedAt: now } });
      await services(c, [{ id: last.id, on: true }]);
      const v = await view(c, 'Хочу записатися', noRef);
      expect(v.kind).not.toBe('handoff');
      expect(v.previews.SEND_REPLY).toContain('Ярка консультація');
      expect(v.previews.SEND_REPLY).not.toContain('Послуга 00');
      expect(v.previews.SEND_REPLY).not.toMatch(/недоступн/i);
    });

    it('автономна клініка пропонує лише свою дозволену послугу; названа непридатна послуга — пояснення й шлях через адміністратора, без часів', async () => {
      const { c, s } = await autoClinic();
      await services(c, [{ id: c.consult.id, on: true }, { id: c.filling.id, on: true }]);
      decideBy(() => decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: null }));
      await ask(c, 'Хочу записатися');
      expect(sendsTo(c)[0].text).toContain('Тестова консультація');
      expect(sendsTo(c)[0].text).not.toContain('Тестове лікування');
      const m = await createAgentClinic({ http, prisma }, {});
      const hyg = await refOf(m, 'Тестова гігієна');
      const v = await view(m, 'Хочу записатися на гігієну', decision({ reply: 'Звісно.', prices: [hyg] }, { action: 'OFFER_TIME', service: hyg }));
      expect(v.handoffReason).toBe('online_booking_unavailable');
      expect(v.options).toEqual([]);
      expect(v.previews.SEND_REPLY).toContain('Тестова гігієна');
      expect(v.previews.SEND_REPLY).toMatch(/адміністратор/i);
      expect(v.previews.SEND_REPLY).not.toMatch(/передали ваш/i);
      expect(s).toBeTruthy();
    });
  });

  describe('виправлення за живою перевіркою: уточнення послуги, слова про ціну, оформлення', () => {
    const viewOf = async (c: C, text: string, answer: string) => {
      await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text } });
      decideBy(() => answer);
      return (await http().post(`/conversations/INSTAGRAM/${c.chat}/draft`).set(auth(c.token)).expect(200)).body as { kind: string; handoffReason: string | null; options: string[]; previews: Record<string, string> };
    };
    const only = (c: C, ids: string[]) => http().put('/booking-settings/services').set(auth(c.token)).send({ services: ids.map((id) => ({ id, onlineBooking: true, cabinetIds: [] })) }).expect(200);

    it('питання про послугу, написане самою моделлю з переліком недоступних послуг (живий збій): текст моделі замінює код, у списку лише придатні', async () => {
      const c = await createAgentClinic({ http, prisma }, {});
      await only(c, [c.consult.id]);
      // the actual live output: the model asks itself and lists services that cannot be booked online
      const live = decision({ kind: 'CLARIFY', reply: 'Звісно, допоможу із записом. На яку послугу ви хочете записатися: тестова безкоштовна перевірка, тестова гігієна, тестова консультація чи тестове лікування?' });
      const v = await viewOf(c, 'Хочу записатися', live);
      const text = v.previews.SEND_REPLY;
      expect(text).toContain('Тестова консультація');
      for (const bad of ['Тестова гігієна', 'тестова гігієна', 'Тестове лікування', 'тестове лікування', 'безкоштовна']) expect(text).not.toContain(bad);
      expect((text.match(/\?/g) ?? []).length).toBe(1);
      expect(v.options).toEqual([]);
      // the same for the Russian dialogue
      const r = await createAgentClinic({ http, prisma }, { lang: 'ru' });
      await only(r, [r.consult.id]);
      const vr = await viewOf(r, 'Хочу записаться', decision({ kind: 'CLARIFY', reply: 'На какую услугу вы хотите записаться: тестовая гигиена или тестовая консультация?' }));
      expect(vr.previews.SEND_REPLY).toContain('Тестовая консультация');
      expect(vr.previews.SEND_REPLY).not.toMatch(/гигиен/i);
    });

    it('питання про послугу від моделі без придатних послуг — шлях через адміністратора; відповіді на фактичні питання з того ж повідомлення зберігаються', async () => {
      const n = await createAgentClinic({ http, prisma }, {});
      await only(n, []);
      await prisma.kbItem.updateMany({ where: { clinicId: n.clinicId, kind: 'SERVICE' }, data: { onlineBooking: false } });
      const none = await viewOf(n, 'Хочу записатися', decision({ kind: 'CLARIFY', reply: 'На яку послугу ви хочете записатися: гігієна чи консультація?' }));
      expect(none.handoffReason).toBe('online_booking_unavailable');
      expect(none.previews.SEND_REPLY).toMatch(/недоступн/i);
      expect(none.previews.SEND_REPLY).not.toMatch(/гігієна чи/i);
      // a mixed message: the factual answer stays, the model's own question and the unavailable names go
      const c = await createAgentClinic({ http, prisma }, {});
      await only(c, [c.consult.id]);
      const mixed = await viewOf(c, 'Скільки триває прийом і хочу записатися', decision({ kind: 'CLARIFY', reply: 'Консультація триває близько 30 хвилин.\nНа яку послугу ви хочете записатися: тестова гігієна чи тестова консультація?' }));
      const text = mixed.previews.SEND_REPLY;
      expect(text).toContain('триває близько 30 хвилин');
      expect(text).toContain('Тестова консультація');
      expect(text).not.toMatch(/гігієна/i);
      expect((text.match(/\?/g) ?? []).length).toBe(1);
    });

    it('попередня ціна не називається точною чи остаточною (uk і ru), навіть коли про точну ціну питають; примітка одна', async () => {
      for (const lang of ['uk', 'ru'] as const) {
        const { c, s } = await autoClinic(lang);
        const reply = lang === 'ru' ? 'Понимаю. Точная стоимость Тестовой консультации: она включает осмотр и план лечения. Окончательная цена зависит от объёма.' : 'Розумію. Точна вартість Тестової консультації: вона включає огляд і план лікування. Остаточна ціна залежить від обсягу.';
        decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply, prices: [s] }));
        await ask(c, lang === 'ru' ? 'Это дорого, сколько точно стоит консультация?' : 'Це дорого, а скільки точно коштує консультація?');
        const text = sendsTo(c)[0].text;
        expect(text).not.toMatch(/(точн|остаточн|окончательн)\p{L}*\s+(вартіст|стоимост|ціна|цена)/iu);
        expect(text).toMatch(lang === 'ru' ? /Стоимость Тестовой консультации/ : /Вартість Тестової консультації/);
        expect(text).toMatch(lang === 'ru' ? /Стоимость предварительная/ : /Вартість попередня/);
        expect((text.match(/попередня|предварительная/g) ?? []).length).toBe(1);
        expect(text).toContain('100');
      }
    });

    it('заголовок ціни не відривається від рядка ціни; зайвий тип послуги перед її назвою прибирається, змістовні назви — ні', async () => {
      const { c, s } = await autoClinic();
      decideBy(() => decision({ reply: 'Вартість консультації:\nКонсультація «Тестова консультація» триває близько 30 хвилин.\nАдреса клініки невідома, її уточнить адміністратор.', prices: [s] }));
      await ask(c, 'Скільки коштує консультація, де ви і скільки триває?');
      const text = sendsTo(c)[0].text;
      expect(text).not.toContain('Консультація «Тестова');
      expect(text).toContain('«Тестова консультація» триває');
      const lines = text.split('\n');
      const lead = lines.findIndex((l) => /^Вартість консультації:$/.test(l));
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(lines[lead + 1]).toMatch(/^- Тестова консультація: 100/);
    });

    it('чисті функції: слова про точність, заголовок і тип послуги', () => {
      expect(softenExact('Точна вартість лікування: вона включає огляд.')).toBe('Вартість лікування: вона включає огляд.');
      expect(softenExact('Точну вартість уточнить адміністратор.')).toBe('Точну вартість уточнить адміністратор.');
      expect(softenExact('Окончательная цена зависит от объёма.')).toBe('Цена зависит от объёма.');
      expect(takeLeadIn('Вартість консультації:\nКонсультація триває 30 хвилин.')).toEqual({ rest: 'Консультація триває 30 хвилин.', lead: 'Вартість консультації:' });
      expect(takeLeadIn('Все добре. Її вартість:')).toEqual({ rest: 'Все добре.', lead: 'Її вартість:' });
      expect(takeLeadIn('Адреса:\nвул. Вигадана').lead).toBe('');
      const titles = ['Тестова консультація', 'Лікування каналів', 'Гігієна'];
      expect(dropTypePrefix('Консультація «Тестова консультація» триває', titles)).toBe('«Тестова консультація» триває');
      expect(dropTypePrefix('Лікування «Лікування каналів»', titles)).toBe('«Лікування каналів»');
      expect(dropTypePrefix('Послуга «Гігієна» коштує', titles)).toBe('Послуга «Гігієна» коштує');
      expect(dropTypePrefix('Консультація «Невідома назва»', titles)).toBe('Консультація «Невідома назва»');
    });
  });

  it('кілька питань пацієнта (ціна, адреса, тривалість) — відповідь на кожне, одна пропозиція; багатотемна відповідь не відхиляється', async () => {
    const { c, s } = await autoClinic();
    decideBy((_l, system) => decision({ reply: `Наша адреса: ${/адреса: ([^;\n]+)/.exec(system)?.[1] ?? ''} Консультація триває близько 30 хвилин.`, prices: [s] }));
    await ask(c, 'Скільки коштує консультація, де ви знаходитесь і скільки вона триває?');
    expect(model.calls).toBe(1); // the several topics were not a reason to refuse
    const t = sendsTo(c)[0].text;
    expect(t).toContain('100 грн');
    expect(t).toContain('Вигадана');
    expect(t).toMatch(/30 хвилин/);
    expect((t.match(/\?/g) ?? []).length).toBe(1); // only the one soft offer
    expect(t.trim().endsWith(SOFT_OFFER.uk)).toBe(true);
  });

  it('немає перевіреної адреси: вигадану модель відхиляє перевірка, відповідь прямо каже, що даних немає; решта питань відповіджена', async () => {
    const { c, s } = await autoClinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { publicAddress: null, publicDirections: null } });
    let n = 0;
    decideBy(() => (++n === 1 ? decision({ reply: 'Ми знаходимося на вул. Шевченка, 5. Консультація триває близько 30 хвилин.', prices: [s] }) : decision({ reply: 'Адреси клініки в мене немає, це уточнить адміністратор. Консультація триває близько 30 хвилин.', prices: [s] })));
    await ask(c, 'Скільки коштує консультація, де ви знаходитесь і скільки вона триває?');
    expect(model.calls).toBe(2);
    const t = sendsTo(c)[0].text;
    expect(t).not.toMatch(/вул\./i);
    expect(t).toMatch(/немає, це уточнить адміністратор/);
    expect(t).toContain('100 грн');
    expect(t).toMatch(/30 хвилин/);
    expect(model.systems[0]).not.toContain('адреса:'); // the prompt did not have an address to give
  });
});

// ---- Stage 2: helpful objection handling and decision support. The model is SCRIPTED (it answers the way a good one is expected to, or tries what the guards must stop); assertions are about
// behaviour and claims (questions, offers, times, bookings, state), not exact prose. No paid call, no real message.
describe('етап 2: допомога з запереченнями', () => {
  const qCount = (c: C) => sendsTo(c).map((m) => (m.text.match(/\?/g) ?? []).length);
  const noNudge = (c: C) => {
    const t = sendsTo(c).map((m) => m.text).join(' ');
    expect(t).not.toContain(SOFT_OFFER.uk);
    expect(t).not.toContain(SOFT_OFFER.ru);
    expect(sendsTo(c).every((m) => m.options.length === 0)).toBe(true);
  };
  const L = { uk: { dear: 'Це занадто дорого', fear: 'Мені страшно', fearWhy: 'Боюся болю', afford: 'Зараз не потягну', think: 'Мені треба порадитися з чоловіком', what: 'Що входить у консультацію?', ok: 'Добре, дякую', book: 'Запишіть мене на консультацію', calm: 'Розумію вас.', body: 'Консультація включає огляд і план лікування.' }, ru: { dear: 'Это слишком дорого', fear: 'Мне страшно', fearWhy: 'Боюсь боли', afford: 'Сейчас нет денег', think: 'Мне нужно посоветоваться с мужем', what: 'Что входит в консультацию?', ok: 'Хорошо, спасибо', book: 'Запишите меня на консультацию', calm: 'Понимаем вас.', body: 'Консультация включает осмотр и план лечения.' } } as const;

  it('читання коду: «не потягну», «порадитися», недовіра — власні види; пауза закриває, невпевненість — ні; страх без пояснення — одне уточнення', () => {
    expect(objectionOf('Зараз не потягну')).toBe('afford');
    expect(objectionOf('Сейчас нет денег')).toBe('afford');
    expect(objectionOf('Я вже мав неприємний досвід у стоматолога')).toBe('distrust');
    expect(objectionOf('Мне нужно посоветоваться с мужем')).toBe('hesitation');
    expect(objectionOf('Страшно, але підберіть вільний час')).toBeNull(); // a request for times is not an objection
    for (const t of ['Я подумаю', 'Мені треба порадитися', 'Не зараз', 'Нужно посоветоваться']) expect([t, closesDialogue(objectionOf(t), t)]).toEqual([t, true]);
    for (const t of ['Не впевнена, що мені це потрібно', 'Це занадто дорого', 'Мені страшно']) expect([t, closesDialogue(objectionOf(t), t)]).toEqual([t, false]);
    for (const [t, v] of [['Мені страшно', true], ['Мне страшно идти к врачу', true], ['Боюся стоматологів', true], ['Боюся болю', false], ['Боюсь, что будет больно и долго', false], ['Це занадто дорого', false]] as const) expect([t, mayClarify(objectionOf(t), t)]).toEqual([t, v]);
    expect(concernExplained('Боюся болю', 'fear')).toBe(true);
    // "afraid of pain" is a fear for the agent only; a real symptom in the same message still goes to a person; the working bot is unchanged
    expect(incomingHandoff('Боюся болю', false, { fearOfPain: true })).toBeNull();
    expect(incomingHandoff('Боюсь боли', false, { fearOfPain: true })).toBeNull();
    expect(incomingHandoff('Боюся, у мене болить зуб', false, { fearOfPain: true })).toBe('medical');
    expect(incomingHandoff('Боюся болю')).toBe('medical');
  });

  for (const lang of ['uk', 'ru'] as const) {
    const t = L[lang];
    it(`1-2. сумнів щодо ціни (${lang}): з перевіреним складом — коротке пояснення; без нього — коротке визнання; без питань, бюджету, знижок і пропозиції; ціна не повторюється`, async () => {
      const a = await autoClinic(lang);
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${t.body}` }));
      await ask(a.c, t.dear);
      expect(qCount(a.c)).toEqual([0]);
      expect(sendsTo(a.c)[0].text).toContain(t.body);
      expect(sendsTo(a.c)[0].text).not.toMatch(/100/);
      noNudge(a.c);
      // no useful verified detail: the short acknowledgement is enough; a question about the budget and an invented discount are both refused and rewritten
      const asks = [lang === 'ru' ? 'Понимаем. Какой у вас бюджет?' : 'Розуміємо. Який у вас бюджет?', lang === 'ru' ? 'Понимаем. Можем сделать скидку.' : 'Розуміємо. Можемо зробити знижку.'];
      for (const bad of asks) {
        model.calls = 0;
        const b = await autoClinic(lang);
        let n = 0;
        decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: ++n === 1 ? bad : t.calm }));
        await ask(b.c, t.dear);
        expect(model.calls).toBe(2); // refused once, rewritten once
        const text = sendsTo(b.c)[0].text;
        expect(text).not.toContain('?');
        expect(text).not.toMatch(/скидк|знижк|бюджет/i);
        noNudge(b.c);
      }
    });

    it(`3. явна неможливість заплатити зараз (${lang}): закриття без переконування, питань, цін і часів, навіть якщо модель їх просить; пізніше пряме прохання працює`, async () => {
      const { c, s } = await autoClinic(lang);
      decideBy((last) => (/запиш|запис/i.test(last) ? decision({ reply: 'ОК.' }, { action: 'OFFER_TIME', service: s }) : decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} Може, підібрати щось дешевше?`, prices: [s] }, { action: 'OFFER_TIME', service: s })));
      await ask(c, t.afford);
      const out = sendsTo(c)[0].text;
      expect(out).not.toContain('?');
      expect(out).not.toMatch(/100|дешев/);
      noNudge(c);
      expect((await stateOf(c)).salesStage).toBe('DECLINED');
      await ask(c, t.book);
      expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    });

    it(`4-6. страх (${lang}): пояснений страх — без уточнення; невиразний — одне уточнення, далі відповідь; проігноровану не повторюють; пропозиції запису немає`, async () => {
      // (the scripted model writes its questions in the language of the conversation: a reply in the other language is no longer sent, see the language tests at the end of the file)
      const ask1 = lang === 'ru' ? 'Что именно вас пугает?' : 'Що саме вас лякає?';
      const ask2 = lang === 'ru' ? 'Что именно вас беспокоит?' : 'Що саме вас турбує?';
      const ask3 = lang === 'ru' ? 'Что-то ещё беспокоит?' : 'Ще щось турбує?';
      // explained: a question is refused, the retry has none
      const a = await autoClinic(lang);
      let n = 0;
      decideBy(() => (++n === 1 ? decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${ask1}` }) : decision({ kind: 'HANDLE_DOUBT', reply: t.calm })));
      await ask(a.c, t.fearWhy);
      expect(model.calls).toBe(2);
      expect(qCount(a.c)).toEqual([0]);
      noNudge(a.c);
      // vague: ONE clarification is allowed (and it is not an offer); the answer gets a relevant reply without another question
      const b = await autoClinic(lang);
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${ask2}` }, { action: 'OFFER_TIME', service: b.s }));
      await ask(b.c, t.fear);
      expect(qCount(b.c)).toEqual([1]);
      noNudge(b.c);
      model.calls = 0;
      let k = 0;
      decideBy(() => (++k === 1 ? decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${ask3}` }) : decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${t.body}` })));
      await ask(b.c, t.fearWhy);
      expect(model.calls).toBe(2);
      expect(qCount(b.c)).toEqual([1, 0]);
      // ignored clarification: the patient says something else that is again vague; no second probe
      model.calls = 0;
      const c = await autoClinic(lang);
      let m = 0;
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: ++m <= 2 ? `${t.calm} ${ask2}` : t.calm }));
      await ask(c.c, t.fear);
      await ask(c.c, lang === 'ru' ? 'Всё равно страшно' : 'Все одно страшно');
      expect(model.calls).toBe(3); // the second probe is refused and rewritten
      expect(qCount(c.c)).toEqual([1, 0]);
      expect(await bookings(c.c)).toBe(0);
    });

    it(`7. поганий попередній досвід (${lang}): обіцянка «інакше» відхиляється, відповідь без гарантій; питання не критикує; передача лише пропонується`, async () => {
      const { c } = await autoClinic(lang);
      let n = 0;
      decideBy(() => (++n === 1 ? decision({ kind: 'HANDLE_DOUBT', reply: lang === 'ru' ? 'У нас такого не будет, гарантируем.' : 'У нас такого не буде, гарантуємо.' }) : decision({ kind: 'HANDLE_DOUBT', reply: lang === 'ru' ? 'Сожалеем, что так вышло. Врач объясняет каждый шаг.' : 'Шкода, що так сталося. Лікар пояснює кожен крок.' })));
      await ask(c, lang === 'ru' ? 'У меня был неприятный опыт у стоматолога' : 'Я вже мав неприємний досвід у стоматолога');
      expect(model.calls).toBe(2);
      expect(sendsTo(c)[0].text).not.toMatch(/гаранту/i);
      noNudge(c);
      // when the concern needs a person, the draft only OFFERS the hand-over: nothing is said to be done
      const h = await createAgentClinic({ http, prisma }, { lang });
      await prisma.chatMessage.create({ data: { clinicId: h.clinicId, channel: 'INSTAGRAM', chatId: h.chat, direction: 'IN', text: lang === 'ru' ? 'У меня был плохой опыт, хочу обсудить с врачом' : 'Я мав поганий досвід, хочу обговорити з лікарем' } });
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: t.calm }, { action: 'HAND_OFF', reason: 'needs_clarification' }));
      const v = (await http().post(`/conversations/INSTAGRAM/${h.chat}/draft`).set(auth(h.token)).expect(200)).body as { kind: string; previews: Record<string, string> };
      expect(v.kind).toBe('handoff');
      expect(v.previews.SEND_REPLY).not.toMatch(/передали ваш|передано|передан/i);
    });

    it(`8. «подумаю / порадитися» (${lang}): шанобливе закриття, без питання, запрошення й нагадувань; пізніше пряме прохання відновлює запис`, async () => {
      const { c, s } = await autoClinic(lang);
      decideBy((last) => (/запиш|запис/i.test(last) ? decision({ reply: 'ОК.' }, { action: 'OFFER_TIME', service: s }) : decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} Підібрати час, щоб ви могли обговорити?` }, { action: 'OFFER_TIME', service: s })));
      await ask(c, t.think);
      expect(sendsTo(c)[0].text).not.toMatch(/\?|підібр|подобр/i);
      noNudge(c);
      expect(sendsTo(c)).toHaveLength(1);
      await ask(c, t.book);
      expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    });

    it(`9-10. після сумніву: питання про зміст — відповідь без часів; «добре/дякую» після пояснення — без автоматичного запису; прийняття пропозиції часу працює`, async () => {
      const { c, s } = await autoClinic(lang);
      // the model asks for times every time; the code looks them up only with a signal of booking intent
      decideBy((last) => decision({ reply: /входить|входит/i.test(last) ? t.body : t.calm }, { action: 'OFFER_TIME', service: s }));
      await ask(c, t.dear);
      await ask(c, t.what);
      expect(sendsTo(c)[1].text).toContain(t.body);
      await ask(c, t.ok);
      expect(sendsTo(c)).toHaveLength(3);
      noNudge(c);
      expect(await bookings(c)).toBe(0);
      // an accepted offer of times is still a booking step
      const d = await autoClinic(lang);
      decideBy((last) => (/коштує|стоит/i.test(last) ? decision({ reply: 'Ось ціна.', prices: [d.s] }) : decision({ reply: 'ОК.' }, { action: 'OFFER_TIME', service: d.s })));
      await ask(d.c, lang === 'ru' ? 'Сколько стоит консультация?' : 'Скільки коштує консультація?');
      expect(offerCount(d.c)).toBe(1);
      await ask(d.c, lang === 'ru' ? 'Хорошо' : 'Добре');
      expect(sendsTo(d.c)[1].options.length).toBeGreaterThan(0);
    });

    it(`11-12. пряме прохання записатися після відмови; сумнів і прохання в одному повідомленні — коротка відповідь і час (${lang})`, async () => {
      const a = await autoClinic(lang);
      decideBy((last) => (/запиш|запис/i.test(last) ? decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: a.s }) : decision({ reply: 'Добре.' }, { action: 'CLOSE' })));
      await ask(a.c, lang === 'ru' ? 'Нет, не надо' : 'Ні, не треба');
      await ask(a.c, t.book);
      expect(sendsTo(a.c)[1].options.length).toBeGreaterThan(0);
      const b = await autoClinic(lang);
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: `${t.calm} ${t.body}` }, { action: 'OFFER_TIME', service: b.s }));
      await ask(b.c, lang === 'ru' ? 'Мне страшно, но запишите меня на консультацию' : 'Мені страшно, але запишіть мене на консультацію');
      expect(sendsTo(b.c)[0].options.length).toBeGreaterThan(0);
      expect(sendsTo(b.c)[0].text).toContain(t.body);
      const e = await autoClinic(lang);
      decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: t.calm }, { action: 'OFFER_TIME', service: e.s }));
      await ask(e.c, lang === 'ru' ? 'Дорого, подберите свободное время' : 'Дорого, підберіть вільний час');
      expect(sendsTo(e.c)[0].options.length).toBeGreaterThan(0);
    });
  }

  it('13. кілька фактичних питань поруч із сумнівом: відповідь на кожне (адреса, тривалість), коротке визнання, без цін, питань і пропозиції', async () => {
    const { c } = await autoClinic();
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Розумію. Наша адреса: м. Тестове, вул. Вигадана, 1 (тестова адреса). Консультація триває близько 30 хвилин.' }));
    await ask(c, 'Дорого. А де ви знаходитесь і скільки триває консультація?');
    const text = sendsTo(c)[0].text;
    expect(text).toContain('Вигадана');
    expect(text).toMatch(/30 хвилин/);
    expect(text).not.toMatch(/100|\?/);
    noNudge(c);
  });

  it('14. немає перевірених даних: вигадані переваги, безболісність і розстрочка відхиляються, повтор — лише визнання', async () => {
    const { c } = await autoClinic();
    const answers = ['Наші лікарі найкращі, і це абсолютно безболісно.', 'Є розстрочка на три місяці.', 'Розумію вас.'];
    let n = 0;
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: answers[Math.min(n++, 2)] }));
    await ask(c, 'Мені страшно, а ще дорого');
    expect(sendsTo(c)[0].text).not.toMatch(/безболісн|розстрочк|найкращ/i);
    expect(sendsTo(c)).toHaveLength(1);
  });

  it('15. невідкладний симптом поруч зі страхом: передача людині без моделі, продажної логіки немає', async () => {
    const { c } = await autoClinic();
    model.calls = 0;
    await ask(c, 'Мені страшно, у мене нестерпно болить зуб');
    expect(model.calls).toBe(0);
    expect((await stateOf(c)).owner).toBe('HUMAN');
    noNudge(c);
  });

  it('16. сумнів після підтвердженого запису не починає новий запис', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/страшно|дорого/i.test(last) ? decision({ kind: 'HANDLE_DOUBT', reply: 'Розумію вас.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Добре.', prices: [s] }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    const done = sendsTo(c).length;
    await ask(c, 'Мені трохи страшно перед візитом');
    await ask(c, 'Добре, дякую');
    const tail = sendsTo(c).slice(done);
    expect(tail.every((m) => m.options.length === 0)).toBe(true);
    expect(tail.map((m) => m.text).join(' ')).not.toMatch(/Підібрати|прізвище|Підтверджуєте/i);
    expect(visitWrites()).toHaveLength(1);
    expect(await bookings(c)).toBe(1);
  });
});

// ---- Stage 2, hardening: contextual booking intent, factual answers in a closing, relevant clarification count, no needless escalation. Scripted model. ----
describe('етап 2: загартування', () => {
  const lookedUp = (m: { text: string; options: unknown[] }) => m.options.length > 0 || /вікон|окон/i.test(m.text);
  const noLookup = (c: C) => sendsTo(c).every((m) => !lookedUp(m));
  const L = { uk: { dear: 'Це занадто дорого', price: 'Скільки коштує консультація?', no: 'Не підходить', eve: 'Ввечері', book: 'Хочу записатися на консультацію', calm: 'Розумію вас.' }, ru: { dear: 'Это слишком дорого', price: 'Сколько стоит консультация?', no: 'Не подходит', eve: 'Вечером', book: 'Хочу записаться на консультацию', calm: 'Понимаем вас.' } } as const;

  for (const lang of ['uk', 'ru'] as const) {
    const t = L[lang];
    it(`1. одні й ті самі слова («${t.no}», «${t.eve}») у контексті запису — підбір часу; після ціни, пояснення чи заперечення — ні (${lang})`, async () => {
      // booking context: times were offered, the patient turns them down / states a preference
      const a = await autoClinic(lang);
      decideBy((last) => (/запис/i.test(last) ? decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: a.s }) : decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: a.s })));
      await ask(a.c, t.book);
      expect(sendsTo(a.c)[0].options.length).toBeGreaterThan(0);
      await ask(a.c, t.no); // the offered times were turned down and no wish is known: ONE focused question, no new search yet
      expect(sendsTo(a.c)[1].text).toContain(ASK_PREFERENCE[lang]);
      expect(lookedUp(sendsTo(a.c)[1])).toBe(false);
      await ask(a.c, t.eve);
      expect(lookedUp(sendsTo(a.c)[2])).toBe(true);
      // the agent asked when it suits: the answer is a time wish
      const b = await autoClinic(lang);
      let n = 0;
      decideBy(() => (++n === 1 ? decision({ kind: 'CLARIFY', reply: lang === 'ru' ? 'Когда вам удобно?' : 'Коли вам зручно?' }) : decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: b.s })));
      await ask(b.c, lang === 'ru' ? 'Подберите время на консультацию' : 'Підберіть час на консультацію');
      await ask(b.c, t.eve);
      expect(lookedUp(sendsTo(b.c)[1])).toBe(true);
      // NO booking context: after an objection answer, after a price answer with the soft offer, after an explanation: the same words do not start a lookup
      const c = await autoClinic(lang);
      decideBy((last) => (/коштує|стоит/i.test(last) ? decision({ reply: 'Ось ціна.', prices: [c.s] }) : decision({ kind: /дорого/i.test(last) ? 'HANDLE_DOUBT' : 'ANSWER', reply: t.calm }, { action: 'OFFER_TIME', service: c.s })));
      await ask(c.c, t.dear);
      await ask(c.c, t.no); // "does not suit" after a price objection: about the price
      await ask(c.c, t.eve);
      expect(noLookup(c.c)).toBe(true);
      expect(await bookings(c.c)).toBe(0);
      const d = await autoClinic(lang);
      decideBy((last) => (/коштує|стоит/i.test(last) ? decision({ reply: 'Ось ціна.', prices: [d.s] }) : decision({ reply: t.calm }, { action: 'OFFER_TIME', service: d.s })));
      await ask(d.c, t.price); // price answer with the soft offer
      await ask(d.c, t.no); // "no" to the offer, not a rejected slot
      expect(noLookup(d.c)).toBe(true);
    });
  }

  it('2. закриття зберігає відповіді на ВСІ явні фактичні питання (адреса, графік, тривалість), без питання, пропозиції й умовлянь (uk і ru)', async () => {
    // uk: the code answers the address from the clinic data, then the thanks
    const a = await autoClinic('uk');
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Розумію вас.' }));
    await ask(a.c, 'Зараз не потягну, а де ви знаходитеся?');
    let text = sendsTo(a.c)[0].text;
    expect(text).toContain('Вигадана');
    expect(text).not.toMatch(/\?|Підібрати|знижк/);
    expect((await stateOf(a.c)).salesStage).toBe('DECLINED');
    // ru: the duration comes from the model's statement, its invitation is dropped, the thanks is added
    const b = await autoClinic('ru');
    decideBy(() => decision({ reply: 'Консультация длится около 30 минут. Если надумаете, запишитесь к нам на удобное время.' }, { action: 'CLOSE' }));
    await ask(b.c, 'Я подумаю. Сколько длится консультация?');
    text = sendsTo(b.c)[0].text;
    expect(text).toMatch(/30 минут/);
    expect(text).not.toMatch(/запишитесь|удобное время|\?/);
    expect(text).toMatch(/Спасибо/);
    // the hours as a request ("просто скажіть"): answered, then closed
    const c = await autoClinic('uk');
    await prisma.clinic.update({ where: { id: c.c.clinicId }, data: { workHours: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), { from: '09:00', to: '18:00' }])) } });
    decideBy(() => decision({ reply: 'Добре.' }, { action: 'CLOSE' }));
    await ask(c.c, 'Не хочу записуватися, просто скажіть ваш графік.');
    text = sendsTo(c.c)[0].text;
    expect(text).toMatch(/09:00/);
    expect(text).not.toMatch(/\?|Підібрати/);
    // missing information is said honestly, not invented
    const d = await autoClinic('uk');
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { publicAddress: null } });
    decideBy(() => decision({ reply: 'Розумію.' }, { action: 'CLOSE' }));
    await ask(d.c, 'Я подумаю, а де ви знаходитесь?');
    text = sendsTo(d.c)[0].text;
    expect(text).not.toMatch(/вул\.|вулиц/i);
    expect(text).toMatch(/адміністратор|немає|не маємо/i);
    // and a price asked together with a pause keeps its answer
    const e = await autoClinic('uk');
    decideBy(() => decision({ reply: 'Добре.', prices: [e.s] }, { action: 'CLOSE' }));
    await ask(e.c, 'Я подумаю, скільки коштує консультація?');
    text = sendsTo(e.c)[0].text;
    expect(text).toContain('100 грн');
    expect(text).toContain('Вартість попередня');
    expect(text).not.toMatch(/\?|Підібрати/);
  });

  it('3. лічильник уточнень: стороннє питання агента не витрачає уточнення; нова турбота — власне; невідповідь не повторюють; повернення після розмови — дозволене', async () => {
    // an unrelated question of the agent earlier does not consume the clarification
    const a = await autoClinic();
    let n = 0;
    decideBy((last) => (/триває/i.test(last) ? decision({ reply: 'Близько 30 хвилин. Вам зручніше вранці чи ввечері?' }) : decision({ kind: 'HANDLE_DOUBT', reply: `${++n && 'Розумію вас.'} Що саме вас турбує?` })));
    await ask(a.c, 'Скільки триває консультація?');
    await ask(a.c, 'Мені страшно');
    expect(qCount2(a.c)).toEqual([1, 1]);
    // an unanswered clarification is not repeated, and not replaced by another probe (even about a different concern)
    const b = await autoClinic();
    let m = 0;
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: ++m <= 2 ? 'Розумію. Що саме вас турбує?' : 'Розумію вас.' }));
    await ask(b.c, 'Мені страшно');
    await ask(b.c, 'Я мав поганий досвід');
    expect(qCount2(b.c)).toEqual([1, 0]);
    // a genuinely new concern, later in the conversation, gets its own clarification
    const c = await autoClinic();
    decideBy((last) => (/страшно|досвід/i.test(last) ? decision({ kind: 'HANDLE_DOUBT', reply: 'Розумію вас. Що саме вас турбує?' }) : decision({ reply: 'Консультація включає огляд.' })));
    await ask(c.c, 'Мені страшно');
    await ask(c.c, 'Що входить у консультацію?');
    await ask(c.c, 'Я мав поганий досвід');
    expect(qCount2(c.c)).toEqual([1, 0, 1]);
    // the same concern coming back after several messages is probed again (an approximation, not an episode detector)
    const d = await autoClinic();
    decideBy((last) => (/страшно/i.test(last) ? decision({ kind: 'HANDLE_DOUBT', reply: 'Розумію вас. Що саме вас турбує?' }) : decision({ reply: 'Консультація включає огляд.' })));
    await ask(d.c, 'Мені страшно');
    for (const q of ['Що входить?', 'Що ще входить?', 'А що ще?', 'І ще що?']) await ask(d.c, q);
    await ask(d.c, 'Мені страшно');
    expect(qCount2(d.c)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it('4. звичайне заперечення, модель двічі порушила правила: коротка відповідь від коду з перевіреним фактом, без повідомлення співробітникам; потрібна передача — зберігається; невдала передача не оголошується', async () => {
    // fear: the one approved FAQ about fear is used; no staff request, the dialogue stays with the bot, no "Передали"
    const a = await autoClinic();
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Це абсолютно безболісно, ми гарантуємо.' }));
    await ask(a.c, 'Боюся болю');
    expect(model.calls).toBe(2);
    let text = sendsTo(a.c)[0].text;
    expect(text).toContain('Лікар пояснює кожен крок');
    expect(text).not.toMatch(/Передали|безболісн|гаранту|\?/);
    expect(await prisma.bookingRequest.count({ where: { clinicId: a.c.clinicId, kind: 'HANDOFF' } })).toBe(0);
    expect((await stateOf(a.c)).owner).toBe('BOT');
    // price concern, no known fact: a short acknowledgement and a statement, not a promise
    const b = await autoClinic('ru');
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Можем сделать скидку.' }));
    await ask(b.c, 'Это слишком дорого');
    text = sendsTo(b.c)[0].text;
    expect(text).not.toMatch(/Передали|скидк|\?/i);
    expect(text).toMatch(/администратор/);
    expect(await prisma.bookingRequest.count({ where: { clinicId: b.c.clinicId, kind: 'HANDOFF' } })).toBe(0);
    // a refusal whose closing the model keeps spoiling: closed with the thanks
    const r = await autoClinic();
    decideBy(() => decision({ reply: 'Підібрати час? Є знижка.' }, { action: 'OFFER_TIME', service: r.s }));
    await ask(r.c, 'Не хочу записуватися');
    expect(sendsTo(r.c)[0].text).toBe(CLOSE_TEXT.uk);
    // NOT an ordinary objection: the old safe path stays (an offer of a hand-over, never "done")
    const q = await createAgentClinic({ http, prisma }, {});
    await prisma.chatMessage.create({ data: { clinicId: q.clinicId, channel: 'INSTAGRAM', chatId: q.chat, direction: 'IN', text: 'Розкажіть про імплантацію докладніше' } });
    decideBy(() => decision({ reply: 'Гарантуємо результат.' }));
    const v = (await http().post(`/conversations/INSTAGRAM/${q.chat}/draft`).set(auth(q.token)).expect(200)).body as { kind: string; previews: Record<string, string> };
    expect(v.kind).toBe('fallback');
    expect(v.previews.SEND_REPLY).not.toMatch(/Передали|передано/);
    // a required hand-over whose request FAILS is not announced
    const f = await autoClinic();
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    const spy = jest.spyOn(app.get(RequestsService), 'upsert').mockRejectedValue(new Error('db down'));
    try {
      await ask(f.c, 'Покличте, будь ласка, адміністратора');
    } finally {
      spy.mockRestore();
    }
    expect(sendsTo(f.c).map((x) => x.text).join(' ')).not.toMatch(/Передали|передано/);
    expect(await prisma.agentDraft.count({ where: { clinicId: f.c.clinicId, status: 'FAILED' } })).toBe(1);
    expect((await stateOf(f.c)).owner).toBe('HUMAN');
  });
});
const qCount2 = (c: C) => sendsTo(c).map((m) => (m.text.match(/\?/g) ?? []).length);

// ---- Stage 3: language of the conversation, an unclear service need, contextual wishes, rejected times, dates. Scripted model, the mock Cliniccards, a fake transport. ----
describe('етап 3: мова, неясна потреба, побажання щодо часу', () => {
  const lookedUp3 = (m: { text: string; options: unknown[] }) => m.options.length > 0 || /вікон|окон/i.test(m.text);
  const DAYS = ['', 'понеділок', 'вівторок', 'середу', 'четвер', 'п’ятницю', 'суботу', 'неділю'];

  it('мова: «Боюсь боли у стоматолога» — російська; короткі й ambiguous повідомлення, імена й телефони мову не міняють; явне прохання виграє', () => {
    expect(detectLanguageAgent('Боюсь боли у стоматолога')).toBe('ru'); // the earlier misreading: no letter of either language, words missing from the short lists
    expect(detectLanguageAgent('Боюся болю у стоматолога')).toBe('uk');
    expect(languageOfAgent(['Боюсь боли у стоматолога'])).toBe('ru');
    expect(detectLanguage('Боюсь боли у стоматолога')).toBeNull(); // the working bot's reading is unchanged
    expect(languageOf(['Ірина Коваль', 'Хочу записаться'])).toBe('uk');
    const ru = 'Хочу записаться на консультацию';
    for (const short of ['ок', 'Так', 'Да', 'Ірина Коваль', 'Коваль Ірина', '0971234567', '12.11', 'Фамилия Коваль, имя Ірина, телефон 0971234567', 'Прізвище Коваль, ім’я Ірина, телефон 0971234567']) expect([short, languageOfAgent([short, ru])]).toEqual([short, 'ru']);
    expect(languageOfAgent(['ок', 'Скільки коштує консультація?'])).toBe('uk');
    expect(languageOfAgent(['ок'])).toBe('uk'); // nothing shows a language: the default
    // an explicit request wins over what the other messages show, and the newest request wins
    expect(languageRequest('Відповідайте, будь ласка, російською')).toBe('ru');
    expect(languageRequest('Можно по-украински?')).toBe('uk');
    expect(languageRequest('Я розмовляю російською')).toBe('ru');
    expect(languageRequest('Скільки коштує консультація?')).toBeNull();
    expect(languageOfAgent(['Скільки це коштує?', 'Давайте по-русски, пожалуйста'])).toBe('ru');
    expect(languageOfAgent(['Давайте українською', 'Скільки это стоит?', 'Ответьте по-русски'])).toBe('uk');
  });

  it('російська розмова до підтвердження запису: усі тексти системи російською, ім’я з українською літерою мову не міняє, скорочені відповіді тримають мову', async () => {
    const { c, s } = await autoClinic('ru');
    decideBy((last) => (/записаться|запис/i.test(last) ? decision({ reply: 'Конечно.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Хорошо.' })));
    await ask(c, 'Хочу записаться на консультацию');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Фамилия Коваль, имя Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    await say(c, 'Да, подтверждаю', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    await ask(c, 'ок');
    const out = sendsTo(c).map((m) => m.text).join('\n');
    expect(out.replace('Ірина', '')).not.toMatch(/[іїєґ]/i); // only the patient's own name echoed back has a Ukrainian letter
    expect(out).toContain('Ваша запись подтверждена');
    // an explicit switch in the middle is respected for the next texts
    const t = await autoClinic('ru');
    decideBy(() => decision({ reply: 'Конечно.' }, { action: 'OFFER_TIME', service: t.s }));
    await ask(t.c, 'Хочу записаться на консультацию');
    await ask(t.c, 'Відповідайте, будь ласка, українською. Підберіть інший час');
    expect(sendsTo(t.c)[1].text).toMatch(/Оберіть, будь ласка|Підкажіть, будь ласка/);
  });

  it('неясна потреба: перший крок називає лише власний опис послуги, яка проходить перевірку онлайн-запису; без моделі; час шукається лише після згоди; без опису — одне питання, потім шлях до адміністратора', async () => {
    const { c, s } = await autoClinic();
    await prisma.kbItem.update({ where: { id: c.consult.id }, data: { text: 'Склад (тестові дані): огляд і план лікування. Підходить як перший крок, якщо не знаєте, з чого почати.' } });
    model.calls = 0;
    decideBy((last) => (/підберіть/i.test(last) ? decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Ось.' })));
    await ask(c, 'Не знаю, яка послуга мені потрібна');
    expect(model.calls).toBe(0); // the clinic's own words, written by the code
    const first = sendsTo(c)[0];
    expect(first.text).toContain('Тестова консультація');
    expect(first.text).toContain('Почати можна з «Тестова консультація»');
    expect(first.text).toContain('огляд і план лікування');
    expect(first.text).not.toMatch(/описі клініки|перший крок|першим кроком/); // the clinic's description is not quoted as a source, and nothing is said twice
    expect(first.text).toContain('Підібрати зручний час?');
    expect(first.options).toEqual([]); // information alone starts no search
    expect((await stateOf(c)).serviceId).toBe(c.consult.id);
    await ask(c, 'Так, підберіть');
    expect(sendsTo(c)[1].options.length).toBeGreaterThan(0);
    // a service that names itself the first step but cannot be booked online is NOT offered
    const o = await autoClinic();
    await prisma.kbItem.update({ where: { id: o.c.consult.id }, data: { text: 'Перший крок для нових пацієнтів.', onlineBooking: false } });
    model.calls = 0;
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує чи для чого вам потрібен візит?' }, { action: 'OFFER_TIME', service: o.s }));
    await ask(o.c, 'Не знаю, яка послуга мені потрібна');
    expect(model.calls).toBeGreaterThan(0);
    expect(sendsTo(o.c)[0].text).not.toContain('Тестова консультація');
    expect(sendsTo(o.c)[0].options).toEqual([]);
    // no approved routing at all: the model may not pick a service from a described need; one question; the limit of clarifications leads to the staff path
    const n = await createAgentClinic({ http, prisma }, {});
    const ref = await refOf(n, 'Тестова консультація');
    await prisma.chatMessage.create({ data: { clinicId: n.clinicId, channel: 'INSTAGRAM', chatId: n.chat, direction: 'IN', text: 'Мені потрібна допомога, не знаю що обрати' } });
    decideBy(() => decision({ reply: 'Дякуємо за повідомлення, розберемося.' }, { action: 'OFFER_TIME', service: ref }));
    const d = (await http().post(`/conversations/INSTAGRAM/${n.chat}/draft`).set(auth(n.token)).expect(200)).body as { options: unknown[]; previews: Record<string, string> };
    expect(d.options).toEqual([]);
    expect(d.previews.SEND_REPLY).not.toContain('Тестова консультація'); // no service is picked from a described need
    const m2 = await createAgentClinic({ http, prisma }, {});
    await prisma.conversationState.create({ data: { clinicId: m2.clinicId, channel: 'INSTAGRAM', chatId: m2.chat, clarifyCount: 2 } });
    await prisma.chatMessage.create({ data: { clinicId: m2.clinicId, channel: 'INSTAGRAM', chatId: m2.chat, direction: 'IN', text: 'Не знаю, яка послуга мені потрібна' } });
    model.calls = 0;
    const h = (await http().post(`/conversations/INSTAGRAM/${m2.chat}/draft`).set(auth(m2.token)).expect(200)).body as { kind: string; handoffReason: string | null; previews: Record<string, string> };
    expect(model.calls).toBe(0);
    expect(h.kind).toBe('handoff');
    expect(h.handoffReason).toBe('service_unknown');
    expect(h.previews.SEND_REPLY).not.toMatch(/передали|передано/i);
    // urgent symptoms keep priority over any routing
    const u = await autoClinic();
    await prisma.kbItem.update({ where: { id: u.c.consult.id }, data: { text: 'Підходить як перший крок, якщо не знаєте, з чого почати.' } });
    model.calls = 0;
    await ask(u.c, 'Не знаю, яка послуга потрібна, у мене нестерпно болить зуб');
    expect(model.calls).toBe(0);
    expect((await stateOf(u.c)).owner).toBe('HUMAN');
    expect(sendsTo(u.c).map((x) => x.text).join(' ')).not.toContain('Почати можна з');
  });

  it('готовність записатися з уже відомими послугою й побажанням: побажання повторно не питається, нові часи не повторюють відхилені; відхилення без побажання — одне питання; «нових вікон немає» — чесно в межах 7 днів', async () => {
    const { c, s } = await autoClinic();
    decideBy((last) => (/коштує/i.test(last) ? decision({ reply: 'Ось ціна.', prices: [s] }) : decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Можу лише після 9:00, і бажано якомога раніше. Скільки коштує консультація?'); // price answer; the wish is known
    await ask(c, 'Запишіть мене на консультацію');
    const first = sendsTo(c)[1].options;
    expect(first.length).toBeGreaterThan(0);
    // turned down, no new wish: the known wish is reused, the rejected times are not shown again
    await ask(c, 'Не підходить');
    const again = sendsTo(c)[2];
    const firstKeys = new Set(first.map((o) => `${o.date}|${o.time}`));
    expect(again.options.every((o) => !firstKeys.has(`${o.date}|${o.time}`))).toBe(true);
    expect(again.text).not.toContain(ASK_PREFERENCE.uk);
    // a patient with NO known wish who turns the times down gets one focused question, once
    const n = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: n.s }));
    await ask(n.c, 'Запишіть мене на консультацію');
    await ask(n.c, 'Не підходить');
    expect(sendsTo(n.c)[1].text).toContain(ASK_PREFERENCE.uk);
    expect(sendsTo(n.c)[1].options).toEqual([]);
    // a wish nothing meets: the actual result and the searched range, no waiting list, no staff request without the patient's yes
    await ask(n.c, 'Тоді після 21:00');
    const none = sendsTo(n.c)[2].text;
    expect(none).toMatch(/7 днів/);
    expect(none).not.toMatch(/черг|очіку|записали до списку/i);
    expect(sendsTo(n.c)[2].options).toEqual([]);
    expect(await prisma.bookingRequest.count({ where: { clinicId: n.c.clinicId, kind: 'HANDOFF' } })).toBe(0);
  });

  it('дати в календарі клініки: «завтра» — лише завтрашні часи; день тижня, що збігається з сьогодні, — одне уточнення; минула дата — прохання іншої; далека дата — чесно, що пошук лише на 7 днів', async () => {
    const tomorrow = clinicDate(new Date(Date.now() + 86_400_000));
    const todayWd = new Date(`${clinicDate(new Date())}T00:00:00Z`).getUTCDay() || 7;
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Підберіть час на консультацію на завтра');
    const opts = sendsTo(c)[0].options;
    if (opts.length) for (const o of opts) expect(o.date).toBe(tomorrow); // a day wish: that day only
    else expect(sendsTo(c)[0].text).toMatch(/вікон/);
    await ask(c, `Підберіть час на ${DAYS[todayWd]}`);
    expect(sendsTo(c)[1].text).toMatch(/сьогодні чи/);
    expect(sendsTo(c)[1].options).toEqual([]);
    const past = new Date(Date.now() - 5 * 86_400_000);
    await ask(c, `Підберіть час на ${clinicDate(past).slice(8)}.${clinicDate(past).slice(5, 7)}`);
    expect(sendsTo(c)[2].text).toMatch(/минула/);
    const far = clinicDate(new Date(Date.now() + 20 * 86_400_000));
    await ask(c, `Підберіть час на ${far.slice(8)}.${far.slice(5, 7)}`);
    expect(sendsTo(c)[3].text).toMatch(/лише на найближчі 7 днів/);
    expect(sendsTo(c)[3].options).toEqual([]);
    expect(await bookings(c)).toBe(0);
  });

  it('інформація без згоди: «що входить?» і «дякую» не запускають пошук часу, навіть коли модель просить; після підтвердженого запису запитання не починає новий запис', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Консультація включає огляд.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Не знаю, яку послугу обрати — розкажіть, що входить у консультацію?');
    await ask(c, 'Дякую');
    expect(sendsTo(c).every((m) => !lookedUp3(m))).toBe(true);
  });
});

describe('етап 3: «будь-який час» скидає раніше названі побажання', () => {
  it('після «після 16:00» усі часи пізні; після «будь-який час підійде» побажання не діє (з’являються й ранкові), показані часи не повторюються', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Запишіть мене на консультацію після 16:00');
    const late = sendsTo(c)[0].options;
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((o) => o.time >= '16:00')).toBe(true);
    await ask(c, 'Не підходить, будь-який час підійде');
    const any = sendsTo(c)[1].options;
    expect(any.length).toBeGreaterThan(0);
    expect(any.some((o) => o.time < '16:00')).toBe(true);
    const shown = new Set(late.map((o) => `${o.date}|${o.time}`));
    expect(any.every((o) => !shown.has(`${o.date}|${o.time}`))).toBe(true);
  });
});

describe('етап 3 (завершення): одне уточнення про послугу, допомога адміністратора, окремий лічильник для питань про час', () => {
  const requests = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } });

  it('неясна потреба → одне уточнення → усе ще неясно → пропозиція допомоги адміністратора (питанням, без переліку симптомів); згода → одна передача; відмова не передає', async () => {
    const { c } = await autoClinic();
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує або для чого ви хочете прийти?' }));
    await ask(c, 'Не знаю, яка послуга мені потрібна');
    expect((await stateOf(c)).clarifyCount).toBe(1);
    const calls = model.calls;
    await ask(c, 'Не знаю, мабуть щось із зубами'); // still unclear: no second question, no model
    expect(model.calls).toBe(calls);
    const offer = sendsTo(c)[1].text;
    expect(offer).toBe(HELP_OFFER.uk);
    expect((offer.match(/\?/g) ?? []).length).toBe(1);
    expect(offer).not.toMatch(/біль|чутлив|симптом|Передали|підійде/i);
    expect(await requests(c)).toBe(0); // only an offer so far
    await ask(c, 'Так, будь ласка');
    expect(model.calls).toBe(calls); // the agreement is decided by the code
    expect(await requests(c)).toBe(1);
    expect((await stateOf(c)).owner).toBe('HUMAN');
    expect(sendsTo(c)[2].text).toMatch(/Передали/); // said only after the request exists
    await ask(c, 'Дякую');
    expect(await requests(c)).toBe(1); // one hand-over, then the person has the dialogue
    // a refusal of the offer hands nothing over
    const d = await autoClinic();
    decideBy((last) => (/Ні, дякую/.test(last) ? decision({ reply: 'Добре.' }, { action: 'CLOSE' }) : decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує?' })));
    await ask(d.c, 'Не знаю, яка послуга мені потрібна');
    await ask(d.c, 'Не знаю, щось із зубами');
    await ask(d.c, 'Ні, дякую');
    expect(await requests(d.c)).toBe(0);
    // the same in Russian
    const r = await autoClinic('ru');
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Что именно вас беспокоит?' }));
    await ask(r.c, 'Не знаю, какая услуга мне нужна');
    await ask(r.c, 'Не знаю, наверное что-то с зубами');
    expect(sendsTo(r.c)[1].text).toBe(HELP_OFFER.ru);
  });

  it('пріоритети збережено: затверджений перший крок пропонується як і раніше; медична відповідь на уточнення йде до людини, а не до пропозиції допомоги', async () => {
    const f = await autoClinic();
    await prisma.kbItem.update({ where: { id: f.c.consult.id }, data: { text: 'Огляд і план лікування. Підходить як перший крок, якщо не знаєте, з чого почати.' } });
    model.calls = 0;
    await ask(f.c, 'Не знаю, яка послуга мені потрібна');
    expect(model.calls).toBe(0);
    expect(sendsTo(f.c)[0].text).toContain('Почати можна з «Тестова консультація»');
    const u = await autoClinic();
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує?' }));
    await ask(u.c, 'Не знаю, яка послуга мені потрібна');
    model.calls = 0;
    await ask(u.c, 'Нестерпно болить зуб');
    expect(model.calls).toBe(0);
    expect((await stateOf(u.c)).owner).toBe('HUMAN');
    expect(sendsTo(u.c).map((x) => x.text)).not.toContain(HELP_OFFER.uk);
  });

  it('питання про зручний час (від моделі чи від коду) не витрачає ліміт уточнень про послугу і не повторюється', async () => {
    for (const byModel of [true, false]) {
      const { c, s } = await autoClinic();
      decideBy((last) => (/запиш/i.test(last) ? decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s }) : byModel ? decision({ kind: 'CLARIFY', reply: 'Коли вам було б зручно?' }) : decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s })));
      await ask(c, 'Запишіть мене на консультацію');
      await ask(c, 'Не підходить');
      expect(sendsTo(c)[1].text).toContain(ASK_PREFERENCE.uk); // the code's one question, whoever wanted to ask
      expect((sendsTo(c)[1].text.match(/\?/g) ?? []).length).toBe(1);
      expect((await stateOf(c)).clarifyCount).toBe(0);
      await ask(c, 'Не підходить');
      expect(sendsTo(c)[2].text).not.toContain(ASK_PREFERENCE.uk); // asked once; the next times are searched instead
      expect((await stateOf(c)).clarifyCount).toBe(0);
    }
    // a clarification about the SERVICE still counts, and only once it is really sent
    const q = await autoClinic();
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує?' }));
    await ask(q.c, 'Не знаю, яка послуга мені потрібна');
    expect((await stateOf(q.c)).clarifyCount).toBe(1);
  });
});

describe('етап 3: втрачений слот і відновлення', () => {
  const occupy = (date: string, from: string, to: string) => {
    for (const cab of ['801', '802']) mock.data.visits.push({ visit_id: `8${rnd()}`, patient_id: '100001', status: 'PLANNED', doctor_id: '503', doctor: 'x', cabinet_id: cab, visit_start: `${date} ${from}:00`, visit_end: `${date} ${to}:00`, note: 'test', price_items: null, date_created: `${date} 08:00:00`, date_edited: `${date} 08:00:00` } as never);
  };

  it('обраний час зайнявся до створення візиту: пацієнту кажуть, пропонують свіжі часи, дані не питають вдруге, новий вибір доходить до одного візиту; запиту співробітникам немає', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Запишіть мене на консультацію');
    const times = sendsTo(c)[0].options;
    await tap(c, times[0]);
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    occupy(times[0].date, '00:00', '23:59');
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
    expect(visitWrites()).toHaveLength(0);
    const told = sendsTo(c).at(-1)!;
    expect(told.text).toMatch(/уже зайнятий/);
    expect(told.options.length).toBeGreaterThan(0);
    expect(told.options.some((o) => o.date === times[0].date && o.time === times[0].time)).toBe(false); // the taken time is not offered again
    expect((await stateOf(c)).owner).toBe('BOT');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } })).toBe(0);
    // recovery: the patient picks a fresh time; the data given before are kept (no second question about them); one consent, one visit
    const before = sendsTo(c).length;
    await tap(c, told.options[0]);
    const asked = sendsTo(c).slice(before).map((m) => m.text).join(' ');
    expect(asked).toMatch(/Підтверджуєте запис/);
    expect(asked).not.toMatch(/напишіть, будь ласка, прізвище/);
    await say(c, 'Так, підтверджую', `bookyes|${(await bookingReq(c))!.id}`);
    expect(visitWrites()).toHaveLength(1);
    expect(sendsTo(c).at(-1)!.text).toContain('Ваш запис підтверджено');
  });

  it('вільних вікон не лишилось у межах пошуку: чесна відповідь про 7 днів і питання про передачу адміністратору (пропозиція, не факт); без «листа очікування»', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Запишіть мене на консультацію');
    const times = sendsTo(c)[0].options;
    await tap(c, times[0]);
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    for (let i = 0; i < 9; i++) occupy(clinicDate(new Date(Date.now() + i * 86_400_000)), '00:00', '23:59');
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'test');
    const told = sendsTo(c).at(-1)!;
    expect(told.options).toEqual([]);
    expect(told.text).toMatch(/уже зайнятий/);
    expect(told.text).toMatch(/7 днів/);
    expect(told.text).toMatch(/Передати ваш запит адміністратору/);
    expect(told.text).not.toMatch(/Передали|черг|очіку/i);
    expect(visitWrites()).toHaveLength(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } })).toBe(0);
  });
});

// ---- Comparison of clinics and explicit "price only" requests. Scripted model; assertions are about behaviour and grounding in the approved facts, not about exact wording. ----
describe('порівняння клінік і «лише ціна»', () => {
  const FACTS = 'Консультація включає огляд, консультацію лікаря та план лікування і триває близько 30 хвилин.';
  const handoffs = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } });
  // a dialogue in which the service is already known (the first answer names it)
  const withService = async (lang: 'uk' | 'ru' = 'uk') => {
    const x = await autoClinic(lang);
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'NONE', service: x.s }));
    await ask(x.c, lang === 'ru' ? 'Расскажите о консультации' : 'Розкажіть про консультацію');
    return x;
  };

  it('порівняння при відомій послузі: 2–3 перевірені факти про неї, без пропозиції запису, без чужих цін, ціна лише відомої послуги і лише попередня', async () => {
    const { c, s } = await withService();
    const other = await refOf(c, 'Тестова гігієна');
    // the model adds an invitation, an unrelated price and the address; the code removes the invitation and the unrelated price
    decideBy(() => decision({ reply: `${FACTS} Лікар пояснює кожен крок. Запишіться до нас на зручний час.`, prices: [s, other] }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Чому мені обрати вашу клініку?');
    const t = sendsTo(c)[1].text;
    expect(t).toContain('огляд');
    expect(t).toContain('30 хвилин');
    expect(t).not.toMatch(/Запишіться|зручний час|Підібрати/);
    expect(t).not.toContain('Тестова гігієна'); // an unrelated price is not listed
    expect((t.match(/Вартість попередня/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(sendsTo(c)[1].options).toEqual([]);
    expect(t).not.toMatch(/\?/);
    expect(await bookings(c)).toBe(0);
  });

  it('порівняння, критерій відомий, фактів немає: жодних вигаданих переваг, передача моделлю не виконується — пропозиція питанням; згода на неї — одна передача', async () => {
    const { c } = await autoClinic();
    decideBy(() => decision({ reply: 'Передаємо.' }, { action: 'HAND_OFF', reason: 'other' }));
    await ask(c, 'Чому ви кращі за інших?');
    expect(sendsTo(c)[0].text).toBe(COMPARE_HELP.uk);
    expect(await handoffs(c)).toBe(0);
    expect((await stateOf(c)).owner).toBe('BOT');
  });

  it('порівняння (критерій відомий): російською — російська пропозиція; передача лише після згоди', async () => {
    const { c } = await autoClinic('ru');
    decideBy(() => decision({ reply: 'Передаём.' }, { action: 'HAND_OFF', reason: 'other' }));
    await ask(c, 'Чем вы лучше других?');
    expect(sendsTo(c)[0].text).toBe(COMPARE_HELP.ru);
    expect(await handoffs(c)).toBe(0);
    expect((await stateOf(c)).owner).toBe('BOT');
    model.calls = 0;
    await ask(c, 'Да, пожалуйста');
    expect(model.calls).toBe(0);
    expect(await handoffs(c)).toBe(1);
    expect(sendsTo(c)[1].text).toMatch(/Передали/);
  });

  it('критерій: розпізнає модель, а не підрахунок слів; питання, яке вже ставили, не повторюється; прохання записатися головніше', async () => {
    // the model is told to read a short criterion and not to take a long unrelated sentence for one (the rule is in the prompt of every comparison turn)
    const a = await autoClinic();
    decideBy(() => decision({ reply: FACTS }));
    await ask(a.c, 'Порівнюю клініки, важлива ціна');
    const sys = model.systems[model.systems.length - 1];
    expect(sys).toContain('важлива ціна');
    expect(sys).toContain('довге речення про інше критерієм не є');
    // a SHORT message with a criterion: the code does not decide; the model answers with facts and no question
    expect(sendsTo(a.c)[0].text).toContain('30 хвилин');
    expect(sendsTo(a.c)[0].text).not.toContain('?');
    // a LONG sentence without any criterion: no hard rejection by length, the model's one question stands
    const b = await autoClinic();
    model.calls = 0;
    decideBy(() => decision({ reply: 'Що для вас найважливіше при виборі клініки?' }));
    await ask(b.c, 'Я порівнюю кілька клінік, бо вчора був довгий день на роботі, ще треба забрати дитину зі школи і купити хліб');
    expect(model.calls).toBe(1);
    expect((sendsTo(b.c)[0].text.match(/\?/g) ?? []).length).toBe(1);
    // a question about the criterion that was already asked is not repeated (refused, then rewritten)
    model.calls = 0;
    let n = 0;
    decideBy(() => decision({ reply: ++n === 1 ? 'А що ще для вас важливо?' : FACTS }));
    await ask(b.c, 'Я порівнюю кілька клінік, ще вагаюсь');
    expect(model.calls).toBe(2);
    expect(sendsTo(b.c)[1].text).not.toContain('?');
    // an explicit request to book is higher than the comparison: times are offered
    const c2 = await autoClinic();
    decideBy(() => decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: c2.s }));
    await ask(c2.c, 'Чому мені обрати вашу клініку? Запишіть мене на консультацію');
    expect(sendsTo(c2.c)[0].options.length).toBeGreaterThan(0);
  });

  it('один наступний крок: немає ні фактів, ні критерію — лише питання про критерій; критерій відомий, а фактів немає — лише пропозиція адміністратора; явне прохання покликати людину й невідкладне головніші', async () => {
    // criterion unknown: the question alone (no administrator in the same message)
    const a = await autoClinic();
    decideBy(() => decision({ reply: 'Що для вас найважливіше при виборі клініки?' }));
    await ask(a.c, 'Чому мені обрати вашу клініку?');
    let t = sendsTo(a.c)[0].text;
    expect((t.match(/\?/g) ?? []).length).toBe(1);
    expect(t).not.toMatch(/адміністратор/i);
    // the question AND an offer of the administrator in one answer are two questions: refused, rewritten as one
    const a2 = await autoClinic();
    model.calls = 0;
    let n = 0;
    decideBy(() => decision({ reply: ++n === 1 ? 'Що для вас найважливіше? Або передати адміністратору ваше звернення?' : 'Що для вас найважливіше при виборі клініки?' }));
    await ask(a2.c, 'Чому мені обрати вашу клініку?');
    expect(model.calls).toBe(2);
    expect(sendsTo(a2.c)[0].text).not.toMatch(/адміністратор/i);
    // criterion known, no facts: only the offer of the administrator (a question), not the criterion question; nothing is handed over before the agreement
    const b = await autoClinic();
    decideBy(() => decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'needs_clarification' }));
    await ask(b.c, 'Чому мені обрати вашу клініку? Важлива гарантія на роботи');
    t = sendsTo(b.c)[0].text;
    expect(t).toBe(COMPARE_HELP.uk);
    expect(t).not.toMatch(/найважливіше/i);
    expect(await handoffs(b.c)).toBe(0);
    model.calls = 0;
    await ask(b.c, 'Так');
    expect(model.calls).toBe(0);
    expect(await handoffs(b.c)).toBe(1);
    // an explicit request for a person is executed (it is not turned into an offer)
    const p = await autoClinic();
    decideBy(() => decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(p.c, 'Чому мені обрати вашу клініку? Покличте, будь ласка, адміністратора');
    expect(await handoffs(p.c)).toBe(1);
    expect((await stateOf(p.c)).owner).toBe('HUMAN');
    // an urgent symptom is decided before any of it
    const u = await autoClinic();
    model.calls = 0;
    await ask(u.c, 'Чому мені обрати вашу клініку? У мене нестерпно болить зуб');
    expect(model.calls).toBe(0);
    expect((await stateOf(u.c)).owner).toBe('HUMAN');
  });

  it('жодних тверджень про перевагу, конкурентів і внутрішню кухню: такі відповіді відхиляються, повтор — лише факти', async () => {
    for (const bad of ['Ми кращі за інших клінік у місті.', 'На відміну від інших клінік, у нас все чудово.', 'Ми — найкраща клініка.', 'У наших затверджених даних немає переваг, бо я не можу вигадувати.', 'Переваг у довідці немає.']) {
      const { c } = await autoClinic();
      model.calls = 0;
      let n = 0;
      decideBy(() => decision({ reply: ++n === 1 ? bad : FACTS }));
      await ask(c, 'Чому мені обрати вашу клініку?');
      expect([bad, model.calls]).toEqual([bad, 2]);
      const t = sendsTo(c)[0].text;
      expect(t).toContain('30 хвилин');
      expect(t).not.toMatch(/кращ|інших клінік|затверджен|довідц|вигадув/i);
    }
    // the neutral word alone is not banned
    const ok = await autoClinic();
    decideBy(() => decision({ reply: 'Ми нічого не вигадуємо: консультація триває близько 30 хвилин.' }));
    await ask(ok.c, 'Чому мені обрати вашу клініку?');
    expect(sendsTo(ok.c)[0].text).toContain('30 хвилин');
  });

  for (const lang of ['uk', 'ru'] as const) {
    it(`«лише ціна» (${lang}): ціна без запрошення й підбору часу; послуга невідома — лише питання, яка; перевага зберігається; пізніше пряме прохання записатися працює`, async () => {
      const only = lang === 'ru' ? 'Мне только цену, без записи.' : 'Мене цікавить лише ціна.';
      // known service: the code answers, no model
      const a = await withService(lang);
      model.calls = 0;
      await ask(a.c, only);
      expect(model.calls).toBe(0);
      expect(sendsTo(a.c)[1].text).toContain('100 грн');
      expect(sendsTo(a.c)[1].text).toMatch(lang === 'ru' ? /Стоимость предварительная/ : /Вартість попередня/);
      noNudgeAt(a.c, 1);
      // unknown service: only the question which one
      const b = await autoClinic(lang);
      model.calls = 0;
      await ask(b.c, only);
      expect(model.calls).toBe(0);
      expect(sendsTo(b.c)[0].text).toBe(WHICH_SERVICE_PRICE[lang]);
      // the service named in the message: the model answers with the price, the code keeps the nudges out even if the model asks for them
      const d = await autoClinic(lang);
      decideBy(() => decision({ reply: 'Гаразд.', prices: [d.s] }, { action: 'OFFER_TIME', service: d.s }));
      await ask(d.c, lang === 'ru' ? 'Только стоимость консультации, записываться пока не хочу' : 'Тільки вартість консультації, записуватися поки не хочу');
      expect(sendsTo(d.c)[0].text).toContain('100 грн');
      noNudgeAt(d.c, 0);
      // the preference lasts through the price discussion ...
      await ask(d.c, lang === 'ru' ? 'А сколько стоит консультация ещё раз?' : 'А скільки коштує консультація ще раз?');
      noNudgeAt(d.c, 1);
      // ... and a later explicit request to book resumes the normal flow
      decideBy(() => decision({ reply: 'Звісно.' }, { action: 'OFFER_TIME', service: d.s }));
      await ask(d.c, lang === 'ru' ? 'Запишите меня на консультацию' : 'Запишіть мене на консультацію');
      expect(sendsTo(d.c)[2].options.length).toBeGreaterThan(0);
    });
  }

  it('ціна й запис в одному повідомленні («скажіть ціну і запишіть мене») — це не «лише ціна»: ціна й часи', async () => {
    const { c, s } = await autoClinic('ru');
    decideBy(() => decision({ reply: 'Конечно.', prices: [s] }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Скажите цену консультации и запишите меня');
    const m = sendsTo(c)[0];
    expect(m.text).toContain('100 грн');
    expect(m.options.length).toBeGreaterThan(0);
  });

  function noNudgeAt(c: C, i: number) {
    const m = sendsTo(c)[i];
    expect(m.options).toEqual([]);
    expect(m.text).not.toContain(SOFT_OFFER.uk);
    expect(m.text).not.toContain(SOFT_OFFER.ru);
    expect(m.text).not.toMatch(/Запишіться|Запишитесь|зручний час|удобное время/);
  }
});

// The three findings of the real-model run of 2026-11-10 (agent-administrator.md, section 34): the price status, the durable "price only" preference, the price as a comparison criterion
describe('ціна: статус «попередня», стійке «лише ціна», ціна як критерій порівняння', () => {
  const FACTS = 'Консультація включає огляд, консультацію лікаря та план лікування і триває близько 30 хвилин.';
  const priced = async (lang: 'uk' | 'ru' = 'uk') => {
    const x = await autoClinic(lang);
    decideBy(() => decision({ reply: lang === 'ru' ? 'Конечно.' : 'Звісно.', prices: [x.s] }, { action: 'NONE', service: x.s }));
    await ask(x.c, lang === 'ru' ? 'Сколько стоит консультация?' : 'Скільки коштує консультація?');
    expect(sendsTo(x.c)[0].text).toContain('100 грн');
    return x;
  };
  const noNudge = (m: { text: string; options: unknown[] }) => {
    expect(m.options).toEqual([]);
    expect(m.text).not.toMatch(/Підібрати|Подобрать|Запишіться|Запишитесь|зручний час|удобное время/);
  };

  it('читання коду: питання про статус ціни, заперечення статусу в будь-якому формулюванні, анонс ціни, порядок подій для «лише ціна»', () => {
    for (const t of ['Це остаточна сума?', 'Это окончательная сумма?', 'Ціна точна?', 'А ціна не зміниться?', 'Это уже окончательно?']) expect([t, finalAmountQuestion(t)]).toEqual([t, true]);
    // a request for the price itself, a booking request and a mixed message are not this question
    for (const t of ['Яка остаточна ціна?', 'Скільки коштує консультація?', 'Це остаточна сума? Запишіть мене', 'Це остаточна сума? І де ви знаходитесь?', 'Дякую']) expect([t, finalAmountQuestion(t)]).toEqual([t, false]);
    for (const t of ['Так, це не попередня ціна.', 'Сума остаточна.', 'Сумма определена.', 'Ціна не зміниться.', 'Это окончательная стоимость консультации.', 'Вартість фіксована.', 'Да, стоимость уже известна, это не предварительная цена.']) expect([t, !!priceStatusDenied(t)]).toEqual([t, true]);
    for (const t of ['Це не остаточна сума.', 'Це попередня вартість за прайсом.', 'Підсумкова сума залежить від фактичного обсягу послуг.', 'Точну суму уточнить адміністратор.', 'Консультація триває близько 30 хвилин.', 'Остаточна сума може змінитися.']) expect([t, priceStatusDenied(t)]).toEqual([t, null]);
    expect(dropPriceAnnouncements('Розумію, що ціна для вас важлива. Ось вартість консультації та лікування в нашій клініці.\nКонсультація триває 30 хвилин.')).toBe('Розумію, що ціна для вас важлива.\n\nКонсультація триває 30 хвилин.');
    expect(dropPriceAnnouncements('Она длится около 30 минут. Стоимость консультации мы тоже назовём.')).toBe('Она длится около 30 минут.');
    const offer = (t: string) => t.includes(SOFT_OFFER.uk);
    const m = (direction: string, text: string) => ({ direction, text });
    expect(priceOnlyStanding([m('IN', 'Запишіть мене на консультацію'), m('OUT', 'Оберіть час'), m('IN', 'Мене цікавить лише ціна, без запису')], offer)).toBe(true); // a newer price-only request wins
    expect(priceOnlyStanding([m('IN', 'Мене цікавить лише ціна'), m('OUT', '100 грн'), m('IN', 'А де ви?'), m('OUT', 'Адреса'), m('IN', 'Запишіть мене')], offer)).toBe(false); // a newer booking request wins
    expect(priceOnlyStanding([m('IN', 'Мене цікавить лише ціна'), m('OUT', 'Передати ваше звернення?'), m('IN', 'Так')], offer)).toBe(true); // "yes" to another question is not a booking
    expect(priceOnlyStanding([m('IN', 'Мене цікавить лише ціна'), m('OUT', SOFT_OFFER.uk), m('IN', 'Так')], offer)).toBe(false); // "yes" to the offer of times is
    expect(priceOnlyStanding([m('IN', 'Скільки коштує консультація?')], offer)).toBe(false);
    // the renderer is one: the working bot keeps its default notice, the agent passes its own words
    const item = [{ ref: 'S1', id: 'x', title: 'Послуга', state: 'KNOWN', amount: 100, category: null }] as never;
    const old = composePriceReply({ intro: '', after: null, ids: ['S1'] }, item, 'ru');
    const own = composePriceReply({ intro: '', after: null, ids: ['S1'] }, item, 'ru', { notice: AGENT_PRICE_NOTICE });
    expect('reply' in old && old.reply).toContain(PRICE_NOTICE.ru);
    expect('reply' in own && own.reply).toContain('Стоимость предварительная. Итоговая сумма зависит от фактического объёма услуг.');
    expect('reply' in own && own.reply).not.toMatch(/администратор/);
  });

  for (const lang of ['uk', 'ru'] as const) {
    it(`«це остаточна сума?» після попередньої ціни (${lang}): відповідає код, статус збережено, без обіцянок і запрошень`, async () => {
      const { c } = await priced(lang);
      model.calls = 0;
      await ask(c, lang === 'ru' ? 'Это окончательная сумма?' : 'Це остаточна сума?');
      expect(model.calls).toBe(0);
      const m = sendsTo(c)[1];
      expect(m.text).toBe(FINAL_AMOUNT[lang]);
      expect(m.text).toMatch(lang === 'ru' ? /предварительная/ : /попередня/);
      expect(m.text).not.toMatch(/адміністратор|администратор|гарант|доплат/i);
      noNudge(m);
    });
  }

  it('модель заперечує попередній статус (змішане повідомлення йде до моделі): відповідь відхиляється з причиною, повтор не суперечить; чесне «не остаточна» не відхиляється', async () => {
    for (const bad of ['Так, це не попередня ціна, сума визначена. Консультація триває близько 30 хвилин.', 'Сума остаточна. Консультація триває близько 30 хвилин.', 'Ціна не зміниться, триває консультація близько 30 хвилин.']) {
      const { c } = await priced();
      model.calls = 0;
      let n = 0;
      decideBy(() => decision({ reply: ++n === 1 ? bad : 'Це попередня вартість за прайсом. Консультація триває близько 30 хвилин.' }));
      await ask(c, 'Це остаточна сума? І скільки триває консультація?');
      expect([bad, model.calls]).toEqual([bad, 2]);
      expect(model.systems[model.systems.length - 1]).toContain('Ціни з прайсу попередні');
      const t = sendsTo(c)[1].text;
      expect(t).toContain('попередня');
      expect(priceStatusDenied(t)).toBeNull();
    }
    const ok = await priced();
    model.calls = 0;
    decideBy(() => decision({ reply: 'Це не остаточна сума: вона залежить від обсягу послуг. Консультація триває близько 30 хвилин.' }));
    await ask(ok.c, 'Це остаточна сума? І скільки триває консультація?');
    expect(model.calls).toBe(1);
    // the status is in the prompt of every turn, with the rule about the price lines of this reply
    const sys = model.systems[model.systems.length - 1];
    expect(sys).toContain('ПОПЕРЕДНІ');
    expect(sys).toContain('ціни в цій відповіді:');
  });

  it('«лише ціна» діє довше трьох повідомлень і поза вікном історії моделі; пряме прохання записатися її знімає; нове «лише ціна» повертає; «так» читається за попереднім питанням', async () => {
    const { c, s } = await autoClinic();
    // the model always asks for times and the price: the code must keep the nudges out while the preference stands
    decideBy((last) => (/вартість|коштує/i.test(last) ? decision({ reply: 'Звісно.', prices: [s] }, { action: 'OFFER_TIME', service: s }) : /Запишіть/i.test(last) ? decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }) : decision({ reply: 'Консультація триває близько 30 хвилин.' }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Тільки вартість консультації, записуватися поки не хочу');
    await ask(c, 'Це остаточна сума?');
    await ask(c, 'А скільки триває консультація?');
    await ask(c, 'А де ви знаходитесь?');
    await ask(c, 'А що входить у консультацію?');
    await ask(c, 'А лікар пояснює, що робить?');
    // the first request is now outside the eight messages loaded for the model (six patient messages and five replies came after it)
    expect(await prisma.chatMessage.count({ where: { clinicId: c.clinicId, chatId: c.chat } })).toBeGreaterThan(9);
    await ask(c, 'Нагадайте, будь ласка, вартість.');
    const sent = sendsTo(c);
    expect(sent).toHaveLength(7);
    expect(sent[0].text).toContain('100 грн');
    expect(sent[1].text).toBe(FINAL_AMOUNT.uk);
    expect(sent[6].text).toContain('100 грн');
    for (const m of sent) noNudge(m);
    expect(model.systems[model.systems.length - 1]).toContain('пацієнт просив лише інформацію про ціну');
    // a bare "yes" answers no offer of times here: it is not a booking
    await ask(c, 'Так');
    noNudge(sendsTo(c)[7]);
    // an explicit request to book overrides the preference
    await ask(c, 'Запишіть мене на консультацію');
    expect(sendsTo(c)[8].options.length).toBeGreaterThan(0);
    expect(model.systems[model.systems.length - 1]).not.toContain('пацієнт просив лише інформацію про ціну');
    // ... and a renewed price-only request overrides the booking request
    await ask(c, 'Мене цікавить лише ціна, без запису');
    await ask(c, 'А скільки коштує консультація ще раз?');
    noNudge(sendsTo(c)[9]);
    noNudge(sendsTo(c)[10]);
    expect(sendsTo(c)[10].text).toContain('100 грн');
    expect(await bookings(c)).toBe(0);
  });

  it('ціна як критерій порівняння, послуга відома: її попередня ціна через наявний рендер, без чужих цін, запрошення й суперечливого вступу', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Гаразд.' }, { action: 'NONE', service: s }));
    await ask(c, 'Розкажіть про консультацію');
    const other = await refOf(c, 'Тестове лікування');
    decideBy(() => decision({ reply: 'Розумію, що ціна для вас важлива. Ось точна вартість консультації.', prices: [s, other] }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Порівнюю клініки, важлива ціна');
    const m = sendsTo(c)[1];
    expect(m.text).toContain('- Тестова консультація: 100 грн');
    expect((m.text.match(/Вартість попередня/g) ?? []).length).toBe(1);
    expect(m.text).not.toContain('Тестове лікування');
    expect(m.text).not.toMatch(/точна вартість|остаточн|дешевш|нижч/i);
    // the agent's own words of the notice (through the shared renderer): provisional, the total depends on the volume, no promise that somebody names an exact sum
    expect(m.text).toContain(AGENT_PRICE_NOTICE.uk);
    expect(m.text).not.toMatch(/уточнить адміністратор/);
    expect(m.text).not.toContain('?');
    noNudge(m);
    expect(model.systems[model.systems.length - 1]).toContain('код покаже попередню ціну лише послуги «Тестова консультація»');
  });

  it('ціна як критерій порівняння, послуга невідома: лише питання, про яку послугу; жодної довільної послуги, прайсу чи заспокоєнь; слово «ціна» саме не вирішує', async () => {
    const a = await autoClinic();
    const other = await refOf(a.c, 'Тестове лікування');
    model.calls = 0;
    decideBy(() => decision({ reply: 'Ціна для вас важлива, тож назву одразу: вартість консультації та лікування в нас відома.\nЯкщо хвилюєтеся, можна сказати лікарю про страх.', prices: [a.s, other] }));
    await ask(a.c, 'Я порівнюю клініки. Важлива ціна.');
    expect(model.calls).toBe(1);
    expect(sendsTo(a.c)[0].text).toBe(WHICH_SERVICE_PRICE.uk);
    expect(model.systems[0]).toContain('послуга невідома, тому рядків із цінами НЕ буде');
    // the answer names the service: its provisional price
    decideBy(() => decision({ reply: 'Звісно.', prices: [a.s] }, { action: 'NONE', service: a.s }));
    await ask(a.c, 'Вартість консультації');
    expect(sendsTo(a.c)[1].text).toContain('- Тестова консультація: 100 грн');
    expect(sendsTo(a.c)[1].text).toContain('Вартість попередня');
    // the word "price" that the model did not read as the criterion: facts stay, no question about a service
    const b = await autoClinic();
    decideBy(() => decision({ reply: FACTS }));
    await ask(b.c, 'Порівнюю клініки, ціна не головне');
    expect(sendsTo(b.c)[0].text).toContain('30 хвилин');
    expect(sendsTo(b.c)[0].text).not.toContain('?');
    // prices listed by the model in a comparison that does not speak about the price: no lines, no question about a service
    const d = await autoClinic();
    decideBy(() => decision({ reply: FACTS, prices: [d.s] }));
    await ask(d.c, 'Чому мені обрати вашу клініку?');
    expect(sendsTo(d.c)[0].text).toContain('30 хвилин');
    expect(sendsTo(d.c)[0].text).not.toMatch(/грн|\?/);
  });

  it('обіцяної ціни без рядка не буває: анонс прибирається, коли код ціну не показує (порівняння, сумнів щодо ціни); анонс без іншого тексту переписується', async () => {
    const a = await autoClinic();
    decideBy(() => decision({ reply: `${FACTS} Вартість консультації теж назвемо.` }));
    await ask(a.c, 'Чому мені обрати вашу клініку?');
    expect(sendsTo(a.c)[0].text).toContain('30 хвилин');
    expect(sendsTo(a.c)[0].text).not.toMatch(/назвемо|вартість/i);
    const b = await priced();
    decideBy(() => decision({ kind: 'HANDLE_DOUBT', reply: 'Розуміємо ваш сумнів. Ось вартість консультації:', prices: [b.s] }));
    await ask(b.c, 'Це занадто дорого');
    expect(sendsTo(b.c)[1].text).toBe('Розуміємо ваш сумнів.');
    // nothing but the announcement: refused with the reason and written again
    const d = await autoClinic();
    model.calls = 0;
    let n = 0;
    decideBy(() => decision({ reply: ++n === 1 ? 'Ось вартість наших послуг:' : FACTS }));
    await ask(d.c, 'Чому мені обрати вашу клініку?');
    expect(model.calls).toBe(2);
    expect(model.systems[model.systems.length - 1]).toContain('рядка з ціною в цій відповіді не буде');
    expect(sendsTo(d.c)[0].text).toContain('30 хвилин');
  });
});

// The language defect of scenario 38 of the real-model runs (agent-administrator.md, sections 34 and 36): ONE resolved language for the prompt, the retry, the code's texts and the check
describe('мова агента: одна визначена мова розмови для підказки, повтору, текстів коду й перевірки', () => {
  const handoffs = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } });
  const UK_LETTER = /[іїєґ]/i;
  // the conversational prose of a reply: without the clinic's stored names (they stay Ukrainian on a clinic whose data are Ukrainian)
  const prose = (t: string) => t.replace(/Тестова консультація|м\. Тестове, вул\. Вигадана, 1 \(тестова адреса\)/g, '');
  const sysLang = () => (/мовою пацієнта: російською/.test(model.systems[model.systems.length - 1]) ? 'ru' : 'uk');

  it('читання мови: більшість слів, правопис, збережені назви клініки; короткі відповіді, імена й телефони мову не міняють; явне прохання головніше', () => {
    for (const t of ['Расскажите о консультации', 'Интересует отбеливание, что для этого нужно', 'Добрый день, подскажите условия', 'Хотелось бы узнать подробнее про лечение']) expect([t, detectLanguageAgent(t)]).toEqual([t, 'ru']);
    for (const t of ['Розкажіть про консультацію', 'Цікавить відбілювання, що для цього потрібно', 'Добрий день, підкажіть умови', 'Хотілося б дізнатися більше про лікування']) expect([t, detectLanguageAgent(t)]).toEqual([t, 'uk']);
    // one Ukrainian name or title inside a Russian sentence does not make it Ukrainian, and the reverse
    expect(detectLanguageAgent('Запишите меня на «Тестова гігієна», пожалуйста')).toBe('ru');
    expect(detectLanguageAgent('Меня зовут Ірина, хочу записаться')).toBe('ru');
    expect(detectLanguageAgent('Запишіть мене, будь ласка, до лікаря Быстрова')).toBe('uk');
    // a stored title or address repeated by the patient is not the patient's language
    expect(languageOfAgent(['Тестова консультація', 'Расскажите о консультации'], ['Тестова консультація'])).toBe('ru');
    expect(languageOfAgent(['м. Тестове, вул. Вигадана, 1 — это где?'], ['м. Тестове, вул. Вигадана, 1'])).toBe('ru');
    // short or data-like replies keep the language the conversation has
    for (const short of ['да', 'Так', 'ок', 'Ірина Коваль', 'Ирина Коваль', '0971234567', '+380 97 123 45 67']) {
      expect([short, languageOfAgent([short, 'Расскажите о консультации'])]).toEqual([short, 'ru']);
      expect([short, languageOfAgent([short, 'Розкажіть про консультацію'])]).toEqual([short, 'uk']);
    }
    // an explicit request wins over everything else
    expect(languageOfAgent(['Сколько стоит консультация?', 'Можно по-украински, пожалуйста?', 'Расскажите о консультации'])).toBe('uk');
    expect(languageOfAgent(['Скільки коштує консультація?', 'Давайте по-русски', 'Розкажіть про консультацію'])).toBe('ru');
    // the working bot's reading is unchanged
    expect(detectLanguage('Расскажите о консультации')).toBeNull();
    expect(languageOf(['Расскажите о консультации'])).toBe('uk');
  });

  it('сценарій 38 дослівно (клініка з українськими даними): обидва ходи російською; повтор називає мову; назва послуги лишається як у довідці', async () => {
    const { c, s } = await autoClinic(); // Ukrainian titles, description and address
    // the scripted model writes in the language the prompt names (what a model that follows the instruction does)
    decideBy((_last, system) => decision({ reply: /мовою пацієнта: російською/.test(system) ? 'Тестова консультація длится около 30 минут и включает осмотр и план лечения.' : 'Тестова консультація триває близько 30 хвилин.' }));
    await ask(c, 'Расскажите о консультации');
    expect(sysLang()).toBe('ru');
    expect(model.calls).toBe(1);
    expect(sendsTo(c)[0].text).toContain('длится около 30 минут');
    expect(prose(sendsTo(c)[0].text)).not.toMatch(UK_LETTER);
    // second message: the first try is Ukrainian, the retry is told the language by name and answers in Russian
    model.calls = 0;
    let n = 0;
    decideBy(() => decision({ reply: ++n === 1 ? 'Консультація коштує так:' : 'Стоимость консультации такая:', prices: [s] }));
    await ask(c, 'Мне только цену, без записи.');
    expect(model.calls).toBe(2);
    expect(model.systems[model.systems.length - 1]).toContain('Мова пацієнта — РОСІЙСЬКА');
    const t = sendsTo(c)[1].text;
    expect(t).toContain('- Тестова консультація: 100 грн'); // the stored title, not translated
    expect(t).toContain('Стоимость предварительная');
    expect(t).not.toContain('Консультація коштує');
    expect(prose(t)).not.toMatch(UK_LETTER);
    expect(await handoffs(c)).toBe(0);
  });

  it('дві відповіді моделі не тією мовою поспіль: відхилений текст не надсилається; ціна, часи чи безпечний текст — мовою розмови; без передачі людині', async () => {
    // a price: the code's own lines in Russian, the Ukrainian lead-in is gone
    const a = await autoClinic();
    decideBy(() => decision({ reply: 'Консультація коштує так:', prices: [a.s] }));
    await ask(a.c, 'Подскажите, сколько стоит консультация?');
    expect(model.calls).toBe(2);
    let t = sendsTo(a.c)[0].text;
    expect(t).toContain('- Тестова консультація: 100 грн');
    expect(t).toContain('Стоимость предварительная. Итоговая сумма зависит от фактического объёма услуг.');
    expect(prose(t)).not.toMatch(UK_LETTER);
    expect(await handoffs(a.c)).toBe(0);
    expect((await stateOf(a.c)).owner).toBe('BOT');
    // prose only: the existing safe text in Russian, an OFFER (nothing is handed over, nothing is claimed)
    const b = await autoClinic();
    decideBy(() => decision({ reply: 'Тестова консультація триває близько 30 хвилин і включає огляд.' }));
    await ask(b.c, 'Расскажите о консультации');
    t = sendsTo(b.c)[0].text;
    expect(t).toBe(AGENT_FALLBACK_TEXT.ru);
    expect(t).not.toMatch(/Передали|передано/);
    expect(await handoffs(b.c)).toBe(0);
    expect((await stateOf(b.c)).owner).toBe('BOT');
    // a booking request: the action of the model stands, the times come with the code's Russian line
    const d = await autoClinic();
    decideBy(() => decision({ reply: 'Добре, ось вільний час.' }, { action: 'OFFER_TIME', service: d.s }));
    await ask(d.c, 'Запишите меня на консультацию, пожалуйста');
    const m = sendsTo(d.c)[0];
    expect(m.options.length).toBeGreaterThan(0);
    expect(m.text).not.toMatch(UK_LETTER);
    expect(m.text).toMatch(/удобное время/);
    // the same in the other direction: a Ukrainian conversation and Russian prose twice
    const u = await autoClinic('ru'); // Russian data, Ukrainian patient
    decideBy(() => decision({ reply: 'Консультация стоит так:', prices: [u.s] }));
    await ask(u.c, 'Підкажіть, скільки коштує консультація?');
    t = sendsTo(u.c)[0].text;
    expect(t).toContain('Вартість попередня');
    expect(t).not.toContain('Консультация стоит');
  });

  it('російська розмова з українськими даними клініки: назва послуги й адреса в російській відповіді не вважаються українською мовою; коротке «да» і прохання змінити мову', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Тестова консультація длится около 30 минут. Наш адрес: м. Тестове, вул. Вигадана, 1 (тестова адреса).' }));
    await ask(c, 'Расскажите о консультации и напишите адрес');
    expect(model.calls).toBe(1); // not refused for its language
    expect(sendsTo(c)[0].text).toContain('Тестова консультація длится');
    // a price question brings the code's offer in Russian; a bare "да" keeps Russian and brings times with the Russian line
    decideBy((last) => (/стоит/i.test(last) ? decision({ reply: 'Конечно.', prices: [s] }) : decision({ reply: 'Хорошо.' }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'А сколько стоит консультация?');
    expect(sendsTo(c)[1].text).toContain(SOFT_OFFER.ru);
    await ask(c, 'да');
    expect(sysLang()).toBe('ru');
    expect(sendsTo(c)[2].options.length).toBeGreaterThan(0);
    expect(sendsTo(c)[2].text).toMatch(/удобное время/);
    // an explicit request to switch: acknowledged by the code in Ukrainian (no model), and the next prompt names Ukrainian
    model.calls = 0;
    await ask(c, 'Можно по-украински, пожалуйста?');
    expect(model.calls).toBe(0);
    expect(sendsTo(c)[3].text.startsWith(LANGUAGE_ACK.uk)).toBe(true);
    decideBy(() => decision({ reply: 'Консультація триває близько 30 хвилин.' }));
    await ask(c, 'А скільки триває консультація?');
    expect(sysLang()).toBe('uk');
  });
});

// A message that only asks for a language is not an answer to the pending question (the failure of scenario 47 of the real-model run, agent-administrator.md, section 38)
describe('прохання лише про мову не є відповіддю на питання, що очікує', () => {
  const handoffs = (c: C) => prisma.bookingRequest.count({ where: { clinicId: c.clinicId, kind: 'HANDOFF' } });

  it('читання: лише прохання про мову; повідомлення з іншим змістом — ні', () => {
    for (const t of ['Пожалуйста, отвечайте по-русски.', 'Можно по-русски?', 'Давайте українською, будь ласка', 'Пишіть мені українською', 'Отвечайте на русском языке, пожалуйста']) expect([t, !!languageOnlyRequest(t)]).toEqual([t, true]);
    for (const t of ['Отвечайте по-русски, хочу записаться на консультацию завтра.', 'Можно по-русски? Сколько стоит консультация?', 'Давайте по-русски и позовите администратора', 'Расскажите о консультации', 'Да']) expect([t, !!languageOnlyRequest(t)]).toEqual([t, false]);
  });

  it('після уточнення послуги: мову застосовано, питання про послугу повторено цією мовою; лічильник не росте, передачі немає; далі справжня неясна відповідь іде за наявним лімітом', async () => {
    const { c } = await autoClinic(); // Ukrainian data
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Подскажите, пожалуйста, что именно вас беспокоит?' }));
    await ask(c, 'Не знаю, какая услуга мне нужна');
    expect((await stateOf(c)).clarifyCount).toBe(1);
    model.calls = 0;
    await ask(c, 'Пожалуйста, отвечайте по-русски.');
    expect(model.calls).toBe(0);
    let t = sendsTo(c)[1].text;
    expect(t.startsWith(LANGUAGE_ACK.ru)).toBe(true);
    expect(t).toContain('что именно вас беспокоит?'); // the pending question again, in the requested language
    expect(t).not.toBe(HELP_OFFER.ru);
    expect(t).not.toMatch(/администратор/i);
    expect((t.match(/\?/g) ?? []).length).toBe(1);
    expect((await stateOf(c)).clarifyCount).toBe(1);
    expect((await stateOf(c)).owner).toBe('BOT');
    expect(await handoffs(c)).toBe(0);
    // a genuine unclear answer after it: the existing rule (one clarification, then the offer of the administrator's help), unchanged
    await ask(c, 'Ну не знаю, что-то с зубами');
    expect(model.calls).toBe(0);
    expect(sendsTo(c)[2].text).toBe(HELP_OFFER.ru);
    expect(await handoffs(c)).toBe(0);
    // ... and a named service after the language request goes on as usual
    const b = await autoClinic();
    decideBy(() => decision({ kind: 'CLARIFY', reply: 'Що саме вас турбує?' }));
    await ask(b.c, 'Не знаю, яка послуга мені потрібна');
    await ask(b.c, 'Можно по-русски, пожалуйста?');
    t = sendsTo(b.c)[1].text;
    expect(t.startsWith(LANGUAGE_ACK.ru)).toBe(true);
    expect(t).toMatch(/На какую услугу/); // the Ukrainian question of the model is not repeated: the code's own question in Russian
    expect(t.replace(/Тестова консультація/g, '')).not.toMatch(/[іїєґ]/i);
    decideBy(() => decision({ reply: 'Хорошо.' }, { action: 'OFFER_TIME', service: b.s }));
    await ask(b.c, 'Запишите меня на консультацию');
    expect(sendsTo(b.c)[2].options.length).toBeGreaterThan(0);
  });

  it('з обраними послугою й часом (крок збору даних): підтвердження мови й те саме питання кроку цією мовою; послуга, час і згода не змінені, контактів із повідомлення не взято', async () => {
    const { c, s } = await autoClinic();
    decideBy(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    const before = (await bookingReq(c))!;
    const n = sendsTo(c).length;
    model.calls = 0;
    await ask(c, 'Пожалуйста, отвечайте по-русски.');
    expect(model.calls).toBe(0);
    const added = sendsTo(c).slice(n);
    expect(added).toHaveLength(2);
    expect(added[0].text).toBe(LANGUAGE_ACK.ru);
    expect(added[1].text).toMatch(/фамили/i); // the data question of the step, in Russian
    expect(added[1].text).not.toMatch(/прізвище/i);
    const after = (await bookingReq(c))!;
    expect(after.slotAt!.getTime()).toBe(before.slotAt!.getTime());
    expect(after.service).toBe(before.service);
    expect(after.stage).toBe(before.stage);
    expect(after.consentAt).toBeNull();
    expect(after.contactName ?? null).toBe(before.contactName ?? null);
    expect(await bookings(c)).toBe(1);
    expect(await handoffs(c)).toBe(0);
    expect(visitWrites()).toHaveLength(0);
    // offered times and no choice yet: the acknowledgement points to the times already shown, nothing is searched again
    const b = await autoClinic();
    await ask(b.c, 'Хочу записатися на консультацію');
    await ask(b.c, 'Давайте по-русски');
    expect(sendsTo(b.c)[1].text).toBe(`${LANGUAGE_ACK.ru} Время можно выбрать из предложенных выше.`);
    expect(sendsTo(b.c)[1].options).toEqual([]);
  });

  it('прохання про мову разом зі змістом обробляється як звичайно, вже цією мовою; термінове й прохання покликати людину лишаються головнішими', async () => {
    const { c, s } = await autoClinic();
    decideBy((_l, system) => decision({ reply: /мовою пацієнта: російською/.test(system) ? 'Хорошо.' : 'Добре.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Отвечайте по-русски, хочу записаться на консультацию завтра.');
    expect(model.calls).toBe(1);
    expect(model.systems[model.systems.length - 1]).toContain('мовою пацієнта: російською');
    const m = sendsTo(c)[0];
    expect(m.options.length).toBeGreaterThan(0);
    expect(m.text).toMatch(/удобное время/);
    expect(m.text).not.toContain(LANGUAGE_ACK.ru);
    // an urgent symptom with a language request goes to a person first, as before
    const u = await autoClinic();
    model.calls = 0;
    await ask(u.c, 'Отвечайте по-русски, у меня нестерпимо болит зуб');
    expect(model.calls).toBe(0);
    expect((await stateOf(u.c)).owner).toBe('HUMAN');
    // a request for a person with a language request: the model decides as before and the hand-over is executed
    const p = await autoClinic();
    decideBy(() => decision({ reply: 'Передаю.' }, { action: 'HAND_OFF', reason: 'asked_for_person' }));
    await ask(p.c, 'Давайте по-русски и позовите, пожалуйста, администратора');
    expect(await handoffs(p.c)).toBe(1);
  });
});

// The agent in the cabinets mode and a doctor the patient names: the SAME recognition, texts and request fields as the old bot (DoctorChoiceService), connected to the agent path
describe('лікар, якого назвав пацієнт (режим кабінетів, агент)', () => {
  const handoffs = (c: C) => prisma.bookingRequest.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } });
  const doctors = async (c: C, titles: string[]) => {
    for (const title of titles) await prisma.kbItem.create({ data: { clinicId: c.clinicId, kind: 'DOCTOR', title, text: 'терапевт (тестові дані)', active: true, approvedAt: new Date() } });
  };
  const wishQ = (lang: 'uk' | 'ru', n: string) => app.get(DoctorChoiceService).wishQuestion(lang, n);
  const visitBodies = () => visitWrites().map((w) => JSON.stringify(w));
  // the scripted model always asks for times of the consultation: the code has to hold them back while the doctor is not settled
  const offering = (s: string) => decideBy(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }));

  it('без побажання: запис як раніше — часи одразу, у заявці немає лікаря, у підтвердженні жодного рядка про лікаря-побажання', async () => {
    const { c, s } = await autoClinic();
    await doctors(c, ['Коваль Ірина']);
    offering(s);
    await ask(c, 'Хочу записатися на консультацію');
    expect(sendsTo(c)[0].options.length).toBeGreaterThan(0);
    await tap(c, sendsTo(c)[0].options[0]);
    // the patient's own surname equals a doctor's: a contact answer is not a wish
    await say(c, `Прізвище Коваль, ім’я Ірина, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    expect(rq.wishedDoctor).toBeNull();
    expect(rq.doctorState).toBeNull();
    const consent = sendsTo(c)[sendsTo(c).length - 1].text;
    expect(consent).toMatch(/Конкретного лікаря призначає клініка/);
    expect(consent).not.toMatch(/побажання щодо лікаря/i);
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
  });

  it('названо лікаря (uk): вибір замість часів, без обіцянки саме цього лікаря; «будь-який лікар» — часи кабінетів, побажання в заявці й у примітці візиту, підтвердження його не обіцяє', async () => {
    const { c, s } = await autoClinic();
    await doctors(c, ['Коваль Ірина']);
    offering(s);
    model.calls = 0;
    await ask(c, 'Хочу записатися на консультацію до лікаря Коваль');
    expect(model.calls).toBe(0);
    let m = sendsTo(c)[0];
    expect(m.text).toBe(wishQ('uk', 'Коваль Ірина'));
    expect(m.options).toEqual([]);
    expect(m.text).toMatch(/не можемо обіцяти запис саме до нього/);
    expect(await bookings(c)).toBe(0);
    await ask(c, 'Будь-який лікар');
    m = sendsTo(c)[1];
    expect(m.options.length).toBeGreaterThan(0);
    expect(m.text).toMatch(/Лікаря призначить клініка/);
    await tap(c, m.options[0]);
    let rq = (await bookingReq(c))!;
    expect([rq.wishedDoctor, rq.doctorState]).toEqual(['Коваль Ірина', 'ANY_DOCTOR']);
    await say(c, `Прізвище Петренко, ім’я Олег, телефон ${phone()}`);
    const consent = sendsTo(c)[sendsTo(c).length - 1].text;
    expect(consent).toMatch(/побажання щодо лікаря Коваль Ірина передамо клініці, але запис саме до цього лікаря не гарантуємо/);
    expect(consent).toMatch(/Конкретного лікаря призначає клініка/);
    rq = (await bookingReq(c))!;
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    expect(visitBodies()[0]).toMatch(/Побажання пацієнта: Коваль Ірина/);
    const done = sendsTo(c)[sendsTo(c).length - 1].text;
    expect(done).toMatch(/Лікаря призначить клініка/);
    expect(done).not.toMatch(/Лікар: Коваль/);
  });

  it('потрібен саме цей лікар (ru): одна передача з побажанням у заявці для персоналу, «передали» лише після заявки, діалог за людиною', async () => {
    const { c, s } = await autoClinic('ru');
    await doctors(c, ['Коваль Ирина']);
    offering(s);
    await ask(c, 'Хочу записаться на консультацию к врачу Коваль');
    expect(sendsTo(c)[0].text).toBe(wishQ('ru', 'Коваль Ирина'));
    model.calls = 0;
    await ask(c, 'Передайте, пожалуйста, пожелание администратору');
    expect(model.calls).toBe(0);
    const h = await handoffs(c);
    expect(h).toHaveLength(1);
    expect(h[0].summary).toMatch(/бажаний лікар: Коваль Ирина \(побажання, не підтверджено\)/);
    expect(sendsTo(c)[1].text).toMatch(/Передали/);
    expect((await stateOf(c)).owner).toBe('HUMAN');
    await ask(c, 'Спасибо');
    expect(sendsTo(c)).toHaveLength(2);
    expect(await handoffs(c)).toHaveLength(1);
    expect(visitWrites()).toHaveLength(0);
  });

  it('неоднозначне прізвище: наявне питання «до якого лікаря», відповідь іменем — питання про вибір щодо цього лікаря', async () => {
    const { c, s } = await autoClinic();
    await doctors(c, ['Коваль Ірина', 'Коваль Олег']);
    offering(s);
    await ask(c, 'Запишіть мене до лікаря Коваль');
    expect(sendsTo(c)[0].text).toBe(app.get(DoctorChoiceService).ambiguousQuestion('uk', ['Коваль Ірина', 'Коваль Олег']));
    expect(sendsTo(c)[0].options).toEqual([]);
    await ask(c, 'Ірина');
    expect(sendsTo(c)[1].text).toBe(wishQ('uk', 'Коваль Ірина'));
    expect(sendsTo(c)[1].options).toEqual([]);
    expect(await bookings(c)).toBe(0);
  });

  it('лікаря названо після вибору часу: дані збережено, згода відкликана, візит призупинено до вибору; стара кнопка згоди й повторні «так» нічого не створюють; після «будь-який лікар» — нова згода й один візит', async () => {
    const { c, s } = await autoClinic();
    await doctors(c, ['Коваль Ірина']);
    offering(s);
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    const tel = phone();
    await say(c, `Прізвище Петренко, ім’я Олег, телефон ${tel}`);
    const before = (await bookingReq(c))!;
    expect(before.stage).toBe('CONFIRM');
    const oldKey = before.consentKey!;
    const n = sendsTo(c).length;
    await ask(c, 'І ще: запишіть мене до лікаря Коваль');
    const asked = sendsTo(c).slice(n);
    expect(asked.map((m) => m.text)).toContain(wishQ('uk', 'Коваль Ірина'));
    let rq = (await bookingReq(c))!;
    expect([rq.wishedDoctor, rq.doctorState]).toEqual(['Коваль Ірина', 'WISH_ASKED']);
    expect([rq.lastName, rq.firstName, rq.phone, rq.slotAt?.getTime(), rq.service]).toEqual([before.lastName, before.firstName, before.phone, before.slotAt?.getTime(), before.service]);
    expect(rq.consentKey).toBeNull();
    expect(rq.consentAt).toBeNull();
    // the earlier consent button and repeated "yes" do not create the visit
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}|${oldKey.slice(0, 10)}`);
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    await ask(c, 'так');
    expect(visitWrites()).toHaveLength(0);
    expect((await bookingReq(c))!.consentAt).toBeNull();
    // settled: a new consent question (with the wish as a wish), then one visit
    await ask(c, 'Будь-який лікар');
    rq = (await bookingReq(c))!;
    expect(rq.doctorState).toBe('ANY_DOCTOR');
    const consent = sendsTo(c)[sendsTo(c).length - 1].text;
    expect(consent).toMatch(/Підтверджуєте запис/);
    expect(consent).toMatch(/не гарантуємо/);
    expect(rq.consentKey).not.toBe(oldKey);
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visitWrites()).toHaveLength(1);
    expect(visitBodies()[0]).toMatch(/Побажання пацієнта: Коваль Ірина/);
    expect(await bookings(c)).toBe(1);
  });

  it('після вибору часу пацієнт хоче саме цього лікаря: одна передача, дані заявки на запис лишаються, візиту немає', async () => {
    const { c, s } = await autoClinic();
    await doctors(c, ['Коваль Ірина']);
    offering(s);
    await ask(c, 'Хочу записатися на консультацію');
    await tap(c, sendsTo(c)[0].options[0]);
    await say(c, `Прізвище Петренко, ім’я Олег, телефон ${phone()}`);
    await ask(c, 'Запишіть до лікаря Коваль');
    await ask(c, 'Хочу саме до неї, передайте адміністратору');
    const h = await handoffs(c);
    expect(h).toHaveLength(1);
    expect(h[0].summary).toMatch(/бажаний лікар: Коваль Ірина/);
    expect((await stateOf(c)).owner).toBe('HUMAN');
    const rq = (await bookingReq(c))!;
    expect(rq.lastName).toBe('Петренко');
    expect(rq.doctorState).toBe('WISH_ADMIN');
    expect(visitWrites()).toHaveLength(0);
  });

  it('створення чернетки нічого не записує: ні заявки, ні передачі, ні стану, навіть коли назвали лікаря чи відповіли «адміністратору»', async () => {
    const { c } = await autoClinic();
    await doctors(c, ['Коваль Ірина']);
    // the messages go straight into the table (no intake, no autonomous turn): only the generation is exercised
    const put = (direction: 'IN' | 'OUT', text: string) => prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction, text } });
    await put('IN', 'Хочу записатися на консультацію до лікаря Коваль');
    const count = async () => [await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } }), await prisma.agentDraft.count({ where: { clinicId: c.clinicId } }), await prisma.conversationState.count({ where: { clinicId: c.clinicId } })];
    const before = await count();
    const gen = app.get(AgentDraftService);
    const d1 = await gen.generate(c.clinicId, 'INSTAGRAM', c.chat);
    expect(d1.reply).toBe(wishQ('uk', 'Коваль Ірина'));
    await put('OUT', d1.reply);
    await put('IN', 'Передайте побажання адміністратору');
    const d2 = await gen.generate(c.clinicId, 'INSTAGRAM', c.chat);
    expect(d2.next.action).toBe('HAND_OFF');
    expect(d2.exec.staffNote).toMatch(/Коваль Ірина/);
    expect(await count()).toEqual(before);
  });
});

// The autonomous agent in the doctors mode: the doctor is settled by DoctorChoiceService (the old bot's own decisions, read only in the draft), the times are that doctor's,
// the consent names him, the visit is made for him, nothing silently changes him. The doctors are kept in LANKA's own schedule (cabinets of the mock, with no visits nearby).
describe('агент у режимі запису за лікарями', () => {
  const handoffs = (c: C) => prisma.bookingRequest.findMany({ where: { clinicId: c.clinicId, chatId: c.chat, kind: 'HANDOFF' } });
  const visits = () => mock.writes.filter((w) => (w as { path?: string }).path === '/visits');
  const doctorOf = (m: { options: { doctorId?: string }[] }) => [...new Set(m.options.map((o) => o.doctorId))];
  const tapD = (c: C, o: { date: string; time: string; doctorId?: string }) => say(c, `Обрав час: ${o.date.slice(8)}.${o.date.slice(5, 7)} ${o.time}`, `slot|${o.date}|${o.time}|#${o.doctorId}`);
  const button = (c: C, m: { options: { label: string; payload?: string }[] }, label: string) => {
    const b = m.options.find((o) => o.label === label)!;
    return say(c, b.label, b.payload);
  };
  const doctor = async (c: C, externalId: string, last: string, first: string, serviceIds: string[], hours: [string, string] = ['10:00', '17:00']) => {
    await prisma.doctor.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId } }, create: { clinicId: c.clinicId, externalId, lastName: last, firstName: first, serviceIds }, update: { lastName: last, firstName: first, serviceIds, active: true } });
    await prisma.doctorAvailability.deleteMany({ where: { clinicId: c.clinicId, doctorId: externalId } });
    await prisma.doctorAvailability.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinicId: c.clinicId, doctorId: externalId, weekday, fromHm: hours[0], toHm: hours[1], cabinetId: externalId === '902' ? '802' : '801' })) });
  };
  const doctorsClinic = async (lang: 'uk' | 'ru' = 'uk') => {
    const x = await autoClinic(lang);
    await prisma.clinic.update({ where: { id: x.c.clinicId }, data: { scheduleMode: 'DOCTORS' } });
    return x;
  };
  const offering = (s: string) => decideBy(() => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: s }));
  const data = (c: C) => say(c, `Прізвище Петренко, ім’я Олег, телефон ${phone()}`);
  const lastSent = (c: C) => sendsTo(c)[sendsTo(c).length - 1];

  it('названий лікар: лише його часи → згода з його ім’ям → один візит саме до нього; повторне «так» не дублює', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    offering(s);
    await ask(c, 'Хочу записатися на консультацію до лікаря Мельник');
    const m = sendsTo(c)[0];
    expect(m.text).toMatch(/Вільний час у лікаря Мельник Олена/);
    expect(doctorOf(m)).toEqual(['901']);
    await tapD(c, m.options[0]);
    await data(c);
    const consent = lastSent(c).text;
    expect(consent).toMatch(/Підтверджуєте запис на Тестова консультація .* лікар Мельник Олена\?/);
    const rq = (await bookingReq(c))!;
    expect([rq.doctorId, rq.doctorReason, rq.scheduleMode]).toEqual(['901', 'CLIENT_CHOICE', 'DOCTORS']);
    for (let i = 0; i < 3; i++) await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visits()).toHaveLength(1);
    expect((visits()[0] as { body: Record<string, unknown> }).body).toMatchObject({ doctor_id: 901, date: m.options[0].date, time_start: m.options[0].time });
    expect(sendsTo(c).filter((x) => /Ваш запис підтверджено/.test(x.text))).toHaveLength(1);
    expect(sendsTo(c).find((x) => /Ваш запис підтверджено/.test(x.text))!.text).toMatch(/Лікар: Мельник Олена/);
  });

  it('неоднозначне прізвище: наявне питання з кнопками лікарів; вибір — часи лише обраного', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '903', 'Мельник', 'Андрій', [c.consult.id]);
    offering(s);
    await ask(c, 'Запишіть мене на консультацію до лікаря Мельника');
    const q = sendsTo(c)[0];
    expect(q.text).toMatch(/Уточніть, будь ласка, до якого лікаря/);
    expect(q.options.map((o) => o.payload).sort()).toEqual(['docpick|901', 'docpick|903']);
    await button(c, q, 'Мельник Андрій');
    expect(doctorOf(sendsTo(c)[1])).toEqual(['903']);
  });

  it('лікар не надає послугу: спершу питання про іншого; згода — часи іншого; відмова — одна передача з лікарем у заявці, без часу', async () => {
    const a = await doctorsClinic();
    await doctor(a.c, '905', 'Савчук', 'Ліна', [a.c.hygiene.id]);
    await doctor(a.c, '902', 'Бондар', 'Ігор', [a.c.consult.id]);
    offering(a.s);
    await ask(a.c, 'Хочу на консультацію до лікаря Савчук');
    const q = sendsTo(a.c)[0];
    expect(q.text).toMatch(/Лікар Савчук Ліна цієї послуги не надає. Можемо запропонувати лікаря Бондар Ігор. Згодні\?/);
    expect(q.options.every((o) => !o.date)).toBe(true);
    await button(a.c, q, 'Так');
    expect(doctorOf(sendsTo(a.c)[1])).toEqual(['902']);
    const b = await doctorsClinic();
    await doctor(b.c, '905', 'Савчук', 'Ліна', [b.c.hygiene.id]);
    await doctor(b.c, '902', 'Бондар', 'Ігор', [b.c.consult.id]);
    offering(b.s);
    await ask(b.c, 'Хочу на консультацію до лікаря Савчук');
    await button(b.c, sendsTo(b.c)[0], 'Ні');
    const h = await handoffs(b.c);
    expect(h).toHaveLength(1);
    expect(h[0].summary).toMatch(/Савчук Ліна/);
    expect(lastSent(b.c).text).toMatch(/лікаря не змінюємо/);
    expect(lastSent(b.c).options).toEqual([]);
    expect((await stateOf(b.c)).owner).toBe('HUMAN');
  });

  it('невідомо, чи лікар надає послугу: наявний шлях адміністратора; запитаний лікар без вільного часу: питання про іншого, без тихої заміни', async () => {
    const a = await doctorsClinic();
    await doctor(a.c, '904', 'Ткач', 'Олег', []);
    offering(a.s);
    await ask(a.c, 'Запишіть на консультацію до лікаря Ткач');
    expect((await handoffs(a.c))[0].summary).toMatch(/не налаштовано, які послуги надає лікар; лікар: Ткач Олег/);
    expect(sendsTo(a.c)[0].text).toMatch(/Передали заявку адміністратору з побажанням: лікар Ткач Олег/);
    expect(sendsTo(a.c)[0].options).toEqual([]);
    const b = await doctorsClinic();
    // a genuine 10-minute working interval every day, and on every day a visit of another doctor later in the same cabinet (the condition that used to stretch the
    // free time to that visit): a 30-minute visit fits nowhere
    await doctor(b.c, '906', 'Гнатюк', 'Віра', [b.c.consult.id], ['10:00', '10:10']);
    const p0 = await prisma.patient.findFirstOrThrow({ where: { clinicId: b.c.clinicId } });
    for (let i = 0; i < 15; i++) {
      const day = clinicDate(new Date(Date.now() + i * 86_400_000));
      await prisma.visit.create({ data: { clinicId: b.c.clinicId, patientId: p0.id, externalId: `x${rnd()}`, doctorId: '501', cabinetId: '801', startsAt: localToUtc(`${day} 11:00:00`), endsAt: localToUtc(`${day} 11:30:00`), status: 'PLANNED' } });
    }
    await doctor(b.c, '901', 'Мельник', 'Олена', [b.c.consult.id]);
    offering(b.s);
    await ask(b.c, 'Хочу на консультацію до лікаря Гнатюк');
    const q = sendsTo(b.c)[0];
    expect(q.text).toMatch(/У лікаря Гнатюк Віра найближчим часом немає вільного часу для цієї послуги. Можемо запропонувати лікаря Мельник Олена. Згодні\?/);
    expect(q.options.some((o) => o.date)).toBe(false);
    expect(await bookings(b.c)).toBe(1); // the request holds the question (a silent request), no time chosen
    expect((await bookingReq(b.c))!.slotAt).toBeNull();
  });

  it('пов’язаний пацієнт: пропозиція продовжити в попереднього лікаря тієї самої послуги; згода — його часи; відмова — «до якого лікаря», «все одно» — лікарі, що надають послугу', async () => {
    const setup = async () => {
      const x = await doctorsClinic();
      await doctor(x.c, '901', 'Мельник', 'Олена', [x.c.consult.id]);
      await doctor(x.c, '902', 'Бондар', 'Ігор', [x.c.consult.id]);
      const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: x.c.clinicId, removedAt: null } });
      await prisma.patientChannel.create({ data: { clinicId: x.c.clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: x.c.chat } });
      await prisma.visit.create({ data: { clinicId: x.c.clinicId, patientId: p.id, externalId: `h${rnd()}`, doctorId: '902', serviceName: 'Тестова консультація', startsAt: new Date(Date.now() - 90 * 86_400_000), status: 'VISITED' } });
      offering(x.s);
      return x;
    };
    const a = await setup();
    await ask(a.c, 'Хочу записатися на консультацію');
    const q = sendsTo(a.c)[0];
    expect(q.text).toContain('Раніше цю послугу («Тестова консультація») вам надавав(ла) Бондар Ігор. Продовжимо в цього лікаря?');
    expect(q.options.map((o) => o.payload)).toEqual(['docyes|902', 'docno|902']);
    await button(a.c, q, 'Так');
    expect(doctorOf(sendsTo(a.c)[1])).toEqual(['902']);
    expect((await bookingReq(a.c))!.doctorReason).toBe('CONTINUATION');
    const b = await setup();
    await ask(b.c, 'Хочу записатися на консультацію');
    await button(b.c, sendsTo(b.c)[0], 'Ні');
    expect(sendsTo(b.c)[1].text).toMatch(/Напишіть, будь ласка, до якого лікаря ви хочете, або що вам усе одно/);
    await ask(b.c, 'Все одно');
    expect(doctorOf(sendsTo(b.c)[2]).sort()).toEqual(['901', '902']);
  });

  it('неперевірений пацієнт: жодної історії (немає питання про попереднього лікаря), навіть коли вводить телефон чужої картки; без побажання — лише лікарі, що надають послугу, або лікар першого запису з налаштувань', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phone: null } } });
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `h${rnd()}`, doctorId: '902', serviceName: 'Тестова консультація', startsAt: new Date(Date.now() - 90 * 86_400_000), status: 'VISITED' } });
    offering(s);
    await ask(c, 'Хочу записатися на консультацію');
    const m = sendsTo(c)[0];
    expect(m.text).not.toMatch(/Раніше|Бондар Ігор\. Продовжимо/);
    expect(doctorOf(m).sort()).toEqual(['901', '902']); // the mock's own doctors provide nothing configured: not offered
    await tapD(c, m.options[0]);
    await say(c, `Прізвище Петренко, ім’я Олег, телефон ${p.phone}`);
    expect(sendsTo(c).map((x) => x.text).join(' ')).not.toMatch(/Раніше|надавав/);
    expect(visits()).toHaveLength(0);
    // the clinic's doctor for a first booking (settings): only his times
    const d = await doctorsClinic();
    await doctor(d.c, '901', 'Мельник', 'Олена', [d.c.consult.id]);
    await doctor(d.c, '902', 'Бондар', 'Ігор', [d.c.consult.id]);
    await prisma.clinic.update({ where: { id: d.c.clinicId }, data: { primaryDoctorId: '902' } });
    offering(d.s);
    await ask(d.c, 'Хочу записатися на консультацію');
    expect(doctorOf(sendsTo(d.c)[0])).toEqual(['902']);
  });

  it('час зайняли до створення візиту: свіжі часи лише того самого лікаря, нова згода, без заміни лікаря; лікар більше не надає послугу перед записом — людина, візиту немає', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    offering(s);
    await ask(c, 'Хочу на консультацію до лікаря Мельник');
    const o = sendsTo(c)[0].options[0];
    await tapD(c, o);
    await data(c);
    const rq = (await bookingReq(c))!;
    // somebody books that doctor at that time directly in Cliniccards
    const at = rq.slotAt!;
    const stamp = (d: Date) => `${clinicDate(d)} ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)}:00`;
    mock.data.visits.push({ visit_id: `99${rnd()}`, patient_id: '100002', status: 'PLANNED', doctor_id: '901', doctor: 'Мельник', cabinet_id: '801', visit_start: stamp(at), visit_end: stamp(new Date(at.getTime() + 30 * 60_000)), note: 'harness', price_items: null, date_created: stamp(at), date_edited: stamp(at) } as never);
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    expect(visits()).toHaveLength(0);
    const fresh = lastSent(c);
    expect(fresh.text).toMatch(/цей час уже зайнятий/);
    expect(doctorOf(fresh)).toEqual(['901']);
    expect(fresh.options.some((x) => x.date === o.date && x.time === o.time)).toBe(false);
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'harness');
    await tapD(c, fresh.options[0]);
    const again = (await bookingReq(c))!;
    expect(again.consentAt).toBeNull();
    expect(lastSent(c).text).toMatch(/лікар Мельник Олена\?/);
    // before the visit is made the doctor stops providing the service: a person, no visit, no other doctor
    await prisma.doctor.update({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: '901' } }, data: { serviceIds: [c.hygiene.id] } });
    const n = sendsTo(c).length;
    await say(c, 'Так, підтверджую', `bookyes|${again.id}`);
    expect(visits()).toHaveLength(0);
    expect((await stateOf(c)).owner).toBe('HUMAN');
    expect(sendsTo(c).some((m) => /Бондар/.test(m.text))).toBe(false);
    // one request for the staff with the reason, then one short message; no booking is claimed
    const h = await handoffs(c);
    expect(h).toHaveLength(1);
    expect(h[0].summary).toMatch(/not_possible: лікар не надає цю послугу/);
    expect(sendsTo(c).slice(n).map((m) => m.text)).toEqual(['Передали ваш запит адміністратору: він допоможе уточнити запис. Запис ще не підтверджено.']);
    // a repeated tap makes nothing more (the dialogue is a person's)
    await say(c, 'Так, підтверджую', `bookyes|${again.id}`);
    expect(sendsTo(c)).toHaveLength(n + 1);
    expect(await handoffs(c)).toHaveLength(1);
  });

  it('передача через непридатного лікаря: якщо заявку для персоналу не створено, пацієнту не кажуть «передали»; діалог однаково за людиною', async () => {
    const { c, s } = await doctorsClinic('ru');
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    offering(s);
    await ask(c, 'Хочу на консультацию к врачу Мельник');
    await tapD(c, sendsTo(c)[0].options[0]);
    await say(c, `Фамилия Петренко, имя Олег, телефон ${phone()}`);
    const rq = (await bookingReq(c))!;
    await prisma.doctor.update({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: '901' } }, data: { serviceIds: [c.hygiene.id] } });
    const reqs = app.get(RequestsService);
    const upsert = reqs.upsert.bind(reqs);
    const spy = jest.spyOn(reqs, 'upsert').mockImplementation(async (clinicId, d, ...rest) => {
      if (d.kind === 'HANDOFF') throw new Error('database unavailable');
      return upsert(clinicId, d, ...rest);
    });
    const n = sendsTo(c).length;
    await say(c, 'Да, подтверждаю', `bookyes|${rq.id}`);
    spy.mockRestore();
    expect(visits()).toHaveLength(0);
    expect(sendsTo(c).slice(n)).toEqual([]);
    expect(await handoffs(c)).toHaveLength(0);
    expect((await stateOf(c)).owner).toBe('HUMAN');
  });

  it('інший лікар під час запису: контакти збережено, старе підтвердження відхилено, часи нового лікаря, нова згода й один візит до нього', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    offering(s);
    await ask(c, 'Хочу на консультацію до лікаря Мельник');
    await tapD(c, sendsTo(c)[0].options[0]);
    await data(c);
    const before = (await bookingReq(c))!;
    const oldKey = before.consentKey!;
    await ask(c, 'Хочу краще до лікаря Бондар');
    const m = lastSent(c);
    expect(doctorOf(m)).toEqual(['902']);
    const mid = (await bookingReq(c))!;
    expect([mid.lastName, mid.firstName, mid.phone]).toEqual([before.lastName, before.firstName, before.phone]);
    expect([mid.slotAt, mid.consentKey]).toEqual([null, null]);
    await say(c, 'Так, підтверджую', `bookyes|${mid.id}|${oldKey.slice(0, 10)}`);
    expect(visits()).toHaveLength(0);
    await tapD(c, m.options[0]);
    expect(lastSent(c).text).toMatch(/лікар Бондар Ігор\?/);
    await say(c, 'Так, підтверджую', `bookyes|${mid.id}`);
    expect(visits()).toHaveLength(1);
    expect((visits()[0] as { body: Record<string, unknown> }).body).toMatchObject({ doctor_id: 902 });
  });

  it('створення чернетки нічого не записує: ні заявки, ні рішення про лікаря, ні оновлення лікарів з Cliniccards', async () => {
    const { c } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await prisma.chatMessage.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, direction: 'IN', text: 'Хочу записатися на консультацію до лікаря Мельник' } });
    const snap = async () => [await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } }), await prisma.agentDraft.count({ where: { clinicId: c.clinicId } }), await prisma.conversationState.count({ where: { clinicId: c.clinicId } }), await prisma.auditLog.count({ where: { clinicId: c.clinicId } }), JSON.stringify(await prisma.doctor.findMany({ where: { clinicId: c.clinicId }, orderBy: { externalId: 'asc' }, select: { externalId: true, refreshedAt: true } }))];
    const before = await snap();
    const reads = mock.writes.length;
    decideBy((_l, system) => decision({ reply: 'Добре.' }, { action: 'OFFER_TIME', service: /\[(S\d+)\]\s*Тестова консультація/.exec(system)?.[1] ?? null }));
    const d = await app.get(AgentDraftService).generate(c.clinicId, 'INSTAGRAM', c.chat);
    expect(d.next.action).toBe('OFFER_TIME');
    expect(d.options.every((o) => o.doctorId === '901')).toBe(true);
    expect(d.exec.doctorPatch).toMatchObject({ doctorId: '901', doctorState: 'AGREED' });
    expect(await snap()).toEqual(before);
    expect(mock.writes.length).toBe(reads);
  });

  it('побажання щодо дня й часу для часів лікаря: лише в межах побажання, той самий лікар; «не підходить» — нові часи без відхилених; «будь-який час» скидає побажання; без збігу — чесно про пошуковий період і наступний крок', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    offering(s);
    const tomorrow = clinicDate(new Date(Date.now() + 86_400_000));
    await ask(c, 'Хочу на консультацію до лікаря Мельник завтра після 14:00');
    const m1 = sendsTo(c)[0];
    expect(doctorOf(m1)).toEqual(['901']);
    expect(m1.options.length).toBeGreaterThan(0);
    expect(m1.options.every((o) => o.date === tomorrow && o.time >= '14:00')).toBe(true);
    expect(m1.text).toMatch(/Враховуємо ваше побажання \(після 14:00 на /);
    await ask(c, 'Не підходить');
    const m2 = sendsTo(c)[1];
    expect(doctorOf(m2)).toEqual(['901']);
    expect(m2.options.every((o) => o.date === tomorrow && o.time >= '14:00')).toBe(true);
    expect(m2.options.some((o) => m1.options.some((x) => x.date === o.date && x.time === o.time))).toBe(false);
    await ask(c, 'Будь-який час підійде');
    const m3 = sendsTo(c)[2];
    expect(doctorOf(m3)).toEqual(['901']);
    expect(m3.options.some((o) => o.time < '14:00' || o.date !== tomorrow)).toBe(true);
    // no match: honest about the searched period, the next step as a question, no times, no other doctor, no "the doctor has no time"
    const b = await doctorsClinic();
    await doctor(b.c, '901', 'Мельник', 'Олена', [b.c.consult.id]); // 10:00-17:00
    await doctor(b.c, '902', 'Бондар', 'Ігор', [b.c.consult.id]);
    offering(b.s);
    await ask(b.c, 'Хочу на консультацію до лікаря Мельник після 19:00');
    const q = sendsTo(b.c)[0];
    expect(q.options).toEqual([]);
    expect(q.text).toMatch(/На найближчі 7 днів вільних вікон після 19:00 не знайшлося. Передати ваш запит адміністратору, щоб він підібрав інший час\?/);
    expect(q.text).not.toMatch(/Бондар|немає вільного часу/);
    expect((await bookingReq(b.c))!.doctorId).toBe('901'); // the settled doctor is kept, not replaced
  });

  it('заміна зайнятого часу зберігає побажання й лікаря', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    offering(s);
    await ask(c, 'Хочу на консультацію до лікаря Мельник після 15:00');
    const o = sendsTo(c)[0].options[0];
    expect(o.time >= '15:00').toBe(true);
    await tapD(c, o);
    await data(c);
    const rq = (await bookingReq(c))!;
    const stamp = (d: Date) => `${clinicDate(d)} ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)}:00`;
    mock.data.visits.push({ visit_id: `99${rnd()}`, patient_id: '100002', status: 'PLANNED', doctor_id: '901', doctor: 'Мельник', cabinet_id: '801', visit_start: stamp(rq.slotAt!), visit_end: stamp(new Date(rq.slotAt!.getTime() + 30 * 60_000)), note: 'harness', price_items: null, date_created: stamp(rq.slotAt!), date_edited: stamp(rq.slotAt!) } as never);
    await say(c, 'Так, підтверджую', `bookyes|${rq.id}`);
    mock.data.visits = mock.data.visits.filter((v) => v.note !== 'harness');
    const fresh = lastSent(c);
    expect(fresh.text).toMatch(/цей час уже зайнятий/);
    expect(doctorOf(fresh)).toEqual(['901']);
    expect(fresh.options.length).toBeGreaterThan(0);
    expect(fresh.options.every((x) => x.time >= '15:00')).toBe(true);
    expect(fresh.options.some((x) => x.date === o.date && x.time === o.time)).toBe(false);
  });

  it('лікар є в Cliniccards, але не в довідці; модель помилково заперечує його: у відповіді немає заперечення, лишається її відповідь на інше питання, далі рішення коду про цього лікаря', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    expect(await prisma.kbItem.count({ where: { clinicId: c.clinicId, kind: 'DOCTOR' } })).toBe(0);
    decideBy(() => decision({ reply: 'Лікаря Мельник у наших даних немає, вибір лікаря уточнить адміністратор. Консультація триває близько 30 хвилин.' }, { action: 'OFFER_TIME', service: s }));
    await ask(c, 'Хочу на консультацію до лікаря Мельник. Скільки вона триває?');
    const m = sendsTo(c)[0];
    expect(m.text).toContain('30 хвилин');
    expect(m.text).not.toMatch(/немає|уточнить адміністратор/);
    expect(m.text).toMatch(/Вільний час у лікаря Мельник Олена/);
    expect(doctorOf(m)).toEqual(['901']);
    // the model was told the code's result (one doctor found), not a list of the doctors
    const sys = model.systems[model.systems.length - 1];
    expect(sys).toContain('пацієнт назвав лікаря Мельник Олена (за кодом: такий лікар Є серед лікарів клініки');
    expect(sys).not.toMatch(/Іваненко|Шевченко/);
    // the model answers without asking for times and denies him: the code's decision about the doctor is still the answer
    const b = await doctorsClinic();
    await doctor(b.c, '901', 'Мельник', 'Олена', [b.c.consult.id]);
    decideBy(() => decision({ reply: 'На жаль, такого лікаря в нас немає.' }));
    await ask(b.c, 'А лікар Мельник у вас приймає? Хочу на консультацію');
    expect(sendsTo(b.c)[0].text).not.toMatch(/немає/);
    expect(doctorOf(sendsTo(b.c)[0])).toEqual(['901']);
    // no service in sight: the denial goes and the code asks the service; nothing is said about the doctor's time
    const d = await doctorsClinic();
    await doctor(d.c, '901', 'Мельник', 'Олена', [d.c.consult.id]);
    decideBy(() => decision({ reply: 'На жаль, такого лікаря в нас немає.' }));
    await ask(d.c, 'А лікар Мельник у вас приймає?');
    expect(sendsTo(d.c)[0].text).not.toMatch(/немає/);
    expect(sendsTo(d.c)[0].text).toMatch(/На яку послугу/);
    expect(sendsTo(d.c)[0].options).toEqual([]);
  });

  it('немає часу за побажанням: точне пояснення щодо цього лікаря без заперечення моделі; згода на передачу — заявка для персоналу з лікарем, послугою, побажанням, причиною й посиланням на заявку на запис', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    decideBy((last) => (/передайте/i.test(last) ? decision({ reply: 'Добре, передамо.' }, { action: 'HAND_OFF', reason: 'time_preference_unavailable' }) : decision({ reply: 'Щодо лікаря Мельник, цього я не знаю, це уточнить адміністратор.' }, { action: 'OFFER_TIME', service: s })));
    await ask(c, 'Запишіть мене на консультацію до лікаря Мельник після 19:00');
    const q = sendsTo(c)[0];
    expect(q.text).toMatch(/^На найближчі 7 днів вільних вікон після 19:00 не знайшлося/);
    expect(q.text).not.toMatch(/не знаю/);
    await ask(c, 'Так, передайте, будь ласка');
    const h = await handoffs(c);
    expect(h).toHaveLength(1);
    const rq = (await bookingReq(c))!;
    expect(h[0].summary).toContain(`заявка на запис ${rq.id}`);
    expect(h[0].summary).toMatch(/послуга: Тестова консультація; лікар: Мельник Олена; побажання: після 19:00; причина: немає вільних вікон за побажанням пацієнта/);
    expect(lastSent(c).text).toMatch(/Передали/);
    expect((await stateOf(c)).owner).toBe('HUMAN');
  });

  it('лікаря не знайдено серед лікарів клініки: так і сказано, без часу й без іншого лікаря; «будь-який лікар» — лікарі, що надають послугу; неоднозначне прізвище не подається як визначене', async () => {
    const { c, s } = await doctorsClinic();
    await doctor(c, '901', 'Мельник', 'Олена', [c.consult.id]);
    await doctor(c, '902', 'Бондар', 'Ігор', [c.consult.id]);
    offering(s);
    model.calls = 0;
    await ask(c, 'Хочу на консультацію до лікаря Сидоренко');
    expect(model.calls).toBe(0);
    expect(sendsTo(c)[0].text).toBe('Лікаря Сидоренко серед лікарів клініки ми не знайшли. Уточніть, будь ласка, прізвище лікаря або напишіть, якщо вам підійде будь-який лікар.');
    expect(sendsTo(c)[0].options).toEqual([]);
    await ask(c, 'Будь-який лікар підійде, запишіть');
    expect(doctorOf(sendsTo(c)[1]).sort()).toEqual(['901', '902']);
    // ambiguous: the model's sentence that picks one of them is not kept, the code asks which
    const b = await doctorsClinic();
    await doctor(b.c, '901', 'Мельник', 'Олена', [b.c.consult.id]);
    await doctor(b.c, '903', 'Мельник', 'Андрій', [b.c.consult.id]);
    decideBy(() => decision({ reply: 'Лікар Мельник Андрій вас прийме завтра.' }, { action: 'OFFER_TIME', service: b.s }));
    await ask(b.c, 'Запишіть на консультацію до лікаря Мельника');
    const t = sendsTo(b.c)[0].text;
    expect(t).not.toMatch(/вас прийме/);
    expect(t).toMatch(/Уточніть, будь ласка, до якого лікаря/);
    expect(model.systems[model.systems.length - 1]).toContain('під слова пацієнта підходять кілька лікарів клініки');
  });
});
