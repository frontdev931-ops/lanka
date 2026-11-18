import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAdminGuard } from '../service/platform-access';
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
@UseGuards(AuthGuard, PlatformAdminGuard)
export class PlatformWebsiteController {
  constructor(private prisma: PrismaService, private leads: LeadsService, private requests: WebsiteRequestsService) {}

  @Get('website-requests')
  async openRequests() {
    return this.requests.openRequests();
  }

  private async details(clinicId: string) {
    const { secret, ...settings } = await this.leads.settings(clinicId);
    return settings;
  }

  @Get('clinics/:id/website')
  async website(@Param('id') id: string) {
    return this.details(id);
  }

  @Patch('clinics/:id/website')
  async configure(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: WebsiteConfigDto) {
    await this.leads.update(id, dto);
    await this.prisma.auditLog.create({ data: { clinicId: id, userId: u.userId, action: 'leads.settings', details: { origins: dto.origins?.length, formConfigured: dto.formConfig === undefined ? undefined : dto.formConfig !== null } } });
    return this.details(id);
  }

  @Patch('clinics/:id/website/requests/:requestId')
  async progress(@Param('id') id: string, @Param('requestId') requestId: string, @Body() dto: WebsiteProgressDto) {
    const { formConfig } = await this.leads.settings(id);
    await this.requests.record(id, requestId, dto.action, formConfig);
    return this.details(id);
  }
}
