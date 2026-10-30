import { Controller, Get, Param, ParseIntPipe, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { Lang, ReqLang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { toPdf, toXlsx } from './report-export';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(
    private reports: ReportsService,
    private prisma: PrismaService,
  ) {}

  @Get()
  catalog(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang) {
    return this.reports.catalog(lang, u.role);
  }

  @Get(':id')
  one(
    @CurrentUser() u: AuthUser,
    @ReqLang() lang: Lang,
    @Param('id') id: string,
    @Query('days', new ParseIntPipe({ optional: true })) days: number | undefined,
    @Query('maxDays', new ParseIntPipe({ optional: true })) maxDays: number | undefined,
  ) {
    return this.reports.build(u.clinicId, id, days, lang, u.role, maxDays);
  }

  // Excel и PDF: те же данные, что на экране и в CSV; выгрузка пишется в историю действий
  @Get(':id/xlsx')
  async xlsx(
    @CurrentUser() u: AuthUser,
    @ReqLang() lang: Lang,
    @Param('id') id: string,
    @Query('days', new ParseIntPipe({ optional: true })) days: number | undefined,
    @Query('maxDays', new ParseIntPipe({ optional: true })) maxDays: number | undefined,
    @Res() res: Response,
  ) {
    const report = await this.reports.build(u.clinicId, id, days, lang, u.role, maxDays);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'report.exported', details: { report: id, rows: report.rows.length, format: 'xlsx' } } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.xlsx"`);
    res.send(await toXlsx(report, lang));
  }

  @Get(':id/pdf')
  async pdf(
    @CurrentUser() u: AuthUser,
    @ReqLang() lang: Lang,
    @Param('id') id: string,
    @Query('days', new ParseIntPipe({ optional: true })) days: number | undefined,
    @Query('maxDays', new ParseIntPipe({ optional: true })) maxDays: number | undefined,
    @Res() res: Response,
  ) {
    const report = await this.reports.build(u.clinicId, id, days, lang, u.role, maxDays);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'report.exported', details: { report: id, rows: report.rows.length, format: 'pdf' } } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.pdf"`);
    res.send(await toPdf(report, lang));
  }

  @Get(':id/csv')
  async csv(
    @CurrentUser() u: AuthUser,
    @ReqLang() lang: Lang,
    @Param('id') id: string,
    @Query('days', new ParseIntPipe({ optional: true })) days: number | undefined,
    @Query('maxDays', new ParseIntPipe({ optional: true })) maxDays: number | undefined,
    @Res() res: Response,
  ) {
    const report = await this.reports.build(u.clinicId, id, days, lang, u.role, maxDays);
    // Выгрузка персональных данных в файл: кто и когда скачал, остаётся в истории действий
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'report.exported', details: { report: id, rows: report.rows.length } } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);
    res.send(this.reports.toCsv(report, lang));
  }
}
