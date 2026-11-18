import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { InsightsModule } from '../insights/insights.module';
import { ReportBuilderModule } from '../report-builder/report-builder.module';
import { ReportsModule } from '../reports/reports.module';
import { NetworkBillingController, NetworkController, NetworkPlatformController } from './network.controller';
import { NetworkService } from './network.service';

// Networks of clinics: consolidated views, network billing, the service owner's network setup (network.service.ts)
@Module({
  imports: [AuthModule, AiModule, BillingModule, InsightsModule, ReportBuilderModule, ReportsModule],
  controllers: [NetworkController, NetworkBillingController, NetworkPlatformController],
  providers: [NetworkService],
})
export class NetworkModule {}
