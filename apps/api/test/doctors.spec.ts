import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { AvailabilityService } from '../src/booking/availability.service';
import { matchDoctors, serves } from '../src/booking/doctor-choice.service';
import { slotPayload } from '../src/automations/channels';
import { IntakeService } from '../src/automations/intake.service';
import { MessengerService } from '../src/automations/messenger.service';
import { clinicDate, localToUtc } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockHandle, MOCK_KEY, startMock } from '../mock/cliniccards-mock';

jest.setTimeout(120_000);

let app: INestApplication;
let prisma: PrismaService;
let mock: MockHandle;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const phone = () => `097${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

// The model only says "this is a booking for this service"; which doctor and which times is decided by the code
const ai = { configured: true, calls: 0, service: 'Консультація', intent: 'booking', complete: async () => {
  ai.calls++;
  return { text: JSON.stringify({ intent: ai.intent, reply: 'Оберіть, будь ласка, час.', summary: 'хоче записатися', service: ai.service, options: [] }), inputTokens: 1, outputTokens: 1 };
} };
const sent: { chatId: string; text: string; buttons: { label: string; payload: string }[] }[] = [];

beforeAll(async () => {
  mock = await startMock({ patients: 60, rateLimitPerMinute: 1_000_000 });
  process.env.CLINICCARDS_BASE_URL = mock.url;
  process.env.CLINICCARDS_WRITE_ENABLED = 'true';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue(ai).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(MessengerService), 'send').mockImplementation(async (_c: string, _ch: string, chatId: string, text: string, options = []) => {
    sent.push({ chatId, text, buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) });
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
  sent.length = 0;
  mock.writes.length = 0;
  ai.service = 'Консультація';
  ai.intent = 'booking';
});

type C = Awaited<ReturnType<typeof clinic>>;
// A clinic connected to the mock: its doctors are read from Cliniccards, two services are in the approved reference
async function clinic(opts: { sync?: boolean } = {}) {
  const email = `d${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  if (opts.sync !== false) await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  await prisma.clinic.update({ where: { id: clinicId }, data: { plan: 'PRO', aiEnabled: true, aiAutoReply: true, sendingEnabled: true } });
  const consult = await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Консультація', durationMin: 30, active: true, approvedAt: new Date() } });
  const caries = await prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: 'Лікування карієсу', category: 'Терапія', durationMin: 60, active: true, approvedAt: new Date() } });
  await http().get('/doctors').set(auth(token)).expect(200); // reads the doctors from Cliniccards
  return { token, clinicId, chat: `ig${rnd()}`, consult, caries };
}
const setServices = (c: C, id: string, serviceIds: string[], acceptsUrgent?: boolean) => http().put(`/doctors/${id}/profile`).set(auth(c.token)).send({ serviceIds, ...(acceptsUrgent !== undefined ? { acceptsUrgent } : {}) }).expect(200);
let mid = 0;
const write = (c: C, text: string, payload?: string) => app.get(IntakeService).handle(c.clinicId, { channel: 'INSTAGRAM', chatId: c.chat, mid: `m${++mid}${rnd()}`, text, ...(payload ? { payload } : {}), name: 'Гість' });
const last = () => sent[sent.length - 1];
const reqOf = (c: C) => prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId }, orderBy: { createdAt: 'desc' } });
const link = async (c: C) => {
  const p = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId, removedAt: null, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' } });
  await prisma.patientChannel.create({ data: { clinicId: c.clinicId, patientId: p.id, channel: 'INSTAGRAM', externalId: c.chat } });
  return p;
};
const tomorrow = () => clinicDate(new Date(Date.now() + 86_400_000));
// A doctor who is not in the shifts of Cliniccards: only the schedule kept in LANKA says when he works (cabinet "k9" has no visits at all)
async function lankaDoctor(c: C, externalId: string, last: string, first: string, serviceIds: string[], opts: { urgent?: boolean; hours?: [string, string] } = {}) {
  await prisma.cabinet.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: 'k9' } }, create: { clinicId: c.clinicId, externalId: 'k9', name: 'Кабінет K9' }, update: {} });
  await prisma.doctor.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId } }, create: { clinicId: c.clinicId, externalId, lastName: last, firstName: first, serviceIds, acceptsUrgent: !!opts.urgent }, update: { lastName: last, firstName: first, serviceIds, acceptsUrgent: !!opts.urgent, active: true } });
  const [from, to] = opts.hours ?? ['10:00', '17:00'];
  await prisma.doctorAvailability.deleteMany({ where: { clinicId: c.clinicId, doctorId: externalId } });
  await prisma.doctorAvailability.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinicId: c.clinicId, doctorId: externalId, weekday, fromHm: from, toHm: to, cabinetId: 'k9' })) });
}
const payloadsOf = (m: { buttons: { payload: string }[] }) => m.buttons.map((b) => b.payload);
const doctorsIn = (m: { buttons: { payload: string }[] }) => [...new Set(payloadsOf(m).filter((p) => p.startsWith('slot|')).map((p) => p.split('|')[3]))];

describe('разбор врача в тексте', () => {
  const docs = [
    { externalId: '1', lastName: 'Іваненко', firstName: 'Олег' },
    { externalId: '2', lastName: 'Петренко', firstName: 'Ірина' },
    { externalId: '3', lastName: 'Іваненко', firstName: 'Андрій' },
  ];
  it('прізвище в будь-якому відмінку; однакове прізвище розрізняється за ім’ям або лишається неоднозначним', () => {
    expect(matchDoctors('Хочу до Петренко', docs)).toEqual(['2']);
    expect(matchDoctors('запишіть до Петренка Ірини', docs)).toEqual(['2']);
    expect(matchDoctors('к Петренко Ирине', docs)).toEqual(['2']);
    expect(matchDoctors('Хочу до Іваненка', docs).sort()).toEqual(['1', '3']);
    expect(matchDoctors('Хочу до Іваненка Олега', docs)).toEqual(['1']);
    expect(matchDoctors('до Ірини', docs)).toEqual(['2']);
    expect(matchDoctors('хочу на чистку', docs)).toEqual([]);
    expect(serves({ serviceIds: [] }, { id: 'a' })).toBe('unknown');
    expect(serves({ serviceIds: ['b'] }, { id: 'a' })).toBe('no');
    expect(serves({ serviceIds: ['a'] }, { id: 'a' })).toBe('yes');
  });
});

describe('налаштування лікарів', () => {
  it('список лікарів береться з Cliniccards (лише лікарі, без телефонів); лікар для первинного запису зберігається за id; чужий id відхиляється', async () => {
    const c = await clinic();
    const list = (await http().get('/doctors').set(auth(c.token)).expect(200)).body;
    expect(list.doctors.map((d: { externalId: string }) => d.externalId).sort()).toEqual(['501', '502', '503']); // the manager 509 is not a doctor
    expect(JSON.stringify(list)).not.toContain('380670000000');
    expect(list.primary).toBeNull();

    const set = (await http().put('/doctors/primary').set(auth(c.token)).send({ doctorId: '502' }).expect(200)).body;
    expect(set.primary).toMatchObject({ doctorId: '502', name: 'Петренко Ірина', problems: expect.arrayContaining(['no_services']) });
    expect(await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).toMatchObject({ primaryDoctorId: '502', primaryDoctorName: 'Петренко Ірина' });
    // an arbitrary id and a staff member who is not a doctor are refused, and the setting does not change
    await http().put('/doctors/primary').set(auth(c.token)).send({ doctorId: '999999' }).expect(400);
    await http().put('/doctors/primary').set(auth(c.token)).send({ doctorId: '509' }).expect(400);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).primaryDoctorId).toBe('502');
    await http().put('/doctors/primary').set(auth(c.token)).send({ doctorId: null }).expect(200);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: c.clinicId } })).primaryDoctorId).toBeNull();
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'doctors.primary' } })).toBe(2);
  });

  it('профіль лікаря: лише послуги цієї клініки; права й ізоляція', async () => {
    const a = await clinic();
    const b = await clinic();
    const res = await setServices(a, '501', [a.consult.id], true);
    expect(res.body.doctors.find((d: { externalId: string }) => d.externalId === '501')).toMatchObject({ serviceIds: [a.consult.id], acceptsUrgent: true });
    await http().put('/doctors/501/profile').set(auth(a.token)).send({ serviceIds: [b.consult.id] }).expect(400); // a service of another clinic
    await http().put('/doctors/501/profile').set(auth(b.token)).send({ serviceIds: [b.consult.id] }).expect(200);
    expect(JSON.stringify((await http().get('/doctors').set(auth(b.token))).body)).not.toContain(a.consult.id);
    await http().put('/doctors/999/profile').set(auth(a.token)).send({ serviceIds: [] }).expect(404);
    const inv = await http().post('/team/invitations').set(auth(a.token)).send({ email: `an${rnd()}@example.com`, role: 'ANALYST' }).expect(201);
    const analyst = (await http().post(`/invites/${(inv.body.link as string).split('/invite/')[1]}/accept`).send({ name: 'Ан', password: PASSWORD }).expect(201)).body.accessToken as string;
    await http().get('/doctors').set(auth(analyst)).expect(200);
    await http().put('/doctors/primary').set(auth(analyst)).send({ doctorId: '501' }).expect(403);
    await http().put('/doctors/501/availability').set(auth(analyst)).send({ weekly: [] }).expect(403);
  });
});

describe('розклад, який клініка веде в LANKA, і вільний час лікаря', () => {
  it('розклад зберігається з перевіркою: години, кабінет, перетин власних рядків, зайнятий кабінет іншого лікаря', async () => {
    const c = await clinic();
    await lankaDoctor(c, '901', 'Лань', 'Андрій', [c.consult.id]);
    await prisma.doctorAvailability.deleteMany({ where: { clinicId: c.clinicId } });
    await lankaDoctor(c, '902', 'Ланко', 'Віра', [c.consult.id]);
    await prisma.doctorAvailability.deleteMany({ where: { clinicId: c.clinicId } });
    const put = (id: string, body: unknown) => http().put(`/doctors/${id}/availability`).set(auth(c.token)).send(body as object);
    await put('901', { weekly: [{ weekday: 1, from: '10:00', to: '14:00', cabinetId: 'k9' }] }).expect(200);
    await put('901', { weekly: [{ weekday: 1, from: '12:00', to: '14:00', cabinetId: 'k9' }, { weekday: 1, from: '13:00', to: '15:00', cabinetId: 'k9' }] }).expect(409); // its own rows overlap
    await put('902', { weekly: [{ weekday: 1, from: '13:00', to: '15:00', cabinetId: 'k9' }] }).expect(409); // the cabinet is taken by another doctor at that time
    await put('902', { weekly: [{ weekday: 1, from: '14:00', to: '16:00', cabinetId: 'k9' }] }).expect(200); // right after: fine
    await put('902', { weekly: [{ weekday: 1, from: '14:00', to: '16:00', cabinetId: 'nope' }] }).expect(400); // an unknown cabinet
    await put('902', { weekly: [{ weekday: 9, from: '14:00', to: '16:00', cabinetId: 'k9' }] }).expect(400);
    await put('902', { weekly: [{ weekday: 2, from: '16:00', to: '14:00', cabinetId: 'k9' }] }).expect(400);
    await put('902', { weekly: [{ weekday: 2, from: '10:00', to: '12:00', cabinetId: 'k9' }], exceptions: [{ date: 'завтра', closed: true }] }).expect(400);
    const saved = (await put('902', { weekly: [{ weekday: 2, from: '10:00', to: '12:00', cabinetId: 'k9' }], exceptions: [{ date: '2031-01-01', closed: true }, { date: '2031-01-02', closed: false, from: '12:00', to: '13:00' }] }).expect(200)).body;
    expect(saved).toMatchObject({ source: 'LANKA', weekly: [{ weekday: 2, from: '10:00', to: '12:00', cabinetId: 'k9' }], exceptions: [{ date: '2031-01-01', closed: true }, { date: '2031-01-02', closed: false, from: '12:00', to: '13:00' }] });
    expect(await prisma.doctorAvailability.count({ where: { clinicId: c.clinicId, doctorId: '902' } })).toBe(3); // replaced as a whole
  });

  it('вільний час: зміни Cliniccards або розклад LANKA, мінус візити лікаря й кабінету та блоки; без розкладу нічого не пропонується (порожній календар не доводить роботу)', async () => {
    const c = await clinic();
    await lankaDoctor(c, '901', 'Лань', 'Андрій', [c.consult.id]);
    await lankaDoctor(c, '903', 'Без', 'Розкладу', [c.consult.id]);
    await prisma.doctorAvailability.deleteMany({ where: { clinicId: c.clinicId, doctorId: '903' } });
    const av = app.get(AvailabilityService);
    const day = tomorrow();
    const patient = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    const at = (hm: string) => localToUtc(`${day} ${hm}:00`);
    // a visit of the doctor 10:00-10:30 and a reserved block of the cabinet 12:00-13:00
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: patient.id, externalId: `v${rnd()}`, doctorId: '901', cabinetId: 'k9', startsAt: at('10:00'), endsAt: at('10:30'), status: 'PLANNED' } });
    await prisma.reservedBlock.create({ data: { clinicId: c.clinicId, externalId: `b${rnd()}`, cabinetId: 'k9', startsAt: at('12:00'), endsAt: at('13:00') } });
    const w = (await av.windows(c.clinicId, '901', { minutes: 30 })).filter((x) => x.date === day);
    expect(w.map((x) => [x.startMin, x.endMin, x.cabinetId])).toEqual([[630, 720, 'k9'], [780, 1020, 'k9']]); // 10:30-12:00 and 13:00-17:00
    expect((await av.windows(c.clinicId, '901', { minutes: 120 })).filter((x) => x.date === day).map((x) => x.startMin)).toEqual([780]); // a long service needs a long gap
    expect(await av.placeFor(c.clinicId, '901', at('11:00'), 30)).toMatchObject({ cabinetId: 'k9' });
    expect(await av.placeFor(c.clinicId, '901', at('10:00'), 30)).toBeNull(); // busy
    expect(await av.placeFor(c.clinicId, '901', at('11:45'), 30)).toBeNull(); // runs into the block
    expect(await av.placeFor(c.clinicId, '901', at('18:00'), 30)).toBeNull(); // outside the hours
    // another doctor's visit in the same cabinet takes the place too
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: patient.id, externalId: `v${rnd()}`, doctorId: '777', cabinetId: 'k9', startsAt: at('14:00'), endsAt: at('15:00'), status: 'PLANNED' } });
    expect(await av.placeFor(c.clinicId, '901', at('14:00'), 30)).toBeNull();
    // a day off for one date
    await http().put('/doctors/901/availability').set(auth(c.token)).send({ weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, from: '10:00', to: '17:00', cabinetId: 'k9' })), exceptions: [{ date: day, closed: true }] }).expect(200);
    expect((await av.windows(c.clinicId, '901', { minutes: 30 })).filter((x) => x.date === day)).toEqual([]);
    // no shifts and no schedule: nothing, and the settings say so
    expect(await av.source(c.clinicId, '903')).toBe('NONE');
    expect(await av.windows(c.clinicId, '903', { minutes: 30 })).toEqual([]);
    expect(await av.source(c.clinicId, '501')).toBe('SHIFTS');
    expect((await http().get('/doctors').set(auth(c.token))).body.doctors.find((d: { externalId: string }) => d.externalId === '501').problems).toEqual(['no_services']);
  });
});

describe('выбор врача: четыре ветки', () => {
  it('1. пожелание пациента: названного врача ищут среди врачей клиники, показываются только его окна, врач хранится по id с причиной', async () => {
    const c = await clinic();
    await setServices(c, '501', [c.consult.id]);
    await setServices(c, '502', [c.consult.id]);
    await write(c, 'Хочу до Іваненка на консультацію');
    expect(doctorsIn(last())).toEqual(['#501']); // only his times
    expect(last().text).toContain('Іваненко Олег');
    expect(await reqOf(c)).toMatchObject({ doctorId: '501', doctor: 'Іваненко Олег', doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED', urgent: false });
    // every offered time really is free for him by the data of the clinic
    for (const p of payloadsOf(last()).filter((x) => x.startsWith('slot|'))) {
      const [, date, time] = p.split('|');
      expect(await app.get(AvailabilityService).placeFor(c.clinicId, '501', localToUtc(`${date} ${time}:00`), 30)).not.toBeNull();
    }
    // a repeated message does not create a second request
    await write(c, 'Так, до Іваненка');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);
  });

  it('1б. неоднозначне прізвище: бот уточнює, нікого не вибираючи; відповідь кнопкою задає лікаря', async () => {
    const c = await clinic();
    await setServices(c, '501', [c.consult.id]);
    await lankaDoctor(c, '504', 'Іваненко', 'Андрій', [c.consult.id]);
    await write(c, 'Хочу до Іваненка');
    expect(last().text).toContain('до якого лікаря');
    expect(payloadsOf(last()).sort()).toEqual(['docpick|501', 'docpick|504']);
    expect((await reqOf(c)).doctorId).toBeNull();
    // the person picks the second one by a button; a repeated tap changes nothing
    await write(c, '', 'docpick|504');
    expect(doctorsIn(last())).toEqual(['#504']);
    const n = sent.length;
    await write(c, '', 'docpick|504');
    expect(sent.length).toBe(n);
    expect(await reqOf(c)).toMatchObject({ doctorId: '504', doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);
    // the first name given at once settles it without a question
    const d = await clinic();
    await setServices(d, '501', [d.consult.id]);
    await lankaDoctor(d, '504', 'Іваненко', 'Андрій', [d.consult.id]);
    await write(d, 'Хочу до Іваненка Олега');
    expect(doctorsIn(last())).toEqual(['#501']);
  });

  it('1в. врач без вільних вікон: лікар не змінюється без згоди — пропонується інший, «ні» лишає того самого лікаря й передає адміністратору', async () => {
    const c = await clinic();
    await setServices(c, '501', [c.consult.id]);
    await lankaDoctor(c, '505', 'Зайнятий', 'Іван', [c.consult.id], { hours: ['10:00', '10:30'] });
    // his only half hour of every day is taken by a visit
    const patient = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.clinicId } });
    for (let i = 0; i < 16; i++) {
      const day = clinicDate(new Date(Date.now() + i * 86_400_000));
      await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: patient.id, externalId: `v${rnd()}`, doctorId: '505', cabinetId: 'k9', startsAt: localToUtc(`${day} 10:00:00`), endsAt: localToUtc(`${day} 10:30:00`), status: 'PLANNED' } });
    }
    await write(c, 'Хочу до Зайнятого на консультацію');
    expect(last().text).toContain('немає вільного часу');
    expect(last().text).toContain('Іваненко Олег');
    expect(payloadsOf(last())).toEqual(['docyes|501', 'docno|501']);
    expect(await reqOf(c)).toMatchObject({ doctorId: '505', doctorState: 'PROPOSED', pendingDoctorId: '501' });
    // "no": the doctor stays the one the person wanted, nothing is booked, a person takes it
    await write(c, '', 'docno|501');
    expect(last().text).toContain('лікаря не змінюємо');
    expect(last().text).not.toContain('Ваш запис підтверджено');
    expect(await reqOf(c)).toMatchObject({ doctorId: '505', doctorState: 'AGREED' });
    expect((await reqOf(c)).summary).toContain('відмовився');
    // a repeated "no" is ignored
    const n = sent.length;
    await write(c, '', 'docno|501');
    expect(sent.length).toBe(n);

    // "yes" on another request: the proposed doctor's times, doctor 501 now
    const d = await clinic();
    await setServices(d, '501', [d.consult.id]);
    await lankaDoctor(d, '505', 'Зайнятий', 'Іван', [d.consult.id], { hours: ['10:00', '10:30'] });
    const p2 = await prisma.patient.findFirstOrThrow({ where: { clinicId: d.clinicId } });
    for (let i = 0; i < 16; i++) {
      const day = clinicDate(new Date(Date.now() + i * 86_400_000));
      await prisma.visit.create({ data: { clinicId: d.clinicId, patientId: p2.id, externalId: `v${rnd()}`, doctorId: '505', cabinetId: 'k9', startsAt: localToUtc(`${day} 10:00:00`), endsAt: localToUtc(`${day} 10:30:00`), status: 'PLANNED' } });
    }
    await write(d, 'Хочу до Зайнятого на консультацію');
    await write(d, 'так');
    expect(doctorsIn(last())).toEqual(['#501']);
    expect(await reqOf(d)).toMatchObject({ doctorId: '501', doctorState: 'AGREED' });
  });

  it('1г. несумісна послуга: лікар її не надає — пропонується інший; якщо послуги лікаря не налаштовані, обіцянок немає', async () => {
    const c = await clinic();
    await setServices(c, '501', [c.consult.id]);
    await setServices(c, '502', [c.caries.id]); // 502 does not do consultations
    await write(c, 'Хочу до Петренка на консультацію');
    expect(last().text).toContain('цієї послуги не надає');
    expect(payloadsOf(last())).toEqual(['docyes|501', 'docno|501']);
    // services of the doctor are not configured at all: unknown, so a person decides and no time is promised
    const d = await clinic();
    await write(d, 'Хочу до Шевченка на консультацію');
    expect(payloadsOf(last())).toEqual([]);
    expect(last().text).toContain('Передали заявку');
    expect(last().text).not.toContain('Ваш запис підтверджено');
    expect(await reqOf(d)).toMatchObject({ doctorId: '503', doctorReason: 'CLIENT_CHOICE' });
    expect((await reqOf(d)).summary).toContain('не налаштовано');
  });

  it('2. продовження лікування: лікар за тією самою послугою, а не останній; пропозиція, лише після згоди — його вікна; телефон з чату нічого не відкриває', async () => {
    ai.service = 'Лікування карієсу';
    const c = await clinic();
    await setServices(c, '501', [c.caries.id]);
    await setServices(c, '502', [c.consult.id]);
    const p = await link(c);
    // 501 treated the caries; the LAST visit was a consultation with 502
    await prisma.planItem.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `pi${rnd()}`, planId: 'pl1', name: 'Лікування карієсу 36 зуб', status: 'DONE', createdAtExt: new Date(Date.now() - 60 * 86_400_000), markedDoneAt: new Date(Date.now() - 50 * 86_400_000), groupName: 'Терапія', doneByDoctorId: '501' } });
    await prisma.visit.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `v${rnd()}`, doctorId: '502', doctorName: 'Петренко Ірина', serviceName: 'Консультація', startsAt: new Date(Date.now() - 5 * 86_400_000), status: 'VISITED' } });
    await write(c, 'Хочу продовжити лікування');
    expect(last().text).toContain('Іваненко Олег');
    expect(last().text).toContain('Продовжимо в цього лікаря');
    expect(payloadsOf(last())).toEqual(['docyes|501', 'docno|501']);
    expect(await reqOf(c)).toMatchObject({ doctorReason: 'CONTINUATION', doctorState: 'PROPOSED', pendingDoctorId: '501', doctorId: null });
    // the times are shown only after the "yes"
    await write(c, '', 'docyes|501');
    expect(doctorsIn(last())).toEqual(['#501']);
    expect(await reqOf(c)).toMatchObject({ doctorId: '501', doctorReason: 'CONTINUATION', doctorState: 'AGREED' });
    expect(await prisma.auditLog.count({ where: { clinicId: c.clinicId, action: 'booking_request.doctor' } })).toBe(1);

    // "no": the bot asks who, and does not propose the same doctor again
    const d = await clinic();
    await setServices(d, '501', [d.caries.id]);
    const p2 = await link(d);
    await prisma.planItem.create({ data: { clinicId: d.clinicId, patientId: p2.id, externalId: `pi${rnd()}`, planId: 'pl1', name: 'Лікування карієсу', status: 'DONE', createdAtExt: new Date(Date.now() - 60 * 86_400_000), markedDoneAt: new Date(Date.now() - 50 * 86_400_000), doneByDoctorId: '501' } });
    await write(d, 'Хочу продовжити лікування');
    await write(d, 'ні');
    expect(last().text).toContain('до якого лікаря');
    expect(await reqOf(d)).toMatchObject({ doctorState: 'NO_CONTINUATION', doctorReason: null });
    await write(d, 'Хочу лікування карієсу');
    expect(payloadsOf(last()).some((x) => x.startsWith('docyes'))).toBe(false);

    // two doctors treated the same service: ask who, do not pick
    const e = await clinic();
    await setServices(e, '501', [e.caries.id]);
    await setServices(e, '502', [e.caries.id]);
    const p3 = await link(e);
    for (const doc of ['501', '502']) await prisma.planItem.create({ data: { clinicId: e.clinicId, patientId: p3.id, externalId: `pi${rnd()}`, planId: 'pl1', name: 'Лікування карієсу', status: 'DONE', createdAtExt: new Date(Date.now() - 60 * 86_400_000), markedDoneAt: new Date(), doneByDoctorId: doc } });
    await write(e, 'Хочу продовжити лікування');
    expect(payloadsOf(last()).sort()).toEqual(['docpick|501', 'docpick|502']);

    // the same history but the chat is NOT tied to the card (only a phone was typed): no continuation, nothing about the card is revealed
    sent.length = 0;
    const f = await clinic();
    await setServices(f, '501', [f.caries.id]);
    const p4 = await prisma.patient.findFirstOrThrow({ where: { clinicId: f.clinicId, NOT: { phoneNorm: null } }, orderBy: { externalId: 'asc' } });
    await prisma.planItem.create({ data: { clinicId: f.clinicId, patientId: p4.id, externalId: `pi${rnd()}`, planId: 'pl1', name: 'Лікування карієсу', status: 'DONE', createdAtExt: new Date(Date.now() - 60 * 86_400_000), markedDoneAt: new Date(), doneByDoctorId: '501' } });
    await write(f, `Хочу лікування карієсу, мій телефон ${p4.phone}`);
    expect(JSON.stringify(sent)).not.toContain('Продовжимо');
    expect(JSON.stringify(sent)).not.toContain('docyes');
  });

  it('3. первинне звернення: лікар для первинного запису, лише якщо він надає послугу й має вікна; інакше запис до нього не пропонується', async () => {
    const c = await clinic();
    await setServices(c, '501', [c.consult.id]);
    await setServices(c, '502', [c.consult.id]);
    // not configured: the usual flow is untouched (the model's own times, no doctor chosen)
    await write(c, 'Хочу записатися на консультацію');
    expect((await reqOf(c)).doctorId).toBeNull();

    await http().put('/doctors/primary').set(auth(c.token)).send({ doctorId: '502' }).expect(200);
    const d = { ...c, chat: `ig${rnd()}` };
    await write(d, 'Хочу записатися на консультацію');
    expect(doctorsIn(last())).toEqual(['#502']);
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: d.chat } })).toMatchObject({ doctorId: '502', doctorReason: 'PRIMARY', doctorState: 'AGREED' });

    // the doctor for first visits does not provide the service: another suitable doctor is PROPOSED, never booked behind the person's back
    ai.service = 'Лікування карієсу';
    await setServices(c, '501', [c.consult.id, c.caries.id]);
    const e = { ...c, chat: `ig${rnd()}` };
    await write(e, 'Хочу записатися на лікування карієсу');
    expect(last().text).toContain('Іваненко Олег');
    expect(payloadsOf(last())).toEqual(['docyes|501', 'docno|501']);
    expect(await prisma.bookingRequest.findFirstOrThrow({ where: { clinicId: c.clinicId, chatId: e.chat } })).toMatchObject({ doctorReason: 'SERVICE_MATCH', doctorState: 'PROPOSED', doctorId: null });

    // nobody suitable: a person takes it; the services of the doctor are unknown: the same
    await setServices(c, '501', []);
    const f = { ...c, chat: `ig${rnd()}` };
    await write(f, 'Хочу записатися на лікування карієсу');
    expect(last().text).toContain('Передали заявку');
    expect(payloadsOf(last())).toEqual([]);
    const g = await clinic();
    await http().put('/doctors/primary').set(auth(g.token)).send({ doctorId: '502' }).expect(200);
    ai.service = 'Консультація';
    await write(g, 'Хочу записатися на консультацію');
    expect(last().text).toContain('Передали заявку');
    expect(last().text).not.toContain('Ваш запис підтверджено');
  });

  it('4. термінове звернення: найближчі вікна лише лікарів, які приймають такі звернення, пріоритетна заявка без дублів; зміна лікаря — лише зі згодою', async () => {
    const c = await clinic();
    await setServices(c, '502', [c.consult.id], true);
    await setServices(c, '503', [c.consult.id], true);
    await setServices(c, '501', [c.consult.id], false);
    await write(c, 'У мене гострий біль і флюс');
    const doctors = doctorsIn(last());
    expect(doctors.length).toBeGreaterThan(0);
    for (const d of doctors) expect(['#502', '#503']).toContain(d); // never 501, who does not take urgent patients
    expect(last().text).toContain('103'); // the usual urgent text, no diagnosis, no advice
    expect(last().text).not.toMatch(/безпечн|нічого страшного|полощ|таблетк|антибіот/i);
    const req = await reqOf(c);
    expect(req).toMatchObject({ urgent: true, doctorReason: 'URGENT' });
    expect(req.summary).toContain('ТЕРМІНОВО');
    // a repeated urgent message: still ONE request
    await write(c, 'Дуже болить, флюс росте');
    expect(await prisma.bookingRequest.count({ where: { clinicId: c.clinicId } })).toBe(1);

    // the person wanted doctor 501, the nearest urgent time is somebody else's: asked first, 501 is kept on "no"
    const d = await clinic();
    await setServices(d, '501', [d.consult.id], false);
    await setServices(d, '502', [d.consult.id], true);
    await write(d, 'Хочу до Іваненка на консультацію');
    expect((await reqOf(d)).doctorId).toBe('501');
    await write(d, 'У мене гострий біль');
    expect(last().text).toContain('в іншого лікаря');
    expect(payloadsOf(last())).toEqual(['docyes|502', 'docno|502']);
    expect(await reqOf(d)).toMatchObject({ urgent: true, doctorId: '501', doctorState: 'PROPOSED', pendingDoctorId: '502' });
    await write(d, '', 'docno|502');
    expect(doctorsIn(last())).toEqual(['#501']); // his own times; the priority request stays
    expect(await reqOf(d)).toMatchObject({ urgent: true, doctorId: '501' });
    expect(await prisma.bookingRequest.count({ where: { clinicId: d.clinicId } })).toBe(1);
    // and with a "yes" the urgent doctors' times are shown instead
    const e = await clinic();
    await setServices(e, '501', [e.consult.id], false);
    await setServices(e, '502', [e.consult.id], true);
    await write(e, 'Хочу до Іваненка на консультацію');
    await write(e, 'У мене гострий біль');
    await write(e, 'так');
    for (const x of doctorsIn(last())) expect(x).toBe('#502');
    expect(await reqOf(e)).toMatchObject({ urgent: true, doctorReason: 'URGENT' });
    // medical questions still go to a person, not to this scenario
    const before = sent.length;
    await write(e, 'Який антибіотик пити при болі?');
    expect(sent.slice(before).map((m) => m.text).join('\n')).not.toContain('103');
  });
});

describe('без змін у Cliniccards, конфлікти й автоматичний запис з лікарем', () => {
  it('немає змін і немає розкладу в LANKA: заявка зберігає побажаного лікаря, підтверджений візит не обіцяється', async () => {
    const c = await clinic();
    await prisma.shift.deleteMany({ where: { clinicId: c.clinicId } });
    await setServices(c, '501', [c.consult.id]);
    await write(c, 'Хочу до Іваненка на консультацію');
    expect(payloadsOf(last())).toEqual([]);
    expect(last().text).toContain('Передали заявку');
    expect(last().text).toContain('Іваненко Олег');
    expect(last().text).not.toContain('Ваш запис підтверджено');
    expect(await reqOf(c)).toMatchObject({ doctorId: '501', doctorReason: 'CLIENT_CHOICE', status: 'NEW' });
    expect((await reqOf(c)).summary).toContain('немає надійного розкладу');
    // once the clinic sets the schedule in LANKA, the same wish gets times
    await prisma.cabinet.upsert({ where: { clinicId_externalId: { clinicId: c.clinicId, externalId: 'k9' } }, create: { clinicId: c.clinicId, externalId: 'k9', name: 'K9' }, update: {} });
    await http().put('/doctors/501/availability').set(auth(c.token)).send({ weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, from: '10:00', to: '17:00', cabinetId: 'k9' })) }).expect(200);
    const d = { ...c, chat: `ig${rnd()}` };
    await write(d, 'Хочу до Іваненка на консультацію');
    expect(doctorsIn(last())).toEqual(['#501']);
  });

  it('автозапис: лікар із заявки, явне «так» із лікарем у питанні, повторна перевірка перед записом; конфлікт з візитом Cliniccards, якого наша копія ще не знає, зупиняє запис; у візиті й підтвердженні фактичний лікар', async () => {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAutoBooking: true } });
    await setServices(c, '501', [c.consult.id]);
    const p = await link(c);
    await write(c, 'Хочу до Іваненка на консультацію');
    const offered = payloadsOf(last()).filter((x) => x.startsWith('slot|'));
    expect(offered.length).toBeGreaterThan(0);
    // the person taps the second offered time (a button of the doctor)
    await write(c, '', offered[Math.min(1, offered.length - 1)]);
    const q = await reqOf(c);
    expect(last().text).toContain('Підтверджуєте запис на Консультація');
    expect(last().text).toContain('лікар Іваненко Олег');
    expect(mock.writes).toHaveLength(0);

    // meanwhile somebody books that doctor directly in Cliniccards (our copy does not know): after "yes" the fresh check stops the write
    const at = q.slotAt!;
    const stamp = (d: Date) => `${clinicDate(d)} ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)}:00`;
    mock.data.visits.push({ visit_id: `99${rnd()}`, patient_id: '100002', status: 'PLANNED', doctor_id: '501', doctor: 'Іваненко', cabinet_id: '801', visit_start: stamp(at), visit_end: stamp(new Date(at.getTime() + 30 * 60_000)), note: 'прямо в Cliniccards', price_items: null, date_created: stamp(new Date()), date_edited: stamp(new Date()) });
    await write(c, 'так');
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(0);
    expect(last().text).toContain('зайнятий');
    expect(await reqOf(c)).toMatchObject({ status: 'NEW', confirmedAt: null });

    // a free time of the same doctor: the booking is made for HIS id, and the confirmation names him
    // the busy answer offers times of the SAME doctor, by his id, and none of them is the time that was just taken
    expect(doctorsIn(last())).toEqual(['#501']);
    expect(payloadsOf(last()).some((x) => x.startsWith(`slot|${clinicDate(at)}|`) && x.split('|')[2] === stamp(at).slice(11, 16))).toBe(false);
    const free = (await app.get(AvailabilityService).windows(c.clinicId, '501', { minutes: 30 })).find((w) => w.date > clinicDate(at) && w.endMin - w.startMin >= 60)!;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const start = Math.ceil(free.startMin / 30) * 30;
    await write(c, '', `slot|${free.date}|${hm(start)}|#501`);
    expect(last().text).toContain('Підтверджуєте запис на Консультація');
    await write(c, 'так');
    const visit = mock.writes.filter((w) => w.path === '/visits');
    expect(visit).toHaveLength(1);
    expect(visit[0].body).toMatchObject({ doctor_id: 501, date: free.date, time_start: hm(start), status: 'PLANNED' });
    expect(last().text).toContain('Лікар: Іваненко Олег');
    const done = await reqOf(c);
    expect(done).toMatchObject({ status: 'DONE', confirmedBy: 'AUTO', doctorId: '501', doctorReason: 'CLIENT_CHOICE', confirmedDoctor: 'Іваненко Олег', patientId: p.id });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.clinicId, action: 'booking_request.confirmed' } });
    expect(audit.details).toMatchObject({ by: 'auto', doctorId: '501', doctorReason: 'CLIENT_CHOICE' });
    // a repeated tap of the same time does not book again
    await write(c, '', `slot|${free.date}|${hm(start)}|#501`);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(1);
  });

  it('автозапис не підставляє довільний doctor_id: невідомий id у кнопці ігнорується, лікар без послуги чи розкладу відправляє заявку адміністратору; термінове звернення не бронюється само', async () => {
    const c = await clinic();
    await prisma.clinic.update({ where: { id: c.clinicId }, data: { bookingWriteEnabled: true, aiAutoBooking: true } });
    await setServices(c, '501', [c.consult.id]);
    await link(c);
    await prisma.bookingRequest.create({ data: { clinicId: c.clinicId, channel: 'INSTAGRAM', chatId: c.chat, kind: 'BOOKING', summary: 'x', service: 'Консультація' } });
    const day = clinicDate(new Date(Date.now() + 3 * 86_400_000));
    await write(c, '', `slot|${day}|11:00|#999999`); // not a doctor of this clinic
    expect((await reqOf(c)).doctorId).toBeNull();
    expect(JSON.stringify(mock.writes)).not.toContain('999999');

    // a doctor who does not provide the service
    const d = await clinic();
    await prisma.clinic.update({ where: { id: d.clinicId }, data: { bookingWriteEnabled: true, aiAutoBooking: true } });
    await setServices(d, '502', [d.caries.id]);
    await link(d);
    await prisma.bookingRequest.create({ data: { clinicId: d.clinicId, channel: 'INSTAGRAM', chatId: d.chat, kind: 'BOOKING', summary: 'x', service: 'Консультація', doctorId: '502', doctor: 'Петренко Ірина', doctorReason: 'CLIENT_CHOICE', doctorState: 'AGREED' } });
    const free = (await app.get(AvailabilityService).windows(d.clinicId, '502', { minutes: 30 })).find((w) => w.date > clinicDate(new Date()))!;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    await write(d, '', `slot|${free.date}|${hm(Math.ceil(free.startMin / 30) * 30)}|#502`);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(0);
    expect(last().text).toContain('Передали заявку');
    expect((await reqOf(d)).summary).toContain('не надає цю послугу');

    // an urgent request is never booked by the bot
    sent.length = 0;
    const e = await clinic();
    await prisma.clinic.update({ where: { id: e.clinicId }, data: { bookingWriteEnabled: true, aiAutoBooking: true } });
    await setServices(e, '502', [e.consult.id], true);
    await link(e);
    await write(e, 'У мене гострий біль');
    const offered = payloadsOf(last()).filter((x) => x.startsWith('slot|'));
    expect(offered.length).toBeGreaterThan(0);
    await write(e, '', offered[0]);
    expect(mock.writes.filter((w) => w.path === '/visits')).toHaveLength(0);
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Підтверджуєте запис');
    expect((await reqOf(e)).summary).toContain('термінове звернення');
  });
});
