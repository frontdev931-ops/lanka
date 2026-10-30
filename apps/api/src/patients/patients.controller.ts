import { Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ContactConsent, Prisma, Role, TaskResult } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const WRITERS = [Role.OWNER, Role.MANAGER, Role.ADMIN];
export const CHANNELS = ['PHONE', 'MESSENGER', 'SMS', 'EMAIL', 'VISIT', 'OTHER'];

class ContactDto {
  @IsIn(CHANNELS) channel: string;
  @IsOptional() @IsEnum(TaskResult) outcome?: TaskResult;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsDateString() contactedAt?: string;
}

class ConsentDto {
  @IsOptional() @IsEnum(ContactConsent) consent?: ContactConsent;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() automationPaused?: boolean;
}

@Controller('patients')
@UseGuards(AuthGuard)
export class PatientsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('search') search = '',
    @Query('source') source?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
  ) {
    const pageSize = 50;
    const s = search.trim();
    const where: Prisma.PatientWhereInput = {
      clinicId: u.clinicId,
      removedAt: null,
      ...(source ? { source: source === '__none' ? null : source } : {}),
      ...(s
        ? { OR: [{ fullName: { contains: s, mode: 'insensitive' } }, { phone: { contains: s.replace(/[^\d+]/g, '') || s } }] }
        : {}),
    };
    const [total, rows, sources] = await Promise.all([
      this.prisma.patient.count({ where }),
      this.prisma.patient.findMany({
        where,
        orderBy: { fullName: 'asc' },
        skip: (Math.max(page, 1) - 1) * pageSize,
        take: pageSize,
        select: { id: true, fullName: true, phone: true, source: true, lastVisitAt: true, balanceIssued: true, balancePaid: true, consent: true, automationPaused: true },
      }),
      this.prisma.patient.groupBy({ by: ['source'], where: { clinicId: u.clinicId, removedAt: null } }),
    ]);
    return {
      total,
      page,
      pageSize,
      sources: sources.map((x) => x.source).filter(Boolean),
      // Долг = выставлено − оплачено. Врач работает с лечением, а не с деньгами пациентов: ему долг не отдаётся
      rows: rows.map(({ balanceIssued, balancePaid, ...rest }) => {
        if (u.role === Role.DOCTOR) return rest;
        const debt = Math.round((Number(balanceIssued ?? 0) - Number(balancePaid ?? 0)) * 100) / 100;
        return { ...rest, debt: debt > 0 ? debt : 0 };
      }),
    };
  }

  @Get(':id')
  async one(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    // A view of a patient card is written to the audit log (not more than once per 10 minutes for the same person and patient)
    const recent = await this.prisma.auditLog.findFirst({ where: { clinicId: u.clinicId, userId: u.userId, action: 'patient.viewed', details: { path: ['patientId'], equals: id }, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } }, select: { id: true } });
    if (!recent) await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.viewed', details: { patientId: id } } });
    const p = await this.prisma.patient.findFirst({
      where: { id, clinicId: u.clinicId },
      include: {
        visits: { orderBy: { startsAt: 'desc' }, take: 100 },
        // Подключённый мессенджер и последние сообщения пациенту (журнал рассылок)
        channels: { select: { channel: true, username: true, linkedAt: true, optedOutAt: true } },
        outbox: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, ruleKey: true, status: true, text: true, scheduledFor: true, sentAt: true, error: true } },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { assignee: { select: { id: true, name: true } } },
        },
        contacts: {
          orderBy: { contactedAt: 'desc' },
          take: 50,
          include: { user: { select: { name: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException('patient_not_found');
    if (u.role === Role.DOCTOR) {
      const { balanceIssued: _a, balancePaid: _b, visits, outbox: _d, ...rest } = p;
      return { ...rest, visits: visits.map(({ amount: _c, ...v }) => v) };
    }
    return p;
  }

  private async mustFind(clinicId: string, id: string) {
    const p = await this.prisma.patient.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!p) throw new NotFoundException('patient_not_found');
  }

  // Ручная запись о контакте с пациентом (звонок, сообщение, визит)
  @Post(':id/contacts')
  @Roles(...WRITERS)
  async addContact(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ContactDto) {
    await this.mustFind(u.clinicId, id);
    const log = await this.prisma.contactLog.create({
      data: {
        clinicId: u.clinicId,
        patientId: id,
        userId: u.userId,
        channel: dto.channel,
        outcome: dto.outcome,
        note: dto.note?.trim() || undefined,
        source: 'MANUAL',
        contactedAt: dto.contactedAt ? new Date(dto.contactedAt) : new Date(),
      },
      include: { user: { select: { name: true } } },
    });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.contact_added', details: { patientId: id } } });
    return log;
  }

  // Согласие на коммуникацию и пауза автоматизаций для пациента. Синхронизация эти поля не меняет.
  @Patch(':id/consent')
  @Roles(...WRITERS)
  async consent(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConsentDto) {
    await this.mustFind(u.clinicId, id);
    const changed = dto.consent !== undefined || dto.note !== undefined;
    const p = await this.prisma.patient.update({
      where: { id },
      data: {
        consent: dto.consent,
        consentNote: dto.note,
        consentUpdatedAt: changed ? new Date() : undefined,
        automationPaused: dto.automationPaused,
      },
      select: { id: true, consent: true, consentNote: true, consentUpdatedAt: true, automationPaused: true },
    });
    await this.prisma.auditLog.create({
      data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.consent', details: { patientId: id, consent: dto.consent, automationPaused: dto.automationPaused } },
    });
    return p;
  }
}
