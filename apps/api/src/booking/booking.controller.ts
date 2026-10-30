import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { BookingService } from './booking.service';

const OPERATORS = [Role.OWNER, Role.MANAGER, Role.ADMIN];

class BookDto {
  @IsString() patientId: string;
  @IsISO8601() startsAt: string;
  @IsInt() @Min(5) @Max(240) durationMin: number;
  @IsString() @MaxLength(40) cabinetId: string;
  @IsOptional() @IsString() @MaxLength(40) doctorId?: string;
  @IsOptional() @IsString() @MaxLength(400) note?: string;
  @IsOptional() @IsString() requestId?: string;
}
class RescheduleDto {
  @IsISO8601() startsAt: string;
  @IsOptional() @IsInt() @Min(5) @Max(240) durationMin?: number;
  @IsOptional() @IsString() @MaxLength(40) cabinetId?: string;
  @IsOptional() @IsString() @MaxLength(40) doctorId?: string;
}
class PhoneDto {
  @IsString() @MaxLength(40) phone: string;
}
class VerifyDto {
  @IsString() patientId: string;
  @IsString() @MaxLength(300) answer: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() chatId?: string;
}
class NewPatientDto {
  @IsString() @MinLength(3) @MaxLength(120) fullName: string;
  @IsString() @MaxLength(40) phone: string;
  @IsOptional() @IsString() @MaxLength(60) source?: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() chatId?: string;
}

// Writing to the clinic's system on an explicit action of staff. Off for every clinic until the service owner enables it.
@Controller('bookings')
@UseGuards(AuthGuard)
@Roles(...OPERATORS)
export class BookingController {
  constructor(private booking: BookingService) {}

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.booking.status(u.clinicId);
  }

  @Get('options')
  options(@CurrentUser() u: AuthUser) {
    return this.booking.options(u.clinicId);
  }

  @Post()
  @HttpCode(200)
  book(@CurrentUser() u: AuthUser, @Body() dto: BookDto) {
    return this.booking.book(u.clinicId, u.userId, { ...dto, startsAt: new Date(dto.startsAt) });
  }

  @Post('visits/:id/reschedule')
  @HttpCode(200)
  reschedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RescheduleDto) {
    return this.booking.reschedule(u.clinicId, u.userId, id, { ...dto, startsAt: new Date(dto.startsAt) });
  }

  @Post('visits/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.booking.cancel(u.clinicId, u.userId, id);
  }

  @Post('visits/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.booking.confirm(u.clinicId, u.userId, id);
  }

  @Post('patients/match')
  @HttpCode(200)
  match(@CurrentUser() u: AuthUser, @Body() dto: PhoneDto) {
    return this.booking.matches(u.clinicId, dto.phone);
  }

  // The person's answer to "your surname or date of birth" is compared by code; on success the chat is linked to the card
  @Post('patients/verify')
  @HttpCode(200)
  async verify(@CurrentUser() u: AuthUser, @Body() dto: VerifyDto) {
    const ok = await this.booking.verify(u.clinicId, dto.patientId, dto.answer);
    if (ok && dto.channel && dto.chatId) await this.booking.linkChat(u.clinicId, dto.patientId, dto.channel, dto.chatId);
    return { verified: ok };
  }

  @Post('patients')
  @HttpCode(200)
  async createPatient(@CurrentUser() u: AuthUser, @Body() dto: NewPatientDto) {
    const r = await this.booking.createPatient(u.clinicId, u.userId, dto);
    if (dto.channel && dto.chatId) await this.booking.linkChat(u.clinicId, r.patientId, dto.channel, dto.chatId);
    return r;
  }
}
