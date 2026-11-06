import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn, IsInt, IsString, Min } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { AgentApprovalService, CHOICES, Choice } from './agent-approval.service';

class ApproveDto {
  // the revision of the draft that the staff member saw
  @IsInt() @Min(1) revision!: number;
  // the button that was pressed; the server checks that this button exists for the stored draft
  @IsIn([...CHOICES]) choice!: Choice;
}

class ResolveDto {
  @IsIn(['DELIVERED', 'NOT_DELIVERED']) outcome!: 'DELIVERED' | 'NOT_DELIVERED';
}

class LatestQuery {
  @IsString() channel!: string;
  @IsString() chatId!: string;
}

// Review and approval of the agent's drafts. The clinic is always the clinic of the signed-in user; the browser sends an id, the revision it saw and a button.
@Controller('agent-drafts')
@UseGuards(AuthGuard)
export class AgentDraftsController {
  constructor(private approval: AgentApprovalService) {}

  @Get('latest')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  async latest(@CurrentUser() u: AuthUser, @Query() q: LatestQuery) {
    return { draft: await this.approval.latest(u.clinicId, q.channel, q.chatId) };
  }

  @Post(':id/approve')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ApproveDto) {
    return this.approval.approve(u.clinicId, u.userId, id, { revision: dto.revision, choice: dto.choice });
  }

  @Post(':id/reject')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.approval.reject(u.clinicId, id);
  }

  // The step of the booking is made again for the state of the request now (no model call)
  @Post('refresh')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  @HttpCode(200)
  async refresh(@CurrentUser() u: AuthUser, @Body() q: LatestQuery) {
    return { draft: await this.approval.refresh(u.clinicId, q.channel, q.chatId) };
  }

  // After an unknown result of creating the visit: the clinic's system is checked, nothing is written blindly
  @Post(':id/recheck')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  @HttpCode(200)
  recheck(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.approval.recheck(u.clinicId, u.userId, id);
  }

  @Post(':id/resolve')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  @HttpCode(200)
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDto) {
    return this.approval.resolve(u.clinicId, u.userId, id, dto.outcome);
  }
}
