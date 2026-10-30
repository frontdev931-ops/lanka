import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { InboundService } from '../src/automations/inbound.service';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
let inbound: InboundService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';
const calls: string[] = [];
let failures = 0;

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
  inbound = app.get(InboundService);
  inbound.register('TEST', async (_c, payload) => {
    calls.push((payload as { n: string }).n);
    if (failures > 0) {
      failures--;
      throw new Error('boom');
    }
  });
});

afterAll(async () => {
  await app.close();
});

async function clinic() {
  const email = `e${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Анна', email, password: PASSWORD }).expect(201);
  const clinicId = (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships[0].clinicId;
  return { token: res.body.accessToken as string, clinicId };
}
const due = (id: string) => prisma.inboundEvent.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

describe('надійний вхідний ящик', () => {
  it('успішна подія стає DONE, повторна доставка того ж id ігнорується', async () => {
    const c = await clinic();
    const id = `x${rnd()}`;
    await inbound.receive(c.clinicId, 'TEST', id, { n: id });
    await inbound.receive(c.clinicId, 'TEST', id, { n: id });
    expect(calls.filter((x) => x === id)).toHaveLength(1);
    expect(await prisma.inboundEvent.findFirstOrThrow({ where: { externalId: id } })).toMatchObject({ status: 'DONE', attempts: 1 });
  });

  it('збій не губить подію: вона повторюється з паузами і зрештою виконується', async () => {
    const c = await clinic();
    const id = `x${rnd()}`;
    failures = 2;
    await inbound.receive(c.clinicId, 'TEST', id, { n: id });
    let ev = await prisma.inboundEvent.findFirstOrThrow({ where: { externalId: id } });
    expect(ev).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'boom' });
    // before the pause is over the scheduler leaves it alone
    await inbound.retryDue();
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).attempts).toBe(1);
    await due(ev.id);
    await inbound.retryDue();
    await due(ev.id);
    await inbound.retryDue();
    ev = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(ev).toMatchObject({ status: 'DONE', attempts: 3, lastError: null });
  });

  it('після останньої спроби подія лишається FAILED, власник бачить її й може повторити; чужа клініка не бачить', async () => {
    const c = await clinic();
    const other = await clinic();
    const id = `x${rnd()}`;
    failures = 99;
    await inbound.receive(c.clinicId, 'TEST', id, { n: id, secret: 'текст пацієнта' });
    const ev = await prisma.inboundEvent.findFirstOrThrow({ where: { externalId: id } });
    for (let i = 0; i < 6; i++) {
      await due(ev.id);
      await inbound.retryDue();
    }
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: 'FAILED', attempts: 6 });

    const view = await http().get('/integration-events').set(auth(c.token)).expect(200);
    expect(view.body.counts.FAILED).toBe(1);
    expect(view.body.problems).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toContain('текст пацієнта');
    expect((await http().get('/integration-events').set(auth(other.token)).expect(200)).body.problems).toHaveLength(0);
    await http().post(`/integration-events/${ev.id}/retry`).set(auth(other.token)).expect(400);

    failures = 0;
    await http().post(`/integration-events/${ev.id}/retry`).set(auth(c.token)).expect(200);
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: 'DONE' });
  });

  it('застарілі виконані події видаляються, свіжі лишаються', async () => {
    const c = await clinic();
    const old = await prisma.inboundEvent.create({ data: { clinicId: c.clinicId, channel: 'TEST', payload: {}, status: 'DONE', nextAttemptAt: new Date(), createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    const fresh = await prisma.inboundEvent.create({ data: { clinicId: c.clinicId, channel: 'TEST', payload: {}, status: 'DONE', nextAttemptAt: new Date() } });
    await inbound.purge();
    expect(await prisma.inboundEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.inboundEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});
