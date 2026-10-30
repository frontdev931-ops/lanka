import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SyncService } from '../src/integrations/sync.service';

// Тестовая клиника с демо-данными. Безопасно запускать повторно.
const EMAIL = 'demo@stomat.test';
const PASSWORD = 'demo12345';

async function main() {
  // The demo user has a known password: this script must never run against a production database
  if (process.env.NODE_ENV === 'production') throw new Error('The seed script creates a user with a known password and is not allowed in production');
  process.env.AUTO_SYNC_MINUTES = '0';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const sync = app.get(SyncService, { strict: false });

  let user = await prisma.user.findUnique({ where: { email: EMAIL }, include: { memberships: true } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: EMAIL,
        name: 'Анна Демо',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        memberships: { create: { role: Role.OWNER, clinic: { create: { name: 'Демо-клініка «Усмішка»' } } } },
      },
      include: { memberships: true },
    });
    for (const [name, email, role] of [
      ['Марія Адміністратор', 'admin@stomat.test', Role.ADMIN],
      ['Ігор Лікар', 'doctor@stomat.test', Role.DOCTOR],
    ] as const) {
      const u = await prisma.user.create({ data: { email, name, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
      await prisma.membership.create({ data: { userId: u.id, clinicId: user.memberships[0].clinicId, role } });
    }
  }
  // название демо-клиники приводим к украинскому, если аккаунт создан раньше
  await prisma.clinic.update({ where: { id: user.memberships[0].clinicId }, data: { name: 'Демо-клініка «Усмішка»' } });
  await sync.run(user.memberships[0].clinicId, null);
  console.log(`Готово. Вход: ${EMAIL} / ${PASSWORD} (также admin@stomat.test и doctor@stomat.test с тем же паролем)`);
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
