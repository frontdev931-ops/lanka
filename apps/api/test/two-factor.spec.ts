import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { base32Decode, base32Encode, hotp, stepOf, verifyTotp } from '../src/auth/totp';
import { I18nExceptionFilter } from '../src/common/i18n';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

let app: INestApplication;
let prisma: PrismaService;
const rnd = () => Math.random().toString(36).slice(2, 9);
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nExceptionFilter());
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => app.close());

const codeAt = (secret: string, step: number) => hotp(secret, step);
async function owner() {
  const email = `t${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: `Клініка ${rnd()}`, name: 'Власниця', email, password: PASSWORD }).expect(201);
  return { email, token: res.body.accessToken as string };
}
// включает двухфакторный вход и возвращает секрет и резервные коды
async function enable(token: string) {
  const { secret } = (await http().post('/auth/2fa/setup').set(auth(token)).expect(200)).body;
  const { recoveryCodes } = (await http().post('/auth/2fa/enable').set(auth(token)).send({ code: codeAt(secret, stepOf()) }).expect(200)).body;
  return { secret: secret as string, recoveryCodes: recoveryCodes as string[] };
}

describe('TOTP: алгоритм', () => {
  it('совпадает с тестовыми значениями RFC 4226/6238 и кодирует base32', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => hotp(secret, i))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1); // RFC 6238: время 59 с, шаг 1
    expect(verifyTotp(secret, '287082', 59_000 + 30_000)).toBe(1); // запас на шаг вперёд
    expect(verifyTotp(secret, '287082', 59_000 + 90_000)).toBeNull(); // а через 3 шага уже нет
    expect(verifyTotp(secret, '12345', 59_000)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 59_000)).toBeNull();
  });
});

describe('двухфакторный вход', () => {
  it('включение: ключ → подтверждение кодом → резервные коды; без подтверждения вход остаётся прежним', async () => {
    const u = await owner();
    expect((await http().get('/auth/2fa').set(auth(u.token)).expect(200)).body).toEqual({ enabled: false, recoveryLeft: 0 });
    await http().post('/auth/2fa/enable').set(auth(u.token)).send({ code: '123456' }).expect(400); // ключ ещё не создан
    const { secret, otpauthUrl } = (await http().post('/auth/2fa/setup').set(auth(u.token)).expect(200)).body;
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl).toContain('issuer=LANKA');
    // ключ создан, но не подтверждён: вход без кода работает
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201);
    // ключ в базе зашифрован
    const row = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
    expect(row.totpSecretEnc).toBeTruthy();
    expect(row.totpSecretEnc).not.toContain(secret);
    await http().post('/auth/2fa/enable').set(auth(u.token)).send({ code: '000000' }).expect(400);
    const ok = await http().post('/auth/2fa/enable').set(auth(u.token)).send({ code: codeAt(secret, stepOf()) }).expect(200);
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect(ok.body.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: u.email } })).recoveryHashes).not.toContain(ok.body.recoveryCodes[0]); // в базе только хэши
    expect((await http().get('/auth/2fa').set(auth(u.token))).body).toEqual({ enabled: true, recoveryLeft: 8 });
    expect((await http().get('/auth/me').set(auth(u.token))).body.twoFactorEnabled).toBe(true);
    await http().post('/auth/2fa/setup').set(auth(u.token)).expect(400); // уже включён
  });

  it('вход: пароль без кода токена не даёт; верный код пускает; тот же код второй раз не принимается; чужой пароль не раскрывает признак', async () => {
    const u = await owner();
    const { secret } = await enable(u.token);
    const first = await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201);
    expect(first.body).toEqual({ twoFactorRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();

    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: '000000' }).expect(401);
    // код следующего шага (запас ±1): принимается, и им же второй раз войти нельзя
    const code = codeAt(secret, stepOf() + 1);
    const ok = await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code }).expect(201);
    expect(ok.body.accessToken).toBeTruthy();
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code }).expect(401);
    // более ранний шаг после использования более позднего тоже не принимается
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: codeAt(secret, stepOf()) }).expect(401);
    // неверный пароль: обычный отказ, без намёка на второй фактор
    const wrong = await http().post('/auth/login').send({ email: u.email, password: 'wrong-password-123', code: codeAt(secret, stepOf() + 1) }).expect(401);
    expect(JSON.stringify(wrong.body)).not.toContain('twoFactor');
  });

  it('резервный код: одноразовый, работает как код входа; запись в журнале; новые коды отменяют старые', async () => {
    const u = await owner();
    const { secret, recoveryCodes } = await enable(u.token);
    const used = recoveryCodes[0];
    expect((await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: used.toLowerCase() }).expect(201)).body.accessToken).toBeTruthy(); // регистр и пробелы не важны
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: used }).expect(401);
    const me = await prisma.user.findUniqueOrThrow({ where: { email: u.email }, include: { memberships: true } });
    expect(await prisma.auditLog.count({ where: { userId: me.id, action: 'auth.login.recovery_code' } })).toBe(1);
    expect((await http().get('/auth/2fa').set(auth(u.token))).body.recoveryLeft).toBe(7);

    const fresh = (await http().post('/auth/2fa/recovery-codes').set(auth(u.token)).send({ code: codeAt(secret, stepOf() + 1) }).expect(200)).body.recoveryCodes as string[];
    expect(fresh).toHaveLength(8);
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: recoveryCodes[1] }).expect(401); // старые отменены
    expect((await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: fresh[0] }).expect(201)).body.accessToken).toBeTruthy();
  });

  it('перебор кодов упирается в ограничение попыток; выключение требует пароль и код', async () => {
    const u = await owner();
    const { secret } = await enable(u.token);
    for (let i = 0; i < 10; i++) await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: '000000' }).expect(401);
    await http().post('/auth/login').send({ email: u.email, password: PASSWORD, code: codeAt(secret, stepOf() + 1) }).expect(429);
    await prisma.rateLimit.deleteMany({ where: { key: { contains: u.email } } });
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: 'login:ip:' } } });

    const code = codeAt(secret, stepOf() + 1);
    await http().post('/auth/2fa/disable').set(auth(u.token)).send({ password: 'wrong-password-123', code }).expect(401);
    await http().post('/auth/2fa/disable').set(auth(u.token)).send({ password: PASSWORD, code: '111111' }).expect(401);
    expect((await http().post('/auth/2fa/disable').set(auth(u.token)).send({ password: PASSWORD, code }).expect(200)).body.ok).toBe(true);
    expect((await http().get('/auth/2fa').set(auth(u.token))).body).toEqual({ enabled: false, recoveryLeft: 0 });
    expect((await http().post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201)).body.accessToken).toBeTruthy();
    const row = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
    expect(row).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, recoveryHashes: null });
  });

  it('несколько клиник: список клиник приходит вместе с запросом кода, а вход проверяет код один раз', async () => {
    const a = await owner();
    const b = await owner();
    // добавляем пользователя a во вторую клинику
    const clinicB = (await prisma.membership.findFirstOrThrow({ where: { user: { email: b.email } } })).clinicId;
    const userA = await prisma.user.findUniqueOrThrow({ where: { email: a.email } });
    await prisma.membership.create({ data: { userId: userA.id, clinicId: clinicB, role: 'MANAGER' } });
    const { secret } = await enable(a.token);
    const step1 = await http().post('/auth/login').send({ email: a.email, password: PASSWORD }).expect(201);
    expect(step1.body.twoFactorRequired).toBe(true);
    expect(step1.body.clinics).toHaveLength(2);
    const code = codeAt(secret, stepOf() + 1);
    // код без выбора клиники токена не даёт и не тратится
    const noClinic = await http().post('/auth/login').send({ email: a.email, password: PASSWORD, code }).expect(201);
    expect(noClinic.body.accessToken).toBeUndefined();
    const final = await http().post('/auth/login').send({ email: a.email, password: PASSWORD, code, clinicId: clinicB }).expect(201);
    expect(final.body.accessToken).toBeTruthy();
  });
});
