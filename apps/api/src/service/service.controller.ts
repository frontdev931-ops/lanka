import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from './usage.service';

class SecurityDto {
  @IsBoolean() require2fa: boolean;
}

// What the clinic itself sees: its plan, limits and usage, and the clinic-wide security switch
@Controller('service')
@UseGuards(AuthGuard)
export class ServiceController {
  constructor(
    private usage: UsageService,
    private prisma: PrismaService,
  ) {}

  @Get('usage')
  @Roles(Role.OWNER, Role.MANAGER)
  get(@CurrentUser() u: AuthUser) {
    return this.usage.overview(u.clinicId);
  }

  // Only the owner can require two-factor sign-in, and only after turning it on for themselves (otherwise they would lock themselves out)
  @Patch('security')
  @Roles(Role.OWNER)
  async security(@CurrentUser() u: AuthUser, @Body() dto: SecurityDto) {
    if (dto.require2fa) {
      const me = await this.prisma.user.findUniqueOrThrow({ where: { id: u.userId }, select: { totpEnabledAt: true } });
      if (!me.totpEnabledAt) throw new BadRequestException('twofa_owner_first');
    }
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { require2fa: dto.require2fa } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.require2fa', details: { require2fa: dto.require2fa } } });
    return this.usage.overview(u.clinicId);
  }
}
