import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { DoctorsService } from './doctors.service';

const READERS = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];
const MANAGERS = [Role.OWNER, Role.MANAGER];

class PrimaryDto {
  @IsOptional() @IsString() @MaxLength(40) doctorId: string | null;
}
class ProfileDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) serviceIds?: string[];
  @IsOptional() @IsBoolean() acceptsUrgent?: boolean;
}

// The booking settings of the clinic: the doctor for a first booking, what each doctor provides, the online-booking schedule kept in LANKA
@Controller('doctors')
@UseGuards(AuthGuard)
export class DoctorsController {
  constructor(private doctors: DoctorsService) {}

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser) {
    return this.doctors.list(u.clinicId, true);
  }

  @Post('refresh')
  @HttpCode(200)
  @Roles(...MANAGERS)
  refresh(@CurrentUser() u: AuthUser) {
    return this.doctors.list(u.clinicId, true);
  }

  @Put('primary')
  @Roles(...MANAGERS)
  primary(@CurrentUser() u: AuthUser, @Body() dto: PrimaryDto) {
    return this.doctors.setPrimary(u.clinicId, u.userId, dto.doctorId ?? null);
  }

  @Put(':id/profile')
  @Roles(...MANAGERS)
  profile(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProfileDto) {
    return this.doctors.updateProfile(u.clinicId, u.userId, id, dto);
  }

  @Get(':id/availability')
  @Roles(...READERS)
  availability(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.doctors.getAvailability(u.clinicId, id);
  }

  @Put(':id/availability')
  @Roles(...MANAGERS)
  setAvailability(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.doctors.setAvailability(u.clinicId, u.userId, id, body);
  }
}
