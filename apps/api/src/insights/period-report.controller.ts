import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PeriodKind } from './period-report-text';
import { PeriodReportService } from './period-report.service';
import { signalLang } from './signal-text';

class ScheduleDto {
  @IsOptional() @IsBoolean() weeklyOn?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(7) weeklyWeekday?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) weeklyHour?: number;
  @IsOptional() @IsBoolean() monthlyOn?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) monthlyHour?: number;
}
class PeriodQuery {
  @IsIn(['WEEKLY', 'MONTHLY']) kind: PeriodKind;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @IsIn(['uk', 'ru', 'en']) lang?: string;
}

// Weekly and monthly reports to managers: the clinic's schedule, the report page with the exact text (read only) and "send to my Telegram".
// Owner and manager only (the report contains money); the clinic always comes from the session.
@Controller('period-reports')
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER)
export class PeriodReportController {
  constructor(private reports: PeriodReportService) {}

  @Get('settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.reports.settings(u.clinicId);
  }

  @Patch('settings')
  update(@CurrentUser() u: AuthUser, @Body() dto: ScheduleDto) {
    return this.reports.updateSettings(u.clinicId, u.userId, dto);
  }

  @Get('preview')
  preview(@CurrentUser() u: AuthUser, @Query() q: PeriodQuery) {
    return this.reports.preview(u.clinicId, q.kind, q.from, signalLang(q.lang));
  }

  @Post('send-to-me')
  @HttpCode(200)
  sendToMe(@CurrentUser() u: AuthUser, @Body() dto: PeriodQuery) {
    return this.reports.sendToMe(u.clinicId, u.userId, dto.kind, dto.from, signalLang(dto.lang));
  }
}
