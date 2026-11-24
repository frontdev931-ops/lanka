import { Body, Controller, Delete, Get, Headers, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import type { TgUpdate } from './telegram.api';
import { LeaderTelegramService } from './leader-telegram.service';

class LeaderTelegramDto {
  @IsOptional() @IsBoolean() digest?: boolean;
  @IsOptional() @IsBoolean() signals?: boolean;
}

// "Telegram for reports and signals": the signed-in owner or manager connects their OWN Telegram to the shared LANKA service bot for the clinic
// of the session (never another person, never by a phone or a chat id)
@Controller('leader-telegram')
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER)
export class LeaderTelegramController {
  constructor(private leader: LeaderTelegramService) {}

  @Get()
  view(@CurrentUser() u: AuthUser) {
    return this.leader.view(u.clinicId, u.userId);
  }

  @Post('link')
  link(@CurrentUser() u: AuthUser) {
    return this.leader.link(u.clinicId, u.userId);
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: LeaderTelegramDto) {
    return this.leader.update(u.clinicId, u.userId, dto);
  }

  @Delete()
  disconnect(@CurrentUser() u: AuthUser) {
    return this.leader.disconnect(u.clinicId, u.userId);
  }
}

// The service bot's webhook (production). No sign-in: Telegram repeats LANKA_TG_WEBHOOK_SECRET in the header; anything else is ignored.
// Separate from the clinic bots' /telegram/webhook/:secret, so the two never mix.
@Controller('telegram-lanka')
export class LeaderTelegramWebhookController {
  constructor(private leader: LeaderTelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Headers('x-telegram-bot-api-secret-token') header: string | undefined, @Body() update: TgUpdate) {
    await this.leader.webhook(header, update).catch(() => undefined);
    return { ok: true };
  }
}
