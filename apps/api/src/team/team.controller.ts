import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Response } from 'express';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { setSessionCookie } from '../auth/auth.controller';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../service/usage.service';

const INVITE_TTL_MS = 7 * 86_400_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

class InviteDto {
  @IsEmail() email: string;
  @IsEnum(Role) role: Role;
}

class AcceptDto {
  @IsOptional() @IsString() name?: string;
  @IsString() @MinLength(10) password: string;
}

@Controller('team')
@UseGuards(AuthGuard)
export class TeamController {
  constructor(
    private prisma: PrismaService,
    private usage: UsageService,
  ) {}

  // Names and emails of colleagues are not for every role: the doctor and the analyst do not need them
  @Get()
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  async list(@CurrentUser() u: AuthUser) {
    const rows = await this.prisma.membership.findMany({
      where: { clinicId: u.clinicId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { user: { name: 'asc' } },
    });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
  }

  @Get('invitations')
  @Roles(Role.OWNER)
  pending(@CurrentUser() u: AuthUser) {
    return this.prisma.invitation.findMany({
      where: { clinicId: u.clinicId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Ссылка показывается один раз при создании: в базе хранится только хэш токена. Роль владельца так не выдаётся.
  @Post('invitations')
  @Roles(Role.OWNER)
  async invite(@CurrentUser() u: AuthUser, @Body() dto: InviteDto) {
    if (dto.role === Role.OWNER) throw new BadRequestException('owner_role');
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing && (await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId: existing.id, clinicId: u.clinicId } } }))) {
      throw new ConflictException('already_member');
    }
    await this.prisma.invitation.deleteMany({ where: { clinicId: u.clinicId, email, acceptedAt: null } });
    // Plan limit: members plus open invitations may not exceed it
    const limits = await this.usage.limitsOf(u.clinicId);
    const used = await this.usage.clinicUsage(u.clinicId);
    if (used.users + used.pendingInvitations >= limits.users) throw new BadRequestException('plan_users_limit');
    const token = randomBytes(32).toString('base64url');
    const inv = await this.prisma.invitation.create({
      data: { clinicId: u.clinicId, email, role: dto.role, tokenHash: hash(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), createdById: u.userId },
    });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'team.invited', details: { email, role: dto.role } } });
    const base = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    return { id: inv.id, email, role: inv.role, expiresAt: inv.expiresAt, link: `${base}/invite/${token}` };
  }

  @Delete('invitations/:id')
  @Roles(Role.OWNER)
  @HttpCode(200)
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.prisma.invitation.deleteMany({ where: { id, clinicId: u.clinicId, acceptedAt: null } });
    if (!r.count) throw new NotFoundException('invite_invalid');
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'team.invite_revoked' } });
    return { ok: true };
  }
}

// Публичные адреса: по ссылке приглашения открывается ещё без входа в систему
// Staff management: change a role, remove a person from the clinic, reset someone's second factor. The owner cannot be touched.
class RoleDto {
  @IsIn([Role.MANAGER, Role.ADMIN, Role.DOCTOR, Role.ANALYST]) role: Role;
}

@Controller('team/members')
@UseGuards(AuthGuard)
@Roles(Role.OWNER)
export class TeamMembersController {
  constructor(private prisma: PrismaService) {}

  private async target(u: AuthUser, userId: string) {
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId: u.clinicId } }, include: { user: { select: { email: true } } } });
    if (!m) throw new NotFoundException();
    if (m.role === Role.OWNER || userId === u.userId) throw new BadRequestException('last_owner');
    return m;
  }

  @Patch(':userId')
  async role(@CurrentUser() u: AuthUser, @Param('userId') userId: string, @Body() dto: RoleDto) {
    const m = await this.target(u, userId);
    await this.prisma.membership.update({ where: { userId_clinicId: { userId, clinicId: u.clinicId } }, data: { role: dto.role } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'team.role_changed', details: { email: m.user.email, from: m.role, to: dto.role } } });
    return { ok: true };
  }

  @Delete(':userId')
  async remove(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    const m = await this.target(u, userId);
    // Open tasks of the removed person go back to nobody; their history stays
    await this.prisma.task.updateMany({ where: { clinicId: u.clinicId, assigneeId: userId, status: { not: 'DONE' } }, data: { assigneeId: null } });
    await this.prisma.membership.delete({ where: { userId_clinicId: { userId, clinicId: u.clinicId } } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'team.removed', details: { email: m.user.email, role: m.role } } });
    return { ok: true };
  }

  // A member who lost the phone and the recovery codes: the owner resets their second factor, they set it up again after signing in
  @Post(':userId/reset-2fa')
  @HttpCode(200)
  async reset2fa(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    const m = await this.target(u, userId);
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryHashes: Prisma.DbNull, sessionsValidAfter: new Date() } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'team.2fa_reset', details: { email: m.user.email } } });
    return { ok: true };
  }
}

@Controller('invites')
export class InvitePublicController {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private async find(token: string) {
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: hash(token) }, include: { clinic: { select: { name: true } } } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new NotFoundException('invite_invalid');
    return inv;
  }

  @Get(':token')
  async info(@Param('token') token: string) {
    const inv = await this.find(token);
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { clinicName: inv.clinic.name, role: inv.role, email: inv.email, existingUser: !!existing };
  }

  // Новому пользователю нужно имя и пароль; тот, кто уже зарегистрирован, подтверждает приглашение своим паролем
  @Post(':token/accept')
  async accept(@Param('token') token: string, @Body() dto: AcceptDto, @Res({ passthrough: true }) res: Response) {
    const inv = await this.find(token);
    let user = await this.prisma.user.findUnique({ where: { email: inv.email } });
    if (user) {
      if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new BadRequestException('bad_credentials');
    } else if (!dto.name || dto.name.trim().length < 2) {
      throw new BadRequestException('name_required');
    }

    // Приглашение занимается атомарно: одну ссылку нельзя использовать дважды
    const claimed = await this.prisma.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (!claimed.count) throw new NotFoundException('invite_invalid');

    user ??= await this.prisma.user.create({
      data: { email: inv.email, name: dto.name!.trim(), passwordHash: await bcrypt.hash(dto.password, 10) },
    });
    await this.prisma.membership.upsert({
      where: { userId_clinicId: { userId: user.id, clinicId: inv.clinicId } },
      create: { userId: user.id, clinicId: inv.clinicId, role: inv.role },
      update: {},
    });
    await this.prisma.auditLog.create({ data: { clinicId: inv.clinicId, userId: user.id, action: 'team.joined', details: { role: inv.role } } });

    const accessToken = await this.jwt.signAsync({ sub: user.id, clinicId: inv.clinicId, role: inv.role }, { jwtid: randomUUID() });
    setSessionCookie(res, accessToken);
    return { accessToken };
  }
}
