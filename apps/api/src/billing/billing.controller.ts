import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SELLABLE_PLANS } from '../service/plans';
import { BillingService } from './billing.service';

class CheckoutDto {
  @IsIn(SELLABLE_PLANS) plan: string;
}

// The clinic's payments. Only the owner pays; the manager can look.
@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  constructor(
    private billing: BillingService,
    private prisma: PrismaService,
  ) {}

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
    const r = await this.billing.checkout(u.clinicId, dto.plan);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'billing.checkout', details: { plan: dto.plan } } });
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
