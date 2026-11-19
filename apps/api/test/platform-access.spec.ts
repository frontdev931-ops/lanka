import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { PlatformWebsiteController } from '../src/automations/platform-website.controller';
import { LeadsService } from '../src/automations/leads.service';
import { WebsiteRequestsService } from '../src/automations/website-requests.service';
import { AuthController } from '../src/auth/auth.controller';
import { BillingService } from '../src/billing/billing.service';
import { ClinicRequestsService } from '../src/billing/clinic-requests.service';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/auth/mail.service';
import { RateLimitService } from '../src/auth/rate-limit.service';
import { hotp, newSecret, stepOf } from '../src/auth/totp';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { encrypt } from '../src/common/crypto';
import { NetworkPlatformController } from '../src/network/network.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { PLATFORM_OWNER_EMAIL } from '../src/service/platform-access';
import { PlatformController } from '../src/service/platform.controller';

const ownerId = 'pinned-fixture-user';
const formerId = 'previous-admin-fixture';
const ordinaryId = 'ordinary-fixture-user';
const formerEmail = 'former-admin@example.test';
const password = 'synthetic-fixture-password';
const clinic = { id: 'fixture-clinic', name: 'Fixture', require2fa: false };
const membership = { clinicId: clinic.id, clinic, role: Role.OWNER };
const account = (id: string, email: string) => ({
  id, email, emailVerifiedAt: new Date() as Date | null,
  totpEnabledAt: null as Date | null, totpSecretEnc: null as string | null, totpLastStep: null,
  recoveryHashes: null, passwordHash: bcrypt.hashSync(password, 4), memberships: [membership],
});
const owner = account(ownerId, PLATFORM_OWNER_EMAIL);
const accounts = [owner, account(formerId, formerEmail), account(ordinaryId, 'ordinary@example.test')];
const prisma = {
  user: {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) => accounts.find((u) => where.id ? u.id === where.id : u.email === where.email)),
    findUniqueOrThrow: jest.fn(async () => owner),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  membership: { findUnique: jest.fn(async ({ where }: { where: { userId_clinicId: { userId: string } } }) => {
    const user = accounts.find((u) => u.id === where.userId_clinicId.userId);
    return user ? { ...membership, user } : null;
  }) },
  revokedToken: { findUnique: jest.fn(async () => null) },
  auditLog: { create: jest.fn(async () => ({})) },
  network: { findMany: jest.fn(async () => []) },
};

let app: INestApplication;
const http = () => request(app.getHttpServer());
const auth = (sub: string) => ({ Authorization: `Bearer ${app.get(JwtService).sign({ sub, clinicId: clinic.id })}` });
const protectedRoutes = [
  ['get', '/platform/clinics'], ['patch', '/platform/clinics/fixture'],
  ['get', '/platform/clinics/fixture/launch'], ['post', '/platform/clinics/fixture/launch'],
  ['get', '/platform/clinic-requests'], ['patch', '/platform/clinic-requests/fixture'],
  ['get', '/platform/plans'], ['get', '/platform/contact-requests'], ['patch', '/platform/contact-requests/fixture'],
  ['get', '/platform/website-requests'], ['get', '/platform/clinics/fixture/website'],
  ['patch', '/platform/clinics/fixture/website'], ['patch', '/platform/clinics/fixture/website/requests/fixture'],
  ['get', '/platform/networks'], ['post', '/platform/networks'], ['patch', '/platform/networks/fixture/branches/fixture'],
] as const;

beforeAll(async () => {
  app = (await Test.createTestingModule({
    imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
    controllers: [AuthController, PlatformController, PlatformWebsiteController, NetworkPlatformController],
    providers: [
      AuthService, TwoFactorService,
      { provide: PrismaService, useValue: prisma },
      { provide: LeadsService, useValue: {} },
      { provide: BillingService, useValue: {} },
      { provide: ClinicRequestsService, useValue: {} },
      { provide: WebsiteRequestsService, useValue: { openRequests: async () => [] } },
      { provide: MailService, useValue: {} },
      { provide: RateLimitService, useValue: { assertBelow: async () => {}, hit: async () => {}, reset: async () => {} } },
    ],
  }).compile()).createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
});
afterAll(async () => { await app?.close(); });

const keys = ['NODE_ENV', 'BILLING_ENFORCED', 'PLATFORM_ADMIN_EMAILS', 'PLATFORM_OWNER_USER_ID', 'PLATFORM_REQUIRE_2FA'] as const;
const prior = keys.map((key) => process.env[key]);
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.BILLING_ENFORCED = 'false';
  process.env.PLATFORM_ADMIN_EMAILS = `${PLATFORM_OWNER_EMAIL},${formerEmail}`;
  process.env.PLATFORM_OWNER_USER_ID = ownerId;
  process.env.PLATFORM_REQUIRE_2FA = 'false';
  clinic.require2fa = false;
  owner.emailVerifiedAt = new Date();
  owner.email = PLATFORM_OWNER_EMAIL;
  owner.totpEnabledAt = null;
  owner.totpSecretEnc = null;
});
afterEach(() => {
  keys.forEach((key, i) => {
    if (prior[i] === undefined) delete process.env[key];
    else process.env[key] = prior[i];
  });
});

it('permits the verified, pinned account without a configured factor on all three platform controllers', async () => {
  await http().get('/platform/plans').set(auth(ownerId)).expect(200);
  await http().get('/platform/website-requests').set(auth(ownerId)).expect(200);
  await http().get('/platform/networks').set(auth(ownerId)).expect(200);
  expect((await http().get('/auth/me').set(auth(ownerId)).expect(200)).body.platformAdmin).toBe(true);
  expect((await http().get('/auth/me').set(auth(formerId)).expect(200)).body.platformAdmin).toBe(false);
});

it.each([[formerId, 403], [ordinaryId, 403], [null, 401]] as const)('denies %s on every platform endpoint', async (userId, status) => {
  for (const [method, path] of protectedRoutes) {
    const req = http()[method](path);
    if (userId) req.set(auth(userId));
    await req.expect(status);
  }
});

it('fails closed without the ID, the expected verified email, or the existing allowlist entry', async () => {
  delete process.env.PLATFORM_OWNER_USER_ID;
  await http().get('/platform/plans').set(auth(ownerId)).expect(403);
  process.env.PLATFORM_OWNER_USER_ID = ownerId;
  owner.email = ordinaryId;
  await http().get('/platform/plans').set(auth(ownerId)).expect(403);
  owner.email = PLATFORM_OWNER_EMAIL;
  owner.emailVerifiedAt = null;
  await http().get('/platform/plans').set(auth(ownerId)).expect(403);
  owner.emailVerifiedAt = new Date();
  process.env.PLATFORM_ADMIN_EMAILS = formerEmail;
  await http().get('/platform/plans').set(auth(ownerId)).expect(403);
});

it('keeps clinic-wide 2FA and can restore the additional platform requirement', async () => {
  clinic.require2fa = true;
  await http().get('/platform/plans').set(auth(ownerId)).expect(403, { statusCode: 403, error: 'Forbidden', message: 'twofa_required' });
  clinic.require2fa = false;
  process.env.PLATFORM_REQUIRE_2FA = 'true';
  await http().get('/platform/plans').set(auth(ownerId)).expect(403, { statusCode: 403, error: 'Forbidden', message: 'platform_2fa_required' });
});

it('still requires a valid login factor for the pinned account when 2FA is configured', async () => {
  const secret = newSecret();
  owner.totpEnabledAt = new Date();
  owner.totpSecretEnc = encrypt(secret);
  const credentials = { email: owner.email, password };
  const challenge = await http().post('/auth/login').send(credentials).expect(201, { twoFactorRequired: true });
  expect(challenge.headers['set-cookie']).toBeUndefined();
  const invalid = await http().post('/auth/login').send({ ...credentials, code: 'invalid-fixture-code' }).expect(401);
  expect(invalid.headers['set-cookie']).toBeUndefined();
  const signedIn = await http().post('/auth/login').send({ ...credentials, code: hotp(secret, stepOf()) }).expect(201);
  expect(signedIn.body.accessToken).toBeTruthy();
  const cookie = (signedIn.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  await http().get('/platform/plans').set('Cookie', cookie).expect(200);
});
