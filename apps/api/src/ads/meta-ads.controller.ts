import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { IsString, Matches, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { metaWebOrigin } from '../automations/meta-chat.service';
import { MetaAdsService } from './meta-ads.service';

const VIEWERS = [Role.OWNER, Role.MANAGER, Role.ANALYST];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class PeriodDto {
  @IsString() @Matches(DAY) since: string;
  @IsString() @Matches(DAY) until: string;
}
class SelectDto {
  @IsString() @MaxLength(60) sessionId: string;
  @IsString() @Matches(/^\d{1,30}$/) accountId: string;
}

// Reports → "Advertising": the owner connects one Meta ad account (read only); the owner, the manager and the analyst see its figures
@Controller('meta-ads')
@UseGuards(AuthGuard)
export class MetaAdsController {
  constructor(private ads: MetaAdsService) {}

  @Get()
  @Roles(...VIEWERS)
  status(@CurrentUser() u: AuthUser) {
    return this.ads.status(u.clinicId, u.role);
  }

  @Get('report')
  @Roles(...VIEWERS)
  report(@CurrentUser() u: AuthUser, @Query() q: PeriodDto) {
    return this.ads.report(u.clinicId, q.since, q.until);
  }

  @Post('refresh')
  @Roles(...VIEWERS)
  @HttpCode(200)
  refresh(@CurrentUser() u: AuthUser, @Body() dto: PeriodDto) {
    return this.ads.refresh(u.clinicId, dto.since, dto.until);
  }

  @Get('connect-url')
  @Roles(Role.OWNER)
  connectUrl(@CurrentUser() u: AuthUser) {
    return this.ads.startUrl(u.clinicId, u.userId);
  }

  @Get('sessions/:id')
  @Roles(Role.OWNER)
  pending(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ads.pending(u.clinicId, u.userId, id);
  }

  @Post('select')
  @Roles(Role.OWNER)
  @HttpCode(200)
  select(@CurrentUser() u: AuthUser, @Body() dto: SelectDto) {
    return this.ads.select(u.clinicId, u.userId, dto.sessionId, dto.accountId);
  }

  @Delete()
  @Roles(Role.OWNER)
  disconnect(@CurrentUser() u: AuthUser) {
    return this.ads.disconnect(u.clinicId, u.userId);
  }
}

// Facebook returns the owner here after the ads login (separate from /meta/oauth/callback of Instagram and Messenger)
@Controller('meta-ads')
export class MetaAdsPublicController {
  constructor(private ads: MetaAdsService) {}

  @Get('oauth/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const page = (q: string) => `${metaWebOrigin()}/ads?${q}`;
    try {
      const r = await this.ads.finish(code, state, error);
      res.redirect(r.kind === 'connected' ? page('meta=ok') : page(`meta=select&s=${encodeURIComponent(r.sessionId)}`));
    } catch (e) {
      const key = e instanceof HttpException ? String((e.getResponse() as { message?: unknown })?.message ?? e.getResponse()) : '';
      const code = ({ meta_ads_denied: 'denied', meta_ads_no_permission: 'noperm', meta_ads_no_accounts: 'noaccounts', meta_ads_not_ready: 'off', demo_restricted: 'demo' } as Record<string, string>)[key] ?? 'fail';
      res.redirect(page(`meta=${code}`));
    }
  }
}
