import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  // Close the connection pool when the app stops; otherwise every restart (and every test app) leaves its connections open
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
