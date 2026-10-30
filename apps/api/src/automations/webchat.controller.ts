import { Body, Controller, Get, Headers, HttpCode, Options, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WebChatService } from './webchat.service';

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true }) origins?: string[];
  @IsOptional() @IsString() @MaxLength(300) greeting?: string | null;
}
class SessionDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}
class MessageDto {
  @IsOptional() @IsString() @MaxLength(1200) text?: string;
  @IsOptional() @IsString() @MaxLength(120) payload?: string;
}

// Settings of the widget: the owner and the manager
@Controller('automations/webchat')
@UseGuards(AuthGuard)
export class WebChatSettingsController {
  constructor(
    private web: WebChatService,
    private prisma: PrismaService,
  ) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  get(@CurrentUser() u: AuthUser) {
    return this.web.settings(u.clinicId);
  }

  @Patch()
  @Roles(Role.OWNER, Role.MANAGER)
  async patch(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    const r = await this.web.update(u.clinicId, dto);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'webchat.settings', details: { enabled: dto.enabled, origins: dto.origins?.length } } });
    return r;
  }

  @Post('rotate-key')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async rotate(@CurrentUser() u: AuthUser) {
    const r = await this.web.rotateKey(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'webchat.key_rotated' } });
    return r;
  }
}

// Public side of the widget. No sign-in: the key and the site's address (Origin) decide, and every call is rate limited.
@Controller('webchat')
export class WebChatPublicController {
  constructor(private web: WebChatService) {}

  // CORS: only a site on the clinic's list gets the headers; the answer to anything else carries none
  private async cors(key: string, req: Request, res: Response) {
    const origin = req.headers.origin;
    if (origin && (await this.web.originAllowed(key, origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  private ip(req: Request) {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  }

  @Options(':key/:rest')
  @HttpCode(204)
  async preflight(@Param('key') key: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
  }

  @Get(':key/config')
  async config(@Param('key') key: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
    return this.web.config(key, req.headers.origin);
  }

  @Post(':key/session')
  @HttpCode(200)
  async session(@Param('key') key: string, @Body() dto: SessionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
    const r = await this.web.startSession(key, req.headers.origin, this.ip(req), dto);
    return { token: r.token };
  }

  @Post(':key/messages')
  @HttpCode(200)
  async send(@Param('key') key: string, @Body() dto: MessageDto, @Headers('authorization') auth: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
    return this.web.send(key, req.headers.origin, auth, this.ip(req), dto);
  }

  @Get(':key/messages')
  async history(@Param('key') key: string, @Query('after') after: string | undefined, @Headers('authorization') auth: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.cors(key, req, res);
    return this.web.history(key, req.headers.origin, auth, after);
  }
}
