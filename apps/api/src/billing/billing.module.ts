import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, MonoWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { MonoClient } from './mono';

@Module({ imports: [AuthModule], controllers: [BillingController, MonoWebhookController], providers: [BillingService, MonoClient], exports: [BillingService] })
export class BillingModule {}
