import { Module } from '@nestjs/common';
import { InvitePublicController, TeamController, TeamMembersController } from './team.controller';

@Module({ controllers: [TeamController, TeamMembersController, InvitePublicController] })
export class TeamModule {}
