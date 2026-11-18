import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { ArrayMaxSize, Equals, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BillingService } from '../billing/billing.service';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { Lang, ReqLang } from '../common/i18n';
import { TERMS_VERSION } from '../common/terms';
import { PrismaService } from '../prisma/prisma.service';
import { toPdf, toXlsx } from '../reports/report-export';
import { ReportsService } from '../reports/reports.service';
import { PlatformAdminGuard } from '../service/platform-access';
import { BRANCH_SETUP_MIN_UAH } from '../service/plans';
import { NetworkService } from './network.service';

const days = (d?: number) => Math.min(365, Math.max(1, d ?? 30));
const only = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

class HistoryItem {
  @IsString() @MaxLength(600) q: string;
  @IsString() @MaxLength(600) a: string;
}
class AskDto {
  @IsString() @MinLength(2) @MaxLength(600) question: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => HistoryItem) history?: HistoryItem[];
}
class DigestDto {
  @IsIn(['OFF', 'WEEKLY', 'DAILY']) digest: string;
}
class NewBranchDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsBoolean() @Equals(true) acceptTerms: boolean;
}
class MemberDto {
  @IsEmail() email: string;
}
class AttachDto {
  @IsString() clinicId: string;
  // the clinic has its own paid period running: the owner confirms that it ends and the network pays from now on (no automatic refund)
  @IsOptional() @IsBoolean() confirmEndOwnSubscription?: boolean;
}

// The network's consolidated views (/network/*) for its members. Every figure is read per branch with that branch's clinicId, taken from the person's
// own memberships (NetworkService.access); the `branches` query only narrows that set. Network billing lives under /billing/network (it must stay
// open while the network is unpaid, like a clinic's payment page).
@Controller('network')
@UseGuards(AuthGuard)
export class NetworkController {
  constructor(
    private network: NetworkService,
    private reports: ReportsService,
    private prisma: PrismaService,
  ) {}

  @Get(':id/summary')
  summary(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('days', new ParseIntPipe({ optional: true })) d?: number, @Query('branches') b?: string) {
    return this.network.summary(u.userId, id, days(d), only(b));
  }

  @Get(':id/signals')
  signals(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.network.signals(u.userId, id);
  }

  @Get(':id/reports/:report')
  report(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Param('id') id: string, @Param('report') report: string, @Query('days', new ParseIntPipe({ optional: true })) d?: number, @Query('branches') b?: string) {
    return this.network.report(u.userId, id, report, d, lang, only(b));
  }

  // The joined report as a file; the export is written to the activity log of every branch it contains
  @Get(':id/reports/:report/:format')
  async file(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Param('id') id: string, @Param('report') report: string, @Param('format') format: string, @Res() res: Response, @Query('days', new ParseIntPipe({ optional: true })) d?: number, @Query('branches') b?: string) {
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new BadRequestException('bad_format');
    const r = await this.network.report(u.userId, id, report, d, lang, only(b));
    const { branches } = await this.network.access(u.userId, id, only(b));
    for (const br of branches) await this.prisma.auditLog.create({ data: { clinicId: br.id, userId: u.userId, action: 'report.exported', details: { report, network: id, rows: r.rows.length, format } } });
    const name = `network-${report}`;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.send(this.reports.toCsv(r, lang));
    }
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      return res.send(await toXlsx(r, lang));
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    return res.send(await toPdf(r, lang));
  }

  // The network assistant: signed in to one of the authorized branches (its AI allowance pays for the model)
  @Post(':id/assistant')
  @HttpCode(200)
  ask(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Param('id') id: string, @Body() dto: AskDto) {
    return this.network.ask(u.userId, u.clinicId, u.role, id, lang, dto.question, dto.history ?? []);
  }

  @Patch(':id/digest')
  digest(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DigestDto) {
    return this.network.setDigest(u.userId, id, dto.digest);
  }

  // A new branch, created by the network's owner (who accepts the terms for it). It waits for the network's next payment, which then includes it.
  @Post(':id/branches')
  async newBranch(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NewBranchDto) {
    await this.network.assertOwner(u.userId, id);
    const clinic = await this.prisma.clinic.create({
      data: { name: dto.name.trim(), networkId: id, termsVersion: TERMS_VERSION, termsAcceptedAt: new Date(), billingStatus: 'AWAITING_PAYMENT', memberships: { create: { userId: u.userId, role: Role.OWNER } } },
      select: { id: true, name: true },
    });
    await this.prisma.auditLog.create({ data: { clinicId: clinic.id, userId: u.userId, action: 'network.branch_created', details: { networkId: id } } });
    return clinic;
  }

  // An existing clinic joins: only one the network's owner already OWNS (never someone else's clinic, never automatically). A clinic with its own
  // running paid period joins only with the owner's explicit confirmation that the network's next payment replaces it.
  @Post(':id/branches/attach')
  async attach(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AttachDto) {
    await this.network.assertOwner(u.userId, id);
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId: u.userId, clinicId: dto.clinicId } }, include: { clinic: { select: { networkId: true, billingStatus: true, paidUntil: true, isDemo: true, limitOverrides: true } } } });
    if (!m || m.role !== Role.OWNER) throw new ForbiddenException('branch_not_owned');
    if (m.clinic.isDemo) throw new BadRequestException('demo_restricted');
    if (m.clinic.networkId) throw new BadRequestException(m.clinic.networkId === id ? 'branch_already_in_network' : 'branch_in_other_network');
    const ownPaid = (m.clinic.billingStatus === 'ACTIVE' || m.clinic.billingStatus === 'PAST_DUE') && !!m.clinic.paidUntil && m.clinic.paidUntil > new Date();
    if (ownPaid && !dto.confirmEndOwnSubscription) throw new BadRequestException('branch_has_own_subscription');
    // The same rule as a new branch: the network's paid access starts with the confirmed network payment that includes the branch. Until then the
    // clinic keeps what it has (its own paid days, if any; no refund); that payment replaces them.
    await this.prisma.clinic.update({ where: { id: dto.clinicId }, data: { networkId: id } });
    await this.prisma.auditLog.create({ data: { clinicId: dto.clinicId, userId: u.userId, action: 'network.branch_attached', details: { networkId: id, endedOwnSubscription: ownPaid } } });
    return { ok: true };
  }

  // The network's people. A member sees in the network views only the branches where they ALREADY hold a management role (given per branch with the
  // ordinary invitation in "Команда"): adding someone here grants no branch. Only the network's owner adds or removes; the person must already be on the
  // team of at least one branch of this network. No platform role is involved.
  @Get(':id/members')
  async members(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.network.assertOwner(u.userId, id);
    const rows = await this.prisma.networkMember.findMany({
      where: { networkId: id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true, memberships: { where: { clinic: { networkId: id } }, select: { role: true, clinic: { select: { name: true } } } } } } },
    });
    return rows.map((r) => ({ userId: r.user.id, name: r.user.name, email: r.user.email, role: r.role, branches: r.user.memberships.map((m) => ({ name: m.clinic.name, role: m.role })) }));
  }

  @Post(':id/members')
  async addMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MemberDto) {
    await this.network.assertOwner(u.userId, id);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() }, select: { id: true, memberships: { where: { clinic: { networkId: id } }, select: { clinicId: true } } } });
    if (!user || !user.memberships.length) throw new BadRequestException('member_not_in_branch');
    await this.prisma.networkMember.upsert({ where: { networkId_userId: { networkId: id, userId: user.id } }, create: { networkId: id, userId: user.id, role: 'MEMBER' }, update: {} });
    for (const m of user.memberships) await this.prisma.auditLog.create({ data: { clinicId: m.clinicId, userId: u.userId, action: 'network.member_added', details: { networkId: id, memberId: user.id } } });
    return { ok: true };
  }

  @Delete(':id/members/:userId')
  async removeMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    await this.network.assertOwner(u.userId, id);
    const m = await this.prisma.networkMember.findUnique({ where: { networkId_userId: { networkId: id, userId } } });
    if (!m) throw new NotFoundException('member_not_found');
    // the owner stays: removing an owner is the service owner's step
    if (m.role === 'OWNER') throw new BadRequestException('member_is_owner');
    await this.prisma.networkMember.delete({ where: { id: m.id } });
    return { ok: true };
  }

  // A branch leaves: it is a standalone clinic again, awaiting its own payment (Start until it buys a plan); its data stay
  @Delete(':id/branches/:clinicId')
  async detach(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('clinicId') clinicId: string) {
    await this.network.assertOwner(u.userId, id);
    const r = await this.prisma.clinic.updateMany({ where: { id: clinicId, networkId: id }, data: { networkId: null, plan: 'START', billingStatus: 'AWAITING_PAYMENT', paidUntil: null, branchSetupQuoteUah: null } });
    if (!r.count) throw new NotFoundException('branch_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId: u.userId, action: 'network.branch_detached', details: { networkId: id } } });
    return { ok: true };
  }
}

// Network billing: the list of the person's networks and the payment page. Under /billing so it stays reachable while the network is unpaid.
@Controller('billing')
@UseGuards(AuthGuard)
export class NetworkBillingController {
  constructor(
    private network: NetworkService,
    private billing: BillingService,
    private prisma: PrismaService,
  ) {}

  @Get('networks')
  mine(@CurrentUser() u: AuthUser) {
    return this.network.mine(u.userId);
  }

  @Get('network/:id')
  async overview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.network.access(u.userId, id);
    return this.billing.networkOverview(id);
  }

  @Get('network/:id/payments/:paymentId')
  async payment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('paymentId') paymentId: string) {
    const { network } = await this.network.access(u.userId, id);
    return this.billing.payment(paymentId, { networkId: id }, network.role === 'OWNER');
  }

  @Post('network/:id/checkout')
  @HttpCode(200)
  async checkout(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.network.assertOwner(u.userId, id);
    const r = await this.billing.networkCheckout(id);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'billing.checkout', details: { kind: 'NETWORK', networkId: id } } });
    return r;
  }

  @Post('network/:id/branch-setup/:clinicId')
  @HttpCode(200)
  async branchSetup(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('clinicId') clinicId: string) {
    await this.network.assertOwner(u.userId, id);
    const r = await this.billing.branchSetupCheckout(id, clinicId);
    await this.prisma.auditLog.create({ data: { clinicId, userId: u.userId, action: 'billing.checkout', details: { kind: 'BRANCH_SETUP', networkId: id } } });
    return r;
  }
}

class CreateNetworkDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsEmail() ownerEmail: string;
}
class QuoteDto {
  @IsOptional() @IsInt() @Min(BRANCH_SETUP_MIN_UAH) @Max(500_000) setupQuoteUah: number | null;
}

// The service owner (PLATFORM_ADMIN_EMAILS) creates a network for an agreed contract and quotes further branches' onboarding. This gives the service
// owner no access to a network's data and gives network members nothing of the platform.
@Controller('platform/networks')
@UseGuards(AuthGuard, PlatformAdminGuard)
export class NetworkPlatformController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list() {
    return this.prisma.network.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, billingStatus: true, paidUntil: true, setupPaidAt: true, createdAt: true, members: { select: { role: true, user: { select: { email: true } } } }, clinics: { select: { id: true, name: true, branchSetupQuoteUah: true, branchSetupPaidAt: true } } },
    });
  }

  // The owner must already have an account (the person who signed the contract); their clinics are NOT added: they attach them themselves
  @Post()
  async create(@Body() dto: CreateNetworkDto) {
    const owner = await this.prisma.user.findUnique({ where: { email: dto.ownerEmail.toLowerCase() }, select: { id: true } });
    if (!owner) throw new NotFoundException('user_not_found');
    const n = await this.prisma.network.create({ data: { name: dto.name.trim(), members: { create: { userId: owner.id, role: 'OWNER' } } }, select: { id: true, name: true } });
    return n;
  }

  @Patch(':id/branches/:clinicId')
  async quote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('clinicId') clinicId: string, @Body() dto: QuoteDto) {
    const r = await this.prisma.clinic.updateMany({ where: { id: clinicId, networkId: id, branchSetupPaidAt: null }, data: { branchSetupQuoteUah: dto.setupQuoteUah ?? null } });
    if (!r.count) throw new NotFoundException('branch_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId: u.userId, action: 'network.branch_quote', details: { networkId: id, quoteUah: dto.setupQuoteUah ?? null } } });
    return { ok: true };
  }
}
