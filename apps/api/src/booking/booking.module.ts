import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({ imports: [IntegrationsModule], controllers: [BookingController], providers: [BookingService], exports: [BookingService] })
export class BookingModule {}
