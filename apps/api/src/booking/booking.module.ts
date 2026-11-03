import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { BookingController } from './booking.controller';
import { AvailabilityService } from './availability.service';
import { BookingService } from './booking.service';
import { DoctorChoiceService } from './doctor-choice.service';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';

@Module({ imports: [IntegrationsModule], controllers: [BookingController, DoctorsController], providers: [BookingService, AvailabilityService, DoctorsService, DoctorChoiceService], exports: [BookingService, AvailabilityService, DoctorsService, DoctorChoiceService] })
export class BookingModule {}
