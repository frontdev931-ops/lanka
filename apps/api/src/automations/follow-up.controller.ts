import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsObject, IsOptional } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { FollowUpService } from './follow-up.service';

class FollowUpSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  // days between the two Telegram follow-ups
  @IsOptional() @IsInt() days?: number;
  // the clinic's own texts: { PRICE|TIME|SILENT|AGAIN: { uk?, ru? } }
  @IsOptional() @IsObject() texts?: Record<string, Record<string, string>>;
}

// Follow-ups to the agent's dialogues that stopped before a booking. The clinic is the signed-in user's; the settings belong to the owner and the manager,
// the list and the sending also to the administrator who works with the conversations.
@Controller('follow-ups')
@UseGuards(AuthGuard)
export class FollowUpController {
  constructor(private followUps: FollowUpService) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  async list(@CurrentUser() u: AuthUser) {
    return { settings: await this.followUps.settings(u.clinicId), items: await this.followUps.list(u.clinicId) };
  }

  @Patch('settings')
  @Roles(Role.OWNER, Role.MANAGER)
  update(@CurrentUser() u: AuthUser, @Body() dto: FollowUpSettingsDto) {
    return this.followUps.updateSettings(u.clinicId, u.userId, dto);
  }

  @Post(':id/send')
  @HttpCode(200)
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  send(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.followUps.sendNow(u.clinicId, u.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.followUps.cancel(u.clinicId, u.userId, id);
  }
}
