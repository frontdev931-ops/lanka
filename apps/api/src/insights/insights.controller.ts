import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { InsightsService, ScheduleInput } from './insights.service';

class ScheduleDto implements ScheduleInput {
  @IsString() @MaxLength(40) savedReportId: string;
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @IsInt() hour: number;
  @IsInt() weekday: number;
  @IsInt() monthDay: number;
  @IsIn(['XLSX', 'PDF']) format: 'XLSX' | 'PDF';
  @IsArray() @IsString({ each: true }) recipientIds: string[];
}
class SchedulePatchDto {
  @IsOptional() @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @IsOptional() @IsInt() hour?: number;
  @IsOptional() @IsInt() weekday?: number;
  @IsOptional() @IsInt() monthDay?: number;
  @IsOptional() @IsIn(['XLSX', 'PDF']) format?: 'XLSX' | 'PDF';
  @IsOptional() @IsArray() @IsString({ each: true }) recipientIds?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class AlertDto {
  // the master switch of the rule (off: not measured, nothing delivered on any channel)
  @IsOptional() @IsBoolean() active?: boolean;
  // the email to the owner
  @IsOptional() @IsBoolean() enabled?: boolean;
  // Push notifications to the clinic's subscribed devices
  @IsOptional() @IsBoolean() push?: boolean;
  // the staff Telegram chat
  @IsOptional() @IsBoolean() telegram?: boolean;
  @IsOptional() @IsNumber() threshold?: number;
  @IsOptional() @IsInt() windowDays?: number;
  @IsOptional() @IsInt() hours?: number;
}

// Reports on a schedule and signals for the manager: set up by the owner and the manager
@Controller()
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER)
export class InsightsController {
  constructor(private insights: InsightsService) {}

  @Get('scheduled-reports')
  async list(@CurrentUser() u: AuthUser) {
    return { schedules: await this.insights.list(u.clinicId), members: await this.insights.members(u.clinicId) };
  }

  @Post('scheduled-reports')
  async create(@CurrentUser() u: AuthUser, @Body() dto: ScheduleDto) {
    return { id: await this.insights.create(u.clinicId, u.userId, dto) };
  }

  @Patch('scheduled-reports/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SchedulePatchDto) {
    await this.insights.update(u.clinicId, u.userId, id, dto);
    return { ok: true };
  }

  @Delete('scheduled-reports/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.insights.remove(u.clinicId, u.userId, id);
    return { ok: true };
  }

  @Post('scheduled-reports/:id/run')
  @HttpCode(200)
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.insights.runNow(u.clinicId, id);
  }

  // The "Signals" section: the clinic's rules measured now (read only; the clinic comes from the session)
  @Get('signals')
  signals(@CurrentUser() u: AuthUser) {
    return this.insights.signals(u.clinicId);
  }

  // The menu badge: the number of switched-on signals with a deviation now (cached for a few minutes, see InsightsService.signalsSummary)
  @Get('signals/summary')
  signalsSummary(@CurrentUser() u: AuthUser) {
    return this.insights.signalsSummary(u.clinicId);
  }

  @Get('alerts')
  alerts(@CurrentUser() u: AuthUser) {
    return this.insights.alerts(u.clinicId);
  }

  @Patch('alerts/:kind')
  async updateAlert(@CurrentUser() u: AuthUser, @Param('kind') kind: string, @Body() dto: AlertDto) {
    await this.insights.updateAlert(u.clinicId, u.userId, kind, dto);
    return this.insights.alerts(u.clinicId);
  }
}
