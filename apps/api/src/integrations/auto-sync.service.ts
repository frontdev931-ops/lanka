import { ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { autoSyncEnabled, autoSyncSlot, clinicTimeZone } from './auto-sync-schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

// The daily automatic load of the clinics with a Cliniccards key, at AUTO_SYNC_HOUR:00 (auto-sync-schedule.ts) in the clinic's time zone. Reports, the funnel and reminders read our
// copy of the data; checks that must be fresh (free places, booking, moving, cancelling, and each appointment reminder right before it goes) ask
// Cliniccards themselves, so a day-old copy does not lead to a wrong action. The manual "refresh now" stays as it was.
//
// Switch: on by default; AUTO_SYNC=off (or the older AUTO_SYNC_MINUTES=0) turns it off. The old meaning of AUTO_SYNC_MINUTES (an interval) is gone.
//
// One run per clinic day, also with several servers: the day is claimed by one atomic update of the Integration row. Recovery is bounded: a failed attempt
// is tried again after RETRY_MS, at most MAX_ATTEMPTS a day; an attempt cut off by a restart is tried again when its lease (LEASE_MS) ends. A start of the
// server only checks; it runs a load only if today's 03:00 has passed and today's load has not been done (once, as any missed slot). A day that passed
// without a load is not made up the next night before 03:00. A manual load after 03:00 counts as the day's load.
const CHECK_MS = 5 * 60_000;
const FIRST_CHECK_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 30 * 60_000;
// longer than the 30 minutes after which a "running" load is treated as cut off (SyncService.failStale)
const LEASE_MS = 45 * 60_000;

@Injectable()
export class AutoSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AutoSyncService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
  ) {}

  onApplicationBootstrap() {
    if (!autoSyncEnabled()) return;
    this.first = setTimeout(() => void this.tick(), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  // One check: starts the loads that are due, one clinic after another (the limit of Cliniccards requests is per key, the database is shared)
  // scope: only these clinics (tests; the scheduler checks all)
  async tick(now = new Date(), scope?: { clinicIds?: string[] }): Promise<{ started: string[] }> {
    const started: string[] = [];
    if (this.busy) return { started }; // the previous check is still loading
    this.busy = true;
    try {
      // only the rows that may be due: today's day not claimed yet, or a retry whose time has come (the exact check is in claim)
      const { day } = autoSyncSlot(now, clinicTimeZone());
      const list = await this.prisma.integration.findMany({
        where: {
          provider: Provider.CLINICCARDS,
          apiKeyEnc: { not: null },
          ...(scope?.clinicIds ? { clinicId: { in: scope.clinicIds } } : {}),
          OR: [{ autoSyncDay: null }, { autoSyncDay: { not: day } }, { autoSyncRetryAt: { lte: now }, autoSyncAttempts: { lt: MAX_ATTEMPTS } }],
        },
        select: { id: true, clinicId: true, lastSyncAt: true, autoSyncDay: true, autoSyncAttempts: true, autoSyncRetryAt: true },
      });
      for (const i of list) {
        if (await this.claim(i, now)) {
          started.push(i.clinicId);
          await this.runClaimed(i.id, i.clinicId, now);
        }
      }
    } finally {
      this.busy = false;
    }
    return { started };
  }

  // Is today's load of this clinic due, and did this server get it? The claim is a compare-and-set of the day and the attempt counter.
  private async claim(i: { id: string; clinicId: string; lastSyncAt: Date | null; autoSyncDay: string | null; autoSyncAttempts: number; autoSyncRetryAt: Date | null }, now: Date): Promise<boolean> {
    const { day, at } = autoSyncSlot(now, clinicTimeZone(i.clinicId));
    if (now.getTime() < at.getTime()) return false;
    const lease = new Date(now.getTime() + LEASE_MS);
    if (i.autoSyncDay !== day) {
      // a load (manual or automatic) already happened after today's 03:00: the day is done without another one
      const done = !!i.lastSyncAt && i.lastSyncAt.getTime() >= at.getTime();
      const r = await this.prisma.integration.updateMany({
        where: { id: i.id, OR: [{ autoSyncDay: null }, { autoSyncDay: { not: day } }] },
        data: done ? { autoSyncDay: day, autoSyncAttempts: 0, autoSyncRetryAt: null } : { autoSyncDay: day, autoSyncAttempts: 1, autoSyncRetryAt: lease },
      });
      return !done && r.count === 1;
    }
    if (i.lastSyncAt && i.lastSyncAt.getTime() >= at.getTime()) return false;
    if (i.autoSyncAttempts >= MAX_ATTEMPTS || !i.autoSyncRetryAt || i.autoSyncRetryAt.getTime() > now.getTime()) return false;
    const r = await this.prisma.integration.updateMany({
      where: { id: i.id, autoSyncDay: day, autoSyncAttempts: i.autoSyncAttempts, autoSyncRetryAt: { lte: now } },
      data: { autoSyncAttempts: i.autoSyncAttempts + 1, autoSyncRetryAt: lease },
    });
    return r.count === 1;
  }

  private async runClaimed(integrationId: string, clinicId: string, now: Date) {
    try {
      await this.sync.run(clinicId, null);
      await this.prisma.integration.update({ where: { id: integrationId }, data: { autoSyncRetryAt: null } });
    } catch (e) {
      // the error itself is in the load history (SyncRun) and on the Cliniccards card; a manual load going on is not an error, it is tried again later
      const row = await this.prisma.integration.findUnique({ where: { id: integrationId }, select: { autoSyncAttempts: true } });
      const more = (row?.autoSyncAttempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
      await this.prisma.integration.update({ where: { id: integrationId }, data: { autoSyncRetryAt: more ? new Date(now.getTime() + RETRY_MS) : null } });
      if (!(e instanceof ConflictException)) this.log.warn(`Automatic load of clinic ${clinicId} failed (attempt ${row?.autoSyncAttempts ?? '?'} of ${MAX_ATTEMPTS}): ${(e as Error).message}`);
    }
  }
}
