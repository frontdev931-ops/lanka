import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Options, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Allow, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { WebsiteRequestsService } from './website-requests.service';

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true }) origins?: string[];
  @Allow() formConfig?: unknown;
}

class WebsiteRequestDto {
  @IsString() @MaxLength(200) website: string;
}

// Settings of the lead intake: the owner and the manager
@Controller('automations/leads')
@UseGuards(AuthGuard)
export class LeadsSettingsController {
  constructor(
    private leads: LeadsService,
    private prisma: PrismaService,
    private websiteRequests: WebsiteRequestsService,
  ) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  async get(@CurrentUser() u: AuthUser) {
    return { ...(await this.leads.clinicSettings(u.clinicId)), canManageSecret: u.role === Role.OWNER };
  }

  @Patch()
  @Roles(Role.OWNER, Role.MANAGER)
  async patch(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    if (dto.formConfig !== undefined) throw new ForbiddenException();
    await this.leads.update(u.clinicId, { enabled: dto.enabled, origins: dto.origins });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.settings', details: { enabled: dto.enabled, origins: dto.origins?.length } } });
    return this.leads.clinicSettings(u.clinicId);
  }

  @Post('connection-request')
  @Roles(Role.OWNER)
  @HttpCode(200)
  request(@CurrentUser() u: AuthUser, @Body() dto: WebsiteRequestDto, @Headers('accept-language') acceptLanguage?: string) {
    const lang = acceptLanguage?.slice(0, 2);
    return this.websiteRequests.request(u, dto.website.trim(), lang === 'ru' || lang === 'en' ? lang : 'uk');
  }

  @Post('rotate-key')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async rotate(@CurrentUser() u: AuthUser) {
    const r = await this.leads.rotateKey(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.key_rotated' } });
    return r;
  }
  // Meta Lead Ads: the state of the clinic's ad forms (connection, permission, subscription, last lead, leads not fetched yet)
  @Get('meta')
  @Roles(Role.OWNER, Role.MANAGER)
  meta(@CurrentUser() u: AuthUser) {
    return this.leads.leadAdsStatus(u.clinicId);
  }

  // The server secret: the owner only. The answer shows it once; later only its last four characters.
  @Post('secret')
  @Roles(Role.OWNER)
  @HttpCode(200)
  async secret(@CurrentUser() u: AuthUser) {
    const r = await this.leads.newSecret(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.secret_created' } });
    return r;
  }

  @Delete('secret')
  @Roles(Role.OWNER)
  async revoke(@CurrentUser() u: AuthUser) {
    const r = await this.leads.revokeSecret(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.secret_revoked' } });
    return r;
  }
}

// The public addresses for website forms. A browser posts to /leads/<public form key> from a listed site; a server posts to /leads/v1/enquiries with its secret.
@Controller('leads')
export class LeadsPublicController {
  constructor(private leads: LeadsService) {}

  private async cors(key: string, req: Request, res: Response) {
    const origin = req.headers.origin;
    if (origin && (await this.leads.originAllowed(key, origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  // A website's server (server-to-server): Authorization: Bearer <secret>; an optional Idempotency-Key header makes a retry the same enquiry.
  // No CORS headers: a browser must never hold the secret.
  @Post('v1/enquiries')
  @HttpCode(200)
  serverSubmit(@Body() body: Record<string, unknown>, @Headers('authorization') authz: string | undefined, @Headers('idempotency-key') idem: string | undefined, @Req() req: Request) {
    return this.leads.submitServer(authz, idem, req.ip ?? req.socket.remoteAddress ?? 'unknown', body ?? {});
  }

  @Options(':key')
  @HttpCode(204)
  async preflight(@Param('key') key: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
  }

  // JSON or a classic form (application/x-www-form-urlencoded)
  @Post(':key')
  @HttpCode(200)
  async submit(@Param('key') key: string, @Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
    return this.leads.submit(key, req.headers.origin, req.ip ?? req.socket.remoteAddress ?? 'unknown', body ?? {});
  }
}
