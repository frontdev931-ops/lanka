import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import type { Response } from 'express';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { Lang, ReqLang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { toPdf, toXlsx } from '../reports/report-export';
import { ReportsService } from '../reports/reports.service';
import { ROW_LIMIT_MAX, ReportBuilderService, ReportSpec } from './report-builder.service';

const USERS = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];

class RunDto {
  @IsObject() spec: ReportSpec;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
}
class SaveDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsObject() spec: ReportSpec;
}
class ExportDto extends RunDto {
  @IsIn(['xlsx', 'pdf', 'csv']) format: 'xlsx' | 'pdf' | 'csv';
}

@Controller('report-builder')
@UseGuards(AuthGuard)
@Roles(...USERS)
export class ReportBuilderController {
  constructor(
    private builder: ReportBuilderService,
    private reports: ReportsService,
    private prisma: PrismaService,
  ) {}

  private async updatedAt(clinicId: string) {
    return (await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } } }))?.lastSyncAt ?? null;
  }

  @Get('catalog')
  catalog(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang) {
    return this.builder.catalog(u.role, lang);
  }

  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Body() dto: RunDto) {
    return this.builder.run(u.clinicId, u.role, lang, { ...dto.spec, limit: Math.min(Number(dto.spec?.limit) || 500, 1000) }, dto.title, await this.updatedAt(u.clinicId));
  }

  // Выгрузка: тот же расчёт, но без ограничения экрана; пишется в историю действий (в файл уходят данные пациентов)
  @Post('export')
  @HttpCode(200)
  async export(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Body() dto: ExportDto, @Res() res: Response) {
    const report = await this.builder.run(u.clinicId, u.role, lang, { ...dto.spec, limit: ROW_LIMIT_MAX }, dto.title, await this.updatedAt(u.clinicId));
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'report.exported', details: { report: 'custom', dataset: dto.spec.dataset, rows: report.rows.length, format: dto.format } } });
    if (dto.format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"');
      return void res.send(await toXlsx(report, lang));
    }
    if (dto.format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
      return void res.send(await toPdf(report, lang));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    res.send(this.reports.toCsv(report, lang));
  }

  @Get('saved')
  saved(@CurrentUser() u: AuthUser) {
    return this.prisma.savedReport.findMany({ where: { clinicId: u.clinicId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, name: true, spec: true, createdAt: true } });
  }

  @Post('saved')
  async save(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Body() dto: SaveDto) {
    // проверяем описание сразу, чтобы в базу не попадали заведомо неверные отчёты
    await this.builder.run(u.clinicId, u.role, lang, { ...dto.spec, limit: 1 });
    if ((await this.prisma.savedReport.count({ where: { clinicId: u.clinicId } })) >= 100) throw new BadRequestException('too_many_saved');
    return this.prisma.savedReport.create({ data: { clinicId: u.clinicId, name: dto.name.trim(), spec: dto.spec as object, createdById: u.userId }, select: { id: true, name: true, spec: true, createdAt: true } });
  }

  @Delete('saved/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.prisma.savedReport.deleteMany({ where: { id, clinicId: u.clinicId } });
    if (!r.count) throw new NotFoundException('report_not_found');
    return { ok: true };
  }
}
