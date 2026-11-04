import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { BookingController } from './booking.controller';
import { CabinetBookingController } from './cabinet-booking.controller';
import { CabinetBookingService } from './cabinet-booking.service';
import { AutoBookingGate } from './auto-booking-gate';
import { AvailabilityService } from './availability.service';
import { BookingService } from './booking.service';
import { DoctorChoiceService } from './doctor-choice.service';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';

@Module({ imports: [IntegrationsModule], controllers: [BookingController, DoctorsController, CabinetBookingController], providers: [AutoBookingGate, BookingService, AvailabilityService, DoctorsService, CabinetBookingService, DoctorChoiceService], exports: [AutoBookingGate, BookingService, AvailabilityService, DoctorsService, CabinetBookingService, DoctorChoiceService] })
export class BookingModule {}
