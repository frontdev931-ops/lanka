import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { CHANNELS, InquiriesService } from './inquiries.service';

class CreateDto {
  @IsIn(CHANNELS as unknown as string[]) channel: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsDateString() occurredAt?: string;
}

class StatusDto {
  @IsIn(['OPEN', 'LOST']) status: 'OPEN' | 'LOST';
}

const READERS = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];
const WRITERS = [Role.OWNER, Role.MANAGER, Role.ADMIN];

@Controller('inquiries')
@UseGuards(AuthGuard)
export class InquiriesController {
  constructor(private inquiries: InquiriesService) {}

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser, @Query('filter') filter?: string, @Query('page') page?: string) {
    const f = filter === 'new' || filter === 'lost' ? filter : 'all';
    return this.inquiries.list(u.clinicId, f, Number.parseInt(page ?? '1', 10) || 1);
  }

  @Post()
  @Roles(...WRITERS)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDto) {
    return this.inquiries.create(u.clinicId, u.userId, dto);
  }

  @Patch(':id')
  @Roles(...WRITERS)
  status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: StatusDto) {
    return this.inquiries.setStatus(u.clinicId, id, dto.status);
  }

  @Delete(':id')
  @Roles(...WRITERS)
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.inquiries.remove(u.clinicId, id);
  }
}
