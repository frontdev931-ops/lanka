import { HttpException, HttpStatus, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Attempt counters in the database: they work across several servers and survive a restart.
@Injectable()
export class RateLimitService implements OnApplicationBootstrap {
  constructor(private prisma: PrismaService) {}

  async onApplicationBootstrap() {
    await this.prisma.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 24 * 3600_000) } } });
  }

  // How many attempts are already recorded in the current window
  async count(key: string, windowMs: number): Promise<number> {
    const r = await this.prisma.rateLimit.findUnique({ where: { key } });
    return r && r.windowStart.getTime() > Date.now() - windowMs ? r.count : 0;
  }

  // Records an attempt (atomically) and returns the new number of attempts in the window
  async hit(key: string, windowMs: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES (${key}, 1, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowMs} * INTERVAL '1 millisecond') THEN 1 ELSE "RateLimit"."count" + 1 END,
        "windowStart" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowMs} * INTERVAL '1 millisecond') THEN NOW() ELSE "RateLimit"."windowStart" END
      RETURNING "count"`;
    return Number(rows[0].count);
  }

  async reset(key: string) {
    await this.prisma.rateLimit.deleteMany({ where: { key } });
  }

  // Limits by address can be widened (RATE_LIMIT_IP_MULTIPLIER): one address may serve a whole clinic office,
  // and tests register dozens of users from one address. Limits by email do not scale.
  private max(key: string, max: number) {
    return key.includes(':ip:') ? max * Number(process.env.RATE_LIMIT_IP_MULTIPLIER ?? 1) : max;
  }

  // Throws 429 if the limit is already used up (without recording a new attempt)
  async assertBelow(key: string, max: number, windowMs: number) {
    if ((await this.count(key, windowMs)) >= this.max(key, max)) throw new HttpException('too_many_attempts', HttpStatus.TOO_MANY_REQUESTS);
  }

  // Records an attempt and throws 429 if this attempt exceeds the limit
  async consume(key: string, max: number, windowMs: number) {
    if ((await this.hit(key, windowMs)) > this.max(key, max)) throw new HttpException('too_many_attempts', HttpStatus.TOO_MANY_REQUESTS);
  }
}
