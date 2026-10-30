import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { Action, AutomationInput, Conditions, CustomAutomationsService, Stop, Trigger } from './custom-automations.service';

class AutomationDto implements AutomationInput {
  @IsString() @MaxLength(200) name: string;
  @IsIn(['service', 'marketing']) kind: 'service' | 'marketing';
  @IsObject() trigger: Trigger;
  @IsOptional() @IsObject() conditions?: Conditions;
  @IsObject() action: Action;
  @IsOptional() @IsObject() stop?: Stop;
  @IsOptional() @IsString() @MaxLength(60) templateKey?: string | null;
}
class PatchDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsIn(['service', 'marketing']) kind?: 'service' | 'marketing';
  @IsOptional() @IsObject() trigger?: Trigger;
  @IsOptional() @IsObject() conditions?: Conditions;
  @IsOptional() @IsObject() action?: Action;
  @IsOptional() @IsObject() stop?: Stop;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

// Automations of the clinic: built and switched on by the owner and the manager
@Controller('custom-automations')
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER)
export class CustomAutomationsController {
  constructor(private svc: CustomAutomationsService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    return { automations: await this.svc.list(u.clinicId), templates: this.svc.templates() };
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: AutomationDto) {
    return { id: await this.svc.create(u.clinicId, u.userId, dto) };
  }

  @Post('preview')
  @HttpCode(200)
  previewDraft(@CurrentUser() u: AuthUser, @Body() dto: AutomationDto) {
    return this.svc.previewDraft(u.clinicId, dto);
  }

  @Get(':id/preview')
  preview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.preview(u.clinicId, id);
  }

  @Get(':id/journal')
  journal(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.journal(u.clinicId, id);
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PatchDto) {
    await this.svc.update(u.clinicId, u.userId, id, dto);
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.remove(u.clinicId, u.userId, id);
    return { ok: true };
  }
}
