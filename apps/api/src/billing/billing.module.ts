import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, MonoWebhookController, PlatformMonoDiagnosticController } from './billing.controller';
import { BillingService } from './billing.service';
import { MonoClient } from './mono';

@Module({ imports: [AuthModule], controllers: [BillingController, MonoWebhookController, PlatformMonoDiagnosticController], providers: [BillingService, MonoClient], exports: [BillingService] })
export class BillingModule {}
