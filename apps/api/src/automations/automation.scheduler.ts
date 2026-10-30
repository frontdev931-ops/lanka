import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DigestService } from './digest.service';
import { InboundService } from './inbound.service';
import { WaitlistService } from './waitlist.service';
import { CustomAutomationsService } from './custom-automations.service';
import { OutboxService } from './outbox.service';
import { PlannerService } from './planner.service';

// Раз в минуту отправляет одобренные сообщения, раз в пять минут пополняет очередь по включённым сценариям.
// AUTOMATIONS_TICK_SECONDS=0 выключает (в тестах).
@Injectable()
export class AutomationScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AutomationScheduler.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private n = 0;

  constructor(
    private prisma: PrismaService,
    private planner: PlannerService,
    private outbox: OutboxService,
    private digest: DigestService,
    private inbound: InboundService,
    private waitlist: WaitlistService,
    private custom: CustomAutomationsService,
  ) {}

  onApplicationBootstrap() {
    const sec = Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60);
    if (!sec) return;
    this.timer = setInterval(() => void this.tick(), sec * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.n++ % 5 === 0) {
        const clinics = await this.prisma.automationRule.findMany({ where: { enabled: true }, distinct: ['clinicId'], select: { clinicId: true } });
        for (const c of clinics) await this.planner.plan(c.clinicId, { dryRun: false }).catch((e) => this.log.warn(`План: ${(e as Error).message}`));
      }
      if (this.n % 5 === 1) await this.custom.planAll().catch((e) => this.log.warn(`Custom automations: ${(e as Error).message}`));
      if (this.n % 5 === 1) await this.waitlist.tickAll().catch((e) => this.log.warn(`Waitlist: ${(e as Error).message}`));
      await this.inbound.retryDue().catch((e) => this.log.warn(`Inbox: ${(e as Error).message}`));
      if (this.n % 60 === 1) await this.inbound.purge().catch((e) => this.log.warn(`Inbox purge: ${(e as Error).message}`));
      await this.outbox.process();
      await this.digest.tick().catch((e) => this.log.warn(`Дайджест: ${(e as Error).message}`));
    } finally {
      this.busy = false;
    }
  }
}
