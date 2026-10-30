import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, LiqpayCallbackController } from './billing.controller';
import { BillingService } from './billing.service';
import { FxRates } from './fx.service';

@Module({ imports: [AuthModule], controllers: [BillingController, LiqpayCallbackController], providers: [BillingService, FxRates], exports: [BillingService] })
export class BillingModule {}
