import { HttpException, HttpStatus, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Счётчики попыток в базе: работают на нескольких серверах и переживают перезапуск.
@Injectable()
export class RateLimitService implements OnApplicationBootstrap {
  constructor(private prisma: PrismaService) {}

  async onApplicationBootstrap() {
    await this.prisma.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 24 * 3600_000) } } });
  }

  // Сколько попыток уже записано в текущем окне
  async count(key: string, windowMs: number): Promise<number> {
    const r = await this.prisma.rateLimit.findUnique({ where: { key } });
    return r && r.windowStart.getTime() > Date.now() - windowMs ? r.count : 0;
  }

  // Записывает попытку (атомарно) и возвращает новое число попыток в окне
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

  // Лимиты по адресу можно расширить (RATE_LIMIT_IP_MULTIPLIER): за одним адресом бывает целый офис клиники,
  // а тесты регистрируют десятки пользователей с одного адреса. Лимиты по почте не масштабируются.
  private max(key: string, max: number) {
    return key.includes(':ip:') ? max * Number(process.env.RATE_LIMIT_IP_MULTIPLIER ?? 1) : max;
  }

  // Бросает 429, если лимит уже исчерпан (не записывая новую попытку)
  async assertBelow(key: string, max: number, windowMs: number) {
    if ((await this.count(key, windowMs)) >= this.max(key, max)) throw new HttpException('too_many_attempts', HttpStatus.TOO_MANY_REQUESTS);
  }

  // Записывает попытку и бросает 429, если лимит превышен этой попыткой
  async consume(key: string, max: number, windowMs: number) {
    if ((await this.hit(key, windowMs)) > this.max(key, max)) throw new HttpException('too_many_attempts', HttpStatus.TOO_MANY_REQUESTS);
  }
}
