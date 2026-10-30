import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { encrypt } from '../src/common/crypto';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const SECRET = 'facebook-app-secret-for-tests';
const IG_SECRET = 'instagram-app-secret-for-tests';
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_INSTAGRAM_APP_SECRET = IG_SECRET;
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  delete process.env.META_INSTAGRAM_APP_SECRET;
  await app.close();
});

const signed = (userId: string, secret = SECRET, extra: Record<string, unknown> = {}) => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId, ...extra })).toString('base64url');
  return `${createHmac('sha256', secret).update(payload).digest('base64url')}.${payload}`;
};
// Meta posts the body as a form
const form = (path: string, signedRequest: string) => http().post(path).type('form').send({ signed_request: signedRequest });

async function connected(ownId: string) {
  const email = `m${rnd()}@example.com`;
  await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: 'correct-horse-battery' }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  await prisma.integration.create({ data: { clinicId, provider: 'INSTAGRAM', apiKeyEnc: encrypt('token'), config: { ownId, name: 'clinic' } } });
  return clinicId;
}

describe('вимоги Meta: відключення доступу і видалення даних', () => {
  it('підроблений або чужий підпис відхиляється й нічого не змінює', async () => {
    const id = `ig${rnd()}`;
    const clinicId = await connected(id);
    await form('/meta/deauthorize', signed(id, 'wrong-secret')).expect(400);
    await form('/meta/data-deletion', signed(id, 'wrong-secret')).expect(400);
    await http().post('/meta/deauthorize').type('form').send({}).expect(400);
    await form('/meta/deauthorize', 'garbage').expect(400);
    expect(await prisma.integration.count({ where: { clinicId } })).toBe(1);
  });

  it('відключення: підключення цієї людини зникає разом із токеном, чужі клініки не зачеплені; можна підписувати секретом застосунку Instagram', async () => {
    const id = `ig${rnd()}`;
    const mine = await connected(id);
    const other = await connected(`ig${rnd()}`);
    await form('/meta/deauthorize', signed(id)).expect(200).expect({ ok: true });
    expect(await prisma.integration.count({ where: { clinicId: mine } })).toBe(0);
    expect(await prisma.integration.count({ where: { clinicId: other } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { clinicId: mine, action: 'instagram.disconnected_by_meta' } })).toBe(1);
    const id2 = `ig${rnd()}`;
    const c2 = await connected(id2);
    await form('/meta/deauthorize', signed(id2, IG_SECRET)).expect(200);
    expect(await prisma.integration.count({ where: { clinicId: c2 } })).toBe(0);
  });

  it('запит на видалення: дані з цим ідентифікатором видаляються, відповідь має код і адресу сторінки стану, сторінка показує підсумок без ідентифікатора', async () => {
    const id = `ig${rnd()}`;
    const clinicId = await connected(id);
    const patient = await prisma.patient.create({ data: { clinicId, externalId: `p${rnd()}`, fullName: 'Пацієнт' } });
    await prisma.patientChannel.create({ data: { clinicId, patientId: patient.id, channel: 'INSTAGRAM', externalId: id } });
    await prisma.chatMessage.createMany({ data: [{ clinicId, channel: 'INSTAGRAM', chatId: id, direction: 'IN', text: 'привіт' }, { clinicId, channel: 'INSTAGRAM', chatId: 'someone-else', direction: 'IN', text: 'інша людина' }] });
    await prisma.bookingRequest.create({ data: { clinicId, channel: 'INSTAGRAM', chatId: id, kind: 'BOOKING', summary: 'x' } });
    const r = await form('/meta/data-deletion', signed(id)).expect(200);
    expect(r.body.confirmation_code).toMatch(/^DD-[0-9a-f]{16}$/);
    expect(r.body.url).toContain(`/data-deletion?code=${r.body.confirmation_code}`);
    expect(await prisma.chatMessage.count({ where: { clinicId, chatId: id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { clinicId, chatId: 'someone-else' } })).toBe(1);
    expect(await prisma.patientChannel.count({ where: { clinicId } })).toBe(0);
    expect(await prisma.bookingRequest.count({ where: { clinicId } })).toBe(0);
    expect(await prisma.integration.count({ where: { clinicId } })).toBe(0);
    expect(await prisma.patient.count({ where: { id: patient.id } })).toBe(1); // the clinic's own record of the patient is not Meta data
    const st = (await http().get(`/meta/data-deletion/status/${r.body.confirmation_code}`).expect(200)).body;
    expect(st).toMatchObject({ status: 'DELETED', summary: { disconnected: 1, messages: 1, chatLinks: 1, requests: 1 } });
    expect(JSON.stringify(st)).not.toContain(id);
    await http().get('/meta/data-deletion/status/DD-unknown').expect(404);
    // a second request for the same id is fine and deletes nothing more
    expect((await form('/meta/data-deletion', signed(id)).expect(200)).body.confirmation_code).not.toBe(r.body.confirmation_code);
  });
});
