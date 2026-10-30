import { BadRequestException, Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, ParseIntPipe, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { IsString } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, SESSION_COOKIE } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { parseWorkHours, readWorkHours } from './work-hours';
import { TERMS_VERSION } from '../common/terms';

class AcceptTermsDto {
  @IsString() version: string;
}

class DeleteClinicDto {
  @IsString() confirmName: string;
  @IsString() password: string;
}

@Controller('clinic')
@UseGuards(AuthGuard)
export class ClinicController {
  constructor(private prisma: PrismaService) {}

  // Владелец принимает соглашение об обработке данных от имени клиники (версия должна быть текущей)
  @Put('terms')
  @Roles(Role.OWNER)
  async acceptTerms(@CurrentUser() u: AuthUser, @Body() dto: AcceptTermsDto, @Req() req: Request) {
    if (dto.version !== TERMS_VERSION) throw new BadRequestException('terms_outdated');
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date(), termsAcceptedById: u.userId } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'terms.accepted', details: { version: TERMS_VERSION, ip: req.ip ?? null } } });
    return { ok: true, version: TERMS_VERSION };
  }

  // Рабочие часы клиники: по ним считаются свободные окна, когда в Cliniccards нет смен врачей
  @Get('work-hours')
  async workHours(@CurrentUser() u: AuthUser) {
    const c = await this.prisma.clinic.findUnique({ where: { id: u.clinicId }, select: { workHours: true } });
    return readWorkHours(c?.workHours);
  }

  @Put('work-hours')
  @Roles(Role.OWNER, Role.MANAGER)
  async setWorkHours(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const hours = parseWorkHours(body);
    await this.prisma.clinic.update({ where: { id: u.clinicId }, data: { workHours: hours } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'clinic.work_hours' } });
    return hours;
  }

  // История действий сотрудников и автоматических процессов
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

  // Полная выгрузка данных клиники одним JSON-файлом. Пароли и ключ Cliniccards в неё не входят.
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

  // Безвозвратное удаление клиники со всеми данными. Нужно ввести её название и пароль владельца.
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
    // Сотрудники, у которых нет других клиник, удаляются вместе с ней
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
