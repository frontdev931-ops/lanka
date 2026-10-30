import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

// Периодическая синхронизация клиник с подключённым ключом Cliniccards.
// AUTO_SYNC_MINUTES: интервал в минутах (по умолчанию 60), 0 — выключить.
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
    if (this.busy) return; // предыдущий проход ещё идёт
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
          // ошибка уже записана в SyncRun и видна на странице «Интеграции»
          this.log.warn(`Синхронизация клиники ${clinicId} не удалась: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
