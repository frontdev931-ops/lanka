import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { ReportsModule } from '../reports/reports.module';
import { ReportBuilderModule } from '../report-builder/report-builder.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({ imports: [AutomationsModule, ReportBuilderModule, ReportsModule], controllers: [InsightsController], providers: [InsightsService], exports: [InsightsService] })
export class InsightsModule {}
