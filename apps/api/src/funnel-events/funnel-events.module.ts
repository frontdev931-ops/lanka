import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FunnelEventsService } from './funnel-events.service';

// Shared by the messaging flow and the booking service (neither module may import the other), so the events live in a module of their own
@Module({ imports: [PrismaModule], providers: [FunnelEventsService], exports: [FunnelEventsService] })
export class FunnelEventsModule {}
