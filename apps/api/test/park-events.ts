import { PrismaService } from '../src/prisma/prisma.service';

// retryDue() takes the 20 oldest due events of the WHOLE test database, so events left behind by other tests (or earlier runs) can push a
// test's own event out of the batch. A test that retries events parks everything else first: other events get a due time far in the future.
export async function parkOtherDueEvents(prisma: PrismaService, keepId: string) {
  await prisma.inboundEvent.updateMany({ where: { status: 'PENDING', id: { not: keepId } }, data: { nextAttemptAt: new Date(Date.now() + 24 * 3_600_000) } });
}
