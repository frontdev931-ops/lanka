import { PrismaService } from '../src/prisma/prisma.service';
import { PLATFORM_OWNER_EMAIL } from '../src/service/platform-access';

// Existing database-backed suites use independently registered synthetic users.
// Pin their platform fixture for the suite, then restore the original test identity.
export async function pinPlatformFixture(prisma: PrismaService, email: string) {
  const fixture = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  const keys = ['PLATFORM_OWNER_USER_ID', 'PLATFORM_ADMIN_EMAILS', 'PLATFORM_REQUIRE_2FA'] as const;
  const prior = keys.map((key) => process.env[key]);
  await prisma.user.update({ where: { id: fixture.id }, data: { email: PLATFORM_OWNER_EMAIL, emailVerifiedAt: new Date() } });
  process.env.PLATFORM_OWNER_USER_ID = fixture.id;
  process.env.PLATFORM_ADMIN_EMAILS = PLATFORM_OWNER_EMAIL;
  process.env.PLATFORM_REQUIRE_2FA = 'false';
  return async () => {
    await prisma.user.update({ where: { id: fixture.id }, data: { email, emailVerifiedAt: fixture.emailVerifiedAt } });
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
  };
}
