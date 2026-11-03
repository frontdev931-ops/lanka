import { BadRequestException, Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, ParseIntPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, SESSION_COOKIE } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsImportService } from '../integrations/settings-import.service';
import { SyncService } from '../integrations/sync.service';
import { parseWorkHours, readWorkHours } from './work-hours';
import { TERMS_VERSION } from '../common/terms';

class AcceptTermsDto {
  @IsString() version: string;
}

class ContactsDto {
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) directions?: string;
}

class DeleteClinicDto {
  @IsString() confirmName: string;
  @IsString() password: string;
}

@Controller('clinic')
@UseGuards(AuthGuard)
export class ClinicController {
  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
    private imports: SettingsImportService,
  ) {}

  // The owner accepts the data processing agreement on behalf of the clinic (the version must be the current one)
  @Put('terms')
  @Roles(Role.OWNER)
  async acceptTerms(@CurrentUser() u: AuthUser, @Body() dto: AcceptTermsDto, @Req() req: Request) {
    if (dto.version !== TERMS_VERSION) throw new BadRequestException('terms_outdated');
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date(), termsAcceptedById: u.userId } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'terms.accepted', details: { version: TERMS_VERSION, ip: req.ip ?? null } } });
    return { ok: true, version: TERMS_VERSION };
  }

  // The clinic's working hours: free windows are calculated from them when Cliniccards has no doctor shifts
  @Get('work-hours')
  async workHours(@CurrentUser() u: AuthUser) {
    const c = await this.prisma.clinic.findUnique({ where: { id: u.clinicId }, select: { workHours: true } });
    return readWorkHours(c?.workHours);
  }

  // Whether the hours are really set, where they came from and when. The 09:00-20:00 that the form shows for an unset clinic is NOT a setting.
  @Get('work-hours/info')
  async workHoursInfo(@CurrentUser() u: AuthUser) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: u.clinicId }, select: { workHours: true, workHoursSource: true, workHoursUpdatedAt: true, workHoursHolidays: true } });
    const configured = !!c.workHours && typeof c.workHours === 'object' && Object.keys(c.workHours as object).length > 0;
    return {
      configured,
      source: configured ? c.workHoursSource ?? 'MANUAL' : null,
      updatedAt: configured ? c.workHoursUpdatedAt : null,
      holidays: configured && c.workHoursSource === 'CLINICCARDS' && Array.isArray(c.workHoursHolidays) ? (c.workHoursHolidays as string[]) : [],
      connected: !!(await this.sync.connectorForClinic(u.clinicId).catch(() => null)),
    };
  }

  // "Take them from Cliniccards": an explicit action that replaces hours typed by hand. If Cliniccards does not give the hours the answer is
  // an error and nothing is changed (hours are never guessed).
  @Post('work-hours/import')
  @HttpCode(200)
  @Roles(Role.OWNER, Role.MANAGER)
  async importWorkHours(@CurrentUser() u: AuthUser) {
    const connector = await this.sync.connectorForClinic(u.clinicId).catch(() => null);
    if (!connector) throw new BadRequestException('hours_unavailable');
    const r = await this.imports.importHours(u.clinicId, connector, true);
    if (r !== 'imported') throw new BadRequestException('hours_unavailable');
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.work_hours_imported' } });
    return this.workHoursInfo(u);
  }

  @Put('work-hours')
  @Roles(Role.OWNER, Role.MANAGER)
  async setWorkHours(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const hours = parseWorkHours(body);
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { workHours: hours, workHoursSource: 'MANUAL', workHoursUpdatedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.work_hours' } });
    return hours;
  }

  // What the chat assistant may tell patients: the address, the administrator's phone and how to get there (empty means unknown to the bot)
  @Get('contacts')
  async contacts(@CurrentUser() u: AuthUser) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: u.clinicId }, select: { publicAddress: true, publicPhone: true, publicDirections: true } });
    return { address: c.publicAddress ?? '', phone: c.publicPhone ?? '', directions: c.publicDirections ?? '' };
  }

  @Put('contacts')
  @Roles(Role.OWNER, Role.MANAGER)
  async setContacts(@CurrentUser() u: AuthUser, @Body() dto: ContactsDto) {
    const v = (x?: string) => (x?.trim() ? x.trim() : null);
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { publicAddress: v(dto.address), publicPhone: v(dto.phone), publicDirections: v(dto.directions) } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.contacts' } });
    return this.contacts(u);
  }

  // History of actions of staff and automatic processes
  @Get('audit')
  @Roles(Role.OWNER, Role.MANAGER)
  async audit(@CurrentUser() u: AuthUser, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1) {
    const pageSize = 50;
    const where = { clinicId: u.clinicId };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (Math.max(page, 1) - 1) * pageSize, take: pageSize }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const names = new Map(users.map((x) => [x.id, x.name]));
    return {
      total,
      page,
      pageSize,
      rows: rows.map((r) => ({ id: r.id, action: r.action, details: r.details, createdAt: r.createdAt, user: r.userId ? names.get(r.userId) ?? null : null })),
    };
  }

  // A full export of the clinic's data as one JSON file. Passwords and the Cliniccards key are not included.
  @Get('export')
  @Roles(Role.OWNER)
  async export(@CurrentUser() u: AuthUser, @Res() res: Response) {
    const where = { clinicId: u.clinicId };
    const [clinic, team, patients, visits, planItems, payments, invoices, shifts, blocks, reminders, tasks, contacts, imports, audit] = await Promise.all([
      this.prisma.clinic.findUnique({ where: { id: u.clinicId }, select: { id: true, name: true, createdAt: true } }),
      this.prisma.membership.findMany({ where, select: { role: true, user: { select: { name: true, email: true } } } }),
      this.prisma.patient.findMany({ where }),
      this.prisma.visit.findMany({ where }),
      this.prisma.planItem.findMany({ where }),
      this.prisma.payment.findMany({ where }),
      this.prisma.invoice.findMany({ where }),
      this.prisma.shift.findMany({ where }),
      this.prisma.reservedBlock.findMany({ where }),
      this.prisma.reminder.findMany({ where }),
      this.prisma.task.findMany({ where }),
      this.prisma.contactLog.findMany({ where }),
      this.prisma.importBatch.findMany({ where, select: { id: true, filename: true, type: true, status: true, stats: true, createdAt: true, appliedAt: true } }),
      this.prisma.auditLog.findMany({ where }),
    ]);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.exported' } });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clinic-export.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), clinic, team, patients, visits, planItems, payments, invoices, shifts, blocks, reminders, tasks, contacts, imports, audit }));
  }

  // Irreversible deletion of the clinic with all its data. The clinic's name and the owner's password must be entered.
  @Delete()
  @Roles(Role.OWNER)
  @HttpCode(200)
  async remove(@CurrentUser() u: AuthUser, @Body() dto: DeleteClinicDto, @Res({ passthrough: true }) res: Response) {
    const [clinic, user] = await Promise.all([
      this.prisma.clinic.findUnique({ where: { id: u.clinicId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: u.userId } }),
    ]);
    if (!clinic || !user || dto.confirmName.trim() !== clinic.name.trim() || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new BadRequestException('wrong_confirmation');
    }
    // Staff who have no other clinics are deleted with it
    const members = await this.prisma.membership.findMany({ where: { clinicId: u.clinicId }, select: { userId: true } });
    const solo: string[] = [];
    for (const m of members) {
      if ((await this.prisma.membership.count({ where: { userId: m.userId, clinicId: { not: u.clinicId } } })) === 0) solo.push(m.userId);
    }
    await this.prisma.$transaction([
      this.prisma.clinic.delete({ where: { id: u.clinicId } }),
      this.prisma.user.deleteMany({ where: { id: { in: solo } } }),
    ]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
