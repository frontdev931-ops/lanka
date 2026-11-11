import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { LlmClient } from '../src/ai/llm.client';
import { AppModule } from '../src/app.module';
import { DigestService } from '../src/automations/digest.service';
import { clinicDate, clinicHm, startOfClinicDay } from '../src/common/clinic-time';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';
import { lankaMoves } from '../src/reports/lanka-moves';

jest.setTimeout(60_000);

// "Rescheduled through LANKA": confirmed rescheduling operations counted by their audit attempt id (one rule for the report and the digest). The audit rows are
// written here directly: the statistics read only what the rescheduling records (agent-administrator.md section 47), nothing is moved in these tests.
let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LlmClient).useValue({ configured: false, complete: async () => { throw new Error('no AI in tests'); } }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});

async function clinic() {
  const email = `s${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Ольга Власниця', email, password: 'correct-horse-battery' }).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  return { token: res.body.accessToken as string, clinicId: user.memberships[0].clinicId, userId: user.id };
}
type C = Awaited<ReturnType<typeof clinic>>;
async function visitOf(c: C, at: Date, status = 'PLANNED') {
  const p = await prisma.patient.create({ data: { clinicId: c.clinicId, externalId: `p${rnd()}`, fullName: 'Коваль Ірина' } });
  return prisma.visit.create({ data: { clinicId: c.clinicId, patientId: p.id, externalId: `v${rnd()}`, startsAt: at, endsAt: new Date(at.getTime() + 1_800_000), status } });
}
// one audit entry of a confirmed move (attempt null: an older entry without the operation id)
const moved = (c: C, o: { visit: string; attempt: string | null; at: Date; from?: Date; to?: Date; by?: 'agent'; userId?: string | null; action?: string }) =>
  prisma.auditLog.create({ data: { clinicId: c.clinicId, userId: o.userId ?? null, action: o.action ?? 'booking.rescheduled', createdAt: o.at, details: { visit: o.visit, ...(o.from ? { from: o.from.toISOString() } : {}), ...(o.to ? { to: o.to.toISOString() } : {}), ...(o.attempt ? { attempt: o.attempt } : {}), ...(o.by ? { by: o.by } : {}) } } });
type Section = { title: string; rule: string; summary: { label: string; value: number }[]; note: string | null; columns: { key: string; label: string }[]; rows: Record<string, string>[] };
const report = async (c: C, days = 30) => (await http().get(`/reports/missed-visits?days=${days}`).set(auth(c.token)).set('Accept-Language', 'uk').expect(200)).body as { rule: string; rows: Record<string, unknown>[]; sections: Section[] };
const section = async (c: C, days = 30) => (await report(c, days)).sections[0];
const totals = (s: Section) => Object.fromEntries(s.summary.map((x) => [x.label, x.value]));
const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
const stamp = (d: Date) => `${clinicDate(d)} ${clinicHm(d)}`;

describe('звіт «Перенесено через LANKA»', () => {
  it('одна операція: дата операції, був і новий час, візит, пацієнт, хто переніс', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(-48));
    const from = ago(-24);
    const at = ago(5);
    await moved(c, { visit: v.externalId, attempt: `a${rnd()}`, at, from, to: v.startsAt, userId: c.userId });
    const s = await section(c);
    expect(s.title).toBe('Перенесено через LANKA');
    expect(totals(s)).toEqual({ 'Операцій перенесення': 1, 'Різних візитів': 1 });
    expect(s.rows).toEqual([{ opWhen: stamp(at), visitRef: v.externalId, patient: 'Коваль Ірина', oldWhen: stamp(from), newWhen: stamp(v.startsAt), actor: 'Співробітник: Ольга Власниця' }]);
    expect(s.note).toBeNull();
    // the agent is named only where it was recorded
    await moved(c, { visit: v.externalId, attempt: `a${rnd()}`, at: ago(4), by: 'agent' });
    await moved(c, { visit: v.externalId, attempt: `a${rnd()}`, at: ago(3) });
    const actors = (await section(c)).rows.map((r) => r.actor);
    expect(actors).toEqual(['Невідомо', 'Агент LANKA', 'Співробітник: Ольга Власниця']);
    expect((await section(c)).rows[0]).toMatchObject({ oldWhen: 'не записано', newWhen: 'не записано' });
  });

  it('повтори одного attempt — одна операція з найранішою датою; A→B→A→B — три операції одного візиту', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(-48));
    const first = new Date(Math.floor(ago(10).getTime() / 60_000) * 60_000);
    await moved(c, { visit: v.externalId, attempt: 'dup1', at: first });
    await moved(c, { visit: v.externalId, attempt: 'dup1', at: new Date(first.getTime() + 2 * 3_600_000) });
    let s = await section(c);
    expect(totals(s)).toEqual({ 'Операцій перенесення': 1, 'Різних візитів': 1 });
    expect(s.rows[0].opWhen).toBe(stamp(first));
    const A = ago(-24);
    const B = ago(-30);
    for (const [i, [f, t]] of ([[A, B], [B, A], [A, B]] as const).entries()) await moved(c, { visit: v.externalId, attempt: `abab${i}`, at: ago(8 - i), from: f, to: t });
    s = await section(c);
    expect(totals(s)).toEqual({ 'Операцій перенесення': 4, 'Різних візитів': 1 });
  });

  it('візит також зі статусом MOVED у Cliniccards: дві окремі метрики, без спільної суми', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(48), 'MOVED');
    await moved(c, { visit: v.externalId, attempt: `a${rnd()}`, at: ago(60) });
    const r = await report(c);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ kind: 'MOVED' });
    expect(totals(r.sections[0])).toEqual({ 'Операцій перенесення': 1, 'Різних візитів': 1 });
    expect(r.rule).toContain('показано окремо нижче й до цих записів не додаються');
    expect(r.sections[0].rule).toContain('ці числа не додаються до записів зі статусом MOVED');
  });

  it('межі періоду й часовий пояс клініки; повтори одного attempt по обидва боки межі рахуються лише там, де найраніший', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(-48));
    await moved(c, { visit: v.externalId, attempt: 'out', at: new Date(Date.now() - 30 * DAY - 60_000) });
    await moved(c, { visit: v.externalId, attempt: 'in', at: new Date(Date.now() - 30 * DAY + 60_000) });
    // the same attempt: first entry 31 days ago, a duplicate 29 days ago
    await moved(c, { visit: v.externalId, attempt: 'span', at: new Date(Date.now() - 31 * DAY) });
    await moved(c, { visit: v.externalId, attempt: 'span', at: new Date(Date.now() - 29 * DAY) });
    expect(totals(await section(c, 30))['Операцій перенесення']).toBe(1); // only "in"
    expect(totals(await section(c, 40))['Операцій перенесення']).toBe(3); // out, in, span once
    // a moment late in the UTC evening is the next day in Kyiv: the date shown is the clinic's
    const d = new Date(`${new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10)}T22:30:00Z`);
    const k = await clinic();
    const kv = await visitOf(k, ago(-48));
    await moved(k, { visit: kv.externalId, attempt: 'tz', at: d });
    const row = (await section(k)).rows[0];
    expect(row.opWhen).toBe(stamp(d));
    expect(row.opWhen.slice(0, 10)).not.toBe(d.toISOString().slice(0, 10));
  });

  it('старі записи без attempt — окремою приміткою, не в числі операцій; візиту вже немає — операція рахується чесно; time_changed не рахується; ізоляція клінік', async () => {
    const c = await clinic();
    await moved(c, { visit: 'gone-visit-1', attempt: `a${rnd()}`, at: ago(6), from: ago(-20), to: ago(-22) });
    await moved(c, { visit: 'legacy-visit', attempt: null, at: ago(7) });
    await moved(c, { visit: 'sync-visit', attempt: null, at: ago(2), action: 'visit.time_changed' });
    await moved(c, { visit: 'sync-visit', attempt: 'not-a-move', at: ago(2), action: 'visit.time_changed' });
    const other = await clinic();
    await moved(other, { visit: 'other-visit', attempt: `a${rnd()}`, at: ago(1) });
    const s = await section(c);
    expect(totals(s)).toEqual({ 'Операцій перенесення': 1, 'Різних візитів': 1 });
    expect(s.rows[0]).toMatchObject({ visitRef: 'gone-visit-1', patient: 'Візиту вже немає в копії LANKA' });
    expect(s.note).toBe('Ще 1 старих записів аудиту без ідентифікатора операції: їх не включено до числа операцій');
    expect(totals(await section(other))['Операцій перенесення']).toBe(1);
  });

  it('вигрузки: CSV, Excel і PDF містять окремий розділ зі своїм правилом і підсумками', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(-48));
    await moved(c, { visit: v.externalId, attempt: `a${rnd()}`, at: ago(5), by: 'agent' });
    const csv = (await http().get('/reports/missed-visits/csv?days=30').set(auth(c.token)).set('Accept-Language', 'uk').expect(200)).text;
    expect(csv).toContain('"Перенесено через LANKA"');
    expect(csv).toContain('"Операцій перенесення";1');
    expect(csv).toContain('"Агент LANKA"');
    const xlsx = await http().get('/reports/missed-visits/xlsx?days=30').set(auth(c.token)).set('Accept-Language', 'uk').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (x: Buffer) => chunks.push(x));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    expect(wb.worksheets.map((w) => w.name)).toContain('Перенесено через LANKA');
    await http().get('/reports/missed-visits/pdf?days=30').set(auth(c.token)).expect(200);
  });
});

describe('дайджест: та сама логіка підрахунку', () => {
  it('рядок операцій через LANKA за період дайджесту; повтори — один раз; MOVED-рядок без змін', async () => {
    const c = await clinic();
    const v = await visitOf(c, ago(-48));
    const to = startOfClinicDay(new Date());
    const from = new Date(to.getTime() - 7 * DAY);
    await moved(c, { visit: v.externalId, attempt: 'w1', at: new Date(from.getTime() + DAY) });
    await moved(c, { visit: v.externalId, attempt: 'w1', at: new Date(from.getTime() + 2 * DAY) });
    await moved(c, { visit: v.externalId, attempt: 'w2', at: new Date(from.getTime() + 3 * DAY) });
    await moved(c, { visit: v.externalId, attempt: null, at: new Date(from.getTime() + 3 * DAY) });
    // the previous week and a duplicate across the boundary: counted in the week of its earliest entry only
    await moved(c, { visit: v.externalId, attempt: 'p1', at: new Date(from.getTime() - DAY) });
    await moved(c, { visit: v.externalId, attempt: 'p1', at: new Date(from.getTime() + DAY) });
    const digest = app.get(DigestService);
    const n = await digest.numbers(c.clinicId, 'WEEKLY');
    expect(n.lankaMoves).toBe(2);
    expect(n.prev.lankaMoves).toBe(1);
    expect(n.lankaMoves).toBe((await lankaMoves(prisma, c.clinicId, from, to)).operations.length);
    expect(n.cancelled).toBe(0);
    const text = digest.format(n, 'Клініка', 'WEEKLY', 'uk', 'u');
    expect(text).toContain('Перенесень через LANKA (операцій, не пацієнтів): 2 (було 1)');
    expect(text).toContain('скасування та перенесення 0');
  });
});
