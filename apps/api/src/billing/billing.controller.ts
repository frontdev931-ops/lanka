import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SELLABLE_PLANS, TERM_MONTHS } from '../service/plans';
import { BillingService } from './billing.service';
import { ClinicRequestsService } from './clinic-requests.service';

class CheckoutDto {
  @IsIn(SELLABLE_PLANS) plan: string;
  // the term: 1 = monthly (default), 12 = one annual payment; any price a client sends is dropped (whitelist) and never used
  @IsOptional() @IsIn(TERM_MONTHS) months?: number;
}

class ClinicRequestDto {
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

// The clinic's payments. Only the owner pays; the manager can look.
@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  constructor(
    private billing: BillingService,
    private prisma: PrismaService,
    private requests: ClinicRequestsService,
  ) {}

  // "Do you have several clinics?": the open request of this clinic and the network link for its owner. The clinic and the person come
  // from the session only.
  @Get('additional-clinic')
  @Roles(Role.OWNER, Role.MANAGER)
  additionalClinic(@CurrentUser() u: AuthUser) {
    return this.requests.state(u.clinicId, u.userId);
  }

  // Only the clinic's owner asks; a repeat returns the open request
  @Post('additional-clinic')
  @Roles(Role.OWNER)
  @HttpCode(200)
  requestAdditionalClinic(@CurrentUser() u: AuthUser, @Body() dto: ClinicRequestDto) {
    return this.requests.request(u.clinicId, u.userId, dto.comment);
  }

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  overview(@CurrentUser() u: AuthUser) {
    return this.billing.overview(u.clinicId);
  }

  @Get('payments/:id')
  @Roles(Role.OWNER, Role.MANAGER)
  payment(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.billing.payment(id, { clinicId: u.clinicId, networkId: null }, u.role === Role.OWNER);
  }

  @Post('checkout')
  @Roles(Role.OWNER)
  @HttpCode(200)
  async checkout(@CurrentUser() u: AuthUser, @Body() dto: CheckoutDto) {
    const r = await this.billing.checkout(u.clinicId, dto.plan, dto.months ?? 1);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'billing.checkout', details: { plan: dto.plan, months: dto.months ?? 1 } } });
    return r;
  }

  @Post('ai-pack')
  @Roles(Role.OWNER)
  @HttpCode(200)
  async pack(@CurrentUser() u: AuthUser) {
    const r = await this.billing.buyPack(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'billing.checkout', details: { kind: 'AI_PACK' } } });
    return r;
  }
}

@Controller('billing/mono')
export class MonoWebhookController {
  constructor(private billing: BillingService) {}

  @Post('webhook')
  @HttpCode(200)
  async callback(@Req() req: RawBodyRequest<Request>, @Headers('x-sign') signature?: string) {
    await this.billing.callback(req.rawBody, signature);
    return { ok: true };
  }
}
