import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());

async function register(name = 'Клиника') {
  const email = `u${rnd()}@example.com`;
  const res = await http()
    .post('/auth/register')
    .send({ acceptTerms: true, clinicName: `${name} ${rnd()}`, name: 'Анна', email, password: 'password123' })
    .expect(201);
  return { token: res.body.accessToken as string, email };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function clinicOf(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  return u.memberships[0].clinicId;
}

describe('доступ', () => {
  it('без токена закрыто', async () => {
    await http().get('/reports').expect(401);
    await http().get('/patients').expect(401);
    await http().get('/tasks').expect(401);
    await http().get('/team').expect(401);
  });

  it('с неверным токеном закрыто', async () => {
    await http().get('/reports').set(auth('garbage')).expect(401);
  });

  it('ограничивает перебор пароля', async () => {
    const { email } = await register();
    for (let i = 0; i < 10; i++) {
      await http().post('/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    }
    await http().post('/auth/login').send({ email, password: 'password123' }).expect(429);
  });
});

describe('изоляция клиник', () => {
  it('одна клиника не видит и не меняет данные другой', async () => {
    const a = await register('A');
    const b = await register('B');
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(201);

    const reportA = await http().get('/reports/no-next-visit').set(auth(a.token)).expect(200);
    const reportB = await http().get('/reports/no-next-visit').set(auth(b.token)).expect(200);
    expect(reportA.body.rows.length).toBeGreaterThan(0);
    expect(reportB.body.rows).toHaveLength(0);

    const patientsB = await http().get('/patients').set(auth(b.token)).expect(200);
    expect(patientsB.body.total).toBe(0);

    const patientsA = await http().get('/patients').set(auth(a.token)).expect(200);
    const patientId = patientsA.body.rows[0].id;
    await http().get(`/patients/${patientId}`).set(auth(b.token)).expect(404);

    await http().post('/tasks/from-report').set(auth(a.token)).send({ reportId: 'no-next-visit' }).expect(201);
    const tasksA = await http().get('/tasks').set(auth(a.token)).expect(200);
    const tasksB = await http().get('/tasks').set(auth(b.token)).expect(200);
    expect(tasksA.body.length).toBeGreaterThan(0);
    expect(tasksB.body).toHaveLength(0);

    await http().patch(`/tasks/${tasksA.body[0].id}`).set(auth(b.token)).send({ status: 'DONE' }).expect(404);
    // чужого пациента нельзя привязать к своей задаче
    await http().post('/tasks').set(auth(b.token)).send({ title: 'Тест', patientId }).expect(400);
  });
});

describe('задачи', () => {
  it('из отчёта не создаются дубли, закрытая задача снова пропускается только после закрытия', async () => {
    const a = await register();
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(201);

    const first = await http().post('/tasks/from-report').set(auth(a.token)).send({ reportId: 'no-next-visit' }).expect(201);
    expect(first.body.created).toBeGreaterThan(0);
    const second = await http().post('/tasks/from-report').set(auth(a.token)).send({ reportId: 'no-next-visit' }).expect(201);
    expect(second.body.created).toBe(0);
    expect(second.body.skippedExisting).toBe(first.body.created);

    const open = await http().get('/tasks?status=OPEN').set(auth(a.token)).expect(200);
    const done = await http().patch(`/tasks/${open.body[0].id}`).set(auth(a.token)).send({ status: 'DONE', result: 'BOOKED' }).expect(200);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedAt).toBeTruthy();

    const third = await http().post('/tasks/from-report').set(auth(a.token)).send({ reportId: 'no-next-visit' }).expect(201);
    expect(third.body.created).toBe(1); // пациент с закрытой задачей снова в отчёте
  });

  it('из отчёта без списка задач создать нельзя', async () => {
    const a = await register();
    await http().post('/tasks/from-report').set(auth(a.token)).send({ reportId: 'sources' }).expect(400);
  });
});

describe('сотрудники и роли', () => {
  // Сотрудник добавляется приглашением: владелец создаёт ссылку, сотрудник по ней задаёт имя и пароль
  async function addMember(ownerToken: string, role: string) {
    const email = `m${rnd()}@example.com`;
    const inv = await http().post('/team/invitations').set(auth(ownerToken)).send({ email, role }).expect(201);
    const token = (inv.body.link as string).split('/invite/')[1];
    const acc = await http().post(`/invites/${token}/accept`).send({ name: 'Сотрудник', password: 'password123' }).expect(201);
    return { token: acc.body.accessToken as string, email };
  }

  it('врач не может создавать задачи, администратор может', async () => {
    const owner = await register();
    const doctor = await addMember(owner.token, 'DOCTOR');
    const admin = await addMember(owner.token, 'ADMIN');
    await http().post('/tasks').set(auth(doctor.token)).send({ title: 'Позвонить' }).expect(403);
    await http().post('/tasks').set(auth(admin.token)).send({ title: 'Позвонить' }).expect(201);
    await http().get('/tasks').set(auth(doctor.token)).expect(200); // смотреть может
  });

  it('добавлять сотрудников может только владелец, роль владельца выдать нельзя', async () => {
    const owner = await register();
    const admin = await addMember(owner.token, 'ADMIN');
    const body = { email: `x${rnd()}@example.com`, role: 'ADMIN' };
    await http().post('/team/invitations').set(auth(admin.token)).send(body).expect(403);
    await http().post('/team/invitations').set(auth(owner.token)).send({ ...body, role: 'OWNER' }).expect(400);
  });

  it('ключ Cliniccards может задать только владелец', async () => {
    const owner = await register();
    const admin = await addMember(owner.token, 'ADMIN');
    await http().put('/integrations/cliniccards/key').set(auth(admin.token)).send({ apiKey: 'some-long-key' }).expect(403);
  });

  it('исполнитель задачи должен быть из этой клиники', async () => {
    const a = await register();
    const b = await register();
    const userB = await prisma.user.findUniqueOrThrow({ where: { email: b.email } });
    await http().post('/tasks').set(auth(a.token)).send({ title: 'Задача', assigneeId: userB.id }).expect(400);
  });

  it('пользователь в двух клиниках выбирает клинику при входе', async () => {
    const owner1 = await register('Первая');
    const owner2 = await register('Вторая');
    // уже зарегистрированный пользователь принимает приглашение своим паролем
    const inv = await http().post('/team/invitations').set(auth(owner2.token)).send({ email: owner1.email, role: 'MANAGER' }).expect(201);
    const inviteToken = (inv.body.link as string).split('/invite/')[1];
    await http().post(`/invites/${inviteToken}/accept`).send({ password: 'password123' }).expect(201);

    const noChoice = await http().post('/auth/login').send({ email: owner1.email, password: 'password123' }).expect(201);
    expect(noChoice.body.accessToken).toBeUndefined();
    expect(noChoice.body.clinics).toHaveLength(2);

    const clinic2 = await clinicOf(owner2.email);
    const chosen = await http().post('/auth/login').send({ email: owner1.email, password: 'password123', clinicId: clinic2 }).expect(201);
    expect(chosen.body.accessToken).toBeTruthy();

    const foreign = await register('Чужая');
    const foreignClinic = await clinicOf(foreign.email);
    await http().post('/auth/login').send({ email: owner1.email, password: 'password123', clinicId: foreignClinic }).expect(401);
  });
});

describe('логика отчётов', () => {
  it('отмена будущей записи не считается следующей записью, действующая считается', async () => {
    const a = await register();
    const clinicId = await clinicOf(a.email);
    const day = 86_400_000;
    const mk = (externalId: string, name: string) =>
      prisma.patient.create({ data: { clinicId, externalId, fullName: name } });
    const visit = (patientId: string, externalId: string, status: string, offsetDays: number) =>
      prisma.visit.create({ data: { clinicId, patientId, externalId, status, startsAt: new Date(Date.now() + offsetDays * day) } });

    const cancelledFuture = await mk('p1', 'Отменил будущую');
    await visit(cancelledFuture.id, 'v1', 'VISITED', -10);
    await visit(cancelledFuture.id, 'v2', 'CANCELLED', 5);

    const hasFuture = await mk('p2', 'Есть запись');
    await visit(hasFuture.id, 'v3', 'VISITED', -10);
    await visit(hasFuture.id, 'v4', 'CONFIRMED', 5);

    const neverCame = await mk('p3', 'Не приходил');
    await visit(neverCame.id, 'v5', 'DID_NOT_COME', -10);

    const report = await http().get('/reports/no-next-visit?days=90').set(auth(a.token)).expect(200);
    const names = report.body.rows.map((r: { fullName: string }) => r.fullName);
    expect(names).toContain('Отменил будущую');
    expect(names).not.toContain('Есть запись');
    expect(names).not.toContain('Не приходил'); // посещения не было

    const missed = await http().get('/reports/missed-visits?days=30').set(auth(a.token)).expect(200);
    expect(missed.body.rows.map((r: { fullName: string }) => r.fullName)).toContain('Не приходил');
  });

  it('CSV открывается в Excel: BOM, точка с запятой, заголовки', async () => {
    const a = await register();
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(201);
    const res = await http().get('/reports/no-next-visit/csv').set(auth(a.token)).expect(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text.split('\r\n')[0]).toContain('"Пацієнт";"Телефон"'); // язык по умолчанию — украинский

    const ru = await http().get('/reports/no-next-visit/csv').set(auth(a.token)).set('Accept-Language', 'ru').expect(200);
    expect(ru.text.split('\r\n')[0]).toContain('"Пациент";"Телефон"');
    const en = await http().get('/reports/no-next-visit/csv').set(auth(a.token)).set('Accept-Language', 'en').expect(200);
    expect(en.text.split('\r\n')[0]).toContain('"Patient";"Phone"');
  });

  it('Excel и PDF: настоящие файлы с кириллицей, подписями на языке запроса; финансовые отчёты по ролям; выгрузка пишется в историю', async () => {
    const a = await register();
    await http().post('/integrations/cliniccards/sync').set(auth(a.token)).expect(201);
    const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const xl = await http().get('/reports/no-next-visit/xlsx').set(auth(a.token)).buffer(true).parse(binary).expect(200);
    expect(xl.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.body);
    const ws = wb.worksheets[0];
    expect(String(ws.getRow(1).getCell(1).value)).toContain('Немає наступного візиту'.slice(0, 5));
    expect(ws.getRow(5).getCell(1).value).toBe('Пацієнт'); // шапка таблицы
    expect(ws.rowCount).toBeGreaterThan(5);
    const en = await http().get('/reports/no-next-visit/xlsx').set(auth(a.token)).set('Accept-Language', 'en').buffer(true).parse(binary).expect(200);
    const wbEn = new ExcelJS.Workbook();
    await wbEn.xlsx.load(en.body);
    expect(wbEn.worksheets[0].getRow(5).getCell(1).value).toBe('Patient');

    const pdf = await http().get('/reports/no-next-visit/pdf').set(auth(a.token)).buffer(true).parse(binary).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(3000);

    const logs = await prisma.auditLog.findMany({ where: { action: 'report.exported' } });
    expect(logs.some((l) => (l.details as { format?: string }).format === 'xlsx')).toBe(true);
    expect(logs.some((l) => (l.details as { format?: string }).format === 'pdf')).toBe(true);
  });

  it('названия и правила отчётов приходят на языке запроса', async () => {
    const a = await register();
    const title = async (lang?: string) => {
      const req = http().get('/reports/missed-visits').set(auth(a.token));
      if (lang) req.set('Accept-Language', lang);
      return (await req.expect(200)).body.title as string;
    };
    expect(await title()).toBe('Неявки, скасування та перенесення');
    expect(await title('ru')).toBe('Неявки, отмены и переносы');
    expect(await title('en')).toBe('No-shows, cancellations and reschedules');
    expect(await title('de')).toBe('Неявки, скасування та перенесення'); // неизвестный язык → украинский
  });

  it('ошибки приходят на языке запроса', async () => {
    const a = await register();
    const msg = async (lang: string) =>
      (await http().get('/reports/nope').set(auth(a.token)).set('Accept-Language', lang).expect(404)).body.message as string;
    expect(await msg('uk')).toBe('Звіт не знайдено');
    expect(await msg('ru')).toBe('Отчёт не найден');
    expect(await msg('en')).toBe('Report not found');
  });

  it('неизвестный отчёт — 404', async () => {
    const a = await register();
    await http().get('/reports/nope').set(auth(a.token)).expect(404);
  });
});

describe('ключ Cliniccards', () => {
  it('неверный ключ отклоняется и не сохраняется', async () => {
    const a = await register();
    const clinicId = await clinicOf(a.email);
    await http().put('/integrations/cliniccards/key').set(auth(a.token)).send({ apiKey: 'definitely-wrong-key' }).expect(400);
    const i = await prisma.integration.findFirst({ where: { clinicId } });
    expect(i?.apiKeyEnc ?? null).toBeNull();
  });
});
