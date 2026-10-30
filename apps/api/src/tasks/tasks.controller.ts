import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role, TaskResult, TaskStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { Lang, ReqLang } from '../common/i18n';
import { TasksService } from './tasks.service';

class CreateTaskDto {
  @IsString() @MinLength(2) title: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() patientId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(2) priority?: number;
}

class UpdateTaskDto {
  @IsOptional() @IsEnum(TaskStatus) status?: TaskStatus;
  @IsOptional() @IsEnum(TaskResult) result?: TaskResult | null;
  @IsOptional() @IsString() assigneeId?: string | null;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(2) priority?: number;
}

class FromReportDto {
  @IsString() reportId: string;
  @IsOptional() @IsInt() @Min(1) @Max(730) days?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) maxDays?: number;
  @IsOptional() @IsString() assigneeId?: string;
}

const WRITERS = [Role.OWNER, Role.MANAGER, Role.ADMIN];

@Controller('tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query('status') status?: TaskStatus,
    @Query('assigneeId') assigneeId?: string,
    @Query('patientId') patientId?: string,
  ) {
    return this.tasks.list(u.clinicId, {
      status: status && status in TaskStatus ? status : undefined,
      assigneeId: assigneeId === 'me' ? u.userId : assigneeId,
      patientId,
    });
  }

  @Get('summary')
  summary(@CurrentUser() u: AuthUser) {
    return this.tasks.summary(u.clinicId);
  }

  @Get('assignees')
  assignees(@CurrentUser() u: AuthUser) {
    return this.tasks.assignees(u.clinicId);
  }

  @Post()
  @Roles(...WRITERS)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(u.clinicId, u.userId, dto);
  }

  @Post('from-report')
  @Roles(...WRITERS)
  fromReport(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Body() dto: FromReportDto) {
    return this.tasks.fromReport(u.clinicId, u.userId, u.role, dto.reportId, dto.days, lang, dto.assigneeId, dto.maxDays);
  }

  @Patch(':id')
  @Roles(...WRITERS)
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(u.clinicId, u.userId, id, dto);
  }
}
