import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { assertAutoServiceSet, configuredAutoServiceIds } from '../automations/agent-auto-gate';
import { BillingService, launchEligible } from '../billing/billing.service';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_KEYS, PLANS, effectiveLimits, monthStart } from './plans';
import { PlatformAdminGuard } from './platform-access';

class ClinicPatchDto {
  // NETWORK is given only by a network (a branch joins it): never set by hand
  @IsOptional() @IsIn(PLAN_KEYS.filter((k) => k !== 'NETWORK')) plan?: string;
  @IsOptional() @IsBoolean() suspended?: boolean;
  @IsOptional() @IsObject() limits?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) aiMonthlyLimit?: number;
  // Manual billing (a deal outside online acquiring, a correction)
  @IsOptional() @IsIn(['AWAITING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'LAPSED']) billingStatus?: string;
  @IsOptional() @IsDateString() paidUntil?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) aiPurchased?: number;
  // Writing appointments and patients to the clinic's system (also needs the server settings)
  @IsOptional() @IsBoolean() bookingWriteEnabled?: boolean;
  // Foundation of the AI administrator-agent: collection of funnel events (the only switch of it) and the reserved agent switch; both off by default
  @IsOptional() @IsBoolean() funnelEventsEnabled?: boolean;
  @IsOptional() @IsBoolean() aiAgentMode?: boolean;
  // The agent's limited AUTONOMOUS mode (off by default, also needs the server list AGENT_AUTO_DIALOGS) and the explicit set of services it may book (at most
  // five; [] disables autonomy). agentAutoServiceId (one service) is the older form of the same setting: it sets the set to that one service, or clears it.
  @IsOptional() @IsBoolean() aiAgentAuto?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) agentAutoServiceIds?: string[];
  @IsOptional() @IsString() agentAutoServiceId?: string | null;
}

class ContactHandledDto {
  @IsBoolean() handled: boolean;
}

@Controller('platform')
@UseGuards(AuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Get('clinics')
  async clinics() {
    const since = monthStart();
    const [clinics, members, patients, messages, ai, sync] = await Promise.all([
      this.prisma.clinic.findMany({ orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, name: true, createdAt: true, plan: true, bookingWriteEnabled: true, billingStatus: true, paidUntil: true, aiPurchased: true, limitOverrides: true, suspendedAt: true, aiEnabled: true, aiMonthlyLimit: true, sendingEnabled: true, require2fa: true } }),
      this.prisma.membership.groupBy({ by: ['clinicId'], _count: true }),
      this.prisma.patient.groupBy({ by: ['clinicId'], where: { removedAt: null }, _count: true }),
      this.prisma.outboundMessage.groupBy({ by: ['clinicId'], where: { status: 'SENT', sentAt: { gte: since } }, _count: true }),
      this.prisma.aiUsage.groupBy({ by: ['clinicId'], where: { ok: true, createdAt: { gte: since } }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.integration.findMany({ where: { provider: 'CLINICCARDS' }, select: { clinicId: true, lastSyncAt: true } }),
    ]);
    // A clinic preparing its launch whose launch payment was partly refunded has no eligible payment left: support resolves the payment (REVIEW)
    const pendingIds = clinics.filter((c) => c.billingStatus === 'LAUNCH_PENDING').map((c) => c.id);
    const eligible = new Set(pendingIds.length
      ? (await this.prisma.billingPayment.findMany({ where: launchEligible({ in: pendingIds }), select: { clinicId: true } })).map((p) => p.clinicId)
      : []);
    const by = <T extends { clinicId: string }>(rows: T[]) => new Map(rows.map((r) => [r.clinicId, r]));
    const m = by(members), pa = by(patients), me = by(messages), a = by(ai), sy = by(sync);
    return clinics.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      plan: c.plan,
      bookingWriteEnabled: c.bookingWriteEnabled,
      billingStatus: c.billingStatus,
      // the launch payment was partly refunded before the start: the month cannot be started until the payment is resolved
      launchReview: c.billingStatus === 'LAUNCH_PENDING' && !eligible.has(c.id),
      paidUntil: c.paidUntil,
      aiPurchased: c.aiPurchased,
      limits: effectiveLimits(c.plan, c.limitOverrides),
      suspended: !!c.suspendedAt,
      sendingEnabled: c.sendingEnabled,
      aiEnabled: c.aiEnabled,
      require2fa: c.require2fa,
      users: m.get(c.id)?._count ?? 0,
      patients: pa.get(c.id)?._count ?? 0,
      messagesThisMonth: me.get(c.id)?._count ?? 0,
      aiRepliesThisMonth: a.get(c.id)?._count ?? 0,
      aiTokensThisMonth: (a.get(c.id)?._sum.inputTokens ?? 0) + (a.get(c.id)?._sum.outputTokens ?? 0),
      lastSyncAt: sy.get(c.id)?.lastSyncAt ?? null,
    }));
  }

  // "Call me back" requests from the public site, newest first
  @Get('contact-requests')
  async contactRequests() {
    return this.prisma.contactRequest.findMany({ where: { clinicId: null }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, phone: true, name: true, lang: true, createdAt: true, handledAt: true } });
  }

  @Patch('contact-requests/:id')
  async markContact(@Param('id') id: string, @Body() dto: ContactHandledDto) {
    const r = await this.prisma.contactRequest.updateMany({ where: { id, clinicId: null }, data: { handledAt: dto.handled ? new Date() : null } });
    if (!r.count) throw new NotFoundException();
    return { ok: true };
  }

  // A new clinic paid its plan with the launch (LAUNCH_PENDING): the service owner starts its first paid month after the launch is agreed with
  // the clinic. GET shows the dates it would get now; POST starts it (once; a repeat returns the started month).
  @Get('clinics/:id/launch')
  launchPreview(@Param('id') id: string) {
    return this.billing.launchPreview(id);
  }

  @Post('clinics/:id/launch')
  @HttpCode(200)
  launch(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.billing.activateLaunch(id, u.userId);
  }

  @Get('plans')
  async plans() {
    // NETWORK is given only by a network, never chosen by hand
    return Object.entries(PLANS).filter(([key]) => key !== 'NETWORK').map(([key, p]) => ({ key, label: p.label, limits: p.limits }));
  }

  @Patch('clinics/:id')
  async patch(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ClinicPatchDto) {
    const clinic = await this.prisma.clinic.findUnique({ where: { id }, select: { id: true } });
    if (!clinic) throw new NotFoundException();
    const limits: Record<string, number> | undefined = dto.limits
      ? Object.fromEntries(['users', 'messagesPerMonth', 'aiRepliesPerMonth'].filter((k) => Number.isInteger(dto.limits![k]) && (dto.limits![k] as number) >= 0).map((k) => [k, dto.limits![k] as number]))
      : undefined;
    // The autonomous set of services: every id an approved, active service of THIS clinic, no repeats, at most five; anything wrong rejects the whole change
    // (nothing is dropped silently). The older single field is the same setting for one service.
    if (dto.agentAutoServiceIds !== undefined && dto.agentAutoServiceId !== undefined) throw new BadRequestException('auto_services_ambiguous');
    const autoSet = dto.agentAutoServiceIds ?? (dto.agentAutoServiceId !== undefined ? (dto.agentAutoServiceId ? [dto.agentAutoServiceId] : []) : undefined);
    let autoBefore: string[] | null = null;
    if (autoSet) {
      await assertAutoServiceSet(this.prisma, id, autoSet);
      autoBefore = configuredAutoServiceIds(await this.prisma.clinic.findUniqueOrThrow({ where: { id }, select: { agentAutoServiceIds: true, agentAutoServicesSet: true, agentAutoServiceId: true } }));
    }
    const data = {
      ...(dto.plan ? { plan: dto.plan, aiMonthlyLimit: dto.aiMonthlyLimit ?? PLANS[dto.plan].limits.aiRepliesPerMonth } : dto.aiMonthlyLimit !== undefined ? { aiMonthlyLimit: dto.aiMonthlyLimit } : {}),
      ...(limits ? { limitOverrides: limits } : {}),
      ...(dto.billingStatus ? { billingStatus: dto.billingStatus } : {}),
      ...(dto.paidUntil ? { paidUntil: new Date(dto.paidUntil) } : {}),
      ...(dto.aiPurchased !== undefined ? { aiPurchased: dto.aiPurchased } : {}),
      ...(dto.bookingWriteEnabled !== undefined ? { bookingWriteEnabled: dto.bookingWriteEnabled } : {}),
      ...(dto.funnelEventsEnabled !== undefined ? { funnelEventsEnabled: dto.funnelEventsEnabled } : {}),
      ...(dto.aiAgentMode !== undefined ? { aiAgentMode: dto.aiAgentMode } : {}),
      ...(dto.aiAgentAuto !== undefined ? { aiAgentAuto: dto.aiAgentAuto } : {}),
      // once set, the set is authoritative (an empty one disables autonomy; the older single value is cleared with it and never comes back)
      ...(autoSet ? { agentAutoServiceIds: autoSet, agentAutoServicesSet: true, agentAutoServiceId: autoSet[0] ?? null } : {}),
      ...(dto.suspended !== undefined ? { suspendedAt: dto.suspended ? new Date() : null } : {}),
    };
    await this.prisma.clinic.update({ where: { id }, data });
    // The change is written to the clinic's own audit log, with the platform admin as the actor
    await this.prisma.auditLog.create({ data: { clinicId: id, userId: u.userId, action: 'platform.clinic_changed', details: JSON.parse(JSON.stringify({ plan: dto.plan, suspended: dto.suspended, limits, billingStatus: dto.billingStatus, paidUntil: dto.paidUntil, aiPurchased: dto.aiPurchased, bookingWriteEnabled: dto.bookingWriteEnabled, funnelEventsEnabled: dto.funnelEventsEnabled, aiAgentMode: dto.aiAgentMode, aiAgentAuto: dto.aiAgentAuto, ...(autoSet ? { agentAutoServices: { before: autoBefore, after: autoSet } } : {}) })) } });
    return { ok: true };
  }
}
