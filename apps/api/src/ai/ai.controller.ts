import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from './ai.service';

class AiDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoBooking?: boolean;
  @IsOptional() @IsBoolean() autoReply?: boolean;
  @IsOptional() @IsBoolean() assistant?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) monthlyLimit?: number;
}

@Controller('ai')
@UseGuards(AuthGuard)
export class AiController {
  constructor(
    private ai: AiService,
    private prisma: PrismaService,
  ) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST)
  status(@CurrentUser() u: AuthUser) {
    return this.ai.status(u.clinicId);
  }

  @Patch()
  @Roles(Role.OWNER, Role.MANAGER)
  async update(@CurrentUser() u: AuthUser, @Body() dto: AiDto) {
    const r = await this.ai.update(u.clinicId, dto);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'ai.settings', details: { ...dto } } });
    return r;
  }
}
