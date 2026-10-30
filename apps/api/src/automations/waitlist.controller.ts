import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsArray, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { WaitlistService } from './waitlist.service';

class EntryDto {
  @IsString() patientId: string;
  @IsOptional() @IsString() @MaxLength(120) doctorName?: string | null;
  @IsOptional() @IsArray() @IsInt({ each: true }) weekdays?: number[];
  @IsOptional() @IsInt() fromHour?: number;
  @IsOptional() @IsInt() toHour?: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

@Controller('waitlist')
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
export class WaitlistController {
  constructor(private waitlist: WaitlistService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.waitlist.list(u.clinicId);
  }

  @Post()
  async add(@CurrentUser() u: AuthUser, @Body() dto: EntryDto) {
    return { id: await this.waitlist.add(u.clinicId, u.userId, dto) };
  }

  @Delete(':id')
  async cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.waitlist.cancel(u.clinicId, u.userId, id);
    return { ok: true };
  }
}
