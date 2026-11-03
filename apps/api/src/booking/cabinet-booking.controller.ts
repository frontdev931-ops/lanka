import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { CabinetBookingService } from './cabinet-booking.service';

const READERS = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];
const MANAGERS = [Role.OWNER, Role.MANAGER];

class ModeDto {
  @IsIn(['DOCTORS', 'CABINETS']) mode: string;
}
class SharedDto {
  @IsOptional() @IsString() @MaxLength(40) doctorId: string | null;
}
class CabinetDto {
  @IsString() @MaxLength(40) externalId: string;
  @IsBoolean() onlineBooking: boolean;
  @IsBoolean() acceptsUrgent: boolean;
}
class CabinetsDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CabinetDto) cabinets: CabinetDto[];
}
class ServiceDto {
  @IsString() @MaxLength(40) id: string;
  @IsBoolean() onlineBooking: boolean;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) cabinetIds: string[];
}
class ServicesDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ServiceDto) services: ServiceDto[];
}

// How the schedule is organised: by doctors (the default) or by cabinets through one shared account of Cliniccards
@Controller('booking-settings')
@UseGuards(AuthGuard)
export class CabinetBookingController {
  constructor(private cabinets: CabinetBookingService) {}

  @Get()
  @Roles(...READERS)
  get(@CurrentUser() u: AuthUser) {
    return this.cabinets.settings(u.clinicId, true);
  }

  @Put('mode')
  @Roles(...MANAGERS)
  mode(@CurrentUser() u: AuthUser, @Body() dto: ModeDto) {
    return this.cabinets.setMode(u.clinicId, u.userId, dto.mode);
  }

  @Put('shared-account')
  @Roles(...MANAGERS)
  shared(@CurrentUser() u: AuthUser, @Body() dto: SharedDto) {
    return this.cabinets.setShared(u.clinicId, u.userId, dto.doctorId ?? null);
  }

  @Put('cabinets')
  @Roles(...MANAGERS)
  setCabinets(@CurrentUser() u: AuthUser, @Body() dto: CabinetsDto) {
    return this.cabinets.setCabinets(u.clinicId, u.userId, dto.cabinets);
  }

  @Put('services')
  @Roles(...MANAGERS)
  setServices(@CurrentUser() u: AuthUser, @Body() dto: ServicesDto) {
    return this.cabinets.setServices(u.clinicId, u.userId, dto.services);
  }

  @Put('exceptions')
  @Roles(...MANAGERS)
  exceptions(@CurrentUser() u: AuthUser, @Body() body: { exceptions?: unknown }) {
    return this.cabinets.setExceptions(u.clinicId, u.userId, body?.exceptions);
  }
}
