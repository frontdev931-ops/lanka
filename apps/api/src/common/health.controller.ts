import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Проверка для хостинга: сервер жив и видит базу. Данных не отдаёт.
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { ok: true };
  }
}
