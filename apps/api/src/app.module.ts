import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { I18nExceptionFilter } from './common/i18n';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { TasksModule } from './tasks/tasks.module';
import { PatientsModule } from './patients/patients.module';
import { TeamModule } from './team/team.module';
import { ImportsModule } from './imports/imports.module';
import { ClinicModule } from './clinic/clinic.module';
import { HealthController } from './common/health.controller';
import { FunnelModule } from './funnel/funnel.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { ReportBuilderModule } from './report-builder/report-builder.module';
import { PushModule } from './push/push.module';
import { BillingModule } from './billing/billing.module';
import { BookingModule } from './booking/booking.module';
import { InsightsModule } from './insights/insights.module';
import { KbModule } from './kb/kb.module';
import { DemoModule } from './demo/demo.module';
import { ServiceModule } from './service/service.module';
import { AiModule } from './ai/ai.module';
import { AutomationsModule } from './automations/automations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ReportsModule,
    IntegrationsModule,
    TasksModule,
    PatientsModule,
    TeamModule,
    ImportsModule,
    ClinicModule,
    FunnelModule,
    InquiriesModule,
    AutomationsModule,
    AiModule,
    ServiceModule,
    BillingModule,
    DemoModule,
    BookingModule,
    KbModule,
    InsightsModule,
    PushModule,
    ReportBuilderModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: I18nExceptionFilter }],
})
export class AppModule {}
