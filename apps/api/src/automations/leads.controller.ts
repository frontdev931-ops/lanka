import { Body, Controller, Get, HttpCode, Options, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true }) origins?: string[];
}

// Settings of the lead intake: the owner and the manager
@Controller('automations/leads')
@UseGuards(AuthGuard)
export class LeadsSettingsController {
  constructor(
    private leads: LeadsService,
    private prisma: PrismaService,
  ) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  get(@CurrentUser() u: AuthUser) {
    return this.leads.settings(u.clinicId);
  }

  @Patch()
  @Roles(Role.OWNER, Role.MANAGER)
  async patch(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    const r = await this.leads.update(u.clinicId, dto);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.settings', details: { enabled: dto.enabled, origins: dto.origins?.length } } });
    return r;
  }

  @Post('rotate-key')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async rotate(@CurrentUser() u: AuthUser) {
    const r = await this.leads.rotateKey(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'leads.key_rotated' } });
    return r;
  }
}

// The public address that site forms and form plugins post to. No sign-in: the secret key in the address decides.
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
