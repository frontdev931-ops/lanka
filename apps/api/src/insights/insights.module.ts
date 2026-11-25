import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { ReportsModule } from '../reports/reports.module';
import { ReportBuilderModule } from '../report-builder/report-builder.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { PeriodReportController } from './period-report.controller';
import { PeriodReportService } from './period-report.service';

@Module({ imports: [AutomationsModule, ReportBuilderModule, ReportsModule], controllers: [InsightsController, PeriodReportController], providers: [InsightsService, PeriodReportService], exports: [InsightsService, PeriodReportService] })
export class InsightsModule {}
