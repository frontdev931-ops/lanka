import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { KB_KINDS, KbKind, KbService } from './kb.service';

class CreateDto {
  @IsIn(KB_KINDS as unknown as string[]) kind: KbKind;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
  @IsOptional() @IsInt() durationMin?: number | null;
  @IsOptional() @IsInt() priceUah?: number | null;
}
class PriceSourceDto {
  @IsIn(['accept', 'keep']) action: 'accept' | 'keep';
}
class MissingDto {
  @IsIn(['keep', 'disable']) action: 'keep' | 'disable';
}
class LinkDto {
  @IsString() @MaxLength(40) importedId: string;
}
class GroupDto {
  @IsIn(KB_KINDS as unknown as string[]) kind: KbKind;
  @IsOptional() @IsString() @MaxLength(200) category?: string | null;
}
class UpdateDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
  @IsOptional() @IsInt() durationMin?: number | null;
  @IsOptional() @IsInt() priceUah?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

// The clinic knowledge base for the AI. Owner and manager edit and approve; the administrator can read it.
@Controller('knowledge')
@UseGuards(AuthGuard)
export class KbController {
  constructor(private kb: KbService) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  async list(@CurrentUser() u: AuthUser) {
    return { items: await this.kb.list(u.clinicId), summary: await this.kb.summary(u.clinicId) };
  }

  // What needs a decision after an import: changed prices, positions that vanished, name matches to link by hand
  @Get('review')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  review(@CurrentUser() u: AuthUser) {
    return this.kb.review(u.clinicId);
  }

  @Post(':id/price-source')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async priceSource(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PriceSourceDto) {
    await this.kb.resolvePrice(u.clinicId, u.userId, id, dto.action);
    return { ok: true };
  }

  @Post(':id/missing')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async missing(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MissingDto) {
    await this.kb.resolveMissing(u.clinicId, u.userId, id, dto.action);
    return { ok: true };
  }

  @Post(':id/link')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async link(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: LinkDto) {
    await this.kb.link(u.clinicId, u.userId, id, dto.importedId);
    return { ok: true };
  }

  @Post(':id/dismiss-match')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async dismissMatch(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.kb.dismissMatch(u.clinicId, u.userId, id);
    return { ok: true };
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER)
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateDto) {
    return { id: await this.kb.create(u.clinicId, u.userId, dto) };
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.MANAGER)
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateDto) {
    await this.kb.update(u.clinicId, u.userId, id, dto);
    return { ok: true };
  }

  @Post('approve-group')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  approveGroup(@CurrentUser() u: AuthUser, @Body() dto: GroupDto) {
    return this.kb.approveGroup(u.clinicId, u.userId, dto.kind, dto.category ?? null);
  }

  @Post(':id/approve')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async approve(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.kb.approve(u.clinicId, u.userId, id);
    return { ok: true };
  }

  @Post(':id/confirm')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  async confirm(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.kb.confirm(u.clinicId, u.userId, id);
    return { ok: true };
  }

  @Delete(':id')
  @Roles(Role.OWNER, Role.MANAGER)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.kb.remove(u.clinicId, u.userId, id);
    return { ok: true };
  }

  @Post('import/services')
  @Roles(Role.OWNER, Role.MANAGER)
  @HttpCode(200)
  importServices(@CurrentUser() u: AuthUser) {
    return this.kb.importServices(u.clinicId, u.userId);
  }
}
