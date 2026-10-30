import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { I18nExceptionFilter } from '../src/common/i18n';
import { normalizePhone } from '../src/common/phone';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

async function register(name = 'Клініка') {
  const email = `u${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `${name} ${rnd()}`, name: 'Анна Власниця', email, password: 'password123' }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { token: res.body.accessToken as string, email, clinicId, cookie: res.headers['set-cookie'] as unknown as string[] };
}

async function invite(ownerToken: string, role: string, email = `m${rnd()}@example.com`) {
  const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
  return { email, id: inv.body.id as string, token: (inv.body.link as string).split('/invite/')[1], link: inv.body.link as string };
}

async function addMember(ownerToken: string, role: string) {
  const { email, token } = await invite(ownerToken, role);
  const acc = await http().post(`/invites/${token}/accept`).send({ name: 'Співробітник', password: 'password123' }).expect(201);
  return { token: acc.body.accessToken as string, email };
}

async function mkPatient(clinicId: string, name: string, phone: string | null, extra: Partial<{ externalId: string }> = {}) {
  return prisma.patient.create({
    data: { clinicId, externalId: extra.externalId ?? `p-${rnd()}`, fullName: name, phone, phoneNorm: normalizePhone(phone) },
  });
}

describe('вход через cookie', () => {
  it('вход ставит httpOnly-cookie, и по ней работает защищённый запрос', async () => {
    const a = await register();
    const login = await http().post('/auth/login').send({ email: a.email, password: 'password123' }).expect(201);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('stomat_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await http().get('/auth/me').set('Cookie', cookie.split(';')[0]).expect(200);
    expect(me.body.email).toBe(a.email);
    await http().get('/auth/me').expect(401);
    await http().get('/auth/me').set('Cookie', 'stomat_session=forged-token').expect(401);
  });

  it('действие по cookie с чужого сайта отклоняется, с нашего и без Origin проходит', async () => {
    const a = await register();
    const cookie = a.cookie[0].split(';')[0];
    const body = { title: 'Позвонить пациенту' };
    await http().post('/tasks').set('Cookie', cookie).set('Origin', 'https://evil.example.com').send(body).expect(403);
    await http().post('/tasks').set('Cookie', cookie).set('Origin', 'http://localhost:3000').send(body).expect(201);
    await http().post('/tasks').set('Cookie', cookie).send(body).expect(201); // не браузер: Origin нет
    await http().get('/tasks').set('Cookie', cookie).set('Origin', 'https://evil.example.com').expect(200); // чтение не меняет данных
  });

  it('выход очищает cookie', async () => {
    const out = await http().post('/auth/logout').expect(200);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/stomat_session=;/);
  });
});

describe('приглашения сотрудников', () => {
  it('ссылка одноразовая, в базе только хэш токена, принятие входит в систему', async () => {
    const owner = await register();
    const inv = await invite(owner.token, 'ADMIN');
    expect(inv.link).toContain('/invite/');

    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(stored.tokenHash).not.toContain(inv.token);
    expect(JSON.stringify(stored)).not.toContain(inv.token);

    const info = await http().get(`/invites/${inv.token}`).expect(200);
    expect(info.body).toMatchObject({ role: 'ADMIN', email: inv.email, existingUser: false });

    const acc = await http().post(`/invites/${inv.token}/accept`).send({ name: 'Марія', password: 'password123' }).expect(201);
    expect((acc.headers['set-cookie'] as unknown as string[])[0]).toContain('stomat_session=');
    await http().get('/auth/me').set(auth(acc.body.accessToken)).expect(200);

    await http().get(`/invites/${inv.token}`).expect(404);
    await http().post(`/invites/${inv.token}/accept`).send({ name: 'Хтось', password: 'password123' }).expect(404);
  });

  it('просроченная, отозванная и чужая ссылки не работают', async () => {
    const owner = await register();
    const other = await register();

    const expired = await invite(owner.token, 'ADMIN');
    await prisma.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().get(`/invites/${expired.token}`).expect(404);

    const revoked = await invite(owner.token, 'DOCTOR');
    await http().delete(`/team/invitations/${revoked.id}`).set(auth(other.token)).expect(403 as number | 404).catch(() => undefined);
    await http().delete(`/team/invitations/${revoked.id}`).set(auth(other.token)).expect((r) => expect([403, 404]).toContain(r.status));
    await http().delete(`/team/invitations/${revoked.id}`).set(auth(owner.token)).expect(200);
    await http().post(`/invites/${revoked.token}/accept`).send({ name: 'Хтось', password: 'password123' }).expect(404);

    await http().get('/invites/неіснуючий-токен').expect(404);
  });

  it('новому нужно имя, зарегистрированному — верный пароль', async () => {
    const owner = await register();
    const newbie = await invite(owner.token, 'ADMIN');
    await http().post(`/invites/${newbie.token}/accept`).send({ password: 'password123' }).expect(400);
    await http().post(`/invites/${newbie.token}/accept`).send({ name: 'Н', password: 'password123' }).expect(400); // слишком короткое имя

    const existing = await register();
    const inv = await invite(owner.token, 'MANAGER', existing.email);
    expect((await http().get(`/invites/${inv.token}`).expect(200)).body.existingUser).toBe(true);
    await http().post(`/invites/${inv.token}/accept`).send({ password: 'неверный-пароль' }).expect(400);
    // неудачная попытка не сжигает ссылку
    await http().post(`/invites/${inv.token}/accept`).send({ password: 'password123' }).expect(201);
  });

  it('приглашать и смотреть список может только владелец; нельзя пригласить участника или владельца', async () => {
    const owner = await register();
    const admin = await addMember(owner.token, 'ADMIN');
    await http().post('/team/invitations').set(auth(admin.token)).send({ email: 'x@example.com', role: 'ADMIN' }).expect(403);
    await http().get('/team/invitations').set(auth(admin.token)).expect(403);
    await http().post('/team/invitations').set(auth(owner.token)).send({ email: 'x@example.com', role: 'OWNER' }).expect(400);
    await http().post('/team/invitations').set(auth(owner.token)).send({ email: admin.email, role: 'DOCTOR' }).expect(409);
  });

  it('в списке ожидающих только непринятые; повторное приглашение заменяет старое', async () => {
    const owner = await register();
    const email = `p${rnd()}@example.com`;
    const first = await invite(owner.token, 'ADMIN', email);
    const second = await invite(owner.token, 'DOCTOR', email);
    const list = (await http().get('/team/invitations').set(auth(owner.token)).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('DOCTOR');
    await http().get(`/invites/${first.token}`).expect(404);
    await http().post(`/invites/${second.token}/accept`).send({ name: 'Лікар', password: 'password123' }).expect(201);
    expect((await http().get('/team/invitations').set(auth(owner.token)).expect(200)).body).toHaveLength(0);
  });
});

describe('контакты с пациентом и согласие', () => {
  it('ручная запись контакта; врач и чужая клиника не могут', async () => {
    const owner = await register();
    const admin = await addMember(owner.token, 'ADMIN');
    const doctor = await addMember(owner.token, 'DOCTOR');
    const other = await register();
    const p = await mkPatient(owner.clinicId, 'Іваненко Олег', '0501112233');

    const log = await http().post(`/patients/${p.id}/contacts`).set(auth(admin.token)).send({ channel: 'PHONE', outcome: 'NO_ANSWER', note: 'Не взяв слухавку' }).expect(201);
    expect(log.body).toMatchObject({ channel: 'PHONE', outcome: 'NO_ANSWER', source: 'MANUAL' });
    await http().post(`/patients/${p.id}/contacts`).set(auth(doctor.token)).send({ channel: 'PHONE' }).expect(403);
    await http().post(`/patients/${p.id}/contacts`).set(auth(other.token)).send({ channel: 'PHONE' }).expect(404);
    await http().post(`/patients/${p.id}/contacts`).set(auth(admin.token)).send({ channel: 'ГОЛУБ' }).expect(400);

    const card = (await http().get(`/patients/${p.id}`).set(auth(doctor.token)).expect(200)).body;
    expect(card.contacts).toHaveLength(1);
    expect(card.contacts[0].user.name).toBe('Співробітник');
  });

  it('результат задачи попадает в историю контактов, возврат задачи в работу — нет', async () => {
    const owner = await register();
    const p = await mkPatient(owner.clinicId, 'Петренко Ірина', '0671234567');
    const task = (await http().post('/tasks').set(auth(owner.token)).send({ title: 'Запросити на огляд', patientId: p.id }).expect(201)).body;

    await http().patch(`/tasks/${task.id}`).set(auth(owner.token)).send({ result: 'NO_ANSWER' }).expect(200);
    await http().patch(`/tasks/${task.id}`).set(auth(owner.token)).send({ status: 'DONE', result: 'BOOKED' }).expect(200);
    await http().patch(`/tasks/${task.id}`).set(auth(owner.token)).send({ status: 'OPEN' }).expect(200);

    const contacts = (await http().get(`/patients/${p.id}`).set(auth(owner.token)).expect(200)).body.contacts;
    expect(contacts.map((c: { outcome: string }) => c.outcome).sort()).toEqual(['BOOKED', 'NO_ANSWER']);
    expect(contacts.every((c: { source: string; taskId: string }) => c.source === 'TASK' && c.taskId === task.id)).toBe(true);
  });

  it('согласие и пауза автоматизаций сохраняются и не затираются синхронизацией', async () => {
    const owner = await register();
    await http().post('/integrations/cliniccards/sync').set(auth(owner.token)).expect(201);
    const patient = await prisma.patient.findFirstOrThrow({ where: { clinicId: owner.clinicId } });
    expect(patient.consent).toBe('UNKNOWN');

    const r = await http().patch(`/patients/${patient.id}/consent`).set(auth(owner.token)).send({ consent: 'WITHDRAWN', note: 'Попросила не писати', automationPaused: true }).expect(200);
    expect(r.body).toMatchObject({ consent: 'WITHDRAWN', automationPaused: true, consentNote: 'Попросила не писати' });
    expect(r.body.consentUpdatedAt).toBeTruthy();

    await prisma.patient.update({ where: { id: patient.id }, data: { extra: { Алергія: { v: 'пеніцилін', b: 'x' } } } });
    await http().post('/integrations/cliniccards/sync').set(auth(owner.token)).expect(201);
    const after = await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } });
    expect(after).toMatchObject({ consent: 'WITHDRAWN', automationPaused: true, consentNote: 'Попросила не писати' });
    expect((after.extra as Record<string, { v: string }>)['Алергія'].v).toBe('пеніцилін');

    await http().patch(`/patients/${patient.id}/consent`).set(auth(owner.token)).send({ consent: 'НЕИЗВЕСТНО' }).expect(400);
  });
});

describe('импорт Excel и CSV', () => {
  const csvFile = (text: string, filename = 'таблиця.csv') => ({ buffer: Buffer.from('﻿' + text, 'utf8'), filename, contentType: 'text/csv' });
  const upload = (token: string, f: { buffer: Buffer; filename: string; contentType: string }) =>
    http().post('/imports').set(auth(token)).attach('file', f.buffer, { filename: f.filename, contentType: f.contentType });
  const extraMapping = (over = {}) => ({
    type: 'PATIENT_EXTRA', matchBy: 'PHONE', matchColumn: 'Телефон', fields: [{ column: 'Джерело', label: 'Звідки дізналась' }, { column: 'Коментар' }], overwrite: false, ...over,
  });

  async function setup() {
    const owner = await register();
    const patients = {
      a: await mkPatient(owner.clinicId, 'Іваненко Олег', '+38 (050) 111-22-33'),
      b: await mkPatient(owner.clinicId, 'Петренко Ірина', '0672223344'),
      c1: await mkPatient(owner.clinicId, 'Коваль Марія', '0633334455'),
      c2: await mkPatient(owner.clinicId, 'Коваль Марія Друга', '380633334455'), // тот же телефон: неоднозначно
    };
    return { owner, patients };
  }

  it('загрузка: столбцы, подсказки, образец строк, русское имя файла', async () => {
    const { owner } = await setup();
    const res = await upload(owner.token, csvFile('ПІБ;Телефон;Джерело\n"Іваненко Олег";0501112233;Instagram\n')).expect(201);
    expect(res.body.columns).toEqual(['ПІБ', 'Телефон', 'Джерело']);
    expect(res.body.totalRows).toBe(1);
    expect(res.body.suggestions).toMatchObject({ phone: 'Телефон', name: 'ПІБ' });
    const history = (await http().get('/imports').set(auth(owner.token)).expect(200)).body;
    expect(history[0].filename).toBe('таблиця.csv');
    expect(history[0].status).toBe('DRAFT');
  });

  it('предпросмотр считает совпадения и ничего не пишет; запись даёт ровно ту же сводку', async () => {
    const { owner, patients } = await setup();
    const csv = [
      'Телефон;Джерело;Коментар',
      '0501112233;Instagram;Алергія на лідокаїн', // Іваненко: найден по телефону в другой записи
      '+380672223344;Google;', // Петренко
      '0633334455;Рекомендація;Неоднозначно', // два пациента с одним телефоном
      '0990000000;Facebook;Такого пациента нет',
      ';Instagram;Нет телефона',
      '0501112233;Google;Повтор того же телефона', // дубль ключа в файле
    ].join('\n');
    const batch = (await upload(owner.token, csvFile(csv)).expect(201)).body;

    const dry = (await http().post(`/imports/${batch.id}/dry-run`).set(auth(owner.token)).send(extraMapping()).expect(200)).body;
    expect(dry).toMatchObject({ total: 6, matched: 3, unmatched: 1, ambiguous: 1, emptyKey: 1, duplicateKeys: 1, patientsToUpdate: 2 });
    expect(dry.samples.unmatched[0]).toMatchObject({ row: 5, key: '0990000000' });
    expect(dry.samples.ambiguous[0].row).toBe(4);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patients.a.id } })).extra).toEqual({}); // предпросмотр не пишет

    const applied = (await http().post(`/imports/${batch.id}/apply`).set(auth(owner.token)).send(extraMapping()).expect(200)).body;
    expect(applied).toEqual(dry);

    const a = (await prisma.patient.findUniqueOrThrow({ where: { id: patients.a.id } })).extra as Record<string, { v: string; b: string }>;
    // у Іваненка две строки с одним телефоном: побеждает последняя (повтор виден в сводке как duplicateKeys)
    expect(a['Звідки дізналась']).toEqual({ v: 'Google', b: batch.id });
    expect(a['Коментар'].v).toBe('Повтор того же телефона');
    const b = (await prisma.patient.findUniqueOrThrow({ where: { id: patients.b.id } })).extra as Record<string, { v: string }>;
    expect(b['Звідки дізналась'].v).toBe('Google');
    expect(b['Коментар']).toBeUndefined(); // пустое значение не создаёт поле
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patients.c1.id } })).extra).toEqual({}); // неоднозначные не тронуты

    // повторно применить нельзя
    await http().post(`/imports/${batch.id}/apply`).set(auth(owner.token)).send(extraMapping()).expect(409);
    await http().post(`/imports/${batch.id}/dry-run`).set(auth(owner.token)).send(extraMapping()).expect(409);

    const history = (await http().get('/imports').set(auth(owner.token)).expect(200)).body[0];
    expect(history).toMatchObject({ status: 'DONE', type: 'PATIENT_EXTRA', total: 6, matched: 3, unmatched: 3 });

    const csvOut = await http().get(`/imports/${batch.id}/unmatched.csv`).set(auth(owner.token)).expect(200);
    expect(csvOut.text).toContain('0990000000');
    expect(csvOut.text).toContain('Неоднозначно');
    expect(csvOut.text).not.toContain('Алергія на лідокаїн');

    // отмена применённого импорта: поля возвращаются, повторно отменить нельзя, чужая клиника не может
    const stranger = await register();
    await http().post(`/imports/${batch.id}/undo`).set(auth(stranger.token)).expect(404);
    const undone = (await http().post(`/imports/${batch.id}/undo`).set(auth(owner.token)).expect(200)).body;
    expect(undone.reverted).toBe(2);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patients.a.id } })).extra).toEqual({});
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patients.b.id } })).extra).toEqual({});
    await http().post(`/imports/${batch.id}/undo`).set(auth(owner.token)).expect(409);
    expect((await http().get('/imports').set(auth(owner.token))).body[0].undoneAt).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { clinicId: owner.clinicId, action: 'import.undone' } })).toBe(1);
  });

  it('уже заполненные значения не перезаписываются, пока не включена перезапись; пустое ничего не стирает', async () => {
    const { owner, patients } = await setup();
    const first = (await upload(owner.token, csvFile('Телефон;Джерело;Коментар\n0501112233;Instagram;Перший коментар\n')).expect(201)).body;
    await http().post(`/imports/${first.id}/apply`).set(auth(owner.token)).send(extraMapping()).expect(200);

    const second = (await upload(owner.token, csvFile('Телефон;Джерело;Коментар\n0501112233;Google;\n')).expect(201)).body;
    const dry = (await http().post(`/imports/${second.id}/dry-run`).set(auth(owner.token)).send(extraMapping()).expect(200)).body;
    expect(dry).toMatchObject({ fieldsSkippedFilled: 1, fieldsToSet: 0, patientsToUpdate: 0 });

    const forced = (await http().post(`/imports/${second.id}/apply`).set(auth(owner.token)).send(extraMapping({ overwrite: true })).expect(200)).body;
    expect(forced).toMatchObject({ fieldsToSet: 1, patientsToUpdate: 1 });
    const extra = (await prisma.patient.findUniqueOrThrow({ where: { id: patients.a.id } })).extra as Record<string, { v: string; b: string }>;
    expect(extra['Звідки дізналась']).toEqual({ v: 'Google', b: second.id });
    expect(extra['Коментар'].v).toBe('Перший коментар'); // пустая ячейка не стёрла комментарий
    expect(extra['Коментар'].b).toBe(first.id); // происхождение поля сохранилось
  });

  it('сопоставление по имени (в любом порядке слов) и по коду из Cliniccards', async () => {
    const { owner, patients } = await setup();
    const byName = (await upload(owner.token, csvFile('Пацієнт;Джерело\nОлег Іваненко;Instagram\nіваненко олег.;Google\n')).expect(201)).body;
    const dry = (await http().post(`/imports/${byName.id}/dry-run`).set(auth(owner.token)).send(extraMapping({ matchBy: 'NAME', matchColumn: 'Пацієнт', fields: [{ column: 'Джерело' }] })).expect(200)).body;
    expect(dry).toMatchObject({ matched: 2, duplicateKeys: 1, patientsToUpdate: 1 });

    const ext = await mkPatient(owner.clinicId, 'Без телефону', null, { externalId: 'CC-7777' });
    const byId = (await upload(owner.token, csvFile('Код;Група\ncc-7777;VIP\n')).expect(201)).body;
    await http().post(`/imports/${byId.id}/apply`).set(auth(owner.token)).send(extraMapping({ matchBy: 'EXTERNAL_ID', matchColumn: 'Код', fields: [{ column: 'Група' }] })).expect(200);
    expect(((await prisma.patient.findUniqueOrThrow({ where: { id: ext.id } })).extra as Record<string, { v: string }>)['Група'].v).toBe('VIP');
    expect(patients.a.id).toBeTruthy();
  });

  it('история контактов из XLSX: даты, результаты, заметки; повторная загрузка не плодит дубли', async () => {
    const { owner, patients } = await setup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Дзвінки');
    ws.addRow(['Телефон', 'Дата дзвінка', 'Результат', 'Коментар']);
    ws.addRow([380501112233, new Date(Date.UTC(2026, 8, 10)), 'Записався', 'На чистку']);
    ws.addRow(['0672223344', '15.09.2026', 'не відповів', '']);
    ws.addRow(['0672223344', '20.09.2026', 'Обговорили ціни', 'Подумає']); // результат не распознан: уйдёт в заметку
    ws.addRow(['0501112233', 'вчора', 'Відмовився', '']); // плохая дата
    ws.addRow(['0501112233', '01.01.2099', 'Записався', '']); // дата в будущем
    const file = { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: 'дзвінки.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const mapping = { type: 'CONTACTS', matchBy: 'PHONE', matchColumn: 'Телефон', dateColumn: 'Дата дзвінка', outcomeColumn: 'Результат', noteColumn: 'Коментар', channel: 'PHONE' };

    const batch = (await upload(owner.token, file).expect(201)).body;
    expect(batch.columns).toEqual(['Телефон', 'Дата дзвінка', 'Результат', 'Коментар']);
    const dry = (await http().post(`/imports/${batch.id}/dry-run`).set(auth(owner.token)).send(mapping).expect(200)).body;
    expect(dry).toMatchObject({ matched: 5, contactsToCreate: 3, badDates: 2 });
    expect(await prisma.contactLog.count({ where: { clinicId: owner.clinicId } })).toBe(0);

    await http().post(`/imports/${batch.id}/apply`).set(auth(owner.token)).send(mapping).expect(200);
    const logs = await prisma.contactLog.findMany({ where: { clinicId: owner.clinicId }, orderBy: { contactedAt: 'asc' } });
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.source === 'IMPORT' && l.channel === 'PHONE' && l.importBatchId === batch.id)).toBe(true);
    const byPatient = (id: string) => logs.filter((l) => l.patientId === id);
    expect(byPatient(patients.a.id)[0]).toMatchObject({ outcome: 'BOOKED', note: 'На чистку' });
    expect(byPatient(patients.b.id).map((l) => l.outcome)).toEqual([null, 'NO_ANSWER'].reverse()); // 15.09 — NO_ANSWER, 20.09 — не распознан
    expect(byPatient(patients.b.id).find((l) => l.outcome === null)?.note).toBe('Обговорили ціни · Подумає');

    // та же таблица второй раз: дублей нет
    const again = (await upload(owner.token, file).expect(201)).body;
    const dry2 = (await http().post(`/imports/${again.id}/dry-run`).set(auth(owner.token)).send(mapping).expect(200)).body;
    expect(dry2).toMatchObject({ contactsToCreate: 0, contactsDuplicate: 3 });
    await http().post(`/imports/${again.id}/apply`).set(auth(owner.token)).send(mapping).expect(200);
    expect(await prisma.contactLog.count({ where: { clinicId: owner.clinicId } })).toBe(3);

    // записи видны в карточке пациента
    const card = (await http().get(`/patients/${patients.b.id}`).set(auth(owner.token)).expect(200)).body;
    expect(card.contacts).toHaveLength(2);
  });

  it('чужая клиника не видит загрузку и не может изменить пациентов с тем же телефоном', async () => {
    const a = await setup();
    const b = await register();
    const bPatient = await mkPatient(b.clinicId, 'Той самий номер', '0501112233');
    const batch = (await upload(a.owner.token, csvFile('Телефон;Джерело\n0501112233;Instagram\n')).expect(201)).body;

    await http().get(`/imports/${batch.id}`).set(auth(b.token)).expect(404);
    await http().post(`/imports/${batch.id}/dry-run`).set(auth(b.token)).send(extraMapping({ fields: [{ column: 'Джерело' }] })).expect(404);
    await http().post(`/imports/${batch.id}/apply`).set(auth(b.token)).send(extraMapping({ fields: [{ column: 'Джерело' }] })).expect(404);
    await http().delete(`/imports/${batch.id}`).set(auth(b.token)).expect(404);
    expect((await http().get('/imports').set(auth(b.token)).expect(200)).body).toHaveLength(0);

    await http().post(`/imports/${batch.id}/apply`).set(auth(a.owner.token)).send(extraMapping({ fields: [{ column: 'Джерело' }] })).expect(200);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: bPatient.id } })).extra).toEqual({}); // пациент другой клиники не тронут
  });

  it('права: врач не может загружать; администратор может', async () => {
    const owner = await register();
    const doctor = await addMember(owner.token, 'DOCTOR');
    const admin = await addMember(owner.token, 'ADMIN');
    await upload(doctor.token, csvFile('a;b\n1;2\n')).expect(403);
    await http().get('/imports').set(auth(doctor.token)).expect(403);
    await upload(admin.token, csvFile('a;b\n1;2\n')).expect(201);
  });

  it('ошибки: не файл, повреждённый файл, слишком большой, неверные настройки', async () => {
    const owner = await register();
    await http().post('/imports').set(auth(owner.token)).expect(400); // без файла
    await upload(owner.token, { buffer: Buffer.from('PK\u0003\u0004не-архив'), filename: 'x.xlsx', contentType: 'application/octet-stream' }).expect(400);
    await upload(owner.token, { buffer: Buffer.alloc(0), filename: 'x.csv', contentType: 'text/csv' }).expect(400);
    const big = await upload(owner.token, { buffer: Buffer.alloc(5 * 1024 * 1024 + 10, 'a'), filename: 'big.csv', contentType: 'text/csv' }).expect(413);
    expect(big.body.message).toBe('Файл завеликий: не більше 5 МБ і 20 000 рядків');

    const batch = (await upload(owner.token, csvFile('Телефон;Джерело\n0501112233;Instagram\n')).expect(201)).body;
    const bad = (m: object) => http().post(`/imports/${batch.id}/dry-run`).set(auth(owner.token)).send(m).expect(400);
    await bad({});
    await bad(extraMapping({ matchColumn: 'Немає такого' }));
    await bad(extraMapping({ fields: [] }));
    await bad({ type: 'CONTACTS', matchBy: 'PHONE', matchColumn: 'Телефон' }); // нет столбца с датой
    const en = await http().post(`/imports/${batch.id}/dry-run`).set(auth(owner.token)).set('Accept-Language', 'en').send({}).expect(400);
    expect(en.body.message).toBe('Invalid column mapping');
  });

  it('черновик можно отбросить, применённую загрузку — нет', async () => {
    const owner = await register();
    const draft = (await upload(owner.token, csvFile('Телефон;Джерело\n1;2\n')).expect(201)).body;
    await http().delete(`/imports/${draft.id}`).set(auth(owner.token)).expect(200);
    await http().get(`/imports/${draft.id}`).set(auth(owner.token)).expect(404);

    const done = (await upload(owner.token, csvFile('Телефон;Джерело\n0501112233;Instagram\n')).expect(201)).body;
    await http().post(`/imports/${done.id}/apply`).set(auth(owner.token)).send(extraMapping({ fields: [{ column: 'Джерело' }] })).expect(200);
    await http().delete(`/imports/${done.id}`).set(auth(owner.token)).expect(404);
  });
});

describe('история действий, экспорт и удаление данных', () => {
  it('история видна владельцу и управляющему, содержит действия и изолирована по клиникам', async () => {
    const owner = await register();
    const other = await register();
    const manager = await addMember(owner.token, 'MANAGER');
    const admin = await addMember(owner.token, 'ADMIN');
    await http().post('/tasks').set(auth(owner.token)).send({ title: 'Подзвонити' }).expect(201);

    const log = (await http().get('/clinic/audit').set(auth(manager.token)).expect(200)).body;
    const actions = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['clinic.created', 'team.invited', 'team.joined', 'task.created']));
    expect(log).toMatchObject({ page: 1, pageSize: 50 });
    expect(log.rows.find((r: { action: string }) => r.action === 'task.created').user).toBe('Анна Власниця');
    await http().get('/clinic/audit').set(auth(admin.token)).expect(403);

    const theirs = (await http().get('/clinic/audit').set(auth(other.token)).expect(200)).body;
    expect(theirs.rows.map((r: { action: string }) => r.action)).not.toContain('task.created');
  });

  it('экспорт содержит данные клиники, но не пароли и не ключ API; доступен только владельцу', async () => {
    const owner = await register();
    const admin = await addMember(owner.token, 'ADMIN');
    await http().post('/integrations/cliniccards/sync').set(auth(owner.token)).expect(201);
    await mkPatient(owner.clinicId, 'Експорт Тестович', '0501112233');
    const other = await register();
    await mkPatient(other.clinicId, 'Чужий Пацієнт', '0509998877');

    await http().get('/clinic/export').set(auth(admin.token)).expect(403);
    const res = await http().get('/clinic/export').set(auth(owner.token)).expect(200);
    expect(res.headers['content-disposition']).toContain('clinic-export.json');
    const data = JSON.parse(res.text);
    expect(data.patients.length).toBeGreaterThan(40);
    expect(data.patients.some((p: { fullName: string }) => p.fullName === 'Експорт Тестович')).toBe(true);
    expect(data.team).toHaveLength(2);
    expect(res.text).not.toContain('passwordHash');
    expect(res.text).not.toContain('apiKeyEnc');
    expect(res.text).not.toContain('Чужий Пацієнт'); // чужие данные в выгрузку не попадают
    expect((await http().get('/clinic/audit').set(auth(owner.token))).body.rows.map((r: { action: string }) => r.action)).toContain('clinic.exported');
  });

  it('удаление клиники: нужны название и пароль; удаляются данные и сотрудники без других клиник', async () => {
    const owner = await register('Видаляється');
    const other = await register('Залишається');
    const staff = await addMember(owner.token, 'ADMIN');
    await mkPatient(owner.clinicId, 'Буде видалений', '0501112233');
    await mkPatient(other.clinicId, 'Залишиться', '0502223344');
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: owner.clinicId } });

    // сотрудник, у которого есть и другая клиника, не удаляется
    const shared = await register('Спільний');
    const inv = await invite(owner.token, 'MANAGER', shared.email);
    await http().post(`/invites/${inv.token}/accept`).send({ password: 'password123' }).expect(201);

    await http().delete('/clinic').set(auth(staff.token)).send({ confirmName: clinic.name, password: 'password123' }).expect(403);
    await http().delete('/clinic').set(auth(owner.token)).send({ confirmName: 'Не та назва', password: 'password123' }).expect(400);
    await http().delete('/clinic').set(auth(owner.token)).send({ confirmName: clinic.name, password: 'неверный' }).expect(400);
    expect(await prisma.clinic.count({ where: { id: owner.clinicId } })).toBe(1);

    const done = await http().delete('/clinic').set(auth(owner.token)).send({ confirmName: clinic.name, password: 'password123' }).expect(200);
    expect((done.headers['set-cookie'] as unknown as string[])[0]).toMatch(/stomat_session=;/);

    expect(await prisma.clinic.count({ where: { id: owner.clinicId } })).toBe(0);
    expect(await prisma.patient.count({ where: { clinicId: owner.clinicId } })).toBe(0);
    expect(await prisma.user.count({ where: { email: owner.email } })).toBe(0);
    expect(await prisma.user.count({ where: { email: staff.email } })).toBe(0);
    expect(await prisma.user.count({ where: { email: shared.email } })).toBe(1); // у него есть своя клиника
    expect(await prisma.patient.count({ where: { clinicId: other.clinicId } })).toBe(1); // чужая клиника цела
  });
});
