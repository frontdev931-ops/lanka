import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_KEYS, PLANS, effectiveLimits, monthStart } from './plans';

// Platform owner = the people listed in PLATFORM_ADMIN_EMAILS (and with a verified email). Clinic roles do not give this access.
export async function isPlatformAdmin(prisma: PrismaService, userId: string): Promise<boolean> {
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  const verifiedOrDev = !!u?.emailVerifiedAt || process.env.REQUIRE_EMAIL_VERIFICATION === 'false';
  return !!u && verifiedOrDev && list.includes(u.email.toLowerCase());
}

class ClinicPatchDto {
  @IsOptional() @IsIn(PLAN_KEYS) plan?: string;
  @IsOptional() @IsBoolean() suspended?: boolean;
  @IsOptional() @IsObject() limits?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) aiMonthlyLimit?: number;
  // Manual billing (a deal outside LiqPay, a correction)
  @IsOptional() @IsIn(['AWAITING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'LAPSED']) billingStatus?: string;
  @IsOptional() @IsDateString() paidUntil?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) aiPurchased?: number;
  // Writing appointments and patients to the clinic's system (also needs the server settings)
  @IsOptional() @IsBoolean() bookingWriteEnabled?: boolean;
}

@Controller('platform')
@UseGuards(AuthGuard)
export class PlatformController {
  constructor(private prisma: PrismaService) {}

  // The service owner sees every clinic: in production the account must have the second factor turned on
  // (PLATFORM_REQUIRE_2FA=false opens this for a first launch; 'true' forces it in any environment)
  private async assertAdmin(u: AuthUser) {
    if (!(await isPlatformAdmin(this.prisma, u.userId))) throw new ForbiddenException();
    const need = process.env.PLATFORM_REQUIRE_2FA === 'true' || (process.env.NODE_ENV === 'production' && process.env.PLATFORM_REQUIRE_2FA !== 'false');
    if (need && !(await this.prisma.user.findUnique({ where: { id: u.userId }, select: { totpEnabledAt: true } }))?.totpEnabledAt) throw new ForbiddenException('platform_2fa_required');
  }

  @Get('clinics')
  async clinics(@CurrentUser() u: AuthUser) {
    await this.assertAdmin(u);
    const since = monthStart();
    const [clinics, members, patients, messages, ai, sync] = await Promise.all([
      this.prisma.clinic.findMany({ orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, name: true, createdAt: true, plan: true, bookingWriteEnabled: true, billingStatus: true, paidUntil: true, aiPurchased: true, limitOverrides: true, suspendedAt: true, aiEnabled: true, aiMonthlyLimit: true, sendingEnabled: true, require2fa: true } }),
      this.prisma.membership.groupBy({ by: ['clinicId'], _count: true }),
      this.prisma.patient.groupBy({ by: ['clinicId'], where: { removedAt: null }, _count: true }),
      this.prisma.outboundMessage.groupBy({ by: ['clinicId'], where: { status: 'SENT', sentAt: { gte: since } }, _count: true }),
      this.prisma.aiUsage.groupBy({ by: ['clinicId'], where: { ok: true, createdAt: { gte: since } }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.integration.findMany({ where: { provider: 'CLINICCARDS' }, select: { clinicId: true, lastSyncAt: true } }),
    ]);
    const by = <T extends { clinicId: string }>(rows: T[]) => new Map(rows.map((r) => [r.clinicId, r]));
    const m = by(members), pa = by(patients), me = by(messages), a = by(ai), sy = by(sync);
    return clinics.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      plan: c.plan,
      bookingWriteEnabled: c.bookingWriteEnabled,
      billingStatus: c.billingStatus,
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

  @Get('plans')
  async plans(@CurrentUser() u: AuthUser) {
    await this.assertAdmin(u);
    return Object.entries(PLANS).map(([key, p]) => ({ key, label: p.label, limits: p.limits }));
  }

  @Patch('clinics/:id')
  async patch(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ClinicPatchDto) {
    await this.assertAdmin(u);
    const clinic = await this.prisma.clinic.findUnique({ where: { id }, select: { id: true } });
    if (!clinic) throw new NotFoundException();
    const limits: Record<string, number> | undefined = dto.limits
      ? Object.fromEntries(['users', 'messagesPerMonth', 'aiRepliesPerMonth'].filter((k) => Number.isInteger(dto.limits![k]) && (dto.limits![k] as number) >= 0).map((k) => [k, dto.limits![k] as number]))
      : undefined;
    const data = {
      ...(dto.plan ? { plan: dto.plan, aiMonthlyLimit: dto.aiMonthlyLimit ?? PLANS[dto.plan].limits.aiRepliesPerMonth } : dto.aiMonthlyLimit !== undefined ? { aiMonthlyLimit: dto.aiMonthlyLimit } : {}),
      ...(limits ? { limitOverrides: limits } : {}),
      ...(dto.billingStatus ? { billingStatus: dto.billingStatus } : {}),
      ...(dto.paidUntil ? { paidUntil: new Date(dto.paidUntil) } : {}),
      ...(dto.aiPurchased !== undefined ? { aiPurchased: dto.aiPurchased } : {}),
      ...(dto.bookingWriteEnabled !== undefined ? { bookingWriteEnabled: dto.bookingWriteEnabled } : {}),
      ...(dto.suspended !== undefined ? { suspendedAt: dto.suspended ? new Date() : null } : {}),
    };
    await this.prisma.clinic.update({ where: { id }, data });
    // The change is written to the clinic's own audit log, with the platform admin as the actor
    await this.prisma.auditLog.create({ data: { clinicId: id, userId: u.userId, action: 'platform.clinic_changed', details: JSON.parse(JSON.stringify({ plan: dto.plan, suspended: dto.suspended, limits, billingStatus: dto.billingStatus, paidUntil: dto.paidUntil, aiPurchased: dto.aiPurchased, bookingWriteEnabled: dto.bookingWriteEnabled })) } });
    return { ok: true };
  }
}
