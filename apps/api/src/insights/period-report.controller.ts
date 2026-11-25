import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
class MoveDto {
  // switch the clinic's weekly report schedule on as part of the move (only when it is off; its own day and hour are kept)
  @IsOptional() @IsBoolean() enableSchedule?: boolean;
}
class HistoryQuery {
  @IsOptional() @IsIn(['WEEKLY', 'MONTHLY']) kind?: PeriodKind;
  @IsOptional() @Matches(/^\d{1,4}$/) page?: string;
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

  // Moving from the old rolling 7-day weekly digest: the preview of what changes for the signed-in person, then the explicit move
  @Get('legacy-weekly')
  legacyWeekly(@CurrentUser() u: AuthUser) {
    return this.reports.legacyWeekly(u.clinicId, u.userId);
  }

  @Post('legacy-weekly/move')
  @HttpCode(200)
  moveLegacyWeekly(@CurrentUser() u: AuthUser, @Body() dto: MoveDto) {
    return this.reports.moveLegacyWeekly(u.clinicId, u.userId, { enableSchedule: !!dto.enableSchedule });
  }

  // The history of saved reports: the clinic's scheduled ones and the person's own manual sends (counts of deliveries only, no recipients)
  @Get('runs')
  history(@CurrentUser() u: AuthUser, @Query() q: HistoryQuery) {
    return this.reports.history(u.clinicId, u.userId, q.kind, Number(q.page ?? 1));
  }

  // One saved report exactly as prepared (never recalculated); another clinic's id or another person's manual send: 404
  @Get('runs/:id')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('lang') lang?: string) {
    return this.reports.savedRun(u.clinicId, u.userId, id, signalLang(lang));
  }

  @Post('send-to-me')
  @HttpCode(200)
  sendToMe(@CurrentUser() u: AuthUser, @Body() dto: PeriodQuery) {
    return this.reports.sendToMe(u.clinicId, u.userId, dto.kind, dto.from, signalLang(dto.lang));
  }
}
