import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, LiqpayCallbackController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({ imports: [AuthModule], controllers: [BillingController, LiqpayCallbackController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
