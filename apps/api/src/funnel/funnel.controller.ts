import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { FunnelService, REASONS, Reason } from './funnel.service';

// The patient funnel. It has no money sums of the clinic, but it has patients' payments and debts: closed to the doctor, like the financial reports.
const ALLOWED = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];

const months = (v?: string) => Math.min(36, Math.max(1, Number.parseInt(v ?? '', 10) || 12));

@Controller('funnel')
@UseGuards(AuthGuard)
@Roles(...ALLOWED)
export class FunnelController {
  constructor(private funnel: FunnelService) {}

  @Get()
  overview(@CurrentUser() u: AuthUser, @Query('months') m?: string, @Query('source') source?: string, @Query('direction') direction?: string) {
    // Money of the cohort only for roles that may see money (not for the administrator)
    return this.funnel.overview(u.clinicId, { months: months(m), source: source || undefined, direction: direction || undefined }, ([Role.OWNER, Role.MANAGER, Role.ANALYST] as Role[]).includes(u.role));
  }

  // Top of the funnel: inquiries → card → appointment → came
  @Get('inquiries')
  inquiries(@CurrentUser() u: AuthUser, @Query('months') m?: string, @Query('channel') channel?: string) {
    return this.funnel.inquiryFunnel(u.clinicId, months(m), channel || undefined);
  }

  // Team work by our own data: who logged inquiries, handled requests and logged contacts
  @Get('staff')
  staff(@CurrentUser() u: AuthUser, @Query('months') m?: string) {
    return this.funnel.staff(u.clinicId, months(m));
  }

  @Get('people')
  people(@CurrentUser() u: AuthUser, @Query('reason') reason: string, @Query('months') m?: string, @Query('source') source?: string, @Query('direction') direction?: string) {
    if (!REASONS.includes(reason as Reason)) throw new BadRequestException('bad_reason');
    return this.funnel.people(u.clinicId, { months: months(m), source: source || undefined, direction: direction || undefined }, reason as Reason);
  }
}
