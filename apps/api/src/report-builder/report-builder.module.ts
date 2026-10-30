import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { ReportBuilderController } from './report-builder.controller';
import { ReportBuilderService } from './report-builder.service';

@Module({
  imports: [ReportsModule],
  controllers: [ReportBuilderController],
  providers: [ReportBuilderService],
  exports: [ReportBuilderService],
})
export class ReportBuilderModule {}
