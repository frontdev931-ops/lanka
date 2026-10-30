import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { OutboxService } from '../src/automations/outbox.service';
import { TelegramApi } from '../src/automations/telegram.api';
import { TelegramService } from '../src/automations/telegram.service';
import { WaitlistService } from '../src/automations/waitlist.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const sent: { chatId: string; text: string; extra?: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } }[] = [];
const tg = {
  getMe: async () => ({ id: 1, username: 'wl_bot' }),
  sendMessage: async (_t: string, chatId: string | number, text: string, extra?: never) => void sent.push({ chatId: String(chatId), text, extra }),
  answerCallbackQuery: async () => true,
  getUpdates: async () => [],
  setWebhook: async () => true,
  deleteWebhook: async () => true,
};
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
let app: INestApplication;
let prisma: PrismaService;
let waitlist: WaitlistService;
let outbox: OutboxService;
let telegram: TelegramService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(TelegramApi).useValue(tg).overrideProvider(LlmClient).useValue({ configured: false, complete: async () => { throw new Error('no AI in tests'); } }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  waitlist = app.get(WaitlistService);
  outbox = app.get(OutboxService);
  telegram = app.get(TelegramService);
  await dropOffers(); // leftovers of an earlier run
});
// The test database is shared: unsent offers must not be picked up by the queue tests of other files
const dropOffers = () => prisma.outboundMessage.updateMany({ where: { ruleKey: 'waitlist-offer', status: { in: ['APPROVED', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED' } });
afterAll(async () => {
  await dropOffers();
  await app.close();
});
beforeEach(() => {
  sent.length = 0;
});

// A clinic with a bot, one cabinet (so the schedule has free windows every working day) and Telegram on
async function clinic(over: Record<string, unknown> = {}) {
  const email = `w${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.clinic.update({ where: { id: clinicId }, data: { sendingEnabled: true, autoSendService: true, ...over } });
  await http().post('/automations/telegram').set(auth(res.body.accessToken)).send({ token: TOKEN }).expect(201);
  await prisma.cabinet.create({ data: { clinicId, externalId: `c${rnd()}`, name: 'Кабінет 1' } });
  return { token: res.body.accessToken as string, clinicId };
}
async function patient(clinicId: string, telegramOn = true) {
  const p = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: `Пацієнт ${rnd()}` } });
  const chat = `chat-${rnd()}`;
  if (telegramOn) await prisma.patientChannel.create({ data: { clinicId, patientId: p.id, channel: 'TELEGRAM', externalId: chat } });
  return { id: p.id, chat };
}
const wish = (token: string, patientId: string, over: Record<string, unknown> = {}) => http().post('/waitlist').set(auth(token)).send({ patientId, fromHour: 10, toHour: 12, ...over });
const cb = (chat: string, data: string) => ({ update_id: 1, callback_query: { id: 'q', from: { id: 1 }, message: { chat: { id: Number(chat.replace(/\D/g, '') || 1) } }, data } });
// the bot chat id is a string in our data: send it through the same shape the webhook uses
const press = (clinicId: string, chat: string, data: string) => telegram.handleUpdate(clinicId, TOKEN, { update_id: 1, callback_query: { id: 'q', from: { id: 1 }, message: { chat: { id: chat as unknown as number } }, data } });
// the queue only sends in the daytime of the clinic: take today at noon and make the message due
async function deliver(clinicId: string) {
  await prisma.outboundMessage.updateMany({ where: { clinicId, ruleKey: 'waitlist-offer', status: 'APPROVED' }, data: { scheduledFor: new Date(Date.now() - 86_400_000) } });
  return outbox.process(localToUtc(`${clinicDate(new Date())} 12:00:00`));
}
void cb;

describe('список очікування', () => {
  it('запис у список: права, перевірка побажань, один активний запис на пацієнта, ізоляція клінік', async () => {
    const a = await clinic();
    const b = await clinic();
    const p = await patient(a.clinicId);
    const doctorToken = await (async () => {
      const inv = await http().post('/team/invitations').set(auth(a.token)).send({ email: `d${rnd()}@example.com`, role: 'DOCTOR' }).expect(201);
      return (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Лікар', password: PASSWORD }).expect(201)).body.accessToken as string;
    })();
    await http().get('/waitlist').set(auth(doctorToken)).expect(403);
    await wish(a.token, p.id, { fromHour: 15, toHour: 15 }).expect(400);
    await wish(a.token, p.id, { weekdays: [9] }).expect(400);
    await wish(b.token, p.id).expect(404); // another clinic's patient
    await wish(a.token, p.id).expect(201);
    await wish(a.token, p.id).expect(400); // already waiting
    const list = (await http().get('/waitlist').set(auth(a.token)).expect(200)).body as { id: string; canBeOffered: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0].canBeOffered).toBe(true);
    expect((await http().get('/waitlist').set(auth(b.token))).body).toHaveLength(0);
    await http().delete(`/waitlist/${list[0].id}`).set(auth(b.token)).expect(404);
    await http().delete(`/waitlist/${list[0].id}`).set(auth(a.token)).expect(200);
    await wish(a.token, p.id).expect(201); // can wait again after cancelling
  });

  it('вільний час пропонується тому, хто чекає найдовше; одне вікно двом не дістається; пропозиція йде в Telegram з кнопками', async () => {
    const c = await clinic();
    const first = await patient(c.clinicId);
    const second = await patient(c.clinicId);
    await wish(c.token, first.id).expect(201);
    await wish(c.token, second.id).expect(201);
    expect(await waitlist.tick(c.clinicId)).toBe(2);
    const offers = await prisma.slotOffer.findMany({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'asc' } });
    expect(offers).toHaveLength(2);
    expect(offers[0].patientId).toBe(first.id);
    expect(offers[0].slotKey).not.toBe(offers[1].slotKey);
    expect(offers[0].startsAt.getTime()).toBeGreaterThan(Date.now() + 2 * 3_600_000);
    expect(offers[0].startsAt.getTime()).toBeLessThan(offers[1].startsAt.getTime()); // the earlier time to the one who waited longer
    // the database holds a window under a unique key: a second open offer for the same window is impossible
    await expect(prisma.slotOffer.create({ data: { clinicId: c.clinicId, entryId: offers[0].entryId, patientId: second.id, slotKey: offers[0].slotKey, activeKey: offers[0].slotKey, startsAt: offers[0].startsAt, expiresAt: new Date(Date.now() + 1e7) } })).rejects.toThrow();
    // nothing more to offer to the same people while their offers are open
    expect(await waitlist.tick(c.clinicId)).toBe(0);

    expect((await deliver(c.clinicId)).sent).toBe(2);
    const msg = sent.find((s) => s.chatId === first.chat)!;
    expect(msg.text).toContain('Звільнився час');
    expect(msg.extra!.reply_markup!.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`wl|${offers[0].id}|y`, `wl|${offers[0].id}|n`]);
    const after = await prisma.slotOffer.findUniqueOrThrow({ where: { id: offers[0].id } });
    expect(after.sentAt).not.toBeNull();
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3 * 3_600_000 + 1000); // the time to answer started at sending
  });

  it('«Підходить»: час утримується за пацієнтом, заявка адміністратору; повторне натискання нічого не міняє; чужий чат і чужа клініка не можуть відповісти', async () => {
    const c = await clinic();
    const other = await clinic();
    const p = await patient(c.clinicId);
    const stranger = await patient(c.clinicId);
    await wish(c.token, p.id);
    await waitlist.tick(c.clinicId);
    await deliver(c.clinicId);
    const offer = await prisma.slotOffer.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    sent.length = 0;
    await press(c.clinicId, stranger.chat, `wl|${offer.id}|y`); // not the person the offer was made to
    await press(other.clinicId, p.chat, `wl|${offer.id}|y`); // another clinic
    expect((await prisma.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('OFFERED');
    await press(c.clinicId, p.chat, `wl|${offer.id}|y`);
    expect(await prisma.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ status: 'ACCEPTED' });
    expect((await prisma.waitlistEntry.findFirstOrThrow({ where: { patientId: p.id } })).status).toBe('DONE');
    const req = await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, patientId: p.id } });
    expect(req).toMatchObject({ kind: 'BOOKING', status: 'NEW' });
    expect(req.summary).toContain('Лист очікування');
    expect(sent.at(-1)!.text).toContain('утримуємо');
    const n = sent.length;
    await press(c.clinicId, p.chat, `wl|${offer.id}|y`); // the second press
    expect(sent.length).toBe(n);
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, patientId: p.id } })).toBe(1);
    // the accepted window is still held: nobody else is offered it
    const waiting = await patient(c.clinicId);
    await wish(c.token, waiting.id);
    await waitlist.tick(c.clinicId);
    expect((await prisma.slotOffer.findMany({ where: { patientId: waiting.id } })).every((o) => o.slotKey !== offer.slotKey)).toBe(true);
  });

  it('«Не підходить» і мовчання: вікно звільняється й дістається наступному; пізня відповідь отримує пояснення', async () => {
    const c = await clinic();
    const a = await patient(c.clinicId);
    const b = await patient(c.clinicId);
    await wish(c.token, a.id);
    await waitlist.tick(c.clinicId);
    await deliver(c.clinicId);
    const offer = await prisma.slotOffer.findFirstOrThrow({ where: { patientId: a.id } });
    await press(c.clinicId, a.chat, `wl|${offer.id}|n`);
    expect(await prisma.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ status: 'DECLINED', activeKey: null });
    expect((await prisma.waitlistEntry.findFirstOrThrow({ where: { patientId: a.id } })).status).toBe('ACTIVE'); // still waits
    // another person waits and receives the freed window; the one who declined is not offered the same time again
    await wish(c.token, b.id);
    await waitlist.tick(c.clinicId);
    const forB = await prisma.slotOffer.findFirstOrThrow({ where: { patientId: b.id } });
    expect(forB.slotKey).toBe(offer.slotKey);
    const again = await prisma.slotOffer.findMany({ where: { patientId: a.id } });
    expect(again.filter((o) => o.slotKey === offer.slotKey)).toHaveLength(1);

    // b does not answer in time: the offer ends, b stays on the list, a late press is refused politely
    await deliver(c.clinicId);
    await prisma.slotOffer.update({ where: { id: forB.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await waitlist.sweep(c.clinicId);
    expect(await prisma.slotOffer.findUniqueOrThrow({ where: { id: forB.id } })).toMatchObject({ status: 'EXPIRED', activeKey: null });
    sent.length = 0;
    await press(c.clinicId, b.chat, `wl|${forB.id}|y`);
    expect(sent.at(-1)!.text).toContain('уже недоступний');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId, patientId: b.id } })).toBe(0);
  });

  it('співробітник скасував повідомлення в черзі: вікно звільняється; без Telegram, без дозволу на відправку, у демо й призупиненій клініці пропозицій немає', async () => {
    const c = await clinic({ autoSendService: false });
    const p = await patient(c.clinicId);
    await wish(c.token, p.id);
    await waitlist.tick(c.clinicId);
    const m = await prisma.outboundMessage.findFirstOrThrow({ where: { clinicId: c.clinicId, ruleKey: 'waitlist-offer' } });
    expect(m.status).toBe('PENDING_APPROVAL'); // waits for the staff when the clinic does not send service messages by itself
    await prisma.outboundMessage.update({ where: { id: m.id }, data: { status: 'CANCELLED' } });
    await waitlist.sweep(c.clinicId);
    expect(await prisma.slotOffer.findFirstOrThrow({ where: { clinicId: c.clinicId } })).toMatchObject({ status: 'EXPIRED', activeKey: null });

    const noTg = await clinic();
    const q = await patient(noTg.clinicId, false);
    await wish(noTg.token, q.id);
    expect(await waitlist.tick(noTg.clinicId)).toBe(0);
    expect((await http().get('/waitlist').set(auth(noTg.token))).body[0].canBeOffered).toBe(false);

    for (const over of [{ sendingEnabled: false }, { suspendedAt: new Date() }, { isDemo: true }]) {
      const x = await clinic();
      const y = await patient(x.clinicId);
      await wish(x.token, y.id);
      await prisma.clinic.update({ where: { id: x.clinicId }, data: over });
      expect(await waitlist.tick(x.clinicId)).toBe(0);
    }
  });

  it('пожелання враховуються: лікар, дні тижня, години; запис живе 30 днів', async () => {
    const c = await clinic();
    const p = await patient(c.clinicId);
    await wish(c.token, p.id, { doctorName: 'Лікар, якого немає в розкладі' });
    expect(await waitlist.tick(c.clinicId)).toBe(0);
    const q = await patient(c.clinicId);
    const today = new Date(`${clinicDate(new Date())}T00:00:00Z`).getUTCDay() || 7;
    const other = (today % 7) + 1;
    await wish(c.token, q.id, { weekdays: [other], fromHour: 14, toHour: 16 });
    expect(await waitlist.tick(c.clinicId)).toBe(1);
    const o = await prisma.slotOffer.findFirstOrThrow({ where: { patientId: q.id } });
    expect(new Date(`${clinicDate(o.startsAt)}T00:00:00Z`).getUTCDay() || 7).toBe(other);
    expect(Number(o.slotKey.split('|')[1].slice(0, 2))).toBeGreaterThanOrEqual(14);
    expect(Number(o.slotKey.split('|')[1].slice(0, 2))).toBeLessThan(16);
    // an entry that ran out is closed by the sweep
    const e = await prisma.waitlistEntry.findFirstOrThrow({ where: { patientId: p.id } });
    await prisma.waitlistEntry.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await waitlist.sweep(c.clinicId);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('CANCELLED');
  });
});
