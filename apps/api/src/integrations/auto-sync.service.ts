import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

// Periodic sync of clinics that have a Cliniccards key connected.
// AUTO_SYNC_MINUTES: the interval in minutes (60 by default), 0 turns it off.
@Injectable()
export class AutoSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AutoSyncService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
  ) {}

  onApplicationBootstrap() {
    const minutes = Number(process.env.AUTO_SYNC_MINUTES ?? 60);
    if (!minutes) return;
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return; // the previous pass is still running
    this.busy = true;
    try {
      const list = await this.prisma.integration.findMany({
        where: { apiKeyEnc: { not: null } },
        select: { clinicId: true },
      });
      for (const { clinicId } of list) {
        try {
          await this.sync.run(clinicId, null);
        } catch (e) {
          // the error is already recorded in SyncRun and visible on the "Integrations" page
          this.log.warn(`Синхронизация клиники ${clinicId} не удалась: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
