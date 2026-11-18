import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { assertPlatformAdmin } from '../service/platform.controller';
import { LeadsService } from './leads.service';
import { WebsiteRequestsService } from './website-requests.service';

class WebsiteConfigDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true }) origins?: string[];
  @IsOptional() @IsObject() formConfig?: Record<string, unknown> | null;
}

class WebsiteProgressDto {
  @IsIn(['installed', 'complete']) action: 'installed' | 'complete';
}

@Controller('platform')
@UseGuards(AuthGuard)
export class PlatformWebsiteController {
  constructor(private prisma: PrismaService, private leads: LeadsService, private requests: WebsiteRequestsService) {}

  @Get('website-requests')
  async openRequests(@CurrentUser() u: AuthUser) {
    await assertPlatformAdmin(this.prisma, u.userId);
    return this.requests.openRequests();
  }

  private async details(clinicId: string) {
    const { secret, ...settings } = await this.leads.settings(clinicId);
    return settings;
  }

  @Get('clinics/:id/website')
  async website(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await assertPlatformAdmin(this.prisma, u.userId);
    return this.details(id);
  }

  @Patch('clinics/:id/website')
  async configure(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: WebsiteConfigDto) {
    await assertPlatformAdmin(this.prisma, u.userId);
    await this.leads.update(id, dto);
    await this.prisma.auditLog.create({ data: { clinicId: id, userId: u.userId, action: 'leads.settings', details: { origins: dto.origins?.length, formConfigured: dto.formConfig === undefined ? undefined : dto.formConfig !== null } } });
    return this.details(id);
  }

  @Patch('clinics/:id/website/requests/:requestId')
  async progress(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('requestId') requestId: string, @Body() dto: WebsiteProgressDto) {
    await assertPlatformAdmin(this.prisma, u.userId);
    const { formConfig } = await this.leads.settings(id);
    await this.requests.record(id, requestId, dto.action, formConfig);
    return this.details(id);
  }
}
