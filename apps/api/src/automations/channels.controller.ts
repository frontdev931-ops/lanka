import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Param, Post, Query, Req, Res, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { MetaLoginService } from './meta-login.service';
import { metaWebOrigin } from './meta-chat.service';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { FacebookService } from './facebook.service';
import type { MetaWebhook } from './meta-graph.api';
import type { WaWebhook } from './whatsapp.api';
import { LeadsService } from './leads.service';
import { ViberService } from './viber.service';
import { WhatsAppService } from './whatsapp.service';

const MANAGERS = [Role.OWNER, Role.MANAGER];

class TokenDto {
  @IsString() @MinLength(20) @MaxLength(2000) token: string;
}
class WhatsAppDto extends TokenDto {
  @IsString() @MaxLength(30) phoneNumberId: string;
}
class MetaConnectDto {
  @IsString() @MaxLength(60) sessionId: string;
  @IsString() @MaxLength(60) pageId: string;
}
const metaPage = (code: string, session?: string) => `${metaWebOrigin()}/automations?meta=${code}${session ? `&session=${encodeURIComponent(session)}` : ''}`;
function metaCode(e: unknown): string {
  if (!(e instanceof HttpException)) return 'fail';
  const r = e.getResponse();
  const key = typeof r === 'string' ? r : r && typeof r === 'object' && 'message' in r ? String((r as { message: unknown }).message) : '';
  return ({ meta_oauth_denied: 'denied', channel_account_taken: 'taken', plan_feature: 'plan', demo_restricted: 'demo', meta_oauth_not_ready: 'off', meta_no_pages: 'nopages', meta_no_permissions: 'noperm', meta_subscribe_denied: 'subscribe', meta_subscribe_failed: 'subscribe' } as Record<string, string>)[key] ?? 'fail';
}
class ViberDto {
  @IsObject() credentials: Record<string, string>;
}

// The other messenger channels: connect and disconnect (the owner or the manager), and the status of all of them in one answer
@Controller('automations')
@UseGuards(AuthGuard)
export class ChannelsController {
  constructor(
    private prisma: PrismaService,
    private facebook: FacebookService,
    private whatsapp: WhatsAppService,
    private viber: ViberService,
    private metaLogin: MetaLoginService,
  ) {}

  @Get('channels')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST)
  async statuses(@CurrentUser() u: AuthUser) {
    const [messenger, whatsapp, viber] = await Promise.all([this.facebook.status(u.clinicId), this.whatsapp.status(u.clinicId), this.viber.status(u.clinicId)]);
    return { messenger, whatsapp, viber };
  }

  // The owner is sent to Facebook (Login for Business with our configuration); Facebook returns them to /meta/oauth/callback
  @Get('meta/oauth')
  @Roles(...MANAGERS)
  async startMeta(@CurrentUser() u: AuthUser, @Res() res: Response) {
    try {
      res.redirect(await this.metaLogin.startUrl(u.clinicId, u.userId));
    } catch (e) {
      res.redirect(metaPage(metaCode(e)));
    }
  }

  // The pages to choose from after the return (the choice is needed only when the person picked several)
  @Get('meta/pending/:id')
  @Roles(...MANAGERS)
  pendingMeta(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.metaLogin.pending(u.clinicId, id);
  }

  @Post('meta/connect')
  @Roles(...MANAGERS)
  @HttpCode(200)
  connectMeta(@CurrentUser() u: AuthUser, @Body() dto: MetaConnectDto) {
    return this.metaLogin.connect(u.clinicId, u.userId, dto.sessionId, dto.pageId);
  }

  private audit(u: AuthUser, action: string) {
    return this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action } });
  }

  @Post('messenger')
  @Roles(...MANAGERS)
  @HttpCode(200)
  async connectMessenger(@CurrentUser() u: AuthUser, @Body() dto: TokenDto) {
    const r = await this.facebook.connect(u.clinicId, dto.token.trim());
    await this.audit(u, 'messenger.connected');
    return r;
  }

  @Delete('messenger')
  @Roles(...MANAGERS)
  async disconnectMessenger(@CurrentUser() u: AuthUser) {
    const r = await this.facebook.disconnect(u.clinicId);
    await this.audit(u, 'messenger.disconnected');
    return r;
  }

  @Post('whatsapp')
  @Roles(...MANAGERS)
  @HttpCode(200)
  async connectWhatsApp(@CurrentUser() u: AuthUser, @Body() dto: WhatsAppDto) {
    const r = await this.whatsapp.connect(u.clinicId, dto.token.trim(), dto.phoneNumberId.trim());
    await this.audit(u, 'whatsapp.connected');
    return r;
  }

  @Delete('whatsapp')
  @Roles(...MANAGERS)
  async disconnectWhatsApp(@CurrentUser() u: AuthUser) {
    const r = await this.whatsapp.disconnect(u.clinicId);
    await this.audit(u, 'whatsapp.disconnected');
    return r;
  }

  @Post('viber')
  @Roles(...MANAGERS)
  @HttpCode(200)
  async connectViber(@CurrentUser() u: AuthUser, @Body() dto: ViberDto) {
    const r = await this.viber.connect(u.clinicId, dto.credentials);
    await this.audit(u, 'viber.connected');
    return r;
  }

  @Delete('viber')
  @Roles(...MANAGERS)
  async disconnectViber(@CurrentUser() u: AuthUser) {
    const r = await this.viber.disconnect(u.clinicId);
    await this.audit(u, 'viber.disconnected');
    return r;
  }
}

// Facebook Messenger webhook (the same Meta app, signature and verify token as Instagram)
@Controller('messenger')
export class MessengerWebhookController {
  constructor(
    private facebook: FacebookService,
    private leads: LeadsService,
  ) {}

  @Get('webhook')
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.facebook.verify(mode, token, challenge);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: MetaWebhook) {
    await this.facebook.handleWebhook(req.rawBody, signature, body).catch(() => undefined);
    // the same webhook carries the leads of advertising forms
    await this.leads.handleWebhook(req.rawBody, signature, body as never).catch(() => undefined);
    return { ok: true };
  }
}

@Controller('whatsapp')
export class WhatsAppWebhookController {
  constructor(private whatsapp: WhatsAppService) {}

  @Get('webhook')
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.whatsapp.verify(mode, token, challenge);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: WaWebhook) {
    await this.whatsapp.handleWebhook(req.rawBody, signature, body).catch(() => undefined);
    return { ok: true };
  }
}

// Facebook returns the person here after the login. No sign-in: the signed state tells whose connection it is.
@Controller('meta')
export class MetaLoginPublicController {
  constructor(private metaLogin: MetaLoginService) {}

  @Get('oauth/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    try {
      const r = await this.metaLogin.finish(code, state, error);
      res.redirect(r.kind === 'connected' ? metaPage(r.result.messenger ? 'ok' : 'ok_instagram') : metaPage('select', r.sessionId));
    } catch (e) {
      res.redirect(metaPage(metaCode(e)));
    }
  }
}

