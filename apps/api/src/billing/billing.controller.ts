import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SELLABLE_PLANS } from '../service/plans';
import { BillingService } from './billing.service';

class CheckoutDto {
  @IsIn(SELLABLE_PLANS) plan: string;
}
class CallbackDto {
  @IsOptional() @IsString() data?: string;
  @IsOptional() @IsString() signature?: string;
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

// LiqPay server callback. No sign-in: the signature (made with the private key) is the proof.
@Controller('billing/liqpay')
export class LiqpayCallbackController {
  constructor(private billing: BillingService) {}

  @Post('callback')
  @HttpCode(200)
  async callback(@Body() body: CallbackDto) {
    if (!body.data || !body.signature) throw new BadRequestException('bad_signature');
    await this.billing.callback(body.data, body.signature);
    return { ok: true };
  }
}
