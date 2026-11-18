import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { AgentSettingsService } from './agent-settings.service';

class ServicesDto {
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) ids: string[];
}

// The clinic's own settings of the autonomous patient agent. The state is readable by the owner and the manager; only the OWNER changes it.
// The clinic always comes from the session, never from the request.
@Controller('ai/agent')
@UseGuards(AuthGuard)
export class AgentSettingsController {
  constructor(private agent: AgentSettingsService) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  status(@CurrentUser() u: AuthUser) {
    return this.agent.status(u.clinicId);
  }

  @Put('services')
  @Roles(Role.OWNER)
  services(@CurrentUser() u: AuthUser, @Body() dto: ServicesDto) {
    return this.agent.setServices(u.clinicId, u.userId, dto.ids);
  }

  @Post('activate')
  @HttpCode(200)
  @Roles(Role.OWNER)
  activate(@CurrentUser() u: AuthUser) {
    return this.agent.activate(u.clinicId, u.userId);
  }

  @Post('deactivate')
  @HttpCode(200)
  @Roles(Role.OWNER)
  deactivate(@CurrentUser() u: AuthUser) {
    return this.agent.deactivate(u.clinicId, u.userId);
  }
}
